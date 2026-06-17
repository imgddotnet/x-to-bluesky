// ==UserScript==
// @name         x-to-bluesky
// @version      2.0b2
// @description  Crosspost from X to Bluesky
// @author       imgddotnet
// @license      MIT
// @namespace    imgddotnet
// @match        htt*://*x.com/*
// @match        htt*://*twitter.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      bsky.social
// @connect      video.bsky.app
// @connect      api.bsky.app
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────
    // CONFIG & SELECTORS
    // ─────────────────────────────
    const SELECTORS = {
        NAV_BAR: 'nav[role="navigation"]',
        POST_TOOLBAR: 'div[data-testid="toolBar"]',
        POST_BUTTON: '[data-testid="tweetButton"],[data-testid="tweetButtonInline"],[data-testid="SideNav_NewTweet_Button"],a[href="/compose/post"],a[href="/compose/tweet"],a[aria-label*="Post"],[role="button"]',
        SIDE_NAV_POST_BUTTON: '[data-testid="SideNav_NewTweet_Button"],a[href="/compose/post"],a[href="/compose/tweet"],a[aria-label*="Post"]',
        TEXT_AREA: '[data-testid^="tweetTextarea_"],[data-testid*="tweetTextarea"],[role="textbox"][contenteditable="true"]',
        ATTACHMENTS: 'div[data-testid="attachments"] img',
        VIDEO_ATTACHMENTS: '[data-testid="tweetEditor"] video,div[data-testid="attachments"] video,div[data-testid="videoPlayer"] video,video',
        QUOTE_LINK: '[data-testid="tweetEditor"] [data-testid^="card.layout"] a[href*="/status/"]',
        MODAL_MASK: 'div[data-testid="mask"]',
        X_CARD_CONTAINER: '[data-testid="card.wrapper"], [data-testid^="card.layout"]',
        X_CARD_IMAGE: 'img',
        X_CARD_TEXT_CONTAINER: '[data-testid="card.layout.large.detail"], [data-testid="card.layout.small.detail"]'
    };

    const CONFIG = {
        VERSION: '2.0b2',
        TIMEOUT: { DEFAULT: 60000, PARSER: 15000, VIDEO_FETCH: 120000, VIDEO_UPLOAD: 180000 },
        IMAGE: { MAX_DIMENSION: 4000, MAX_SIZE: 975000, COMPRESSION_QUALITY: 0.85, THUMB_DIMENSION: 800 },
        VIDEO: { MAX_SIZE: 300 * 1024 * 1024, UPLOAD_ENDPOINT: 'https://video.bsky.app/xrpc/app.bsky.video.uploadVideo', JOB_STATUS_ENDPOINT: 'https://video.bsky.app/xrpc/app.bsky.video.getJobStatus', POLL_INTERVAL_MS: 2000, POLL_MAX_ATTEMPTS: 180 }
    };

    let rawPds = GM_getValue('bsky_pds_url', 'https://bsky.social').replace('https://https://', 'https://');
    let settings = {
        pdsUrl: rawPds,
        handle: GM_getValue('bsky_handle', ''),
        password: GM_getValue('bsky_app_password', ''),
        session: GM_getValue('bsky_session', null),
        crosspostChecked: GM_getValue('bsky_crosspost_checked', false)
    };

    let settingsPanel = null, isCurrentlyBridging = false;

    // ─────────────────────────────
    // UTILITIES
    // ─────────────────────────────
    const getByteLength = str => new TextEncoder().encode(str).length;

    const parseFacets = text => {
        const facets = [], patterns = [
            { regex: /(#[\p{L}\p{N}_]+)/gu, type: 'app.bsky.richtext.facet#tag', extract: m => m.substring(1) },
            { regex: /(https?:\/\/[^\s]+)/g, type: 'app.bsky.richtext.facet#link', extract: m => m }
        ];
        patterns.forEach(({ regex, type, extract }) => {
            let match; regex.lastIndex = 0;
            while ((match = regex.exec(text))) {
                const byteStart = getByteLength(text.substring(0, match.index));
                facets.push({
                    index: { byteStart, byteEnd: byteStart + getByteLength(match[0]) },
                    features: [{ $type: type, [type.includes('tag') ? 'tag' : 'uri']: extract(match[0]) }]
                });
            }
        });
        return facets;
    };

    const fetchBlobSafely = (url, timeoutMs = CONFIG.TIMEOUT.DEFAULT, customHeaders = {}) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'GET', url, responseType: 'blob', timeout: timeoutMs, headers: customHeaders,
            onload: res => (res.status >= 200 && res.status < 300) ? resolve(res.response) : reject(new Error(`HTTP ${res.status}`)),
            onerror: () => reject(new Error('Network error')), ontimeout: () => reject(new Error('Timeout'))
        });
    });

    const resizeImageBlob = (blob, maxDimension, quality) => new Promise(resolve => {
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'), image = new Image();
        let objectUrl = null;
        image.onload = () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            let w = image.naturalWidth, h = image.naturalHeight;
            if (w > maxDimension || h > maxDimension) {
                if (w > h) { h = Math.round(h * maxDimension / w); w = maxDimension; }
                else { w = Math.round(w * maxDimension / h); h = maxDimension; }
            }
            canvas.width = w; canvas.height = h;
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
            ctx.drawImage(image, 0, 0, w, h);
            const compress = q => {
                canvas.toBlob(resultBlob => {
                    if (resultBlob && resultBlob.size > CONFIG.IMAGE.MAX_SIZE && q > 0.2) compress(q - 0.1);
                    else resolve({ blob: resultBlob || blob, aspectRatio: { width: w, height: h } });
                }, 'image/jpeg', q);
            };
            compress(quality);
        };
        image.onerror = () => resolve({ blob, aspectRatio: { width: 1, height: 1 } });
        objectUrl = URL.createObjectURL(blob); image.src = objectUrl;
    });

    // ─────────────────────────────
    // サムネイル取得（Blogger URL 正規化 + リトライ対応）
    // ─────────────────────────────

    const normalizeBloggerImageUrl = (url) => {
        try {
            // /w1200-h630-p-k-no-nu/ など複雑なフィルタ → /s800/
            const complexFilter = url.replace(/\/w\d+[^/]*\//, '/s800/');
            if (complexFilter !== url) return complexFilter;
            // /s400/ など単純なサイズ指定 → /s800/
            const simpleSize = url.replace(/\/s\d+\//, '/s800/');
            if (simpleSize !== url) return simpleSize;
        } catch {}
        return null; // Blogger URL でなければ null
    };

    const fetchThumbSafely = async (url, timeoutMs = CONFIG.TIMEOUT.DEFAULT) => {
        // まず元の URL で試みる
        try {
            return await fetchBlobSafely(url, timeoutMs);
        } catch (e) {
            // 失敗 & Blogger URL なら正規化してリトライ
            const normalized = normalizeBloggerImageUrl(url);
            if (normalized && normalized !== url) {
                console.info('[x-to-bluesky] Blogger URL normalized, retrying:', normalized);
                return await fetchBlobSafely(normalized, timeoutMs);
            }
            throw e; // それ以外はそのまま投げる
        }
    };

    // ─────────────────────────────
    // 【第2層】OGP / Twitter Card 直接取得
    // ─────────────────────────────
    const fetchLinkCard = (url) => new Promise((resolve) => {
        const reqHeaders = { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            timeout: CONFIG.TIMEOUT.PARSER,
            headers: reqHeaders,
            onload: res => {
                try {
                    if (res.status < 200 || res.status >= 300) { resolve(null); return; }
                    const doc = new DOMParser().parseFromString(res.responseText, 'text/html');
                    const domain = new URL(url).hostname;

                    // メタタグから値を取得するヘルパー
                    // Twitter Card → OGP → フォールバック の優先順位で取得
                    const getMeta = (...props) => {
                        for (const p of props) {
                            const el = doc.querySelector(`meta[name="${p}"], meta[property="${p}"]`);
                            const val = el?.getAttribute('content')?.trim();
                            if (val) return val;
                        }
                        return '';
                    };

                    // タイトル: twitter:title → og:title → <title>タグ の順
                    const title = getMeta('twitter:title', 'og:title')
                        || doc.querySelector('title')?.textContent?.trim()
                        || domain;

                    // description: twitter:description → og:description → description の順
                    const description = getMeta('twitter:description', 'og:description', 'description');

                    // 画像: twitter:image → og:image の順（相対URLは絶対URLに変換）
                    let imageUrl = getMeta('twitter:image', 'twitter:image:src', 'og:image');
                    if (imageUrl && !imageUrl.startsWith('http')) {
                        try { imageUrl = new URL(imageUrl, new URL(url).origin).href; } catch { imageUrl = ''; }
                    }

                    if (!title || title === domain) { resolve(null); return; }
                    resolve({ title, description, imageUrl });
                } catch (e) { resolve(null); }
            },
            onerror: () => resolve(null),
            ontimeout: () => resolve(null)
        });
    });

    // ─────────────────────────────
    // 【3層フェイルセーフ】リンクカード生成
    // ─────────────────────────────
    const processExternalEmbed = async (targetUrl, updateStatus, editorElement) => {
        try {
            const domain = new URL(targetUrl).hostname;
            if (domain.includes('x.com') || domain.includes('twitter.com')) return null;

            updateStatus('Card...');

            // 第1層で取得した画像（blob: URL）を保持するための変数
            let layer1ImageBlob = null;
            // 第1層の抽出結果（title・description）
            let layer1Title = '';
            let layer1Description = '';
            let layer1ImageHttpUrl = '';

            if (editorElement) {
                const xCardContainer = editorElement.querySelector(SELECTORS.X_CARD_CONTAINER);
                if (xCardContainer) {

                    // large card / small card 両方に対応するセレクター
                    const cardLink = xCardContainer.querySelector(
                        'div[data-testid="card.layoutLarge.media"] > a[rel][aria-label], ' +
                        'div[data-testid="card.layoutSmall.media"] > a[rel][aria-label], ' +
                        'a[data-testid="card.wrapper"] > div > a[rel][aria-label]'
                    );

                    if (cardLink) {
                        const ariaLabel = cardLink.getAttribute('aria-label') || '';
                        // aria-label = "ドメイン名 タイトル本文…"（先頭がドメイン名、以降がタイトル）
                        const spaceIdx = ariaLabel.indexOf(' ');
                        if (spaceIdx > 0) {
                            // サイト名部分（= domain）をスキップしてタイトルだけ取り出す
                            const extracted = ariaLabel.substring(spaceIdx + 1).trim();
                            if (extracted && extracted !== domain) {
                                layer1Title = extracted;
                            }
                        }

                        // 画像は aria-label を持つリンク内の img から取得
                        // src が空の場合は srcset の最初のURLを使う（Xの遅延ロード対策）
                        const cardImg = cardLink.querySelector('img');
                        if (cardImg) {
                            let imgSrc = cardImg.src || '';
                            // srcset フォールバック（"https://... 1x, https://... 2x" 形式）
                            if (!imgSrc && cardImg.srcset) {
                                imgSrc = cardImg.srcset.split(',')[0].trim().split(' ')[0];
                            }
                            console.info('[x-to-bluesky] Layer1 card img src:', imgSrc);
                            if (imgSrc.startsWith('blob:')) {
                                try {
                                    layer1ImageBlob = await (await fetch(imgSrc)).blob();
                                } catch (e) { console.warn('[x-to-bluesky] Layer1 blob extract failed:', e); }
                            } else if (imgSrc.startsWith('http')) {
                                layer1ImageHttpUrl = imgSrc;
                            }
                        }
                    }

                    // ── フォールバック: aria-label が取れなかった場合は leafSpan 方式 ──
                    if (!layer1Title) {
                        const textContainer = xCardContainer.querySelector(SELECTORS.X_CARD_TEXT_CONTAINER);
                        if (textContainer) {
                            const leafSpans = Array.from(textContainer.querySelectorAll('span'))
                                .filter(el => !el.querySelector('span') && el.textContent.trim().length > 0)
                                .map(el => el.textContent.trim())
                                .filter((t, i, arr) => arr.indexOf(t) === i);

                            const withoutDomain = leafSpans.filter(t => t !== domain && !t.startsWith('http'));
                            if (withoutDomain.length > 0) layer1Title = withoutDomain[0];
                            if (withoutDomain.length > 1) layer1Description = withoutDomain.slice(1).join(' ');
                        }

                        // 画像もまだ取れていなければ img を総当たりで探す
                        if (!layer1ImageBlob && !layer1ImageHttpUrl) {
                            const xImgEl = xCardContainer.querySelector(SELECTORS.X_CARD_IMAGE);
                            if (xImgEl?.src) {
                                if (xImgEl.src.startsWith('blob:')) {
                                    try {
                                        layer1ImageBlob = await (await fetch(xImgEl.src)).blob();
                                    } catch (e) { console.warn('[x-to-bluesky] Layer1 blob extract failed (fallback):', e); }
                                } else if (xImgEl.src.startsWith('http')) {
                                    layer1ImageHttpUrl = xImgEl.src;
                                }
                            }
                        }
                    }
                }
            }

            // ──────────────────────────────────────
            // 【第2層】OGP / Twitter Card を直接 fetch
            // ──────────────────────────────────────
            let layer2Card = null;
            const layer1TitleIsWeak = !layer1Title || layer1Title === domain;
            if (layer1TitleIsWeak) {
                updateStatus('OGP...');
                layer2Card = await fetchLinkCard(targetUrl);
            }

            // ──────────────────────────────────────
            // 最終的な card オブジェクトの決定
            // ──────────────────────────────────────
            const finalTitle       = layer2Card?.title       || layer1Title       || domain;
            const finalDescription = layer2Card?.description || layer1Description || '';
            // 画像優先度: 第2層OGP画像 → 第1層blob → 第1層http
            const finalImageHttpUrl = layer2Card?.imageUrl   || layer1ImageHttpUrl || '';

            console.info('[x-to-bluesky] Card resolved:', {
                title: finalTitle,
                layer1Title, layer1ImageHttpUrl, layer1ImageBlobSize: layer1ImageBlob?.size,
                layer2ImageUrl: layer2Card?.imageUrl,
                finalImageHttpUrl
            });

            // ──────────────────────────────────────
            // 【第3層】すべてが失敗した場合の最終フォールバック
            // ──────────────────────────────────────
            const external = {
                uri: targetUrl,
                title: finalTitle.substring(0, 300),
                description: finalDescription.substring(0, 800)
            };

            // サムネイル画像のアップロード
            // 第1層で blob を取得済みの場合はそれを使い、HTTP の場合は改めて fetch する
            if (layer2Card?.imageUrl && layer2Card.imageUrl.startsWith('http')) {
                // 第2層（OGP）の画像を優先
                try {
                    updateStatus('Thumb...');
                    console.info('[x-to-bluesky] Fetching Layer2 thumb:', layer2Card.imageUrl);
                    const imgBlob = await fetchThumbSafely(layer2Card.imageUrl, CONFIG.TIMEOUT.DEFAULT);
                    const resized = await resizeImageBlob(imgBlob, CONFIG.IMAGE.THUMB_DIMENSION, CONFIG.IMAGE.COMPRESSION_QUALITY);
                    external.thumb = await bskyAPI.uploadBlob(resized.blob);
                } catch (e) {
                    console.warn('[x-to-bluesky] Layer2 thumb failed, trying layer1:', e);
                    // 第2層画像が失敗したら第1層にフォールバック
                    if (layer1ImageBlob) {
                        try {
                            console.info('[x-to-bluesky] Using Layer1 blob as fallback thumb');
                            const resized = await resizeImageBlob(layer1ImageBlob, CONFIG.IMAGE.THUMB_DIMENSION, CONFIG.IMAGE.COMPRESSION_QUALITY);
                            external.thumb = await bskyAPI.uploadBlob(resized.blob);
                        } catch (e2) { console.warn('[x-to-bluesky] Layer1 blob thumb also failed:', e2); }
                    }
                }
            } else if (layer1ImageBlob) {
                // 第2層に画像がなければ第1層 blob を使用
                try {
                    console.info('[x-to-bluesky] Using Layer1 blob thumb');
                    const resized = await resizeImageBlob(layer1ImageBlob, CONFIG.IMAGE.THUMB_DIMENSION, CONFIG.IMAGE.COMPRESSION_QUALITY);
                    external.thumb = await bskyAPI.uploadBlob(resized.blob);
                } catch (e) { console.warn('[x-to-bluesky] Layer1 blob thumb failed:', e); }
            } else if (finalImageHttpUrl.startsWith('http')) {
                // 残った HTTP URL を最後の手段として使用
                try {
                    updateStatus('Thumb...');
                    console.info('[x-to-bluesky] Fetching fallback thumb:', finalImageHttpUrl);
                    const imgBlob = await fetchThumbSafely(finalImageHttpUrl, CONFIG.TIMEOUT.DEFAULT);
                    const resized = await resizeImageBlob(imgBlob, CONFIG.IMAGE.THUMB_DIMENSION, CONFIG.IMAGE.COMPRESSION_QUALITY);
                    external.thumb = await bskyAPI.uploadBlob(resized.blob);
                } catch (e) { console.warn('[x-to-bluesky] Fallback thumb failed:', e); }
            } else {
                console.warn('[x-to-bluesky] No thumb image source available');
            }

            return { $type: 'app.bsky.embed.external', external };

        } catch (err) {
            console.error('[x-to-bluesky] processExternalEmbed error:', err);
            return null;
        }
    };

    // ─────────────────────────────
    // PROCESS EMBEDS (IMAGES/VIDEOS)
    // ─────────────────────────────
    const processVideoEmbed = async (videos, updateStatus) => {
        const el = videos[0];
        const src = el.src || el.currentSrc || el.querySelector?.('source')?.src;
        if (!src) throw new Error('Video source missing.');
        let blob = src.startsWith('blob:') ? await (await fetch(src)).blob() : await fetchBlobSafely(src, CONFIG.TIMEOUT.VIDEO_FETCH);
        if (blob.size > CONFIG.VIDEO.MAX_SIZE) throw new Error('Exceeds 300MB limit.');
        const ref = await bskyAPI.uploadVideo(blob, updateStatus);
        if (ref) ref.mimeType = blob.type || 'video/mp4';
        return { $type: 'app.bsky.embed.video', video: ref, aspectRatio: { width: el.videoWidth || 16, height: el.videoHeight || 9 } };
    };

    const processImageEmbed = async (attachments, updateStatus) => {
        const images = [];
        for (let [i, img] of Array.from(attachments).slice(0, 4).entries()) {
            updateStatus(`Img ${i + 1}/${Math.min(attachments.length, 4)}...`);
            const resized = await resizeImageBlob(await fetchBlobSafely(img.src), CONFIG.IMAGE.MAX_DIMENSION, CONFIG.IMAGE.COMPRESSION_QUALITY);
            images.push({ image: await bskyAPI.uploadBlob(resized.blob), alt: '', aspectRatio: resized.aspectRatio });
        }
        return { $type: 'app.bsky.embed.images', images };
    };

    // ─────────────────────────────
    // UI COMPONENTS
    // ─────────────────────────────
    const showNotification = (text, isError = false) => {
        document.getElementById('bsky-notification')?.remove();
        const notif = document.createElement('div');
        notif.id = 'bsky-notification';
        notif.className = `bsky-notification ${isError ? 'error' : 'success'}`;
        notif.innerHTML = `<div class="bsky-notification-title">X to Bluesky</div><div class="bsky-notification-text">${text}</div>`;
        document.body.appendChild(notif);
        setTimeout(() => { notif.classList.add('fade-out'); setTimeout(() => notif.remove(), 500); }, 5000);
    };

    const toggleSettings = () => {
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
            GM_setValue('bsky_pds_url', settings.pdsUrl); GM_setValue('bsky_handle', settings.handle); GM_setValue('bsky_app_password', settings.password);
            settingsPanel.remove(); settingsPanel = null;
        };
    };

    const injectCheckboxToToolbar = () => {
        document.querySelectorAll(SELECTORS.POST_TOOLBAR).forEach(toolbar => {
            if (toolbar.querySelector('.bsky-toolbar-checkbox-container') || !toolbar.firstChild) return;
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
    };

    // ─────────────────────────────
    // ROBUST POST HANDLER
    // ─────────────────────────────
    const handlePost = async (e) => {
        if (isCurrentlyBridging) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }

        const btn = e.currentTarget;
        if (!btn || btn.closest(SELECTORS.SIDE_NAV_POST_BUTTON) || !settings.crosspostChecked || !settings.handle || !settings.password) return;

        const tid = btn.getAttribute('data-testid'), txt = btn.textContent || '';
        const isTargetButton = (tid === 'tweetButton' || tid === 'tweetButtonInline' || txt.includes('ポスト') || txt.includes('ツイート') || txt.includes('すべて') || txt.includes('返信') || txt.includes('Post') || txt.includes('Tweet') || txt.includes('Reply'));
        if (!isTargetButton) return;

        e.stopPropagation(); e.preventDefault(); e.stopImmediatePropagation();
        isCurrentlyBridging = true;

        const textNode = btn.querySelector('span span') || btn, originalText = textNode.textContent;
        if (textNode && textNode !== btn) { Object.assign(textNode.style, { whiteSpace: 'nowrap', minWidth: '120px', display: 'inline-block', textAlign: 'center' }); }
        const updateStatus = msg => { if (textNode && textNode !== btn) textNode.textContent = msg; };

        let successBridging = false;

        try {
            btn.style.opacity = '0.7'; updateStatus('Init...');
            await bskyAPI.verifySession();

            const dialogContext = btn.closest('div[role="dialog"]') || btn.closest('form') || document.body;
            let editors = Array.from(dialogContext.querySelectorAll('[data-testid="tweetEditor"]'));
            if (editors.length === 0) editors = [dialogContext];

            let replyRef = null;
            let postedCount = 0;

            for (let i = 0; i < editors.length; i++) {
                const ed = editors[i];
                let postText = '';

                ed.querySelectorAll(SELECTORS.TEXT_AREA).forEach(textarea => {
                    const t = (textarea.innerText || textarea.textContent || '').trim();
                    if (t && t !== 'いまどうしてる？' && t !== 'What\'s happening?') postText = t;
                });

                if (!postText.trim()) {
                    if (editors.length === 1) {
                        isCurrentlyBridging = false; btn.removeEventListener('click', handlePost, true); btn.removeAttribute('data-bsky-listener'); btn.click(); return;
                    }
                    continue;
                }

                const record = { $type: 'app.bsky.feed.post', text: postText, createdAt: new Date().toISOString(), facets: parseFacets(postText) };
                if (replyRef) record.reply = replyRef;

                const vids = ed.querySelectorAll(SELECTORS.VIDEO_ATTACHMENTS);
                if (vids.length > 0) record.embed = await processVideoEmbed(vids, updateStatus);
                else {
                    const imgs = ed.querySelectorAll(SELECTORS.ATTACHMENTS);
                    if (imgs.length > 0) record.embed = await processImageEmbed(imgs, updateStatus);
                }

                const urlsInText = postText.match(/(https?:\/\/[^\s]+)/g);
                if (urlsInText && urlsInText.length > 0 && !record.embed) {
                    const embedCard = await processExternalEmbed(urlsInText[0], updateStatus, ed);
                    if (embedCard) record.embed = embedCard;
                }

                const quote = ed.querySelector('[data-testid="tweetEditor"] [data-testid^="card.layout"] a[href*="/status/"]');
                if (quote?.href) { record.text += '\n' + quote.href; record.facets = parseFacets(record.text); }

                const prefix = editors.length > 1 ? `[${i + 1}/${editors.length}] ` : '';
                updateStatus(`${prefix}Post...`);

                const res = await bskyAPI.createPost(record);
                postedCount++;

                if (!replyRef) {
                    replyRef = { root: { uri: res.uri, cid: res.cid }, parent: { uri: res.uri, cid: res.cid } };
                } else {
                    replyRef.parent = { uri: res.uri, cid: res.cid };
                }
            }

            if (postedCount > 0) { showNotification('Crossposted!'); successBridging = true; }
        } catch (err) {
            console.error('[x-to-bluesky]', err); showNotification(err.message, true);
        } finally {
            if (textNode && textNode !== btn) { Object.assign(textNode.style, { whiteSpace: '', minWidth: '', display: '', textAlign: '' }); }
            updateStatus(originalText); btn.style.opacity = '1';

            if (successBridging) {
                setTimeout(() => {
                    isCurrentlyBridging = false;
                    if (btn && typeof btn.click === 'function') {
                        btn.removeEventListener('click', handlePost, true);
                        btn.removeAttribute('data-bsky-listener');
                        btn.click();
                    }
                }, 1000);
            } else {
                setTimeout(() => { isCurrentlyBridging = false; }, 1000);
            }
        }
    };

    // ─────────────────────────────
    // INITIALIZATION & OBSERVER
    // ─────────────────────────────
    let obTimeout;
    const observer = new MutationObserver(() => {
        clearTimeout(obTimeout);
        obTimeout = setTimeout(() => {
            const navbar = document.querySelector(SELECTORS.NAV_BAR);
            let settingsIcon = document.getElementById('bsky-settings-nav-item');

            if (navbar && !settingsIcon) {
                const wrapper = document.createElement('div');
                wrapper.id = 'bsky-settings-nav-item';
                const isMobile = window.getComputedStyle(navbar).flexDirection === 'row' || window.innerHeight < window.innerWidth;
                wrapper.className = `bsky-nav-wrapper ${isMobile ? 'mobile-nav' : 'pc-nav'}`;
                wrapper.innerHTML = `<a href="#" class="bsky-nav-link"><div style="display: flex; align-items: center; justify-content: center;"><svg viewBox="0 0 24 24" style="width: 22px; height: 22px; fill: #1d9bf0;"><path d="M12 2.69l7.92 7.92-7.92 7.92-7.92-7.92Z"/></svg></div></a>`;
                navbar.appendChild(wrapper);
                wrapper.onclick = e => { e.preventDefault(); toggleSettings(); };
                settingsIcon = wrapper;
            }

            if (settingsIcon) {
                settingsIcon.style.display = (window.innerWidth <= 687 && !!document.querySelector(SELECTORS.TEXT_AREA)) ? 'none' : '';
            }

            injectCheckboxToToolbar();
            document.querySelectorAll(SELECTORS.POST_BUTTON).forEach(b => {
                if (!b.hasAttribute('data-bsky-listener')) { b.addEventListener('click', handlePost, true); b.setAttribute('data-bsky-listener', 'true'); }
            });
        }, 100);
    });
    setInterval(injectCheckboxToToolbar, 400);

    GM_addStyle(`
        .bsky-nav-wrapper.pc-nav { display: flex; align-items: center; justify-content: center; width: 100%; padding: 4px 0; }
        .bsky-nav-wrapper.mobile-nav { display: flex; align-items: center; justify-content: center; flex: 1 1 0%; height: 100%; min-width: 0; }
        .bsky-nav-link { display: flex; align-items: center; justify-content: center; width: 50px; height: 50px; border-radius: 9999px; transition: background-color 0.2s; text-decoration: none !important; }
        .bsky-nav-link:hover { background-color: rgba(231, 233, 234, 0.1); }
        .bsky-toolbar-checkbox-container { display: inline-flex !important; align-items: center !important; margin-left: 8px !important; height: 34px !important; }
        .bsky-toolbar-crosspost-checkbox { display: inline-flex !important; align-items: center !important; font-family: TwitterChirp, -apple-system, sans-serif !important; font-size: 14px !important; color: currentColor !important; gap: 5px; cursor: pointer; user-select: none; }
        .bsky-toolbar-crosspost-checkbox input { width: 15px !important; height: 15px !important; cursor: pointer; accent-color: rgb(29, 155, 240); margin: 0 !important; }
        div[role="progressbar"] ~ .bsky-nav-wrapper, div[data-testid="toolBar"] ~ .bsky-nav-wrapper, main [role="progressbar"] .bsky-nav-wrapper, div[data-testid="primaryColumn"] [role="progressbar"] ~ .bsky-nav-wrapper { display: none !important; }
        .bsky-notification { position: fixed; bottom: 20px; right: 50%; transform: translateX(50%); background: rgb(29, 155, 240); color: white; padding: 12px 18px; border-radius: 8px; z-index: 99999; font-family: TwitterChirp, sans-serif; font-size: 13px; box-shadow: 0 4px 15px rgba(0,0,0,.3); transition: opacity .4s, transform .4s; }
        .bsky-notification.error { background: rgb(244, 33, 46); }
        .bsky-notification.fade-out { opacity: 0; transform: translateX(50%) translateY(30px); }
        .bsky-notification-title { font-weight: bold; margin-bottom: 2px; }
        .bsky-settings { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 300px; background: #15202b; padding: 15px; border-radius: 12px; border: 1px solid #38444d; box-shadow: 0 0 20px rgba(0,0,0,.6); z-index: 100000; font-family: TwitterChirp, sans-serif; color: white; font-size: 14px; }
        .bsky-settings fieldset { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
        .bsky-settings legend { display: flex !important; align-items: baseline !important; justify-content: space-between !important; width: 100% !important; margin-bottom: 8px; }
        .legend-title { font-weight: bold; color: rgb(29, 155, 240); }
        .legend-version { font-size: 11px; color: #8899a6; font-family: monospace; font-weight: normal; margin-left: auto; }
        .bsky-settings input { width: 100%; padding: 6px; border-radius: 6px; border: 1px solid #38444d; background: #192734; color: white; box-sizing: border-box; font-size: 13px; }
        .settings-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
        .settings-actions button { background: rgb(29, 155, 240); border: none; color: white; padding: 6px 14px; border-radius: 9999px; cursor: pointer; font-weight: bold; font-size: 13px; }
    `);

    // ─────────────────────────────
    // BLUESKY RPC API
    // ─────────────────────────────
    const bskyAPI = {
        async request(method, endpoint, data = null, customHeaders = {}) {
            return new Promise((resolve, reject) => {
                const headers = { ...customHeaders };
                if (settings.session) headers.Authorization = `Bearer ${settings.session.accessJwt}`;
                if (data && !(data instanceof Blob) && !(data instanceof ArrayBuffer)) headers['Content-Type'] = 'application/json';
                GM_xmlhttpRequest({
                    method, url: `${settings.pdsUrl}/xrpc/${endpoint}`, headers,
                    data: (data && !(data instanceof Blob) && !(data instanceof ArrayBuffer)) ? JSON.stringify(data) : data,
                    binary: (data instanceof Blob || data instanceof ArrayBuffer), timeout: CONFIG.TIMEOUT.DEFAULT,
                    onload: res => {
                        let p = res.responseText; try { p = JSON.parse(res.responseText); } catch {}
                        if (res.status >= 200 && res.status < 300) resolve(p);
                        else reject(new Error(p?.message || `HTTP ${res.status}`));
                    },
                    onerror: () => reject(new Error('PDS Connection Refused')), ontimeout: () => reject(new Error('Timeout'))
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
            onProgress('Vid Auth...'); const mime = videoBlob.type || 'video/mp4'; let token = null;
            try {
                const res = await this.request('POST', 'com.atproto.server.getServiceAuth', { aud: 'did:web:video.bsky.app', lxm: 'com.atproto.repo.uploadBlob', exp: Math.floor(Date.now() / 1000) + 1800 });
                token = res.token || res.accessJwt;
            } catch {}
            if (!token) { onProgress('PDS Upload...'); return await this.uploadBlob(videoBlob, mime); }
            onProgress('Vid Buffer...');
            const buffer = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(videoBlob); });
            const upUrl = new URL(CONFIG.VIDEO.UPLOAD_ENDPOINT); upUrl.searchParams.set('did', settings.session.did); upUrl.searchParams.set('name', `video_${Date.now()}.${mime.includes('quicktime') ? 'mov' : 'mp4'}`);
            const upRes = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST', url: upUrl.toString(), headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime },
                    data: buffer, binary: true, timeout: CONFIG.TIMEOUT.VIDEO_UPLOAD,
                    onload: res => res.status >= 200 && res.status < 300 ? resolve(JSON.parse(res.responseText)) : reject(new Error('Upload fail')), onerror: () => reject(new Error('Net error'))
                });
            });
            if (upRes.blob) { if (upRes.blob.ref) upRes.blob.mimeType = mime; return upRes.blob; }
            const jobId = upRes.jobId; if (!jobId) throw new Error('No jobId');
            for (let i = 0; i < CONFIG.VIDEO.POLL_MAX_ATTEMPTS; i++) {
                await new Promise(r => setTimeout(r, CONFIG.VIDEO.POLL_INTERVAL_MS));
                try {
                    const status = await new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({
                            method: 'GET', url: `${CONFIG.VIDEO.JOB_STATUS_ENDPOINT}?jobId=${encodeURIComponent(jobId)}`, headers: { Authorization: `Bearer ${token}` },
                            onload: res => resolve(JSON.parse(res.responseText)), onerror: reject
                        });
                    });
                    const js = status.jobStatus || status;
                    if (js.progress != null) onProgress(`Enc ${js.progress}%`);
                    if (js.blob) { if (js.blob.ref) js.blob.mimeType = mime; return js.blob; }
                    if (js.state === 'JOB_STATE_FAILED') throw new Error(js.error || 'Failed');
                } catch {}
            }
            throw new Error('Timeout');
        }
    };

    observer.observe(document.body, { childList: true, subtree: true });
})();
