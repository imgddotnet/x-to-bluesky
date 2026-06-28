// ==UserScript==
// @name         x-to-bluesky
// @version      2.0b6
// @description  Crosspost from X to Bluesky (Enhanced Link Card Parser)
// @author       imgddotnet
// @license      MIT
// @namespace    imgddotnet
// @match        htt*://*x.com/*
// @match        htt*://*twitter.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @connect      bsky.social
// @connect      video.bsky.app
// @connect      api.bsky.app
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // 1. 定数・設定値の集約 (Configuration & Constants)
    // ==========================================
    const SELECTORS = {
        NAV_BAR: 'nav[role="navigation"]',
        POST_TOOLBAR: 'div[data-testid="toolBar"]',
        POST_BUTTON: '[data-testid="tweetButton"],[data-testid="tweetButtonInline"],[data-testid="SideNav_NewTweet_Button"],a[href="/compose/post"],a[href="/compose/tweet"],a[aria-label*="Post"],[role="button"]',
        SIDE_NAV_POST_BUTTON: '[data-testid="SideNav_NewTweet_Button"],a[href="/compose/post"],a[href="/compose/tweet"],a[aria-label*="Post"]',
        TEXT_AREA: '[data-testid^="tweetTextarea_"],[data-testid*="tweetTextarea"],[role="textbox"][contenteditable="true"]',
        ATTACHMENTS: 'div[data-testid="attachments"] img',
        VIDEO_ATTACHMENTS: 'div[data-testid="attachments"] video',
        X_CARD_CONTAINER: '[data-testid="card.wrapper"],[data-testid^="card.layout"],[data-testid="cardPreview"]',
        QUOTED_TWEET_TEXT: '[data-testid="tweetText"]',
        QUOTED_TWEET_AVATAR: '[data-testid="Tweet-User-Avatar"]'
    };

    const CONFIG = {
        VERSION: '2.0b6',
        TIMEOUT: { DEFAULT: 60000, PARSER: 15000, VIDEO_FETCH: 120000, VIDEO_UPLOAD: 180000 },
        IMAGE: { MAX_DIMENSION: 4000, MAX_SIZE: 975000, COMPRESSION_QUALITY: 0.85, THUMB_DIMENSION: 800 },
        VIDEO: {
            MAX_SIZE: 300 * 1024 * 1024,
            UPLOAD_ENDPOINT: 'https://video.bsky.app/xrpc/app.bsky.video.uploadVideo',
            JOB_STATUS_ENDPOINT: 'https://video.bsky.app/xrpc/app.bsky.video.getJobStatus',
            POLL_INTERVAL_MS: 2000, POLL_MAX_ATTEMPTS: 180
        },
        USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };

    // 略語から正式な単語へ置き換え
    const PROGRESS_STATUS = {
        INITIALIZING: 'Initializing...',
        FETCHING_OGP: 'Fetching Link Info...',
        FETCHING_THUMBNAIL: 'Fetching Thumbnail...',
        UPLOADING_IMAGE: (current, total) => `Uploading Image ${current}/${total}...`,
        POSTING: 'Posting to Bluesky...',
        VIDEO_AUTH: 'Authenticating Video...',
        VIDEO_PDS: 'Uploading to PDS...',
        VIDEO_BUFFER: 'Buffering Video...',
        VIDEO_ENCODING: (progress) => `Encoding ${progress}%`
    };

    // ==========================================
    // 2. 状態管理 (State Management)
    // ==========================================
    let settings = {
        pdsUrl: GM_getValue('bsky_pds_url', 'https://bsky.social').replace('https://https://', 'https://'),
        handle: GM_getValue('bsky_handle', ''),
        password: GM_getValue('bsky_app_password', ''),
        session: GM_getValue('bsky_session', null),
        crosspostChecked: GM_getValue('bsky_crosspost_checked', false)
    };

    let settingsPanel = null;
    let isCurrentlyBridging = false;
    let pendingQuoteUrl = null;

    // ==========================================
    // 3. ネットワーククライアント (Network Utilities)
    // ==========================================
    const NetworkClient = {
        fetchBlob(url, timeoutMs = CONFIG.TIMEOUT.DEFAULT, headers = {}) {
            return new Promise((resolve, reject) => {
                if (url && url.startsWith('blob:')) {
                    fetch(url).then(res => res.blob()).then(resolve).catch(reject);
                    return;
                }
                GM_xmlhttpRequest({
                    method: 'GET', url, responseType: 'blob', timeout: timeoutMs, headers,
                    onload: r => r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error(`HTTP ${r.status}`)),
                    onerror: () => reject(new Error('Network error')),
                    ontimeout: () => reject(new Error('Timeout'))
                });
            });
        },

        fetchHtml(url, extraHeaders = {}) {
            return new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: CONFIG.TIMEOUT.PARSER,
                    headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...extraHeaders },
                    onload: r => resolve(r.status >= 200 && r.status < 300 ? r.responseText : null),
                    onerror: () => resolve(null), ontimeout: () => resolve(null)
                });
            });
        },

        fetchThumbSafely(url, timeoutMs = CONFIG.TIMEOUT.DEFAULT) {
            try { return this.fetchBlob(url, timeoutMs); } catch {
                const norm = url.replace(/\/w\d+[^/]*\//, '/s800/').replace(/\/s\d+\//, '/s800/');
                if (norm !== url) return this.fetchBlob(norm, timeoutMs);
                throw new Error('Thumb fetch failed');
            }
        },

        fetchOEmbed(oEmbedUrl) {
            return new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'GET', url: oEmbedUrl, timeout: CONFIG.TIMEOUT.PARSER,
                    headers: { 'User-Agent': CONFIG.USER_AGENT },
                    onload: res => {
                        try {
                            if (res.status < 200 || res.status >= 300) return resolve(null);
                            const j = JSON.parse(res.responseText);
                            resolve({ title: j.title || '', description: j.description || j.summary || '', imageUrl: j.thumbnail_url || '' });
                        } catch { resolve(null); }
                    },
                    onerror: () => resolve(null), ontimeout: () => resolve(null)
                });
            });
        }
    };

    // ==========================================
    // 4. データ解析モジュール (Parsers & Scrapers)
    // ==========================================
    const DataParser = {
        getByteLength(str) {
            return new TextEncoder().encode(str).length;
        },

        parseFacets(text) {
            const facets = [];
            const patterns = [
                { regex: /(#[\p{L}\p{N}_]+)/gu, type: 'app.bsky.richtext.facet#tag', extract: m => m.substring(1) },
                { regex: /(https?:\/\/[^\s]+)/g, type: 'app.bsky.richtext.facet#link', extract: m => m }
            ];
            patterns.forEach(({ regex, type, extract }) => {
                let match; regex.lastIndex = 0;
                while ((match = regex.exec(text))) {
                    const byteStart = this.getByteLength(text.substring(0, match.index));
                    facets.push({
                        index: { byteStart, byteEnd: byteStart + this.getByteLength(match[0]) },
                        features: [{ $type: type, [type.includes('tag') ? 'tag' : 'uri']: extract(match[0]) }]
                    });
                }
            });
            return facets;
        },

        parseOgp(html, baseUrl) {
            try {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const getMeta = (...props) => {
                    for (const p of props) {
                        const val = doc.querySelector(`meta[name="${p}"],meta[property="${p}"]`)?.getAttribute('content')?.trim();
                        if (val) return val;
                    }
                    return '';
                };
                const title = getMeta('twitter:title', 'og:title') || doc.querySelector('title')?.textContent?.trim() || '';
                const description = getMeta('twitter:description', 'og:description', 'description');
                let imageUrl = getMeta('twitter:image', 'twitter:image:src', 'og:image');
                if (imageUrl && !imageUrl.startsWith('http')) {
                    try { imageUrl = new URL(imageUrl, new URL(baseUrl).origin).href; } catch { imageUrl = ''; }
                }
                return { title, description, imageUrl, doc };
            } catch { return null; }
        },

        async fetchOEmbedFromDoc(targetUrl, doc) {
            try {
                const link = doc.querySelector('link[type="application/json+oembed"][href]');
                if (!link) return null;
                let oEmbedUrl = link.getAttribute('href');
                if (!oEmbedUrl.startsWith('http')) oEmbedUrl = new URL(oEmbedUrl, new URL(targetUrl).origin).href;
                return await NetworkClient.fetchOEmbed(oEmbedUrl);
            } catch { return null; }
        },

        async fetchYouTubeOEmbed(url) {
            const vidId = url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1];
            const r = await NetworkClient.fetchOEmbed(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
            if (r) {
                if (vidId) r.imageUrl = `https://i.ytimg.com/vi/${vidId}/maxresdefault.jpg`;
                return r;
            }
            const html = await NetworkClient.fetchHtml(url, { 'User-Agent': CONFIG.USER_AGENT });
            if (html) {
                const ogp = this.parseOgp(html, url);
                if (ogp?.title) return { title: ogp.title, description: ogp.description, imageUrl: ogp.imageUrl || (vidId ? `https://i.ytimg.com/vi/${vidId}/maxresdefault.jpg` : '') };
            }
            return vidId ? { title: '', description: '', imageUrl: `https://i.ytimg.com/vi/${vidId}/maxresdefault.jpg` } : null;
        },

        extractXCardMeta(editorEl, domain) {
            if (!editorEl) return { xCardTitle: '', xCardDesc: '', xCardImageUrl: '' };

            let xCard = Array.from(editorEl.querySelectorAll(SELECTORS.X_CARD_CONTAINER))
                .find(el => !DomQuery.isInsideQuotedContent(el, null));

            if (!xCard) {
                const context = editorEl.closest('div[role="dialog"]') || editorEl.closest('form') || document.body;
                xCard = Array.from(context.querySelectorAll(SELECTORS.X_CARD_CONTAINER))
                    .find(el => !DomQuery.isInsideQuotedContent(el, null));
            }

            if (!xCard) return { xCardTitle: '', xCardDesc: '', xCardImageUrl: '' };

            const domainBase = domain.replace(/^www\./, '').toLowerCase();
            const textNodes = [];
            const walker = document.createTreeWalker(xCard, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while ((node = walker.nextNode())) {
                const t = node.textContent.trim();
                if (t) textNodes.push(t);
            }

            const uniqueTexts = [...new Set(textNodes)];
            const candidates = uniqueTexts.filter(t => {
                const tl = t.toLowerCase();
                if (tl === domainBase || tl === domain.toLowerCase()) return false;
                if (t.startsWith('http')) return false;
                if (t.length <= 1) return false;
                if (t === '取り消す' || t === '削除' || tl === 'dismiss' || tl === 'remove') return false;
                return true;
            });

            let xCardTitle = '';
            let xCardDesc = '';
            if (candidates.length > 0) {
                xCardTitle = candidates[0];
                if (candidates.length > 1) {
                    xCardDesc = candidates.slice(1).join(' ');
                }
            }

            let xCardImageUrl = '';
            const cardImg = xCard.querySelector('img[src]');
            if (cardImg?.src && (cardImg.src.startsWith('http') || cardImg.src.startsWith('blob:'))) {
                xCardImageUrl = cardImg.src;
            } else {
                const divs = xCard.querySelectorAll('div[style*="background-image"]');
                for (const div of divs) {
                    const bg = div.style.backgroundImage;
                    const m = bg.match(/url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/);
                    if (m) { xCardImageUrl = m[1]; break; }
                }
            }

            return { xCardTitle, xCardDesc, xCardImageUrl };
        }
    };

    // ==========================================
    // 5. DOMクエリ・DOM抽出抽出処理 (DOM Query Helpers)
    // ==========================================
    const DomQuery = {
        getQuotedContainer(editorEl) {
            const textEl = editorEl.querySelector(SELECTORS.QUOTED_TWEET_TEXT);
            const avatarEl = editorEl.querySelector(SELECTORS.QUOTED_TWEET_AVATAR);
            if (!textEl || !avatarEl) return null;
            let node = textEl.parentElement;
            while (node && node !== editorEl) {
                if (node.contains(avatarEl)) return node;
                node = node.parentElement;
            }
            return null;
        },

        extractQuoteUrl() {
            if (pendingQuoteUrl) return pendingQuoteUrl;
            const m = location.pathname.match(/\/([A-Za-z0-9_]{1,50})\/status\/(\d{10,20})/);
            return m ? `https://x.com/${m[1]}/status/${m[2]}` : null;
        },

        captureQuoteUrl(clickedEl) {
            const article = clickedEl.closest('article');
            if (!article) return;
            for (const a of article.querySelectorAll('a[href]')) {
                const m = (a.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,50})\/status\/(\d{10,20})/);
                if (m) { pendingQuoteUrl = `https://x.com/${m[1]}/status/${m[2]}`; return; }
            }
        },

        isInsideQuotedContent(el, quotedContainer) {
            return !!(
                (quotedContainer && quotedContainer.contains(el)) ||
                el.closest('[data-testid^="card.layout"]') ||
                el.closest('[data-testid="card.wrapper"]')
            );
        },

        getOwnAttachments(editorEl, quotedContainer) {
            return {
                images: Array.from(editorEl.querySelectorAll(SELECTORS.ATTACHMENTS)).filter(el => !this.isInsideQuotedContent(el, quotedContainer)),
                videos: Array.from(editorEl.querySelectorAll(SELECTORS.VIDEO_ATTACHMENTS)).filter(el => !this.isInsideQuotedContent(el, quotedContainer))
            };
        }
    };

    // ==========================================
    // 6. 画像・メディア処理モジュール (Media Processors)
    // ==========================================
    const MediaProcessor = {
        resizeImageBlob(blob, maxDimension, quality) {
            return new Promise(resolve => {
                const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'), img = new Image();
                let objectUrl = null;
                img.onload = () => {
                    if (objectUrl) URL.revokeObjectURL(objectUrl);
                    let w = img.naturalWidth, h = img.naturalHeight;
                    if (w > maxDimension || h > maxDimension) {
                        if (w > h) { h = Math.round(h * maxDimension / w); w = maxDimension; }
                        else { w = Math.round(w * maxDimension / h); h = maxDimension; }
                    }
                    canvas.width = w; canvas.height = h;
                    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0, w, h);
                    const compress = q => canvas.toBlob(b => {
                        if (b && b.size > CONFIG.IMAGE.MAX_SIZE && q > 0.2) compress(q - 0.1);
                        else resolve({ blob: b || blob, aspectRatio: { width: w, height: h } });
                    }, 'image/jpeg', q);
                    compress(quality);
                };
                img.onerror = () => resolve({ blob, aspectRatio: { width: 1, height: 1 } });
                objectUrl = URL.createObjectURL(blob); img.src = objectUrl;
            });
        },

        async processExternalEmbed(targetUrl, updateStatus, editorEl) {
            try {
                const domain = new URL(targetUrl).hostname;
                if (domain.includes('x.com') || domain.includes('twitter.com')) return null;
                const isYouTube = domain.includes('youtube.com') || domain.includes('youtu.be');

                const { xCardTitle, xCardDesc, xCardImageUrl } = DataParser.extractXCardMeta(editorEl, domain);

                let title       = (xCardTitle || '').trim();
                let description = (xCardDesc || '').trim();
                let imageUrl    = xCardImageUrl || '';

                if (!title) {
                    updateStatus(PROGRESS_STATUS.FETCHING_OGP);
                    let ogp = null, oembed = null;
                    if (isYouTube) {
                        oembed = await DataParser.fetchYouTubeOEmbed(targetUrl);
                    } else {
                        const html = await NetworkClient.fetchHtml(targetUrl, { 'User-Agent': CONFIG.USER_AGENT });
                        if (html) {
                            ogp = DataParser.parseOgp(html, targetUrl);
                            oembed = ogp ? await DataParser.fetchOEmbedFromDoc(targetUrl, ogp.doc) : null;
                        }
                    }

                    title       = (oembed?.title       || ogp?.title       || domain).trim();
                    description = (oembed?.description || ogp?.description || '').trim();
                    imageUrl    = imageUrl || ogp?.imageUrl || oembed?.imageUrl || '';
                }

                const external = { uri: targetUrl, title: title.substring(0, 300), description: description.substring(0, 800) };
                if (imageUrl.startsWith('http') || imageUrl.startsWith('blob:')) {
                    try {
                        updateStatus(PROGRESS_STATUS.FETCHING_THUMBNAIL);
                        const { THUMB_DIMENSION: dim, COMPRESSION_QUALITY: q } = CONFIG.IMAGE;
                        external.thumb = await bskyAPI.uploadBlob((await this.resizeImageBlob(await NetworkClient.fetchThumbSafely(imageUrl), dim, q)).blob);
                    } catch {}
                }
                return { $type: 'app.bsky.embed.external', external };
            } catch { return null; }
        },

        async processVideoEmbed(videos, updateStatus) {
            const el = videos[0];
            const src = el.src || el.currentSrc || el.querySelector?.('source')?.src;
            if (!src) throw new Error('Video source missing.');
            const blob = src.startsWith('blob:') ? await (await fetch(src)).blob() : await NetworkClient.fetchBlob(src, CONFIG.TIMEOUT.VIDEO_FETCH);
            if (blob.size > CONFIG.VIDEO.MAX_SIZE) throw new Error('Exceeds 300MB limit.');
            const ref = await bskyAPI.uploadVideo(blob, updateStatus);
            if (ref) ref.mimeType = blob.type || 'video/mp4';
            return { $type: 'app.bsky.embed.video', video: ref, aspectRatio: { width: el.videoWidth || 16, height: el.videoHeight || 9 } };
        },

        async processImageEmbed(attachments, updateStatus) {
            const images = [];
            const total = Math.min(attachments.length, 4);
            for (const [i, img] of Array.from(attachments).slice(0, 4).entries()) {
                updateStatus(PROGRESS_STATUS.UPLOADING_IMAGE(i + 1, total));
                const resized = await this.resizeImageBlob(await NetworkClient.fetchBlob(img.src), CONFIG.IMAGE.MAX_DIMENSION, CONFIG.IMAGE.COMPRESSION_QUALITY);
                images.push({ image: await bskyAPI.uploadBlob(resized.blob), alt: '', aspectRatio: resized.aspectRatio });
            }
            return { $type: 'app.bsky.embed.images', images };
        }
    };

    // ==========================================
    // 7. UI制御・画面管理 (UI Elements Manager)
    // ==========================================
    const UiManager = {
        showNotification(text, isError = false) {
            document.getElementById('bsky-notification')?.remove();
            const el = document.createElement('div');
            el.id = 'bsky-notification';
            el.className = `bsky-notification ${isError ? 'error' : 'success'}`;
            el.innerHTML = `<div class="bsky-notification-title">X to Bluesky</div><div class="bsky-notification-text">${text}</div>`;
            document.body.appendChild(el);
            setTimeout(() => { el.classList.add('fade-out'); setTimeout(() => el.remove(), 500); }, 5000);
        },

        toggleSettings() {
            if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; return; }
            settingsPanel = document.createElement('div');
            settingsPanel.className = 'bsky-settings';
            settingsPanel.innerHTML = `
                <fieldset>
                    <legend><span class="legend-title">Bluesky Settings</span><span class="legend-version">v${CONFIG.VERSION}</span></legend>
                    <label>PDS URL</label><input type="url" name="pds" value="${settings.pdsUrl}">
                    <label>Handle</label><input type="text" name="handle" value="${settings.handle}">
                    <label>App Password</label><input type="password" name="password" value="${settings.password}">
                    <div class="settings-actions"><button id="bsky-save">Save</button></div>
                </fieldset>`;
            document.body.appendChild(settingsPanel);
            settingsPanel.querySelector('#bsky-save').onclick = () => {
                settings.pdsUrl = (settingsPanel.querySelector('[name="pds"]').value || 'https://bsky.social').replace('https://https://', 'https://');
                settings.handle = settingsPanel.querySelector('[name="handle"]').value;
                settings.password = settingsPanel.querySelector('[name="password"]').value;
                GM_setValue('bsky_pds_url', settings.pdsUrl);
                GM_setValue('bsky_handle', settings.handle);
                GM_setValue('bsky_app_password', settings.password);
                settingsPanel.remove(); settingsPanel = null;
            };
        },

        injectCheckboxToToolbar() {
            document.querySelectorAll(SELECTORS.POST_TOOLBAR).forEach(toolbar => {
                if (toolbar.hasAttribute('data-bsky-injected') || !toolbar.firstChild) return;
                toolbar.setAttribute('data-bsky-injected', 'true');
                const container = document.createElement('div');
                container.className = 'bsky-toolbar-checkbox-container';
                container.innerHTML = `<label class="bsky-toolbar-crosspost-checkbox"><input type="checkbox" ${settings.crosspostChecked ? 'checked' : ''}><span>Bluesky</span></label>`;
                container.querySelector('input').onchange = e => {
                    settings.crosspostChecked = e.target.checked;
                    GM_setValue('bsky_crosspost_checked', settings.crosspostChecked);
                    document.querySelectorAll('.bsky-toolbar-crosspost-checkbox input').forEach(i => i.checked = settings.crosspostChecked);
                };
                toolbar.firstChild.appendChild(container);
            });
        }
    };

    // ==========================================
    // 8. Bluesky API クライアント (Bluesky Endpoint Wrapper)
    // ==========================================
    const bskyAPI = {
        async request(method, endpoint, data = null, extraHeaders = {}) {
            return new Promise((resolve, reject) => {
                const headers = { ...extraHeaders };
                if (settings.session) headers.Authorization = `Bearer ${settings.session.accessJwt}`;
                const isRaw = data instanceof Blob || data instanceof ArrayBuffer;
                if (data && !isRaw) headers['Content-Type'] = 'application/json';
                GM_xmlhttpRequest({
                    method, url: `${settings.pdsUrl}/xrpc/${endpoint}`, headers,
                    data: data && !isRaw ? JSON.stringify(data) : data,
                    binary: isRaw, timeout: CONFIG.TIMEOUT.DEFAULT,
                    onload: r => {
                        let p = r.responseText; try { p = JSON.parse(r.responseText); } catch {}
                        r.status >= 200 && r.status < 300 ? resolve(p) : reject(new Error(p?.message || `HTTP ${r.status}`));
                    },
                    onerror: () => reject(new Error('PDS Connection Refused')),
                    ontimeout: () => reject(new Error('Timeout'))
                });
            });
        },
        async login() {
            const s = await this.request('POST', 'com.atproto.server.createSession', { identifier: settings.handle, password: settings.password });
            settings.session = s; GM_setValue('bsky_session', s); return s;
        },
        async verifySession() {
            if (!settings.session) return this.login();
            try { await this.request('GET', 'com.atproto.server.getSession'); return settings.session; } catch { return this.login(); }
        },
        async uploadBlob(blob, mimeType = null) {
            return (await this.request('POST', 'com.atproto.repo.uploadBlob', blob, { 'Content-Type': mimeType || blob.type || 'application/octet-stream' })).blob;
        },
        async createPost(record) {
            return this.request('POST', 'com.atproto.repo.createRecord', { repo: settings.session.did, collection: 'app.bsky.feed.post', record });
        },
        async uploadVideo(videoBlob, onProgress) {
            onProgress(PROGRESS_STATUS.VIDEO_AUTH);
            const mime = videoBlob.type || 'video/mp4';
            let token = null;
            try {
                const res = await this.request('POST', 'com.atproto.server.getServiceAuth', { aud: 'did:web:video.bsky.app', lxm: 'com.atproto.repo.uploadBlob', exp: Math.floor(Date.now() / 1000) + 1800 });
                token = res.token || res.accessJwt;
            } catch {}
            if (!token) { onProgress(PROGRESS_STATUS.VIDEO_PDS); return this.uploadBlob(videoBlob, mime); }
            onProgress(PROGRESS_STATUS.VIDEO_BUFFER);
            const buffer = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(videoBlob); });
            const upUrl = new URL(CONFIG.VIDEO.UPLOAD_ENDPOINT);
            upUrl.searchParams.set('did', settings.session.did);
            upUrl.searchParams.set('name', `video_${Date.now()}.${mime.includes('quicktime') ? 'mov' : 'mp4'}`);
            const upRes = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST', url: upUrl.toString(),
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime },
                    data: buffer, binary: true, timeout: CONFIG.TIMEOUT.VIDEO_UPLOAD,
                    onload: r => r.status >= 200 && r.status < 300 ? resolve(JSON.parse(r.responseText)) : reject(new Error('Upload fail')),
                    onerror: () => reject(new Error('Net error'))
                });
            });
            if (upRes.blob) { if (upRes.blob.ref) upRes.blob.mimeType = mime; return upRes.blob; }
            const jobId = upRes.jobId; if (!jobId) throw new Error('No jobId');
            for (let i = 0; i < CONFIG.VIDEO.POLL_MAX_ATTEMPTS; i++) {
                await new Promise(r => setTimeout(r, CONFIG.VIDEO.POLL_INTERVAL_MS));
                try {
                    const status = await new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({
                            method: 'GET', url: `${CONFIG.VIDEO.JOB_STATUS_ENDPOINT}?jobId=${encodeURIComponent(jobId)}`,
                            headers: { Authorization: `Bearer ${token}` },
                            onload: r => resolve(JSON.parse(r.responseText)), onerror: reject
                        });
                    });
                    const js = status.jobStatus || status;
                    if (js.progress != null) onProgress(PROGRESS_STATUS.VIDEO_ENCODING(js.progress));
                    if (js.blob) { if (js.blob.ref) js.blob.mimeType = mime; return js.blob; }
                    if (js.state === 'JOB_STATE_FAILED') throw new Error(js.error || 'Failed');
                } catch {}
            }
            throw new Error('Timeout');
        }
    };

    // ==========================================
    // 9. イベントハンドラー & コアロジック (App Orchestrator)
    // ==========================================
    const handlePost = async (e) => {
        if (isCurrentlyBridging) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
        const btn = e.currentTarget;
        if (!btn || btn.closest(SELECTORS.SIDE_NAV_POST_BUTTON) || !settings.crosspostChecked || !settings.handle || !settings.password) return;
        const tid = btn.getAttribute('data-testid'), txt = btn.textContent || '';
        if (!(tid === 'tweetButton' || tid === 'tweetButtonInline' || txt.includes('Post') || txt.includes('Tweet') || txt.includes('Reply'))) return;
        e.stopPropagation(); e.preventDefault(); e.stopImmediatePropagation();
        isCurrentlyBridging = true;
        const textNode = btn.querySelector('span span') || btn, originalText = textNode.textContent;
        if (textNode !== btn) Object.assign(textNode.style, { whiteSpace: 'nowrap', minWidth: '120px', display: 'inline-block', textAlign: 'center' });
        const updateStatus = msg => { if (textNode !== btn) textNode.textContent = msg; };
        let successBridging = false;
        try {
            btn.style.opacity = '0.7'; updateStatus(PROGRESS_STATUS.INITIALIZING);
            await bskyAPI.verifySession();
            const dialogContext = btn.closest('div[role="dialog"]') || btn.closest('form') || document.body;
            let editors = Array.from(dialogContext.querySelectorAll('[data-testid="tweetEditor"]'));
            if (!editors.length) editors = [dialogContext];
            let replyRef = null;
            for (let i = 0; i < editors.length; i++) {
                const ed = editors[i];
                let postText = '';
                ed.querySelectorAll(SELECTORS.TEXT_AREA).forEach(ta => { const t = (ta.innerText || ta.textContent || '').trim(); if (t) postText = t; });
                if (!postText.trim()) {
                    if (editors.length === 1) { isCurrentlyBridging = false; btn.removeEventListener('click', handlePost, true); btn.removeAttribute('data-bsky-listener'); btn.click(); return; }
                    continue;
                }
                const quotedContainer = DomQuery.getQuotedContainer(ed);
                const isQuotePost = !!quotedContainer;
                const record = { $type: 'app.bsky.feed.post', text: postText, createdAt: new Date().toISOString(), facets: DataParser.parseFacets(postText) };
                if (replyRef) record.reply = replyRef;

                if (!isQuotePost) {
                    const { images, videos } = DomQuery.getOwnAttachments(ed, null);
                    if (videos.length) {
                        try { record.embed = await MediaProcessor.processVideoEmbed(videos, updateStatus); }
                        catch (err) { UiManager.showNotification(`Video: ${err.message}`, true); }
                    } else if (images.length) {
                        record.embed = await MediaProcessor.processImageEmbed(images, updateStatus);
                    }
                    if (!record.embed) {
                        const urls = postText.match(/(https?:\/\/[^\s]+)/g);
                        if (urls?.length) { const card = await MediaProcessor.processExternalEmbed(urls[0], updateStatus, ed); if (card) record.embed = card; }
                    }
                } else {
                    const quoteUrl = DomQuery.extractQuoteUrl();
                    if (quoteUrl) { record.text += '\n' + quoteUrl; record.facets = DataParser.parseFacets(record.text); }
                }

                updateStatus(`${editors.length > 1 ? `[${i + 1}/${editors.length}] ` : ''}${PROGRESS_STATUS.POSTING}`);
                const res = await bskyAPI.createPost(record);
                replyRef = replyRef
                    ? { root: replyRef.root, parent: { uri: res.uri, cid: res.cid } }
                    : { root: { uri: res.uri, cid: res.cid }, parent: { uri: res.uri, cid: res.cid } };
            }
            if (replyRef) { UiManager.showNotification('Crossposted!'); successBridging = true; }
        } catch (err) { UiManager.showNotification(err.message, true); } finally {
            if (textNode !== btn) Object.assign(textNode.style, { whiteSpace: '', minWidth: '', display: '', textAlign: '' });
            updateStatus(originalText); btn.style.opacity = '1';
            pendingQuoteUrl = null;
            setTimeout(() => { isCurrentlyBridging = false; if (successBridging && btn) { btn.removeEventListener('click', handlePost, true); btn.removeAttribute('data-bsky-listener'); btn.click(); } }, 1000);
        }
    };

    // ==========================================
    // 10. 初期化・DOM監視 (App Initialization)
    // ==========================================
    let obTimeout;
    const observer = new MutationObserver(() => {
        clearTimeout(obTimeout);
        obTimeout = setTimeout(() => {
            const navbar = document.querySelector(SELECTORS.NAV_BAR);
            if (navbar && !document.getElementById('bsky-settings-nav-item')) {
                const wrapper = document.createElement('div');
                wrapper.id = 'bsky-settings-nav-item';
                const isMobile = window.getComputedStyle(navbar).flexDirection === 'row' || window.innerHeight < window.innerWidth;
                wrapper.className = `bsky-nav-wrapper ${isMobile ? 'mobile-nav' : 'pc-nav'}`;
                wrapper.innerHTML = `<a href="#" class="bsky-nav-link"><div style="display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 24 24" style="width:22px;height:22px;fill:#1d9bf0;"><path d="M12 2.69l7.92 7.92-7.92 7.92-7.92-7.92Z"/></svg></div></a>`;
                navbar.appendChild(wrapper);
                wrapper.onclick = e => { e.preventDefault(); UiManager.toggleSettings(); };
            }
            UiManager.injectCheckboxToToolbar();
            document.querySelectorAll(SELECTORS.POST_BUTTON).forEach(b => {
                if (!b.hasAttribute('data-bsky-listener')) { b.addEventListener('click', handlePost, true); b.setAttribute('data-bsky-listener', 'true'); }
            });
            if (/iPhone/.test(navigator.userAgent)) {
                const isCompose = location.pathname === '/compose/post';
                document.body.classList.toggle('bsky-iphone-compose', isCompose);
                document.body.classList.toggle('bsky-iphone-home', !isCompose);
            }
        }, 100);
    });

    document.addEventListener('click', e => {
        const retweetBtn = e.target.closest('[data-testid="retweet"]');
        if (retweetBtn) { DomQuery.captureQuoteUrl(retweetBtn); return; }
        const menuItem = e.target.closest('[role="menuitem"]');
        if (menuItem && (menuItem.textContent.includes('Quote') || menuItem.textContent.includes('引用')) && !pendingQuoteUrl) {
            const m = location.pathname.match(/\/([A-Za-z0-9_]{1,50})\/status\/(\d{10,20})/);
            if (m) pendingQuoteUrl = `https://x.com/${m[1]}/status/${m[2]}`;
        }
    }, true);

    if (/iPhone/.test(navigator.userAgent)) {
        const applyIPhoneVisibility = pathname => {
            const isCompose = pathname === '/compose/post';
            document.body.classList.toggle('bsky-iphone-compose', isCompose);
            document.body.classList.toggle('bsky-iphone-home', !isCompose);
        };
        const origPushState = history.pushState.bind(history);
        history.pushState = (...args) => {
            origPushState(...args);
            try { applyIPhoneVisibility(new URL(args[2], location.origin).pathname); }
            catch { applyIPhoneVisibility(location.pathname); }
        };
        window.addEventListener('popstate', () => applyIPhoneVisibility(location.pathname));
        const iPhoneInitObserver = new MutationObserver(() => {
            if (document.getElementById('bsky-settings-nav-item')) {
                applyIPhoneVisibility(location.pathname);
                iPhoneInitObserver.disconnect();
            }
        });
        iPhoneInitObserver.observe(document.body, { childList: true, subtree: true });
        applyIPhoneVisibility(location.pathname);
    }

    // スタイル記述（既存ママ）
    GM_addStyle(`
        .bsky-nav-wrapper.pc-nav { display: flex; align-items: center; justify-content: center; width: 100%; padding: 4px 0; }
        .bsky-nav-wrapper.mobile-nav { display: flex; align-items: center; justify-content: center; flex: 1 1 0%; height: 100%; min-width: 0; }
        .bsky-iphone-compose-hide { display: none !important; }
        .bsky-nav-link { display: flex; align-items: center; justify-content: center; width: 50px; height: 50px; border-radius: 9999px; transition: background-color 0.2s; text-decoration: none !important; }
        .bsky-nav-link:hover { background-color: rgba(231, 233, 234, 0.1); }
        .bsky-toolbar-checkbox-container { display: inline-flex !important; align-items: center !important; margin-left: 8px !important; height: 34px !important; }
        body.bsky-iphone-home    #bsky-settings-nav-item           { display: flex        !important; }
        body.bsky-iphone-compose #bsky-settings-nav-item           { display: none        !important; }
        body.bsky-iphone-home    .bsky-toolbar-checkbox-container   { display: none        !important; }
        body.bsky-iphone-compose .bsky-toolbar-checkbox-container   { display: inline-flex !important; }
        .bsky-toolbar-crosspost-checkbox { display: inline-flex !important; align-items: center !important; font-family: sans-serif !important; font-size: 14px !important; color: currentColor !important; gap: 5px; cursor: pointer; user-select: none; }
        .bsky-toolbar-crosspost-checkbox input { width: 15px !important; height: 15px !important; cursor: pointer; accent-color: rgb(29, 155, 240); margin: 0 !important; }
        .bsky-notification { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: rgb(29, 155, 240); color: white; padding: 12px 18px; border-radius: 8px; z-index: 99999; font-family: sans-serif; font-size: 13px; box-shadow: 0 4px 15px rgba(0,0,0,.3); transition: opacity .4s, transform .4s; }
        .bsky-notification.fade-out { opacity: 0; transform: translateX(-50%) translateY(-20px); }
        .bsky-notification.error { background: rgb(244, 33, 46); }
        .bsky-notification-title { font-weight: bold; margin-bottom: 2px; }
        .bsky-settings { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 300px; background: #15202b; padding: 15px; border-radius: 12px; border: 1px solid #38444d; box-shadow: 0 0 20px rgba(0,0,0,.6); z-index: 100000; font-family: sans-serif; color: white; font-size: 14px; }
        .bsky-settings fieldset { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
        .bsky-settings legend { display: flex !important; align-items: baseline !important; justify-content: space-between !important; width: 100% !important; margin-bottom: 8px; }
        .legend-title { font-weight: bold; color: rgb(29, 155, 240); }
        .legend-version { font-size: 11px; color: #8899a6; font-family: monospace; font-weight: normal; margin-left: auto; }
        .bsky-settings input { width: 100%; padding: 6px; border-radius: 6px; border: 1px solid #38444d; background: #192734; color: white; box-sizing: border-box; font-size: 13px; }
        .settings-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
        .settings-actions button { background: rgb(29, 155, 240); border: none; color: white; padding: 6px 14px; border-radius: 9999px; cursor: pointer; font-weight: bold; font-size: 13px; }
    `);

    observer.observe(document.body, { childList: true, subtree: true });
})();
