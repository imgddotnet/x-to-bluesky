// ==UserScript==
// @name         x-to-bluesky
// @version      1.0b2
// @description  Crosspost from X (formerly Twitter) to Bluesky with link cards, images, and videos (Enhanced: Image Resize & Content-Type Fix & ALT Text Support)
// @author       imgddotnet (Modified by Gemini & Claude)
// @license      MIT
// @namespace    imgddotnet
// @match        htt*://*x.com/*
// @match        htt*://*twitter.com/*
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzU3OUZENiIgZD0iTTEyIDEuNjkybC01LjY5MiA5LjY5Mmw1LjY5MiA5LjY5Mmw1LjY5Mi05LjY5MnoiLz48L3N2Zz4=
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      bsky.social
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // セレクタ定義
    const SELECTORS = {
        NAV_BAR: 'header nav[role="navigation"]',
        BSKY_NAV: 'header nav[role="navigation"]:not(.bsky-navbar)',
        POST_TOOLBAR: 'div[data-testid="toolBar"]:not(.bsky-toolbar)',
        POST_BUTTON: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
        SIDE_NAV_POST_BUTTON: '[data-testid="SideNav_NewTweet_Button"], a[href="/compose/post"], a[href="/compose/tweet"], a[aria-label*="Post"]',
        TEXT_AREA: '[data-testid="tweetTextarea_0"]',
        ATTACHMENTS: 'div[data-testid="attachments"] img',
        VIDEO_ATTACHMENTS: 'div[data-testid="attachments"] video',
        QUOTE_LINK: '[data-testid="tweetEditor"] [data-testid^="card.layout"] a[href*="/status/"]'
    };

    // 定数の統合 (削減案1)
    const CONFIG = {
        VERSION: 'v1.0b2',
        ICON_SVG: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzU3OUZENiIgZD0iTTEyIDEuNjkybC01LjY5MiA5LjY5Mmw1LjY5MiA5LjY5Mmw1LjY5Mi05LjY5MnoiLz48L3N2Zz4=',
        BUFFER: {
            URL: 'https://publish.buffer.com/compose?',
            UNIVERSAL_LINK: 'https://buffer.com/app/compose',
            POPUP_WIDTH: 600,
            POPUP_HEIGHT: 800
        },
        IMAGE: {
            MAX_DIMENSION: 1024,
            COMPRESSION_QUALITY: 0.8
        }
    };

    // 設定管理
    let settings = {
        pdsUrl: GM_getValue('bsky_pds_url', 'https://bsky.social'),
        handle: GM_getValue('bsky_handle', ''),
        password: GM_getValue('bsky_app_password', ''),
        session: GM_getValue('bsky_session', null),
        crosspostChecked: GM_getValue('bsky_crosspost_checked', false),
        bufferEnabled: GM_getValue('buffer_popup_enabled', false)
    };

    let settingsPanel = null;
    let isPosting = false;

    // ユーティリティ関数
    const getByteLength = (str) => new TextEncoder().encode(str).length;

    const parseFacets = (text) => {
        const facets = [];
        const patterns = [
            { regex: /(#[\p{L}\p{N}_]+)/gu, type: 'app.bsky.richtext.facet#tag', extract: (m) => m.substring(1) },
            { regex: /(https?:\/\/[^\s]+)/g, type: 'app.bsky.richtext.facet#link', extract: (m) => m }
        ];
        patterns.forEach(({ regex, type, extract }) => {
            let match;
            while ((match = regex.exec(text)) !== null) {
                const byteStart = getByteLength(text.substring(0, match.index));
                const byteEnd = byteStart + getByteLength(match[0]);
                facets.push({
                    index: { byteStart, byteEnd },
                    features: [{ $type: type, [type.includes('tag') ? 'tag' : 'uri']: extract(match[0]) }]
                });
            }
        });
        return facets;
    };

    // フォールバック用のリンク情報を生成
    const getFallbackLinkInfo = (url) => {
        try {
            return { title: new URL(url).hostname, description: '', imageUrl: '' };
        } catch (e) {
            return { title: 'Link', description: '', imageUrl: '' };
        }
    };

    // 画像リサイズとアスペクト比情報を返す
    const resizeImageBlob = (blob, maxDimension, quality) => {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const image = new Image();

            image.onload = () => {
                URL.revokeObjectURL(url);
                let width = image.naturalWidth;
                let height = image.naturalHeight;
                const needsResize = width > maxDimension || height > maxDimension;

                if (needsResize) {
                    if (width > height) {
                        height = Math.round((height * maxDimension) / width);
                        width = maxDimension;
                    } else {
                        width = Math.round((width * maxDimension) / height);
                        height = maxDimension;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(image, 0, 0, width, height);

                canvas.toBlob((resultBlob) => {
                    if (resultBlob) {
                        console.log(`[X-to-Bluesky] Image resized: ${image.naturalWidth}x${image.naturalHeight} -> ${width}x${height}, size: ${Math.round(resultBlob.size / 1024)}KB`);
                        resolve({ blob: resultBlob, aspectRatio: { width, height } });
                    } else {
                        console.warn('[X-to-Bluesky] Failed to create blob, using original');
                        resolve({ blob, aspectRatio: { width: image.naturalWidth, height: image.naturalHeight } });
                    }
                }, 'image/jpeg', quality);
            };

            image.onerror = (error) => {
                console.warn('[X-to-Bluesky] Failed to load image for resizing:', error);
                resolve({ blob, aspectRatio: { width: 1, height: 1 } });
            };

            const url = URL.createObjectURL(blob);
            image.src = url;
        });
    };

    // 画像のALTテキストを取得
    const getImageAltText = (img) => {
        const groupDiv = img.closest('div[role="group"][aria-label]');
        if (groupDiv) {
            const altText = groupDiv.getAttribute('aria-label');
            if (altText && altText !== '画像の説明を読む') {
                return altText;
            }
        }
        return '';
    };

    // OGPメタデータを取得
    const getMetaContent = (doc, properties) => {
        for (const prop of properties) {
            const meta = doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
            const content = meta?.getAttribute('content');
            if (content && content.trim()) {
                console.log(`[X-to-Bluesky] Found ${prop}:`, content.trim());
                return content.trim();
            }
        }
        return '';
    };

    // リンクカード情報を取得
    const fetchLinkCard = async (url) => {
        console.log('[X-to-Bluesky] Fetching link card for URL:', url);
        return new Promise((resolve) => {
            const handleError = () => resolve(getFallbackLinkInfo(url));

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 15000,
                onload: (response) => {
                    console.log('[X-to-Bluesky] Response status:', response.status);
                    try {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(response.responseText, 'text/html');

                        let title = getMetaContent(doc, ['og:title', 'twitter:title']);
                        if (!title) {
                            const titleTag = doc.querySelector('title');
                            title = titleTag?.textContent?.trim() || '';
                            console.log('[X-to-Bluesky] Title tag:', title);
                        }
                        if (!title) {
                            try {
                                title = new URL(url).hostname;
                                console.log('[X-to-Bluesky] Using hostname as title:', title);
                            } catch (e) {
                                title = 'Link';
                            }
                        }

                        let description = getMetaContent(doc, ['og:description', 'twitter:description', 'description']);
                        let imageUrl = getMetaContent(doc, ['og:image', 'twitter:image', 'twitter:image:src', 'og:image:secure_url']);

                        if (imageUrl && !imageUrl.startsWith('http')) {
                            try {
                                imageUrl = new URL(imageUrl, new URL(url).origin).href;
                                console.log('[X-to-Bluesky] Resolved image URL:', imageUrl);
                            } catch (e) {
                                console.warn('[X-to-Bluesky] Failed to resolve relative image URL:', e);
                                imageUrl = '';
                            }
                        }

                        console.log('[X-to-Bluesky] Final link card data:', { title, description, imageUrl });
                        resolve({ title, description, imageUrl });
                    } catch (error) {
                        console.error('[X-to-Bluesky] Failed to parse link card data:', error);
                        handleError();
                    }
                },
                onerror: (error) => {
                    console.error('[X-to-Bluesky] Failed to fetch link card:', error);
                    handleError();
                },
                ontimeout: () => {
                    console.warn('[X-to-Bluesky] Link card fetch timeout');
                    handleError();
                }
            });
        });
    };

    // GM_xmlhttpRequestをPromiseでラップするヘルパー関数 (削減案2)
    const gmXhrPromise = (opts, endpoint) => new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            ...opts,
            onload: (res) => {
                if (res.status >= 200 && res.status < 300) {
                    try { resolve(JSON.parse(res.responseText)); } catch { resolve(res.responseText); } 
                } else {
                    try {
                        const json = JSON.parse(res.responseText);
                        reject(new Error(json.message || `API Error: ${res.status} ${endpoint}`));
                    } catch {
                        reject(new Error(`API Error: ${res.status} ${endpoint}`));
                    }
                }
            },
            onerror: (err) => reject(new Error(`${endpoint} failed: ${err.statusText}`)),
            ontimeout: () => reject(new Error(`${endpoint} timeout`))
        });
    });

    // Bluesky API
    const bskyAPI = {
        async request(method, endpoint, data = null) {
            const opts = { method, url: `${settings.pdsUrl}/xrpc/${endpoint}`, headers: {}, timeout: 30000 };
            if (data instanceof Blob) {
                opts.data = data;
                opts.headers['Content-Type'] = data.type;
            } else if (data !== null) {
                opts.data = JSON.stringify(data);
                opts.headers['Content-Type'] = 'application/json';
            } else {
                opts.headers['Content-Type'] = 'application/json';
            }
            if (settings.session) opts.headers.Authorization = `Bearer ${settings.session.accessJwt}`;
            return gmXhrPromise(opts, endpoint);
        },

        async login() {
            const session = await this.request('POST', 'com.atproto.server.createSession', {
                identifier: settings.handle,
                password: settings.password
            });
            settings.session = session;
            GM_setValue('bsky_session', session);
            return session;
        },

        async verifySession() {
            if (!settings.session) return this.login();
            try {
                await this.request('GET', 'com.atproto.server.getSession');
                return settings.session;
            } catch (err) {
                console.warn('[X-to-Bluesky] Session expired, re-logging in.');
                return this.login();
            }
        },

        async uploadBlob(blob) {
            const res = await this.request('POST', 'com.atproto.repo.uploadBlob', blob);
            return res.blob;
        },

        async createPost(record) {
            return this.request('POST', 'com.atproto.repo.createRecord', {
                repo: settings.session.did,
                collection: 'app.bsky.feed.post',
                record
            });
        }
    };

    // 通知表示（簡略化適用）
    const showNotification = (text, isError = false) => {
        let notif = document.getElementById('bsky-notification');
        
        // 既存の通知があれば削除
        if (notif) notif.remove();

        notif = document.createElement('div');
        notif.id = 'bsky-notification';
        
        // クラスの付け替えのみに集中
        notif.className = `bsky-notification ${isError ? 'error' : 'success'}`;
        
        notif.innerHTML = `
            <div class="bsky-notification-icon"></div>
            <div class="bsky-notification-content">
                <div class="bsky-notification-title">X to Bluesky</div>
                <div class="bsky-notification-text">${text}</div>
            </div>
        `;
        document.body.appendChild(notif);

        setTimeout(() => {
            notif.classList.add('fade-out');
            setTimeout(() => notif.remove(), 500); // アニメーション後にDOMから削除
        }, 5000);
    };

    // 設定パネルのトグル
    const toggleSettings = () => {
        if (settingsPanel) {
            settingsPanel.remove();
            settingsPanel = null;
            return;
        }

        settingsPanel = document.createElement('div');
        settingsPanel.className = 'bsky-settings';
        settingsPanel.innerHTML = `
            <fieldset>
                <legend>Bluesky Settings</legend>
                <label>PDS URL:</label>
                <input type="url" name="pds" value="${settings.pdsUrl}">
                <label>Handle:</label>
                <input type="text" name="handle" placeholder="xxxx.bsky.social" value="${settings.handle}">
                <label>App Password:</label>
                <input type="password" name="password" placeholder="xxxx-xxxx-xxxx-xxxx" value="${settings.password}">
            </fieldset>
            <div class="checkbox-group">
                <input type="checkbox" id="buffer-toggle" ${settings.bufferEnabled ? 'checked' : ''}>
                <label for="buffer-toggle">Open Buffer post window</label>
            </div>
            <div class="settings-actions">
                <div class="version">${CONFIG.VERSION}</div>
                <button>Save</button>
            </div>
        `;
        document.body.appendChild(settingsPanel);

        settingsPanel.querySelector('button').onclick = () => {
            settings.pdsUrl = settingsPanel.querySelector('[name="pds"]').value || 'https://bsky.social';
            settings.handle = settingsPanel.querySelector('[name="handle"]').value;
            settings.password = settingsPanel.querySelector('[name="password"]').value;
            settings.bufferEnabled = settingsPanel.querySelector('#buffer-toggle').checked;

            GM_setValue('bsky_pds_url', settings.pdsUrl);
            GM_setValue('bsky_handle', settings.handle);
            GM_setValue('bsky_app_password', settings.password);
            GM_setValue('buffer_popup_enabled', settings.bufferEnabled);

            // ESLint警告の修正 (修正案4)
            document.querySelectorAll('.bsky-crosspost-checkbox input').forEach(el => {
                el.checked = settings.crosspostChecked;
                el.disabled = !(settings.handle && settings.password);
            });

            settingsPanel.remove();
            settingsPanel = null;
        };
    };

    // 設定アイコンを追加
    const addSettingsIcon = (parent, mobile = false) => {
        const wrapper = document.createElement('div');
        wrapper.className = mobile ? 'bsky-settings-icon-wrapper' : 'bsky-nav';
        wrapper.innerHTML = '<a title="Bluesky Settings" href="#"></a>';
        if (!mobile) parent.classList.add('bsky-navbar');
        parent.appendChild(wrapper);
        wrapper.querySelector('a').onclick = (e) => {
            e.preventDefault();
            toggleSettings();
        };
    };

    // クロスポストコントロールを追加
    const addCrosspostControls = (toolbar) => {
        toolbar.classList.add('bsky-toolbar');
        const container = toolbar.parentElement;
        const postBtn = container?.querySelector(SELECTORS.POST_BUTTON);
        
        // isDesktopのインライン化 (削減案2)
        const desktop = document.querySelector(SELECTORS.NAV_BAR) !== null;

        const checkbox = document.createElement('label');
        checkbox.className = 'bsky-crosspost-checkbox';
        checkbox.innerHTML = `
            <input type="checkbox" ${settings.crosspostChecked ? 'checked' : ''}
                   ${!(settings.handle && settings.password) ? 'disabled' : ''}>
            <span>Bluesky</span>
        `;
        checkbox.querySelector('input').onchange = (e) => {
            settings.crosspostChecked = e.target.checked;
            GM_setValue('bsky_crosspost_checked', settings.crosspostChecked);
            
            // ESLint警告の修正 (修正案4)
            document.querySelectorAll('.bsky-crosspost-checkbox input').forEach(el => {
                el.checked = settings.crosspostChecked;
            });
        };

        const controls = document.createElement('div');
        controls.className = 'bsky-controls-container';

        if (!desktop) {
            const icon = document.createElement('div');
            icon.className = 'bsky-settings-icon-wrapper';
            icon.innerHTML = '<a title="Bluesky Settings" href="#"></a>';
            icon.querySelector('a').onclick = (e) => {
                e.preventDefault();
                toggleSettings();
            };
            controls.appendChild(icon);
        }

        controls.appendChild(checkbox);

        if (postBtn) {
            postBtn.parentElement.insertBefore(controls, postBtn);
        } else {
            if (!desktop) addSettingsIcon(toolbar, true);
            toolbar.appendChild(checkbox);
        }
    };

    // Buffer起動
    const openBuffer = () => {
        // isIPhoneとisDesktopのロジックをインライン化し、モバイル/デスクトップを判定 (削減案2)
        const isMobile = ((/iPhone/i.test(navigator.userAgent) || /iPod/i.test(navigator.userAgent)) && !/iPad/i.test(navigator.userAgent)) || document.querySelector(SELECTORS.NAV_BAR) === null;

        if (isMobile) {
            console.log('[X-to-Bluesky] Opening Buffer via Universal Link');
            window.location.href = CONFIG.BUFFER.UNIVERSAL_LINK;
        } else {
            console.log('[X-to-Bluesky] Opening Buffer popup for desktop');
            const w = window.innerWidth, h = window.innerHeight;
            const x = (window.screenX || window.screenLeft) + (w - CONFIG.BUFFER.POPUP_WIDTH) / 2;
            const y = (window.screenY || window.screenTop) + (h - CONFIG.BUFFER.POPUP_HEIGHT) / 2;
            window.open(CONFIG.BUFFER.URL, '_blank', `width=${CONFIG.BUFFER.POPUP_WIDTH},height=${CONFIG.BUFFER.POPUP_HEIGHT},left=${x},top=${y}`);
        }
    };

    // 投稿処理
    const handlePost = async (e) => {
        const isSideNav = e.target.closest(SELECTORS.SIDE_NAV_POST_BUTTON);

        console.log('[X-to-Bluesky] Button clicked - UA:', navigator.userAgent);

        // Buffer機能（サイドナビ/FABボタン）
        if (isSideNav && settings.bufferEnabled) {
            console.log('[X-to-Bluesky] Opening Buffer...');
            e.stopPropagation();
            e.preventDefault();
            e.stopImmediatePropagation();
            openBuffer();
            return;
        }

        // Buffer無効時はサイドナビボタンは標準動作
        if (isSideNav) {
            console.log('[X-to-Bluesky] SideNav button - standard behavior');
            return;
        }

        // Blueskyクロスポスト処理
        console.log('[X-to-Bluesky] Checking for Bluesky crosspost...');
        if (!settings.crosspostChecked || !settings.handle || !settings.password || isPosting) return;

        e.stopPropagation();
        e.preventDefault();
        e.stopImmediatePropagation();

        isPosting = true;
        const btn = e.currentTarget;
        const originalHTML = btn.innerHTML;

        try {
            btn.disabled = true;
            btn.innerHTML = '<span class="bsky-post-status-text">Posting to Bluesky...</span>';

            await bskyAPI.verifySession();

            const textarea = document.querySelector(SELECTORS.TEXT_AREA);
            const quoteLink = document.querySelector(SELECTORS.QUOTE_LINK);
            let text = textarea?.innerText || '';

            const record = {
                $type: 'app.bsky.feed.post',
                text,
                createdAt: new Date().toISOString(),
                facets: parseFacets(text)
            };

            // 画像添付処理
            const attachments = document.querySelectorAll(SELECTORS.ATTACHMENTS);
            const videos = document.querySelectorAll(SELECTORS.VIDEO_ATTACHMENTS);

            if (attachments.length > 0) {
                const images = [];
                for (const img of attachments) {
                    try {
                        const response = await fetch(img.src);
                        const blob = await response.blob();
                        console.log('[X-to-Bluesky] Resizing image for upload limit...');
                        const resizedResult = await resizeImageBlob(blob, CONFIG.IMAGE.MAX_DIMENSION, CONFIG.IMAGE.COMPRESSION_QUALITY);
                        const uploaded = await bskyAPI.uploadBlob(resizedResult.blob);
                        const altText = getImageAltText(img);
                        console.log('[X-to-Bluesky] ALT text:', altText || '(none)');
                        images.push({
                            alt: altText,
                            image: uploaded,
                            aspectRatio: resizedResult.aspectRatio
                        });
                        console.log('[X-to-Bluesky] Image uploaded successfully after resize.');
                    } catch (err) {
                        console.error('Failed to upload image:', err);
                        const errorMessage = err.message.includes('file too large') ?
                                             'Upload failed: File size too large (max ~1MB).' : err.message;
                        showNotification(`Image upload failed: ${errorMessage}. Skipping image.`, true);
                    }
                }
                if (images.length > 0) {
                    record.embed = { $type: 'app.bsky.embed.images', images };
                }
            } else if (videos.length > 0) {
                // 動画添付処理（最初の1つのみ）
                try {
                    const video = videos[0];
                    const response = await fetch(video.src);
                    const blob = await response.blob();
                    const uploaded = await bskyAPI.uploadBlob(blob);
                    record.embed = { $type: 'app.bsky.embed.video', video: uploaded };
                    console.log('[X-to-Bluesky] Video uploaded successfully.');
                } catch (err) {
                    console.error('Failed to upload video:', err);
                    const errorMessage = err.message.includes('file too large') ?
                                         'Upload failed: Video size too large (max ~1MB).' : err.message;
                    showNotification(`Video upload failed: ${errorMessage}. Skipping video.`, true);
                }
            } else {
                // リンクカード処理
                const urlRegex = /(https?:\/\/[^\s]+)/g;
                const urls = text.match(urlRegex);

                if (urls && urls.length > 0) {
                    const url = urls[0];
                    console.log('[X-to-Bluesky] Found URL in text:', url);

                    try {
                        const cardData = await fetchLinkCard(url);
                        console.log('[X-to-Bluesky] Card data received:', cardData);

                        if (cardData && cardData.title) {
                            const external = {
                                uri: url,
                                title: cardData.title.substring(0, 300),
                                description: cardData.description.substring(0, 1000)
                            };

                            // サムネイル画像のアップロード
                            if (cardData.imageUrl) {
                                try {
                                    console.log('[X-to-Bluesky] Uploading thumbnail:', cardData.imageUrl);
                                    const imgResponse = await fetch(cardData.imageUrl);
                                    if (imgResponse.ok) {
                                        const imgBlob = await imgResponse.blob();
                                        console.log('[X-to-Bluesky] Resizing thumbnail image...');
                                        const resizedThumbResult = await resizeImageBlob(imgBlob, 600, 0.7);
                                        const thumbBlob = await bskyAPI.uploadBlob(resizedThumbResult.blob);
                                        external.thumb = thumbBlob;
                                        console.log('[X-to-Bluesky] Thumbnail uploaded successfully after resize');
                                    } else {
                                        console.warn('[X-to-Bluesky] Failed to fetch thumbnail, status:', imgResponse.status);
                                    }
                                } catch (err) {
                                    console.warn('[X-to-Bluesky] Failed to upload thumbnail:', err);
                                }
                            }

                            record.embed = { $type: 'app.bsky.embed.external', external };
                            console.log('[X-to-Bluesky] Link card embed created successfully:', record.embed);
                        } else {
                            console.warn('[X-to-Bluesky] No title found, skipping link card');
                        }
                    } catch (err) {
                        console.error('[X-to-Bluesky] Failed to create link card:', err);
                    }
                }
            }

            // 引用投稿処理
            if (quoteLink?.href) {
                text += `\n${quoteLink.href}`;
                record.text = text;
                record.facets = parseFacets(text);
            }

            await bskyAPI.createPost(record);
            showNotification('Post successfully crossposted to Bluesky.');
        } catch (error) {
            console.error('Crosspost failed:', error);
            const errorMessage = error.message.includes('file too large') ?
                                 'Upload failed: File size too large (max ~1MB).' : error.message;
            showNotification(`Failed: ${errorMessage}`, true);
        } finally {
            btn.innerHTML = originalHTML;
            btn.disabled = false;
            btn.click();
            isPosting = false;
        }
    };

    // DOM監視（スロットリング付き）
    let observerTimeout;
    const observer = new MutationObserver(() => {
        clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => {
            const navbar = document.querySelector(SELECTORS.BSKY_NAV);
            if (navbar && !navbar.querySelector('.bsky-nav')) addSettingsIcon(navbar);

            document.querySelectorAll(SELECTORS.POST_TOOLBAR).forEach(toolbar => {
                if (!toolbar.querySelector('.bsky-crosspost-checkbox')) addCrosspostControls(toolbar);
            });

            document.querySelectorAll(SELECTORS.POST_BUTTON).forEach(btn => {
                if (!btn.hasAttribute('data-bsky-listener')) {
                    btn.addEventListener('click', handlePost, true);
                    btn.setAttribute('data-bsky-listener', 'true');
                }
            });

            document.querySelectorAll(SELECTORS.SIDE_NAV_POST_BUTTON).forEach(btn => {
                if (!btn.hasAttribute('data-bsky-listener')) {
                    btn.addEventListener('click', handlePost, true);
                    btn.setAttribute('data-bsky-listener', 'true');
                }
            });
        }, 100);
    });

    // スタイル定義（共通化と整理 - 削減案3）
    const ICON_SVG = CONFIG.ICON_SVG;

GM_addStyle(`
.bsky-nav {
    padding: 12px;
    cursor: pointer;
}
/* アイコンの共通設定 */
.bsky-nav a,
.bsky-settings-icon-wrapper a,
.bsky-notification-icon {
    background: url(${ICON_SVG}) no-repeat center/cover;
    display: block;
}
.bsky-nav a {
    width: 1.75rem;
    height: 1.75rem;
}
.bsky-settings-icon-wrapper {
    display: inline-block;
    margin-right: 12px;
}
.bsky-settings-icon-wrapper a {
    width: 28px;
    height: 28px;
    border-radius: 50%;
}
.bsky-controls-container {
    display: flex;
    align-items: center;
    flex-grow: 1;
    order: -1;
}
.bsky-crosspost-checkbox {
    display: inline-flex;
    align-items: center;
    margin-right: 12px;
}
.bsky-crosspost-checkbox input {
    margin-right: 4px;
    cursor: pointer;
}
.bsky-crosspost-checkbox span {
    font: 14px system-ui;
    cursor: pointer;
}
.bsky-crosspost-checkbox input:disabled + span {
    color: #888;
    cursor: default;
}
.bsky-post-status-text {
    font: 12px system-ui;
    display: block;
    line-height: 38px;
    text-align: center;
    color: #fff !important;
}
.bsky-notification {
    position: fixed;
    top: 12px;
    right: 50%;
    transform: translateX(50%);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: rgb(29, 155, 240);
    color: #fff;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    font-family: system-ui;
    max-width: 320px;
    width: 90%;
    z-index: 99999;
    transition: opacity 0.5s, transform 0.5s;
}
.bsky-notification.error {
    background: rgb(244, 33, 46);
}
.bsky-notification.fade-out {
    opacity: 0;
    transform: translateX(50%) translateY(-100%);
}
.bsky-notification-icon {
    width: 20px;
    height: 20px;
    filter: brightness(0) invert(1);
}
.bsky-notification-content {
    line-height: 1.3;
}
.bsky-notification-title {
    font-weight: 700;
    font-size: 14px;
}
.bsky-notification-text {
    font-size: 13px;
}
.bsky-settings {
    position: fixed;
    width: 300px;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #fff;
    padding: 15px;
    border: 2px solid #0085ff;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    font: 14px system-ui;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.bsky-settings fieldset {
    border: 1px solid #ccc;
    padding: 10px;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.bsky-settings legend {
    font-weight: 700;
    padding: 0 5px;
}
.bsky-settings label {
    font-weight: 500;
}
.bsky-settings input[type="text"],
.bsky-settings input[type="url"],
.bsky-settings input[type="password"] {
    width: 100%;
    padding: 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-sizing: border-box;
}
.bsky-settings .settings-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.bsky-settings button {
    padding: 8px 16px;
    border: none;
    background: #1d9bf0;
    color: #fff;
    border-radius: 9999px;
    font-weight: 700;
    cursor: pointer;
}
.bsky-settings button:hover {
    background: #1a8cd8;
}
.bsky-settings .version {
    font-size: 12px;
    color: #888;
}
.bsky-settings .checkbox-group {
    display: flex;
    align-items: center;
    gap: 8px;
}
@media (min-width: 1280px) {
    .bsky-nav a:after {
        content: "Crosspost";
        margin-left: 46px;
        color: rgb(15, 20, 25);
        font-family: system-ui;
    }
    .bsky-controls-container {
        justify-content: flex-end;
    }
}
@media (min-width: 501px) {
    .bsky-notification {
        width: 500px;
        max-width: 500px;
    }
}
@media (prefers-color-scheme: dark) {
    .bsky-nav a:after {
        color: rgb(247, 249, 249);
    }
    .bsky-settings {
        background: #000;
        color: #fff;
        border-color: #0055aa;
    }
    .bsky-settings fieldset {
        border-color: #444;
    }
    .bsky-settings input {
        background: #333;
        border-color: #555;
        color: #fff;
    }
}
`);

    observer.observe(document.body, { childList: true, subtree: true });
})();
