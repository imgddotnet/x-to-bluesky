// ==UserScript==
// @name         x-to-bluesky
// @version      0.1
// @description  Crosspost from X (formerly Twitter) to Bluesky.
// @author       imgddotnet (Refactored by Gemini)
// @license      MIT
// @namespace    imgddotnet
// @match        https://twitter.com/*
// @match        https://x.com/*
// @icon         data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KICA8Y2lyY2xlIGN4PSIzMiIgY3k9IjMyIiByPSIzMiIgZmlsbD0iIzAwOEZGQyIvPgogIDxwYXRoIGQ9Ik00Ny45MSAzNC41NWMwLTcuMDUtNS43LTMwLjgyLTI3LjEzLTI0LjA5QzYuMzYgMTYuMTMgMCAzMC40NCAwIDM4LjY2YzAgOC4wOCAzLjY2IDE1LjIgMTIuMzcgMTUuMiAxMC43NSAwIDE0LjE1LTYuMiAxNi44LTkuNzUgNC4zNy01Ljg0IDYuMDgtMTkuOTUgMTguNzQtMTkuOTVjNS45MiAwIDQuMjkgMi44MiA0LjI5IDYuNDd6IiBmaWxsPSIjZmZmZmZmIi8+Cjwvc3ZnPg==
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_openInTab
// @run-at       document-end
// @inject-into  page
// ==/UserScript==

(function() {
    'use strict';

    const state = {
        settings: {
            pdsUrl: GM_getValue('bsky_pds_url', 'https://bsky.social'),
            handle: GM_getValue('bsky_handle', ''),
            appPassword: GM_getValue('bsky_app_password', ''),
            crosspostChecked: GM_getValue('bsky_crosspost_checked', false)
        },
        session: GM_getValue('bsky_session', null),
        isPosting: false
    };

    const selectors = {
        POST_BUTTON: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
        TEXTAREA: '[data-testid="tweetTextarea_0"]',
        QUOTE_POST_LINK: '[data-testid="tweetEditor"] [data-testid^="card.layout"] a[href*="/status/"]',
        FILE_INPUT: 'input[type="file"][data-testid="fileInput"]'
    };

    const BskyClient = {
        async _request(method, endpoint, headers = {}, data = null) {
            const url = `${state.settings.pdsUrl}/xrpc/${endpoint}`;
            const reqHeaders = { ...headers };
            
            if (state.session && state.session.accessJwt) {
                reqHeaders['Authorization'] = `Bearer ${state.session.accessJwt}`;
            }

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method,
                    url,
                    headers: reqHeaders,
                    data,
                    onload: (response) => {
                        const res = JSON.parse(response.responseText);
                        if (response.status >= 200 && response.status < 300) {
                            resolve(res);
                        } else {
                            reject(new Error(res.message || `API error: ${response.status}`));
                        }
                    },
                    onerror: (err) => reject(new Error('Network or API request failed')),
                    ontimeout: () => reject(new Error('Request timed out'))
                });
            });
        },

        async login() {
            const data = JSON.stringify({ identifier: state.settings.handle, password: state.settings.appPassword });
            const session = await this._request('POST', 'com.atproto.server.createSession', { 'Content-Type': 'application/json' }, data);
            state.session = session;
            GM_setValue('bsky_session', state.session);
            return session;
        },

        async verifySession() {
            try {
                if (state.session) {
                    await this._request('GET', 'com.atproto.server.getSession');
                    return state.session;
                }
            } catch (error) {
                console.error('Session verification failed, attempting re-login:', error);
            }
            return this.login();
        },

        async uploadImage(file) {
            await this.verifySession();
            const formData = new FormData();
            formData.append('blob', file);
            const res = await this._request('POST', 'com.atproto.repo.uploadBlob', { 'Authorization': `Bearer ${state.session.accessJwt}` }, formData);
            return res;
        },

        async createPost(record) {
            await this.verifySession();
            const data = JSON.stringify({ repo: state.session.did, collection: 'app.bsky.feed.post', record: record });
            const res = await this._request('POST', 'com.atproto.repo.createRecord', { 'Content-Type': 'application/json' }, data);
            return res;
        }
    };

    const createPostRecord = (text, images) => {
        const record = {
            '$type': 'app.bsky.feed.post',
            text: text,
            createdAt: new Date().toISOString(),
            facets: []
        };
        const encoder = new TextEncoder();
        
        text.replace(/(#[\p{L}\p{N}_]+)/gu, (match, hashtag, index) => {
            const byteStart = encoder.encode(text.substring(0, index)).length;
            const byteEnd = byteStart + encoder.encode(hashtag).length;
            record.facets.push({
                index: { byteStart, byteEnd },
                features: [{ '$type': 'app.bsky.richtext.facet#tag', tag: hashtag.substring(1) }]
            });
        });

        text.replace(/(https?:\/\/[^\s]+)/g, (match, url, index) => {
            const byteStart = encoder.encode(text.substring(0, index)).length;
            const byteEnd = byteStart + encoder.encode(url).length;
            record.facets.push({
                index: { byteStart, byteEnd },
                features: [{ '$type': 'app.bsky.richtext.facet#link', uri: url }]
            });
        });

        if (images.length > 0) {
            record.embed = { '$type': 'app.bsky.embed.images', images: images };
        }
        return record;
    };

    const handlePost = async (e) => {
        if (e.isScriptGenerated || state.isPosting || !state.settings.crosspostChecked || !state.settings.handle || !state.settings.appPassword) {
            return;
        }

        e.stopPropagation();
        e.preventDefault();

        state.isPosting = true;
        const postButton = e.currentTarget;
        const originalButtonContent = postButton.innerHTML;
        
        postButton.disabled = true;
        postButton.style.opacity = '0.5';

        try {
            const files = document.querySelector(selectors.FILE_INPUT)?.files;
            const uploadedImages = [];

            if (files && files.length > 0) {
                postButton.innerHTML = `<span>Uploading to Bluesky...</span>`;
                const uploadPromises = Array.from(files).map(file => BskyClient.uploadImage(file));
                const uploadedResults = await Promise.all(uploadPromises);
                
                uploadedResults.forEach(uploaded => {
                    uploadedImages.push({ alt: '', image: uploaded.blob.ref });
                });
                
                GM_notification('Image upload to Bluesky complete.', 'X to Bluesky');
            }

            postButton.innerHTML = `<span>Crossposting...</span>`;
            const postText = document.querySelector(selectors.TEXTAREA)?.innerText || '';
            const quotePostLink = document.querySelector(selectors.QUOTE_POST_LINK)?.href;
            const finalPostText = quotePostLink ? `${postText}\n${quotePostLink}` : postText;
            const record = createPostRecord(finalPostText, uploadedImages);
            await BskyClient.createPost(record);
            GM_notification('Successfully crossposted to Bluesky.', 'X to Bluesky');
        } catch (error) {
            console.error('Blueskyへのクロスポストに失敗しました:', error);
            GM_notification(`Crossposting to Bluesky failed: ${error.message}`, 'X to Bluesky');
        } finally {
            state.isPosting = false;
            postButton.disabled = false;
            postButton.style.opacity = '1';
            postButton.innerHTML = originalButtonContent;
            
            const newEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            newEvent.isScriptGenerated = true;
            setTimeout(() => postButton.dispatchEvent(newEvent), 100);
        }
    };

    const createSettingsPanel = (buttonRect) => {
        if (state.settingsPanel) {
            state.settingsPanel.remove();
        }

        const panel = document.createElement('div');
        panel.className = 'bsky-settings';
        panel.innerHTML = `
            <fieldset>
                <legend>Bluesky Integration Settings (v0.60)</legend>
                <label for="bsky_pds_url">PDS URL:</label>
                <input type="url" name="bsky_pds_url" placeholder="https://bsky.social" value="${state.settings.pdsUrl}">
                <label for="bsky_handle">Handle:</label>
                <input type="text" name="bsky_handle" placeholder="xxxx.bsky.social" autocomplete="section-bsky username" value="${state.settings.handle}">
                <label for="bsky_app_password">App Password:</label>
                <input type="password" name="bsky_app_password" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="section-bsky current-password" value="${state.settings.appPassword}">
                <label class="bsky-crosspost-checkbox">
                    <input type="checkbox" name="crosspost_toggle">
                    <span>Crosspost to Bluesky</span>
                </label>
            </fieldset>
            <button>Save</button>
        `;
        
        const crosspostCheckbox = panel.querySelector('[name="crosspost_toggle"]');
        crosspostCheckbox.checked = state.settings.crosspostChecked;
        crosspostCheckbox.disabled = !state.settings.handle || !state.settings.appPassword;

        crosspostCheckbox.addEventListener('change', () => {
            state.settings.crosspostChecked = crosspostCheckbox.checked;
            GM_setValue('bsky_crosspost_checked', state.settings.crosspostChecked);
        });

        panel.querySelector('button').addEventListener('click', () => {
            state.settings.pdsUrl = panel.querySelector('[name="bsky_pds_url"]').value || 'https://bsky.social';
            state.settings.handle = panel.querySelector('[name="bsky_handle"]').value;
            state.settings.appPassword = panel.querySelector('[name="bsky_app_password"]').value;
            
            GM_setValue('bsky_pds_url', state.settings.pdsUrl);
            GM_setValue('bsky_handle', state.settings.handle);
            GM_setValue('bsky_app_password', state.settings.appPassword);

            crosspostCheckbox.disabled = !state.settings.handle || !state.settings.appPassword;
            panel.style.display = 'none';
        });

        document.body.appendChild(panel);
        state.settingsPanel = panel;

        const panelHeight = state.settingsPanel.offsetHeight;
        const windowHeight = window.innerHeight;
        let top = buttonRect.bottom + 5;
        if (top + panelHeight > windowHeight && buttonRect.top > panelHeight) {
            top = buttonRect.top - panelHeight - 5;
        }
        
        state.settingsPanel.style.top = `${top}px`;
        state.settingsPanel.style.left = `${buttonRect.left}px`;
        state.settingsPanel.style.display = 'block';
    };

    const addCustomUI = (postButton) => {
        const parent = postButton.parentElement;
        if (!parent || parent.querySelector('.bsky-toggle-button')) return;

        const toggleButton = document.createElement('div');
        toggleButton.className = 'bsky-toggle-button';
        toggleButton.title = 'Open Bluesky settings';
        toggleButton.innerHTML = `
            <a href="#">
                <svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="32" cy="32" r="32" fill="#008FFC"/>
                    <path d="M47.91 34.55c0-7.05-5.7-30.82-27.13-24.09C6.36 16.13 0 30.44 0 38.66c0 8.08 3.66 15.2 12.37 15.2 10.75 0 14.15-6.2 16.8-9.75 4.37-5.84 6.08-19.95 18.74-19.95c5.92 0 4.29 2.82 4.29 6.47z" fill="#ffffff"/>
                </svg>
            </a>
        `;
        
        toggleButton.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            const rect = toggleButton.getBoundingClientRect();
            createSettingsPanel(rect);
        });

        parent.insertBefore(toggleButton, postButton);
        parent.style.display = 'flex';
        parent.style.alignItems = 'center';
        parent.style.justifyContent = 'flex-end';
        postButton.addEventListener('click', handlePost, true);
    };

    function enforceImageLimit() {
        const fileInput = document.querySelector(selectors.FILE_INPUT);
        if (!fileInput) return;

        fileInput.addEventListener('change', (e) => {
            const currentCount = e.target.files.length;
            const attachedCount = document.querySelectorAll('[data-testid="attachments"] img').length;
            const total = currentCount + attachedCount;

            if (total > 4) {
                alert('Blueskyへのクロスポストは画像4枚までです。\n選択枚数を減らしてください。');
                e.target.value = '';
            }
        });
    }

    const init = () => {
        GM_addStyle(`
            .bsky-toggle-button a {
                width: 2.25rem;
                height: 2.25rem;
                display: block;
                margin-right: 8px;
                cursor: pointer;
            }
            .bsky-toggle-button svg {
                width: 100%;
                height: 100%;
                display: block;
            }
            .bsky-settings {
                position: fixed;
                width: 300px;
                padding: 15px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                z-index: 9999;
                display: none;
                flex-direction: column;
                gap: 10px;
                background: #fff;
                border: 2px solid #0085FF;
            }
            @media (prefers-color-scheme: dark) {
                .bsky-settings {
                    background-color: #1a202c !important;
                    color: #f7fafc !important;
                    border-color: #4a5568 !important;
                }
                .bsky-settings fieldset {
                    border-color: #4a5568 !important;
                }
                .bsky-settings legend {
                    color: #cbd5e0 !important;
                }
                .bsky-settings label {
                    color: #e2e8f0 !important;
                }
                .bsky-settings input[type="text"], .bsky-settings input[type="url"], .bsky-settings input[type="password"] {
                    background-color: #2d3748 !important;
                    color: #f7fafc !important;
                    border-color: #4a5568 !important;
                }
                .bsky-settings button {
                    background-color: #1a8cd8 !important;
                }
            }
            .bsky-settings fieldset { border: 1px solid #ccc; padding: 10px; border-radius: 4px; display: flex; flex-direction: column; gap: 8px;}
            .bsky-settings legend { font-weight: bold; padding: 0 5px; }
            .bsky-settings label { font-weight: 500; }
            .bsky-settings input[type="text"], .bsky-settings input[type="url"], .bsky-settings input[type="password"] {
                width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;
            }
            .bsky-settings button {
                align-self: flex-end; padding: 8px 16px; border: none; background-color: #1d9bf0; color: white;
                border-radius: 9999px; font-weight: bold; cursor: pointer;
            }
            .bsky-settings button:hover { background-color: #1a8cd8; }
            .bsky-crosspost-checkbox { display: inline-flex; align-items: center; cursor: pointer; }
            .bsky-crosspost-checkbox input { margin-right: 4px; cursor: pointer; }
            .bsky-crosspost-checkbox input:disabled + span { color: #888; cursor: default; }
        `);
        
        const observer = new MutationObserver((mutations) => {
            const postButton = document.querySelector(selectors.POST_BUTTON);
            if (postButton && !postButton.hasAttribute('data-bsky-added')) {
                addCustomUI(postButton);
                postButton.setAttribute('data-bsky-added', 'true');
            }
            const fileInput = document.querySelector(selectors.FILE_INPUT);
            if (fileInput && !fileInput.hasAttribute('data-bsky-limit-enforced')) {
                enforceImageLimit();
                fileInput.setAttribute('data-bsky-limit-enforced', 'true');
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    };

    init();
})();
