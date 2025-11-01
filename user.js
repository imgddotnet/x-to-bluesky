// ==UserScript==
// @name         x-to-bluesky
// @version      1.0b
// @description  Crosspost from X (formerly Twitter) to Bluesky with enhancements, and an option for Buffer popups.
// @author       imgddotnet (Modified by Gemini)
// @license      MIT
// @namespace    imgddotnet
// @match        htt*://*x.com/*
// @match        htt*://*twitter.com/*
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzEwNTRGRiIgZD0iTTEyIDEuNjkybC01LjY5MiA5LjY5Mmw1LjY5MiA5LjY5Mmw1LjY5Mi05LjY5MnoiLz48L3N2Zz4=
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_openInTab
// @connect      bsky.social
// @connect      http*://*bsky.social*
// @connect      *
// @run-at       document-end
// @inject-into  page
// ==/UserScript==

(function() {
    'use strict';

    // --- セレクタの統合 (短縮: S) ---
    const S = {
        NAV_BAR: 'header nav[role="navigation"]',
        BSKY_NAV: 'header nav[role="navigation"]:not(.bsky-navbar)',
        POST_TOOLBAR: 'div[data-testid="toolBar"]:not(.bsky-toolbar)',
        POST_BUTTON: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
        SIDE_NAV_POST_BUTTON: '[data-testid="SideNav_NewTweet_Button"]',
        TEXT_AREA: '[data-testid="tweetTextarea_0"]',
        ATTACHMENTS: 'div[data-testid="attachments"] img',
        QUOTE_LINK: '[data-testid="tweetEditor"] [data-testid^="card.layout"] a[href*="/status/"]',
        COMPOSE_AREA: 'div[data-testid="tweetEditor"]',
    };

    // --- 定数 (短縮) ---
    const BUF_URL = 'https://publish.buffer.com/compose?';
    const P_W = 600; // POPUP_WIDTH
    const P_H = 800; // POPUP_HEIGHT
    const VER = 'v1.0r'; // SCRIPT_VERSION
    const B_ICO = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iIzEwNTRGRiIgZD0iTTEyIDEuNjkybC01LjY5MiA5LjY5Mmw1LjY5MiA5LjY5Mmw1LjY5Mi05LjY5MnoiLz48L3N2Zz4='; // BSKY_ICON_DATA_URI

    // --- グローバル変数 (短縮) ---
    let pds = GM_getValue('bsky_pds_url', 'https://bsky.social'); // bsky_pds_url
    let hndl = GM_getValue('bsky_handle', ''); // bsky_handle
    let pwd = GM_getValue('bsky_app_password', ''); // bsky_app_password
    let ses = GM_getValue('bsky_session', null); // bsky_session
    let cpEna = Boolean(hndl && pwd); // crosspost_enabled
    let cpChk = GM_getValue('bsky_crosspost_checked', false); // bsky_crosspost_checked
    let bufEna = GM_getValue('buffer_popup_enabled', false); // buffer_popup_enabled
    let sDiv = null; // settings_div
    let isPst = false; // isPosting

    // --- テキスト/バイト計算ユーティリティ (短縮: TU) ---
    const TU = {
        encoder: new TextEncoder(),

        getByteLength(str) {
            return this.encoder.encode(str).length;
        },

        parseFacets(postText) {
            const facets = [];
            const hashtagRegex = /(#[\p{L}\p{N}_]+)/gu;
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            let match;

            while ((match = hashtagRegex.exec(postText)) !== null) {
                const hashtag = match[0];
                const byteStart = TU.getByteLength(postText.substring(0, match.index));
                const byteEnd = byteStart + TU.getByteLength(hashtag);
                facets.push({
                    'index': { 'byteStart': byteStart, 'byteEnd': byteEnd },
                    'features': [{ '$type': 'app.bsky.richtext.facet#tag', 'tag': hashtag.substring(1) }]
                });
            }

            while ((match = urlRegex.exec(postText)) !== null) {
                const url = match[0];
                const byteStart = TU.getByteLength(postText.substring(0, match.index));
                const byteEnd = byteStart + TU.getByteLength(url);
                facets.push({
                    'index': { 'byteStart': byteStart, 'byteEnd': byteEnd },
                    'features': [{ '$type': 'app.bsky.richtext.facet#link', 'uri': url }]
                });
            }

            return facets;
        }
    };


    /**
     * Bluesky API Client Class (短縮: BC)
     */
    class BC {
        constructor() {
            this.pdsUrl = GM_getValue('bsky_pds_url', 'https://bsky.social');
            this.handle = GM_getValue('bsky_handle', '');
            this.appPassword = GM_getValue('bsky_app_password', '');
            this.session = GM_getValue('bsky_session', null);
        }

        async login() {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${this.pdsUrl}/xrpc/com.atproto.server.createSession`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ identifier: this.handle, password: this.appPassword }),
                    onload: (response) => {
                        const session = JSON.parse(response.responseText);
                        if (session.error) {
                            reject(new Error(session.message));
                        } else {
                            this.session = session;
                            GM_setValue('bsky_session', this.session);
                            resolve(session);
                        }
                    },
                    onerror: (err) => reject(new Error('Login failed: ' + err.statusText))
                });
            });
        }

        async verifySession() {
            if (!this.session) {
                console.log('No session found. Attempting to log in...');
                return this.login();
            }

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `${this.pdsUrl}/xrpc/com.atproto.server.getSession`,
                    headers: { 'Authorization': `Bearer ${this.session.accessJwt}` },
                    onload: async (response) => {
                        const res = JSON.parse(response.responseText);
                        if (!res.error) {
                            console.log('Session is valid.');
                            resolve(this.session);
                        } else if (res.error === 'ExpiredToken' || res.error === 'InvalidToken') {
                            console.log('Session expired. Attempting to re-login...');
                            try {
                                const newSession = await this.login();
                                resolve(newSession);
                            } catch (loginError) {
                                reject(loginError);
                            }
                        } else {
                            reject(new Error(res.message));
                        }
                    },
                    onerror: (err) => reject(new Error('Session verification failed: ' + err.statusText))
                });
            });
        }

        async uploadImage(blob) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${this.pdsUrl}/xrpc/com.atproto.repo.uploadBlob`,
                    headers: {
                        'Content-Type': blob.type,
                        'Authorization': `Bearer ${this.session.accessJwt}`
                    },
                    data: blob,
                    onload: (response) => {
                        const res = JSON.parse(response.responseText);
                        if (res.error) {
                            reject(new Error(res.message));
                        } else {
                            resolve(res.blob);
                        }
                    },
                    onerror: (err) => reject(new Error('Image upload failed: ' + err.statusText))
                });
            });
        }

        async createPost(record) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${this.pdsUrl}/xrpc/com.atproto.repo.createRecord`,
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.session.accessJwt}`
                    },
                    data: JSON.stringify({ repo: this.session.did, collection: 'app.bsky.feed.post', record: record }),
                    onload: (response) => {
                        const res = JSON.parse(response.responseText);
                        if (res.error) {
                            reject(new Error(res.message));
                        } else {
                            resolve(res);
                        }
                    },
                    onerror: (err) => reject(new Error('Post creation failed: ' + err.statusText))
                });
            });
        }
    }

    const bC = new BC(); // bskyClient

    const getBlobFromUrl = async (url) => {
        const response = await fetch(url);
        return await response.blob();
    };

    /**
     * Blueskyアイコン付きのカスタム通知をDOM内に表示する関数
     */
    const showCustomNotification = (text, isError = false) => {
        const notificationId = 'bsky-custom-notification';
        const existingNotif = document.getElementById(notificationId);
        if (existingNotif) {
            existingNotif.remove();
        }

        const notif = document.createElement('div');
        notif.id = notificationId;
        notif.className = 'bsky-notification' + (isError ? ' error' : ' success');
        notif.innerHTML = `
            <div class="bsky-notification-icon"></div>
            <div class="bsky-notification-content">
                <div class="bsky-notification-title">X to Bluesky</div>
                <div class="bsky-notification-text">${text}</div>
            </div>
        `;
        document.body.appendChild(notif);

        // 3秒後に通知をフェードアウトさせて削除
        setTimeout(() => {
            notif.classList.add('fade-out');
            setTimeout(() => {
                if (notif.parentElement) {
                    notif.remove();
                }
            }, 500);
        }, 3000);
    };


    const observer = new MutationObserver(() => {
        // Mac/iPadなどのデスクトップ版では、左側ナビゲーションバーにアイコンを追加
        const navbar = document.querySelector(S.BSKY_NAV);
        if (navbar && !navbar.querySelector('.bsky-nav')) {
            addSettingsIconToNav(navbar);
        }

        // 投稿ツールバーにアイコンとチェックボックスを追加
        const toolbars = document.querySelectorAll(S.POST_TOOLBAR);
        for (const toolbar of toolbars) {
            // 既にコントロールが追加されていないことを確認
            if (!toolbar.parentElement.querySelector('.bsky-crosspost-checkbox') && !toolbar.querySelector('.bsky-crosspost-checkbox')) {
                addCrosspostControlsToToolbar(toolbar);
            }
        }

        const postButtons = document.querySelectorAll(S.POST_BUTTON + ', ' + S.SIDE_NAV_POST_BUTTON);
        for(const button of postButtons) {
            if (!button.hasAttribute('data-bsky-listener')) {
                button.addEventListener('click', handlePost, true);
                button.setAttribute('data-bsky-listener', 'true');
            }
        }
    });

    /**
     * 左側ナビゲーションバーに設定アイコンを追加
     */
    const addSettingsIconToNav = (nav) => {
        const div = document.createElement('div');
        div.className = 'bsky-nav';
        div.innerHTML = `<a title="Bluesky Settings" href="#"></a>`;
        nav.classList.add('bsky-navbar');
        nav.appendChild(div);
        div.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            toggleSettingsPanel();
        });
    };

    /**
     * 投稿ツールバーに設定アイコンとチェックボックスを追加
     */
    const addCrosspostControlsToToolbar = (toolbar) => {
        toolbar.classList.add('bsky-toolbar');
        const actionsContainer = toolbar.parentElement;
        const postButton = actionsContainer ? actionsContainer.querySelector(S.POST_BUTTON) : null;

        // デスクトップUIかモバイルUIかを判断
        const isDesktop = document.querySelector(S.NAV_BAR) !== null;

        // チェックボックスを作成
        const checkboxLabel = document.createElement('label');
        checkboxLabel.className = 'bsky-crosspost-checkbox';
        checkboxLabel.title = 'Crosspost to Bluesky?';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = cpChk;
        checkbox.disabled = !cpEna;
        checkbox.addEventListener('click', () => {
            cpChk = checkbox.checked;
            GM_setValue('bsky_crosspost_checked', cpChk);
            // 他のチェックボックスの状態も同期
            for (let el of document.querySelectorAll('.bsky-crosspost-checkbox input')) {
                el.checked = cpChk;
            }
        });
        const checkboxSpan = document.createElement('span');
        checkboxSpan.innerText = 'Bluesky';
        checkboxLabel.appendChild(checkbox);
        checkboxLabel.appendChild(checkboxSpan);

        // 要素を挿入
        if (postButton) {
            const controlsContainer = document.createElement('div');
            controlsContainer.className = 'bsky-controls-container';

            if (!isDesktop) {
                // モバイル版の場合

                // 設定アイコンを作成
                const iconDiv = document.createElement('div');
                iconDiv.className = 'bsky-settings-icon-wrapper';
                iconDiv.innerHTML = `<a title="Bluesky Settings" href="#"></a>`;
                iconDiv.querySelector('a').addEventListener('click', (e) => {
                    e.preventDefault();
                    toggleSettingsPanel();
                });

                controlsContainer.appendChild(iconDiv);
                controlsContainer.appendChild(checkboxLabel);

            } else {
                 // デスクトップ版の場合
                controlsContainer.appendChild(checkboxLabel);
            }

            // 投稿ボタンの親要素に挿入
            postButton.parentElement.insertBefore(controlsContainer, postButton);

        } else {
             // 投稿ボタンが見つからない場合のフォールバック

             if (!isDesktop) {
                const iconDiv = document.createElement('div');
                iconDiv.className = 'bsky-settings-icon-wrapper';
                iconDiv.innerHTML = `<a title="Bluesky Settings" href="#"></a>`;
                iconDiv.querySelector('a').addEventListener('click', (e) => {
                    e.preventDefault();
                    toggleSettingsPanel();
                });
                toolbar.appendChild(iconDiv);
             }

             toolbar.appendChild(checkboxLabel);
        }
    };

    const toggleSettingsPanel = () => {
        if (sDiv) {
            document.body.removeChild(sDiv);
            sDiv = null;
            return;
        }

        sDiv = document.createElement('div');
        sDiv.className = 'bsky-settings';

        // --- Buffer設定は常に表示 ---
        let bufferCheckboxHtml = `
            <div class="checkbox-group">
                <input type="checkbox" id="buffer-popup-toggle" name="buffer_popup" ${bufEna ? 'checked' : ''}>
                <label for="buffer-popup-toggle">Open Buffer post window</label>
            </div>
        `;
        // -----------------------------------------------------------

        sDiv.innerHTML = `
            <fieldset>
                <legend>Bluesky Settings</legend>
                <label for="bsky_pds_url">PDS URL:</label>
                <input type="url" name="bsky_pds_url" placeholder="https://bsky.social" value="${pds}">
                <label for="bsky_handle">Handle:</label>
                <input type="text" name="bsky_handle" placeholder="xxxx.bsky.social" autocomplete="section-bsky username" value="${hndl}">
                <label for="bsky_app_password">App Password:</label>
                <input type="password" name="bsky_app_password" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="section-bsky current-password" value="${pwd}">
            </fieldset>
            ${bufferCheckboxHtml}
            <div class="settings-actions">
                <div class="version">${VER}</div>
                <button>Save</button>
            </div>
        `;
        document.body.appendChild(sDiv);

        sDiv.querySelector('button').addEventListener('click', () => {
            pds = sDiv.querySelector('[name="bsky_pds_url"]').value || 'https://bsky.social';
            hndl = sDiv.querySelector('[name="bsky_handle"]').value;
            pwd = sDiv.querySelector('[name="bsky_app_password"]').value;

            // --- チェックボックスの状態を保存 ---
            const bufferToggle = sDiv.querySelector('#buffer-popup-toggle');
            if (bufferToggle) {
                bufEna = bufferToggle.checked;
                GM_setValue('buffer_popup_enabled', bufEna);
            } else {
                bufEna = false;
                GM_setValue('buffer_popup_enabled', bufEna);
            }
            // ------------------------------------------------------------------

            GM_setValue('bsky_pds_url', pds);
            GM_setValue('bsky_handle', hndl);
            GM_setValue('bsky_app_password', pwd);

            bC.pdsUrl = pds;
            bC.handle = hndl;
            bC.appPassword = pwd;
            cpEna = hndl && pwd;

            for (let el of document.querySelectorAll('.bsky-crosspost-checkbox input')) {
                el.checked = cpChk;
                el.disabled = !cpEna;
            }
            document.body.removeChild(sDiv);
            sDiv = null;
        });
    };

    /**
     * 投稿ボタンがクリックされたときの処理
     */
    const handlePost = async (e) => {
        const isSideNavPostButton = e.target.closest(S.SIDE_NAV_POST_BUTTON);

        if (isSideNavPostButton) {
            if (bufEna) {
                e.stopPropagation();
                e.preventDefault();
                e.stopImmediatePropagation();

                const isDesktop = document.querySelector(S.NAV_BAR) !== null;

                if (isDesktop) {
                    // Mac/iPad: ポップアップウィンドウでブラウザ中央に開く
                    const innerWidth = window.innerWidth;
                    const innerHeight = window.innerHeight;
                    const screenX = window.screenX || window.screenLeft;
                    const screenY = window.screenY || window.screenTop;

                    const left = screenX + (innerWidth / 2) - (P_W / 2);
                    const top = screenY + (innerHeight / 2) - (P_H / 2);

                    window.open(
                        BUF_URL,
                        '_blank',
                        `width=${P_W},height=${P_H},left=${left},top=${top},scrollbars=yes,resizable=yes,toolbar=no,menubar=no`
                    );
                } else {
                    // iPhone/モバイル: ネイティブアプリを試行
                    const NATIVE_SCHEME = 'bufferapp://compose';
                    const WEB_URL = BUF_URL;
                    const FALLBACK_TIMEOUT = 300;

                    window.location.href = NATIVE_SCHEME;

                    setTimeout(() => {
                        window.open(WEB_URL, '_blank');
                    }, FALLBACK_TIMEOUT);
                }
                return;
            } else {
                return;
            }
        }

        const isBlueskyCrossposting = cpChk && cpEna;

        if (!isBlueskyCrossposting) {
            return;
        }

        if (isPst) {
            return;
        }

        // イベント阻止を強化
        e.stopPropagation();
        e.preventDefault();
        e.stopImmediatePropagation();

        isPst = true;

        const postButton = e.currentTarget;
        const originalButtonContent = postButton.innerHTML;

        const postTextarea = document.querySelector(S.TEXT_AREA);
        const attachments = document.querySelectorAll(S.ATTACHMENTS);
        const quotePostLink = document.querySelector(S.QUOTE_LINK);

        try {
            postButton.disabled = true;
            postButton.innerHTML = `<span class="bsky-post-status-text">Posting to Bluesky...</span>`;

            let postText = postTextarea ? postTextarea.innerText : '';

            // 認証チェック
            await bC.verifySession();

            if (quotePostLink && quotePostLink.href) {
                postText += `\n${quotePostLink.href}`;
            }

            const record = {
                '$type': 'app.bsky.feed.post',
                'text': postText,
                'createdAt': new Date().toISOString(),
                // 効率化されたファセット解析を呼び出す
                'facets': TU.parseFacets(postText)
            };

            if (attachments.length > 0) {
                const images = [];
                for (const img of attachments) {
                    const blob = await getBlobFromUrl(img.src);

                    // 画像をPNGに変換してアップロード
                    const convertedBlob = await new Promise(resolve => {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        const image = new Image();
                        image.onload = () => {
                            canvas.width = image.width;
                            canvas.height = image.height;
                            ctx.drawImage(image, 0, 0);
                            canvas.toBlob(resolve, 'image/png');
                        };
                        image.src = URL.createObjectURL(blob);
                    });

                    const uploadedBlob = await bC.uploadImage(convertedBlob);
                    images.push({ alt: img.alt || '', image: uploadedBlob });
                }
                record.embed = { '$type': 'app.bsky.embed.images', images: images };
            }

            await bC.createPost(record);
            showCustomNotification('Post successfully crossposted to Bluesky.', false);

        } catch (error) {
            console.error('Failed to crosspost to Bluesky:', error);
            showCustomNotification(`Failed to crosspost to Bluesky: ${error.message}`, true);
        } finally {
            postButton.innerHTML = originalButtonContent;
            postButton.disabled = false;
            // Xのネイティブ投稿をトリガー
            postButton.click();
            isPst = false;
        }
    };

    // CSS スタイル (可読性を高めた整形版)
    const css = `
        .bsky-nav { padding: 12px; cursor: pointer; }
        .bsky-nav a {
            width: 1.75rem; height: 1.75rem;
            background-image: url(${B_ICO});
            background-size: cover; display: block;
        }
        /* デスクトップ版での左側メニューの表示調整 - 太字解除 */
        @media (min-width: 1000px) { /* 1000px以上をデスクトップと仮定 */
             .bsky-nav a:after {
                content: "Crosspost"; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                margin-left: 46px; color: rgb(15, 20, 25); font-weight: 400;
            }
        }
        .bsky-settings-icon-wrapper { display: inline-block; margin-right: 12px; }
        .bsky-settings-icon-wrapper a {
            width: 28px;
            height: 28px;
            background-image: url(${B_ICO});
            background-size: cover;
            display: block;
            border-radius: 50%;
        }
        /* モバイル版でのアイコンとチェックボックスを投稿ボタンの左側に並べるためのコンテナスタイル */
        .bsky-controls-container {
            display: flex;
            align-items: center;
            /* モバイルでは左寄せ、デスクトップでは右寄せ */
            justify-content: flex-start;
            flex-grow: 1;
            order: -1; /* 投稿ボタンの左に配置するために順序を最初にする */
        }
        @media (min-width: 1000px) {
            .bsky-controls-container {
                justify-content: flex-end; /* デスクトップは右寄せ */
            }
             .bsky-nav a:after { color: rgb(15, 20, 25); font-weight: 400; }
        }

        @media (prefers-color-scheme: dark) {
            .bsky-nav a:after { color: rgb(247, 249, 249); font-weight: 400; }
            .bsky-settings { background: #000; color: #fff; border-color: #0055AA;}
        }

        .bsky-crosspost-checkbox {
            display: inline-flex;
            align-items: center;
            margin-right: 12px;
        }
        @media (max-width: 1000px) {
             .bsky-settings-icon-wrapper { margin-right: 4px; }
        }

        .bsky-crosspost-checkbox input { margin-right: 4px; cursor: pointer; }
        .bsky-crosspost-checkbox span { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; cursor: pointer; }
        .bsky-crosspost-checkbox input:disabled + span { color: #888; cursor: default; }

        /* 投稿中のテキストのスタイル */
        .bsky-post-status-text {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 12px;
            display: block;
            line-height: 38px;
            text-align: center;
            margin: 0;
            padding: 0;
        }

        /* ------------------------------------------- */
        /* カスタム通知スタイル */
        /* ------------------------------------------- */

        .bsky-notification {
            position: fixed;
            top: 12px;
            right: 50%; /* 中央寄せの基準 */
            transform: translateX(50%); /* 中央寄せ */
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background-color: rgb(29, 155, 240);
            color: white;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            max-width: 320px; /* 小さな画面の最大幅 */
            width: 90%; /* モバイルのデフォルト幅 */
            z-index: 99999;
            opacity: 1;
            transition: opacity 0.5s ease-in-out, transform 0.5s ease-in-out;
        }

        .bsky-notification.error {
            background-color: rgb(244, 33, 46);
        }

        /* アニメーションを全環境で上方向にフェードアウトに統一 */
        .bsky-notification.fade-out {
            opacity: 0;
            transform: translateX(50%) translateY(-100%);
        }

        .bsky-notification-icon {
            width: 20px;
            height: 20px;
            background-image: url(${B_ICO});
            background-size: cover;
            flex-shrink: 0;
            filter: brightness(0) invert(1);
        }

        .bsky-notification-content {
            display: flex;
            flex-direction: column;
            line-height: 1.3;
        }
        .bsky-notification-title {
            font-weight: bold;
            font-size: 14px;
        }
        .bsky-notification-text {
            font-size: 13px;
        }

        /* Mac/iPad/デスクトップ (501px以上) での幅固定 */
        @media (min-width: 501px) {
            .bsky-notification {
                width: 500px; /* 固定幅 */
                max-width: 500px; /* 念のため最大幅も固定 */
            }
        }

        /* ------------------------------------------- */
        /* 設定パネルのスタイル */
        /* ------------------------------------------- */

        .bsky-settings {
            position: fixed;
            width: 300px;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #fff;
            padding: 15px;
            border: 2px solid #0085FF;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 14px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .bsky-settings fieldset { border: 1px solid #ccc; padding: 10px; border-radius: 4px; display: flex; flex-direction: column; gap: 8px;}
        .bsky-settings legend { font-weight: bold; padding: 0 5px; }
        .bsky-settings label { font-weight: 500; }
        .bsky-settings input[type="text"], .bsky-settings input[type="url"], .bsky-settings input[type="password"] {
            width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;
        }
        .bsky-settings .settings-actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .bsky-settings button {
            padding: 8px 16px; border: none; background-color: #1d9bf0; color: white;
            border-radius: 9999px; font-weight: bold; cursor: pointer;
        }
        .bsky-settings button:hover { background-color: #1a8cd8; }
        .bsky-settings .version { font-size: 12px; color: #888; text-align: left; }
        .bsky-settings .checkbox-group { display: flex; align-items: center; gap: 8px; }

        @media (prefers-color-scheme: dark) {
            .bsky-settings { background: #000 !important; color: #fff !important; border-color: #0055AA !important; }
            .bsky-settings fieldset { border-color: #444 !important; }
            .bsky-settings input[type="text"],
            .bsky-settings input[type="url"],
            .bsky-settings input[type="password"] {
                background-color: #333 !important;
                border-color: #555 !important;
                color: #fff !important;
            }
        }
    `;

    GM_addStyle(css);
    observer.observe(document.body, { childList: true, subtree: true });

})();
