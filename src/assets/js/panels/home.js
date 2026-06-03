import { config, database, logger, changePanel, appdata, setStatus, pkg, popup, ModpackSync, skin2D, accountSelect } from '../utils.js';

const { Launch } = require('minecraft-java-core');
const { shell, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');

class Home {
    static id = "home";
    _launching = false;
    _launchingInstance = null;
    _instanceStatus = new Map(); // instanceName → 'downloading' | 'installing' | 'running'

    async init(config) {
        this.config = config;
        this.db = new database();
        this.minecraftProcess = null;

        const gamePath = `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`;
        this.gamePath = gamePath;

        // Initialize user skin / head avatar
        await this.initUserAvatar();

        // Account dropdown toggle
        this.setupAccountDropdown();

        // 1. Load news section
        this.news();

        // Render quick access
        await this.renderQuickAccess();
        await this.updateDmVisibility();

        // Download queue floating panel
        this.setupDownloadsPanel();

        // Discord CTA button
        const discordBtn = document.getElementById('discord-cta-btn');
        if (discordBtn) {
            discordBtn.addEventListener('click', () => {
                const { shell } = require('electron');
                shell.openExternal('https://discord.gg/yusup');
            });
        }

        // 2. Setup Navigation, Account View & Friends
        this.setupNavigation();
        await this.setupAccountView();

        // 3. Render and initialize modpacks
        await this.initInstances();

        // Refresh button
        document.getElementById('btn-refresh-instances')?.addEventListener('click', () => {
            this.initInstances();
        });

        // 4. Initialize Settings
        await this.initSettings();

        // Auto-refresh instances every 30s
        this._refreshTimer = setInterval(() => {
            this.initInstances();
            this.renderQuickAccess();
            this.updateDmVisibility();
        }, 30000);
    }

    async initUserAvatar() {
        let configClient = await this.db.readData('configClient');
        let auth = await this.db.readData('accounts', configClient.account_selected);
        const setAvatar = async (el, clearChildren = true) => {
            if (!el) return;
            if (auth && auth.profile && auth.profile.skins && auth.profile.skins[0]) {
                try {
                    let headTex = await new skin2D().creatHeadTexture(auth.profile.skins[0].base64);
                    el.style.backgroundImage = `url(${headTex})`;
                    if (clearChildren) el.innerHTML = '';
                } catch (e) {
                    el.style.backgroundImage = `url('assets/images/default/setve.png')`;
                }
            } else {
                el.style.backgroundImage = `url('assets/images/default/setve.png')`;
            }
        };
        setAvatar(document.querySelector('#top-profile-avatar'), true);
        setAvatar(document.querySelector('#top-profile-avatar'), false);
    }

    async news() {
        let newsElement = document.querySelector('.news-list');
        if (!newsElement) return;
        newsElement.innerHTML = '';

        let news = await config.getNews(this.config).then(res => res).catch(() => false);
        if (news) {
            if (!news.length) {
                let blockNews = document.createElement('div');
                const date = this.getdate(new Date());
                blockNews.classList.add('news-block');
                blockNews.innerHTML = `
                    <div class="news-header">
                        <div class="title">No hay noticias disponibles actualmente.</div>
                    </div>
                    <div class="news-content">
                        <p>Aquí podrás seguir todas las noticias relacionadas con el servidor.</p>
                    </div>`;
                newsElement.appendChild(blockNews);
            } else {
                for (let News of news) {
                    let blockNews = document.createElement('div');
                    blockNews.classList.add('news-block');
                    blockNews.innerHTML = `
                        <div class="news-image-placeholder">
                            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                                <polyline points="21 15 16 10 5 21"></polyline>
                            </svg>
                        </div>
                        <div class="news-header">
                            <div class="title">${News.title}</div>
                            <span class="news-author">Autor: <span>${News.author}</span></span>
                        </div>
                        <div class="news-content">
                            <p>${News.content.replace(/\n/g, '</br>')}</p>
                        </div>`;
                    newsElement.appendChild(blockNews);
                }
            }
        } else {
            let blockNews = document.createElement('div');
            blockNews.classList.add('news-block');
            blockNews.innerHTML = `
                <div class="news-header">
                    <div class="title">Error de conexión.</div>
                </div>
                <div class="news-content">
                    <p>No se pudo contactar con el servidor de noticias.</br>Por favor, comprueba tu conexión.</p>
                </div>`;
            newsElement.appendChild(blockNews);
        }
    }

    setupNavigation() {
        const navButtons = document.querySelectorAll('.sidebar-item.nav-btn');
        const views = document.querySelectorAll('.dashboard-view');
        const backBtn = document.getElementById('sidebar-back-btn');

        navButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                let targetViewId = '';
                if (btn.id === 'nav-btn-home') targetViewId = 'view-home';
                else if (btn.id === 'nav-btn-instances') targetViewId = 'view-instances';
                else if (btn.id === 'nav-btn-settings') targetViewId = 'view-settings';

                if (!targetViewId) return;

                navButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                views.forEach(v => v.classList.remove('active'));
                document.getElementById(targetViewId)?.classList.add('active');

                if (backBtn) backBtn.style.display = 'none';
                const optDropdown = document.getElementById('detail-fab-menu');
                if (optDropdown) optDropdown.classList.remove('open');

                // Close account dropdown
                const accDropdown = document.querySelector('.account-dropdown-overlay');
                if (accDropdown) accDropdown.classList.remove('open');
            });
        });

        // DM button: open Discord
        const dmBtn = document.getElementById('sidebar-btn-dm');
        if (dmBtn) {
            dmBtn.addEventListener('click', () => {
                shell.openExternal('https://discord.gg/yusup');
            });
        }

        // BIND: Sidebar details back button
        backBtn?.addEventListener('click', () => {
            navButtons.forEach(b => b.classList.remove('active'));
            document.getElementById('nav-btn-instances')?.classList.add('active');

            views.forEach(v => v.classList.remove('active'));
            document.getElementById('view-instances')?.classList.add('active');

            if (backBtn) backBtn.style.display = 'none';
        });
    }

    setupAccountDropdown() {
        this._accountOverlay = document.querySelector('.account-dropdown-overlay');
        const avatar = document.getElementById('top-profile-btn');
        if (!avatar || !this._accountOverlay) return;

        avatar.addEventListener('click', async (e) => {
            e.stopPropagation();
            const isOpen = this._accountOverlay.classList.contains('open');
            document.querySelectorAll('.account-dropdown-overlay').forEach(d => d.classList.remove('open'));
            if (!isOpen) {
                this._accountOverlay.classList.add('open');
                await this.populateAccountDropdown();
            }
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.account-dropdown-overlay') && !e.target.closest('#top-profile-btn')) {
                if (this._accountOverlay) this._accountOverlay.classList.remove('open');
            }
        });

        // Add account button in dropdown
        const addBtn = document.getElementById('dropdown-btn-add');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                if (this._accountOverlay) this._accountOverlay.classList.remove('open');
                const cancelBtn = document.querySelector('.cancel-home');
                if (cancelBtn) cancelBtn.style.display = 'inline';
                changePanel('login');
            });
        }

        // Logout button
        const logoutBtn = document.getElementById('dropdown-btn-logout');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                if (this._accountOverlay) this._accountOverlay.classList.remove('open');
            });
        }
    }

    async populateAccountDropdown() {
        const overlay = this._accountOverlay;
        let configClient = await this.db.readData('configClient');
        let accounts = await this.db.readAllData('accounts');
        const currentAccount = await this.db.readData('accounts', configClient.account_selected);

        // Account list
        const listEl = document.getElementById('dropdown-accounts-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        for (let acc of accounts) {
            let skin = false;
            if (acc?.profile?.skins[0]?.base64) {
                try {
                    skin = await new skin2D().creatHeadTexture(acc.profile.skins[0].base64);
                } catch (e) {}
            }

            const item = document.createElement('div');
            item.className = 'dropdown-account-item' + (acc.ID === configClient.account_selected ? ' active-account' : '');
            item.innerHTML = `
                <div class="dropdown-account-avatar" ${skin ? `style="background-image: url(${skin});"` : ''}></div>
                <div class="dropdown-account-info">
                    <div class="dropdown-account-name">${acc.name}</div>
                    <div class="dropdown-account-uuid">${acc.uuid || ''}</div>
                </div>
                <div class="dropdown-account-delete" data-id="${acc.ID}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </div>
            `;

            // Switch account
            item.addEventListener('click', async (e) => {
                if (e.target.closest('.dropdown-account-delete')) return;
                if (acc.ID === configClient.account_selected) return;

                let popupSwitch = new popup();
                popupSwitch.openPopup({ title: 'Conexión', content: 'Cargando cuenta...', color: 'var(--color)' });

                let cc = await this.db.readData('configClient');
                cc.account_selected = acc.ID;
                let instancesList = await config.getInstanceList();
                if (instancesList.length > 0) cc.instance_select = instancesList[0].name;
                await this.db.updateData('configClient', cc);
                await accountSelect(acc);
                await this.initUserAvatar();
                await this.setupAccountView();
                await this.initInstances();

                popupSwitch.closePopup();
                overlay.classList.remove('open');
            });

            // Delete account
            item.querySelector('.dropdown-account-delete').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`¿Eliminar la cuenta de ${acc.name}?`)) return;

                await this.db.deleteData('accounts', acc.ID);
                let remaining = await this.db.readAllData('accounts');
                if (remaining.length === 0) {
                    overlay.classList.remove('open');
                    return changePanel('login');
                }

                let cc = await this.db.readData('configClient');
                if (cc.account_selected === acc.ID) {
                    cc.account_selected = remaining[0].ID;
                    await accountSelect(remaining[0]);
                    let instancesList = await config.getInstanceList();
                    if (instancesList.length > 0) cc.instance_select = instancesList[0].name;
                    await this.db.updateData('configClient', cc);
                    await this.initUserAvatar();
                    await this.setupAccountView();
                    await this.initInstances();
                } else {
                    await this.setupAccountView();
                }

                await this.populateAccountDropdown();
            });

            listEl.appendChild(item);
        }
    }

    async updateDmVisibility() {
        const dmBtn = document.getElementById('sidebar-btn-dm');
        if (!dmBtn) return;
        let sessions = await this.db.readAllData('sessions') || [];
        const hasPlayed = sessions.some(s => (s.playtime_seconds || 0) > 0);
        dmBtn.style.display = hasPlayed ? 'flex' : 'none';
    }

    /* ==========================================================================
       DOWNLOAD QUEUE MANAGER (floating panel like Epic Games)
       ========================================================================== */
    _activeDownloads = new Map();

    showDownload(instanceName, title) {
        this.refreshInstanceStatus(instanceName, 'downloading');
        const panel = document.getElementById('downloads-floating-panel');
        const body = document.getElementById('downloads-panel-body');
        const badge = document.getElementById('downloads-badge');
        if (!panel || !body) return;

        if (!this._activeDownloads.has(instanceName)) {
            const row = document.createElement('div');
            row.className = 'downloads-row-item';
            row.id = `download-item-${instanceName}`;
            row.innerHTML = `
                <div class="downloads-row-info">
                    <span class="downloads-row-name">${title || instanceName}</span>
                    <span class="downloads-row-status">Preparando...</span>
                </div>
                <div class="downloads-row-bar">
                    <div class="downloads-row-fill" style="width:0%"></div>
                </div>
                <span class="downloads-row-pct">0%</span>
            `;
            body.appendChild(row);
            this._activeDownloads.set(instanceName, { row, progress: 0 });
        }

        // Remove empty state
        const empty = body.querySelector('.downloads-panel-empty');
        if (empty) empty.remove();

        panel.style.display = 'flex';
        if (badge) {
            badge.textContent = this._activeDownloads.size;
            badge.style.display = 'flex';
        }
    }

    updateDownload(instanceName, pct, message) {
        const entry = this._activeDownloads.get(instanceName);
        if (!entry) return;
        const row = entry.row;
        entry.progress = pct;
        const fill = row.querySelector('.downloads-row-fill');
        const status = row.querySelector('.downloads-row-status');
        const pctEl = row.querySelector('.downloads-row-pct');
        if (fill) fill.style.width = `${Math.min(pct, 100)}%`;
        if (status) status.textContent = message || 'Descargando...';
        if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
    }

    hideDownload(instanceName) {
        this.refreshInstanceStatus(instanceName, null);
        const panel = document.getElementById('downloads-floating-panel');
        const body = document.getElementById('downloads-panel-body');
        const badge = document.getElementById('downloads-badge');
        const row = document.getElementById(`download-item-${instanceName}`);
        if (row) row.remove();
        this._activeDownloads.delete(instanceName);

        if (this._activeDownloads.size === 0) {
            if (body) body.innerHTML = '<div class="downloads-panel-empty">No hay descargas activas.</div>';
            if (panel) panel.style.display = 'none';
        }
        if (badge) {
            if (this._activeDownloads.size > 0) {
                badge.textContent = this._activeDownloads.size;
            } else {
                badge.style.display = 'none';
            }
        }
    }

    async setupDownloadsPanel() {
        const panel = document.getElementById('downloads-floating-panel');
        const btn = document.getElementById('nav-btn-downloads');
        const closeBtn = document.getElementById('downloads-panel-close');
        const badge = document.getElementById('downloads-badge');

        if (btn) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!panel) return;
                const isOpen = panel.style.display === 'flex';
                panel.style.display = isOpen ? 'none' : 'flex';
            });
        }
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                if (panel) panel.style.display = 'none';
            });
        }
        document.addEventListener('click', (e) => {
            if (panel && panel.style.display === 'flex') {
                if (!e.target.closest('#downloads-floating-panel') && !e.target.closest('#nav-btn-downloads')) {
                    panel.style.display = 'none';
                }
            }
        });
    }

    async renderQuickAccess() {
        const container = document.getElementById('sidebar-quick-access-items');
        const section = document.getElementById('sidebar-quick-access');
        if (!container) return;

        let sessions = await this.db.readAllData('sessions') || [];
        let instanceMap = new Map();
        for (let s of sessions) {
            if (!s.instance || !s.playtime_seconds || s.playtime_seconds <= 0) continue;
            if (!instanceMap.has(s.instance) || new Date(s.start_time) > new Date(instanceMap.get(s.instance).start_time)) {
                instanceMap.set(s.instance, s);
            }
        }

        const recent = Array.from(instanceMap.values())
            .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
            .slice(0, 5);

        container.innerHTML = '';
        if (recent.length === 0) {
            if (section) section.style.display = 'none';
            return;
        }
        if (section) section.style.display = 'flex';

        let instancesList = await config.getInstanceList();
        for (let session of recent) {
            const pack = instancesList.find(p => p.name === session.instance);
            const title = pack?.title || pack?.name || session.instance;
            const initial = title.charAt(0).toUpperCase();
            const hue = this._nameToHue(title);
            const bgColor = `hsl(${hue}, 55%, 85%)`;
            const textColor = `hsl(${hue}, 60%, 30%)`;

            const item = document.createElement('div');
            item.className = 'sidebar-quick-access-item';
            item.innerHTML = `
                <div class="qa-avatar" style="background:${bgColor}; color:${textColor};">${initial}</div>
                <div class="qa-info">
                    <span class="sidebar-quick-access-label">${title}</span>
                    <span class="qa-play-hint">Iniciar modpack</span>
                </div>
            `;
            if (pack) {
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.qa-play-hint')) {
                        if (this._launching) return;
                        this.startGame(pack, this.gamePath);
                    } else {
                        this.selectInstance(pack);
                    }
                });
                item.style.cursor = 'pointer';
            }
            container.appendChild(item);
        }
    }

    _nameToHue(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return Math.abs(hash) % 360;
    }

    async setupAccountView() {
        let configClient = await this.db.readData('configClient');
        let currentAccount = await this.db.readData('accounts', configClient.account_selected);

        // Fill Active Profile Info
        const activeAvatarEl = document.getElementById('acc-active-avatar');
        const activeNameEl = document.getElementById('acc-active-name');
        const activeUuidEl = document.getElementById('acc-active-uuid');
        const activeTypeEl = document.getElementById('acc-active-type');

        if (currentAccount) {
            if (activeNameEl) activeNameEl.textContent = currentAccount.name;
            if (activeUuidEl) activeUuidEl.textContent = `UUID: ${currentAccount.uuid || '-'}`;
            if (activeTypeEl) activeTypeEl.textContent = currentAccount.meta?.type || 'Offline';

            if (currentAccount.profile?.skins && currentAccount.profile.skins[0]) {
                try {
                    let headTex = await new skin2D().creatHeadTexture(currentAccount.profile.skins[0].base64);
                    if (activeAvatarEl) activeAvatarEl.style.backgroundImage = `url(${headTex})`;
                } catch (e) {
                    if (activeAvatarEl) activeAvatarEl.style.backgroundImage = `url('assets/images/default/setve.png')`;
                }
            } else {
                if (activeAvatarEl) activeAvatarEl.style.backgroundImage = `url('assets/images/default/setve.png')`;
            }
        }

        // BIND: Add account button switches to login
        const addAccBtn = document.getElementById('acc-btn-add-account');
        addAccBtn?.replaceWith(addAccBtn.cloneNode(true));
        document.getElementById('acc-btn-add-account')?.addEventListener('click', () => {
            const cancelBtn = document.querySelector('.cancel-home');
            if (cancelBtn) cancelBtn.style.display = 'inline';
            changePanel('login');
        });

        // Load list of accounts to switch
        await this.loadAccountsSwitcherList(configClient.account_selected);

        // Load Friends list
        await this.loadFriendsList();

        // BIND: Add Friend
        const addFriendBtn = document.getElementById('add-friend-btn');
        addFriendBtn?.replaceWith(addFriendBtn.cloneNode(true));
        document.getElementById('add-friend-btn')?.addEventListener('click', async () => {
            const inputEl = document.getElementById('add-friend-username');
            const username = inputEl.value.trim();
            if (username.length < 3) {
                alert('El nombre debe tener al menos 3 caracteres.');
                return;
            }
            if (username.includes(' ')) {
                alert('El nombre no debe contener espacios.');
                return;
            }

            // Save friend to DB
            let friends = await this.db.readAllData('friends');
            if (friends.find(f => f.name.toLowerCase() === username.toLowerCase())) {
                alert('Este usuario ya está en tu lista de amigos.');
                return;
            }

            await this.db.createData('friends', {
                name: username,
                status: Math.random() > 0.4 ? 'online' : 'offline'
            });

            inputEl.value = '';
            await this.loadFriendsList();
        });

    }

    async loadAccountsSwitcherList(selectedId) {
        const container = document.getElementById('account-selection-container');
        if (!container) return;
        container.innerHTML = '';

        let accounts = await this.db.readAllData('accounts');
        for (let acc of accounts) {
            let skin = false;
            if (acc?.profile?.skins[0]?.base64) {
                try {
                    skin = await new skin2D().creatHeadTexture(acc.profile.skins[0].base64);
                } catch (e) {
                    // Fallback
                }
            }

            const card = document.createElement('div');
            card.classList.add('account');
            if (acc.ID === selectedId) {
                card.classList.add('account-select');
            }
            card.id = `switch-${acc.ID}`;
            card.innerHTML = `
                <div class="profile-image" ${skin ? `style="background-image: url(${skin});"` : ''}></div>
                <div class="profile-infos">
                    <div class="profile-pseudo">${acc.name}</div>
                    <div class="profile-uuid">${acc.uuid}</div>
                </div>
                <div class="delete-profile" id="delete-${acc.ID}">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </div>
            `;

            // Click Account to Switch
            card.addEventListener('click', async (e) => {
                if (e.target.closest('.delete-profile')) return; // Ignore if delete clicked

                let popupSwitch = new popup();
                popupSwitch.openPopup({
                    title: 'Conexión',
                    content: 'Cargando cuenta...',
                    color: 'var(--color)'
                });

                let configClient = await this.db.readData('configClient');
                configClient.account_selected = acc.ID;
                
                // Select default instance for new account
                let instancesList = await config.getInstanceList();
                if (instancesList.length > 0) {
                    configClient.instance_select = instancesList[0].name;
                }
                
                await this.db.updateData('configClient', configClient);
                await accountSelect(acc);
                
                // Re-init account details, user avatar, and instances list
                await this.initUserAvatar();
                await this.setupAccountView();
                await this.initInstances();

                popupSwitch.closePopup();
            });

            // Click Trash to Delete Account
            card.querySelector('.delete-profile').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`¿Estás seguro de que quieres eliminar la cuenta de ${acc.name}?`)) return;

                let popupDel = new popup();
                popupDel.openPopup({
                    title: 'Conexión',
                    content: 'Eliminando cuenta...',
                    color: 'var(--color)'
                });

                await this.db.deleteData('accounts', acc.ID);
                let remainingAccounts = await this.db.readAllData('accounts');

                if (remainingAccounts.length === 0) {
                    popupDel.closePopup();
                    return changePanel('login');
                }

                let currentConfig = await this.db.readData('configClient');
                if (currentConfig.account_selected === acc.ID) {
                    currentConfig.account_selected = remainingAccounts[0].ID;
                    await accountSelect(remainingAccounts[0]);

                    let instancesList = await config.getInstanceList();
                    if (instancesList.length > 0) {
                        currentConfig.instance_select = instancesList[0].name;
                    }
                    await this.db.updateData('configClient', currentConfig);

                    await this.initUserAvatar();
                    await this.setupAccountView();
                    await this.initInstances();
                } else {
                    await this.setupAccountView();
                }

                popupDel.closePopup();
            });

            container.appendChild(card);
        }
    }

    async loadFriendsList() {
        const container = document.getElementById('friends-list-container');
        if (!container) return;
        container.innerHTML = '';

        let friends = await this.db.readAllData('friends');

        // Populate with dynamic default mock friends if table is completely empty
        if (friends.length === 0) {
            const defaults = [
                { name: 'MrDiego05', status: 'online' },
                { name: 'Luuxis', status: 'online' },
                { name: 'JuanCarlosElMinero', status: 'offline' }
            ];
            for (let f of defaults) {
                await this.db.createData('friends', f);
            }
            friends = await this.db.readAllData('friends');
        }

        friends.forEach(f => {
            const div = document.createElement('div');
            div.classList.add('friend-item');
            div.innerHTML = `
                <div class="friend-avatar" style="background-image: url('assets/images/default/setve.png');"></div>
                <div class="friend-name">${f.name}</div>
                <div class="friend-status ${f.status}">
                    <span class="status-dot"></span>
                    <span>${f.status === 'online' ? 'Conectado' : 'Desconectado'}</span>
                </div>
                <div class="friend-delete-btn" title="Eliminar amigo">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </div>
            `;

            // Delete friend listener
            div.querySelector('.friend-delete-btn').addEventListener('click', async () => {
                if (confirm(`¿Eliminar a ${f.name} de tus amigos?`)) {
                    await this.db.deleteData('friends', f.ID);
                    await this.loadFriendsList();
                }
            });

            container.appendChild(div);
        });
    }

    getThemeColor(pack) {
        if (pack.themeColor) return pack.themeColor;
        const loaderType = (pack.loader?.type || pack.loader?.loader_type || 'vanilla').toLowerCase();
        if (loaderType === 'neoforge') return 'lime';
        if (loaderType === 'forge') return 'orange';
        if (loaderType === 'fabric') return 'emerald';
        return 'green';
    }

    async initInstances() {
        let configClient = await this.db.readData('configClient') || {};
        let instancesList = await config.getInstanceList();
        let currentSelect = configClient.instance_select;

        // Get current account to check whitelist
        const currentAccount = configClient.account_selected
            ? await this.db.readData('accounts', configClient.account_selected)
            : null;
        const currentPlayerName = currentAccount?.name || '';

        function isAdmin(pack, playerName) {
            if (!pack.whitelistActive) return null; // null = no filter
            const entry = (pack.whitelist || []).find(w => w.name.toLowerCase() === playerName.toLowerCase());
            return entry ? entry.role : false;
        }

        // Filter instances based on whitelist
        instancesList = instancesList.filter(pack => {
            const role = isAdmin(pack, currentPlayerName);
            if (role === null) return true;      // no whitelist → everyone sees it
            if (role === 'admin') return true;    // admin sees all
            if (role === 'player') return true;   // player sees their assigned ones
            return false;                          // not in whitelist → hidden
        });

        // Auto select first instance if none selected
        if (!currentSelect && instancesList.length > 0) {
            currentSelect = instancesList[0].name;
            configClient.instance_select = currentSelect;
            await this.db.updateData('configClient', configClient);
        } else if (instancesList.length === 0) {
            this.renderInstancesGrid([], 'instances-grid-installed');
            this.renderInstancesGrid([], 'instances-grid-all');
            return;
        }

        // 1. Separate installed vs available modpacks
        let installedPacks = [];
        let allPacks = [];

        for (let pack of instancesList) {
            const localPackDir = path.join(this.gamePath, 'instances', pack.name);
            const hasVersion = configClient.instances_versions?.[pack.name];
            const hasManifestFile = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
            if (hasVersion || hasManifestFile) {
                installedPacks.push(pack);
            } else {
                allPacks.push(pack);
            }
        }

        // 2. Merge creator tools modpacks — check each for installed status like remote instances
        const userDataPath = await ipcRenderer.invoke('path-user-data');
        const creatorPath = path.join(userDataPath, 'creator-modpacks.json');
        const fallbackCreatorPath = path.join(process.cwd(), 'data', 'creator-modpacks.json');
        const resolvedCreatorPath = fs.existsSync(creatorPath) ? creatorPath : (fs.existsSync(fallbackCreatorPath) ? fallbackCreatorPath : null);
        if (resolvedCreatorPath) {
            try {
                const fileData = fs.readFileSync(resolvedCreatorPath, 'utf8');
                let parsedData = JSON.parse(fileData);
                for (let c of parsedData) {
                    const loaderType = (c.loader || 'none').toLowerCase();
                    const localManifest = path.join(c.location, 'modpack.json');
                    const pack = {
                        name: c.id,
                        title: c.title,
                        description: c.description || '',
                        tags: c.tags || [],
                        gameVersion: c.gameVersion,
                        loader: {
                            type: loaderType,
                            build: c.loaderVersion || '',
                            enable: loaderType !== 'none' && loaderType !== 'vanilla',
                            loader_type: loaderType === 'vanilla' ? 'none' : loaderType,
                            loader_version: c.loaderVersion || '',
                            minecraft_version: c.gameVersion
                        },
                        url: '',
                        verify: true,
                        ignored: [],
                        themeColor: 'lime',
                        playTime: '0.0h',
                        modpack_url: fs.existsSync(localManifest) ? localManifest : undefined,
                        whitelistActive: c.whitelistActive || false,
                        whitelist: c.whitelist || []
                    };
                    const localPackDir = path.join(this.gamePath, 'instances', pack.name);
                    const hasVersion = configClient.instances_versions?.[pack.name];
                    const hasManifestFile = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
                    if (hasVersion || hasManifestFile) {
                        installedPacks.push(pack);
                    } else {
                        allPacks.push(pack);
                    }
                }
            } catch (e) {
                console.error('Error reading creator tools modpacks:', e);
            }
        }

        // 3. Build playtime map from sessions
        let playtimeMap = {};
        try {
            const allSessions = await this.db.readAllData('sessions') || [];
            for (let pack of instancesList) {
                const packSessions = allSessions.filter(s => s.instance === pack.name);
                const totalSeconds = packSessions.reduce((sum, s) => sum + (s.playtime_seconds || 0), 0);
                if (totalSeconds > 0) playtimeMap[pack.name] = totalSeconds;
            }
        } catch (e) {}

        // 4. Render sections
        this.renderInstancesGrid(installedPacks, 'instances-grid-installed', playtimeMap);
        this.renderInstancesGrid(allPacks, 'instances-grid-all', playtimeMap);
    }

    renderInstancesGrid(packs, containerId, playtimeMap = {}) {
        const gridContainer = document.getElementById(containerId);
        if (!gridContainer) return;
        gridContainer.innerHTML = '';

        if (packs.length === 0) {
            gridContainer.innerHTML = `<div style="grid-column: span 4; color: #64748b; font-size: 0.85em; text-align: center; padding: 20px;">No hay instancias en esta sección.</div>`;
            return;
        }

        packs.forEach(pack => {
            const card = document.createElement('div');
            card.classList.add('modpack-grid-card');
            card.dataset.instanceName = pack.name;

            const totalSeconds = playtimeMap[pack.name] || 0;
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const playtimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

            const status = this._instanceStatus.get(pack.name);
            let statusTag = '';
            if (status === 'downloading') statusTag = '<span class="modpack-grid-tag downloading">Descargando</span>';
            else if (status === 'installing') statusTag = '<span class="modpack-grid-tag installing">Instalando</span>';
            else if (status === 'running') statusTag = '<span class="modpack-grid-tag running">Ejecutando</span>';

            card.innerHTML = `
                <div class="modpack-grid-thumb">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                        <line x1="12" y1="22.08" x2="12" y2="12"></line>
                    </svg>
                    ${statusTag}
                </div>
                <h3 class="modpack-grid-name">${pack.title || pack.name}</h3>
                ${totalSeconds > 0 ? `<span class="modpack-grid-playtime">${playtimeStr}</span>` : ''}
            `;

            card.addEventListener('click', () => {
                this.selectInstance(pack);
            });

            gridContainer.appendChild(card);
        });
    }

    refreshInstanceStatus(name, status) {
        if (status) this._instanceStatus.set(name, status);
        else this._instanceStatus.delete(name);
        const label = status === 'running' ? 'Ejecutando' : status === 'downloading' ? 'Descargando' : status === 'installing' ? 'Instalando' : '';
        document.querySelectorAll(`.modpack-grid-card[data-instance-name="${name}"]`).forEach(card => {
            const thumb = card.querySelector('.modpack-grid-thumb');
            if (!thumb) return;
            let existing = thumb.querySelector('.modpack-grid-tag');
            if (existing) existing.remove();
            if (!label) return;
            const tag = document.createElement('span');
            tag.className = `modpack-grid-tag ${status}`;
            tag.textContent = label;
            thumb.appendChild(tag);
        });
    }

    async selectInstance(pack) {
        // Save selection in DB
        let configClient = await this.db.readData('configClient');
        configClient.instance_select = pack.name;
        await this.db.updateData('configClient', configClient);

        // Switch to detail view
        const views = document.querySelectorAll('.dashboard-view');
        views.forEach(v => v.classList.remove('active'));
        document.getElementById('view-detail')?.classList.add('active');

        const progressContainer = document.getElementById('detail-progress');
        const playBtn = document.getElementById('detail-play-btn');
        const btnContent = document.getElementById('detail-play-btn-content');
        const btnSpinner = document.getElementById('detail-play-btn-spinner');

        // Keep button in loading state if this or another instance is currently launching
        if (this._launching) {
            if (progressContainer) progressContainer.style.display = 'none';
            if (playBtn) {
                playBtn.disabled = true;
                playBtn.title = this._launchingInstance === pack.name ? 'Instancia iniciando...' : `Ya hay una instancia en ejecución`;
            }
            if (btnContent) btnContent.style.display = 'none';
            if (btnSpinner) btnSpinner.style.display = 'flex';
        } else {
            if (progressContainer) progressContainer.style.display = 'none';
            if (playBtn) {
                playBtn.disabled = false;
                playBtn.title = '';
            }
            if (btnContent) btnContent.style.display = 'flex';
            if (btnSpinner) btnSpinner.style.display = 'none';
        }

        // Show sidebar back button
        const backBtn = document.getElementById('sidebar-back-btn');
        if (backBtn) backBtn.style.display = 'flex';

        // Wire up detail back button
        const detailBackBtn = document.getElementById('detail-back-btn');
        if (detailBackBtn) {
            detailBackBtn.replaceWith(detailBackBtn.cloneNode(true));
            const newDetailBack = document.getElementById('detail-back-btn');
            newDetailBack.addEventListener('click', () => {
                const navBtns = document.querySelectorAll('.sidebar-item.nav-btn');
                navBtns.forEach(b => b.classList.remove('active'));
                document.getElementById('nav-btn-instances')?.classList.add('active');
                document.querySelectorAll('.dashboard-view').forEach(v => v.classList.remove('active'));
                document.getElementById('view-instances')?.classList.add('active');
                const sbBackBtn = document.getElementById('sidebar-back-btn');
                if (sbBackBtn) sbBackBtn.style.display = 'none';
            });
        }

        // Fill detail viewport floating card content
        document.getElementById('detail-title').textContent = pack.title || pack.name;

        // Set poster image
        const posterImg = document.getElementById('detail-poster-img');
        if (posterImg) {
            posterImg.src = pack.poster || pack.image || 'assets/images/default/setve.png';
            posterImg.alt = (pack.title || pack.name) + ' poster';
        }
        document.getElementById('detail-version').textContent = pack.gameVersion || pack.loader?.minecraft_version || '';

        // Calculate real playtime from sessions
        try {
            const allSessions = await this.db.readAllData('sessions') || [];
            const packSessions = allSessions.filter(s => s.instance === pack.name);
            const totalSeconds = packSessions.reduce((sum, s) => sum + (s.playtime_seconds || 0), 0);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            document.getElementById('detail-playtime').textContent = hours > 0 ? `${hours}.${minutes}h` : `${minutes}m`;
        } catch (e) {
            document.getElementById('detail-playtime').textContent = '0.0h';
        }

        // Dynamic tags
        const tagsContainer = document.getElementById('detail-tags');
        if (tagsContainer) {
            const loaderName = (pack.loader?.type || pack.loader?.loader_type || 'vanilla').toUpperCase();
            const mcVersion = pack.gameVersion || pack.loader?.minecraft_version || '';
            const customTags = pack.tags || [];
            let tagsHtml = `<span>${loaderName}</span>`;
            if (mcVersion) tagsHtml += `<span>MC ${mcVersion}</span>`;
            customTags.forEach(t => { tagsHtml += `<span>${t}</span>`; });
            tagsContainer.innerHTML = tagsHtml;
        }

        // Dynamic Description
        const descEl = document.getElementById('detail-desc');
        if (descEl) {
            descEl.innerHTML = pack.description || 'Un evento único y optimizado donde experimentarás la mejor jugabilidad en Minecraft. Disfruta de rendimiento superior, mods integrados y conectividad instantánea con el servidor principal.';
        }

        // Verify if already downloaded
        let hasDownloaded = false;
        let effectiveGamePath = this.gamePath;
        const localPackDir = path.join(this.gamePath, 'instances', pack.name);
        const hasVersion = configClient.instances_versions?.[pack.name];
        const hasManifestFile = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
        hasDownloaded = hasVersion || hasManifestFile;

        const playBtnLabel = document.querySelector('#detail-play-btn-content span');
        if (playBtnLabel) {
            playBtnLabel.textContent = hasDownloaded ? 'Jugar' : 'Descargar';
        }

        // Setup launcher control listeners
        this.setupLauncherControls(pack, effectiveGamePath);
    }

    setupLauncherControls(pack, gamePath) {
        const playBtn = document.getElementById('detail-play-btn');
        const optionsBtn = document.getElementById('detail-options-btn');
        const dropdown = document.getElementById('detail-fab-menu');

        // 1. Play Button Click
        playBtn.replaceWith(playBtn.cloneNode(true));
        const newPlayBtn = document.getElementById('detail-play-btn');
        newPlayBtn.addEventListener('click', () => {
            if (this._launching) return;
            this.startGame(pack, gamePath);
        });

        // 2. Toggle Quick Menu Dropdown
        optionsBtn.replaceWith(optionsBtn.cloneNode(true));
        const newOptionsBtn = document.getElementById('detail-options-btn');
        newOptionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dropdown) {
                dropdown.classList.toggle('open');
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            if (dropdown) dropdown.classList.remove('open');
        });

        // Dropdown Items Clicks Handlers
        const localPackDir = path.join(gamePath, 'instances', pack.name);
        const openFolder = (subDir) => {
            if (dropdown) dropdown.classList.remove('open');
            const fullPath = path.join(localPackDir, subDir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
            shell.openPath(fullPath);
        };

        document.getElementById('opt-btn-worlds').onclick = () => openFolder('saves');
        document.getElementById('opt-btn-resourcepacks').onclick = () => openFolder('resourcepacks');
        document.getElementById('opt-btn-screenshots').onclick = () => openFolder('screenshots');

        // Dropdown Option: Clean / Reinstall (Eliminar Instancia)
        document.getElementById('opt-btn-reinstall').onclick = async () => {
            if (dropdown) dropdown.classList.remove('open');
            if (!fs.existsSync(localPackDir)) {
                alert('Esta instancia aún no se ha instalado.');
                return;
            }

            if (confirm(`¿Estás completamente seguro de que quieres eliminar la instancia de ${pack.title || pack.name}?\nTodos tus mundos locales y capturas serán eliminados permanentemente.`)) {
                try {
                    fs.rmSync(localPackDir, { recursive: true, force: true });

                    // Clear stored version so it shows "Descargar" again
                    let cc = await this.db.readData('configClient');
                    if (cc.instances_versions) delete cc.instances_versions[pack.name];
                    if (cc.instances_features) delete cc.instances_features[pack.name];
                    await this.db.updateData('configClient', cc);

                    // Also remove NeoForge version folder for this instance, if any
                    const nfVersion = pack.loader?.build || pack.loader?.loader_version;
                    if (nfVersion) {
                        const versionsDir = path.join(gamePath, 'versions');
                        if (fs.existsSync(versionsDir)) {
                            try {
                                const entries = fs.readdirSync(versionsDir);
                                const nfFolder = entries.find(e =>
                                    e.toLowerCase().includes(nfVersion.toLowerCase()) &&
                                    fs.existsSync(path.join(versionsDir, e, `${e}.json`))
                                );
                                if (nfFolder) {
                                    fs.rmSync(path.join(versionsDir, nfFolder), { recursive: true, force: true });
                                }
                            } catch (e) {
                                console.error('Error cleaning NeoForge version folder:', e);
                            }
                        }
                    }

                    alert('Instancia eliminada con éxito. Ya puedes reinstalarla limpiamente.');
                    // Refresh view
                    await this.initInstances();
                    await this.selectInstance(pack);
                } catch (err) {
                    alert(`Error al eliminar la instancia: ${err.message}`);
                }
            }
        };

        // Dropdown Option: Force Close Game (Forzar Cierre)
        document.getElementById('opt-btn-kill').onclick = () => {
            if (dropdown) dropdown.classList.remove('open');
            const proc = this.minecraftProcess?._process;
            if (proc) {
                proc.kill();
                this.minecraftProcess = null;
                new logger('Minecraft', '#ef4444').info('Minecraft finalizado por el usuario.');
                alert('Minecraft ha sido cerrado de forma forzada.');
            } else {
                const { exec } = require('child_process');
                if (process.platform === 'win32') {
                    exec('taskkill /f /im javaw.exe');
                } else {
                    exec('killall -9 java');
                }
                alert('Procesos de Java cerrados de forma forzada.');
            }
        };
    }

    async showFeaturesModal(modpackUrl) {
        let manifest;
        try {
            if (fs.existsSync(modpackUrl)) {
                manifest = JSON.parse(fs.readFileSync(modpackUrl, 'utf8'));
            } else {
                const controller = new AbortController();
                const fetchTimeout = setTimeout(() => controller.abort(), 10000);
                const res = await fetch(modpackUrl, { signal: controller.signal });
                clearTimeout(fetchTimeout);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                manifest = await res.json();
            }
        } catch (e) {
            return []; // Can't get features, proceed without selecting
        }

        const features = manifest.features;
        if (!features || features.length === 0) return [];

        let existing = document.getElementById('features-overlay');
        if (existing) existing.remove();

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.id = 'features-overlay';
            overlay.style.cssText = `
                position:fixed; top:0; left:0; width:100%; height:100%;
                background:rgba(0,0,0,0.7); z-index:9999;
                display:flex; align-items:center; justify-content:center;
                backdrop-filter:blur(4px);
            `;

            const modal = document.createElement('div');
            modal.style.cssText = `
                background:#1e293b; border-radius:12px; padding:24px;
                width:420px; max-height:80vh; overflow-y:auto;
                border:1px solid rgba(255,255,255,0.1);
                color:#f1f5f9; font-family:inherit;
            `;

            const title = document.createElement('h3');
            title.textContent = 'Características opcionales';
            title.style.cssText = 'margin:0 0 4px 0; font-size:1.1em;';
            modal.appendChild(title);

            const subtitle = document.createElement('p');
            subtitle.textContent = 'Seleccioná los mods y componentes que querés incluir:';
            subtitle.style.cssText = 'margin:0 0 16px 0; font-size:0.85em; color:#94a3b8;';
            modal.appendChild(subtitle);

            const checkboxes = {};
            for (const feat of features) {
                const label = document.createElement('label');
                label.style.cssText = `
                    display:flex; align-items:center; gap:10px;
                    padding:8px 12px; margin:4px 0;
                    border-radius:8px; cursor:pointer;
                    background:rgba(255,255,255,0.03);
                    transition:background 0.2s;
                `;

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = feat.selected !== false;
                cb.style.cssText = 'accent-color:#3b82f6; width:16px; height:16px;';

                const info = document.createElement('div');
                info.style.cssText = 'display:flex; flex-direction:column; gap:2px;';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = feat.name;
                nameSpan.style.cssText = 'font-weight:600; font-size:0.9em;';

                const descSpan = document.createElement('span');
                descSpan.textContent = feat.description || '';
                descSpan.style.cssText = 'font-size:0.8em; color:#94a3b8;';

                if (feat.recommendation === 'starred') {
                    const badge = document.createElement('span');
                    badge.textContent = '★ Recomendado';
                    badge.style.cssText = 'font-size:0.75em; color:#f59e0b; margin-left:8px;';
                    nameSpan.appendChild(badge);
                }

                info.appendChild(nameSpan);
                info.appendChild(descSpan);
                label.appendChild(cb);
                label.appendChild(info);
                modal.appendChild(label);

                checkboxes[feat.name] = cb;
            }

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex; justify-content:flex-end; gap:8px; margin-top:16px;';

            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancelar';
            cancelBtn.style.cssText = `
                padding:8px 16px; border-radius:8px; border:1px solid rgba(255,255,255,0.1);
                background:transparent; color:#ccc; cursor:pointer; font-family:inherit;
            `;

            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = 'Confirmar';
            confirmBtn.style.cssText = `
                padding:8px 16px; border-radius:8px; border:none;
                background:#3b82f6; color:#fff; cursor:pointer; font-weight:600; font-family:inherit;
            `;

            cancelBtn.onclick = () => {
                overlay.remove();
                resolve(undefined); // User cancelled
            };

            confirmBtn.onclick = () => {
                const selected = Object.entries(checkboxes)
                    .filter(([, cb]) => cb.checked)
                    .map(([name]) => name);
                overlay.remove();
                resolve(selected);
            };

            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(confirmBtn);
            modal.appendChild(btnRow);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
        });
    }

    async startGame(options, gamePath) {
        let launch = new Launch();
        let configClient = await this.db.readData('configClient');
        let authenticator = await this.db.readData('accounts', configClient.account_selected);

        let playBtn = document.getElementById('detail-play-btn');
        let btnContent = document.getElementById('detail-play-btn-content');
        let btnSpinner = document.getElementById('detail-play-btn-spinner');

        let progressContainer = document.getElementById('detail-progress');
        let progressText = document.getElementById('detail-progress-text');
        let progressPct = document.getElementById('detail-progress-pct');
        const wavyBar = document.getElementById('detail-progress-wavy');
        if (!progressContainer || !progressText || !progressPct || !wavyBar) {
            console.error('Progress DOM elements missing — cannot show sync progress');
        }

        // Normalize loader fields: support both old (loader_type/loader_version) and new (type/build) formats
        const loaderType = (options.loader?.loader_type || options.loader?.type || 'none').toLowerCase();
        let loaderVersion = options.loader?.loader_version || options.loader?.build || '';
        const mcVersion = options.loader?.minecraft_version || options.gameVersion || '1.20.1';

        // For Forge, the build must include the MC version prefix (e.g. "1.20.1-47.4.10")
        if (loaderType === 'forge' && loaderVersion && !loaderVersion.startsWith(mcVersion + '-')) {
            loaderVersion = mcVersion + '-' + loaderVersion;
        }

        const loaderEnabled = loaderType !== 'none' && loaderType !== 'vanilla' && loaderVersion !== '';

        let effectivePath = gamePath;
        let instanceName = options.name;

        // Cap memory to safe limits
        const totalMemGB = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        const maxSafeGB = Math.max(1, Math.trunc((60 * totalMemGB) / 100));
        let minGB = configClient.java_config?.java_memory?.min || 1;
        let maxGB = configClient.java_config?.java_memory?.max || 2;
        if (maxGB > maxSafeGB) maxGB = maxSafeGB;
        if (maxGB > 4) maxGB = 4;
        if (minGB > maxGB) minGB = 1;

        let opt = {
            url: options.url || undefined,
            authenticator: authenticator,
            timeout: 10000,
            path: effectivePath,
            instance: instanceName,
            version: mcVersion,
            detached: configClient.launcher_config?.closeLauncher == "close-all" ? false : true,
            downloadFileMultiple: configClient.launcher_config?.download_multi || 5,
            intelEnabledMac: configClient.launcher_config?.intelEnabledMac ?? true,

            loader: {
                type: loaderType === 'vanilla' ? 'none' : loaderType,
                build: loaderVersion,
                enable: loaderEnabled
            },

            verify: options.modpack_url ? false : (options.verify ?? true),
            ignored: options.ignored ? [...options.ignored] : [],

            java: {
                path: configClient.java_config?.java_path || null,
            },

            JVM_ARGS: [...(configClient.java_config?.jvm_args || []), ...(options.jvm_args || [])],
            GAME_ARGS: options.game_args ? options.game_args : [],

            screen: {
                width: configClient.game_config?.screen_size?.width || 854,
                height: configClient.game_config?.screen_size?.height || 480
            },

            memory: {
                min: `${minGB * 1024}M`,
                max: `${maxGB * 1024}M`
            }
        };

        // Prevent launching while already launching
        if (this._launching) {
            new popup().openPopup({
                title: 'Ya hay una instancia iniciando',
                content: 'Esperá a que la instancia actual termine de iniciarse.',
                color: 'orange',
                options: true
            });
            return;
        }
        this._launching = true;
        this._launchingInstance = options.name;

        // Migration: if version stored but new-path instance dir doesn't exist, reset version to force re-sync
        const newPathDir = path.join(gamePath, 'instances', options.name);
        const oldPathDir = path.join(gamePath, options.name);
        if (configClient.instances_versions?.[options.name]) {
            const hasNewFiles = fs.existsSync(newPathDir) && fs.readdirSync(newPathDir).length > 0;
            const hasOldFiles = fs.existsSync(oldPathDir) && fs.readdirSync(oldPathDir).length > 0;
            if (!hasNewFiles && hasOldFiles) {
                // One-time migration: copy old game files to new instances/ path so settings are preserved
                try {
                    fs.cpSync(oldPathDir, newPathDir, { recursive: true, force: false });
                } catch (e) {
                    console.error('Migration copy failed:', e);
                }
                delete configClient.instances_versions[options.name];
                await this.db.updateData('configClient', configClient);
            }
        }

        // Transition Play Button to Loading Spinner, show floating progress card
        if (btnContent) btnContent.style.display = 'none';
        if (btnSpinner) btnSpinner.style.display = 'flex';
        playBtn.disabled = true;

        if (progressContainer) progressContainer.style.display = 'flex';
        if (wavyBar) wavyBar.style.width = '0%';
        if (progressPct) progressPct.innerHTML = '0%';
        ipcRenderer.send('main-window-progress-load');

        // 1. Sync modpack (if applicable) — SKCraft-style with feature gating and version tracking
        if (options.modpack_url) {
            try {
                // Ask user to select optional features before syncing
                let enabledFeatures = configClient.instances_features?.[options.name] || [];
                const selectedFeatures = await this.showFeaturesModal(options.modpack_url);
                if (selectedFeatures === undefined) {
                    // User cancelled the features dialog
                    if (btnContent) btnContent.style.display = 'flex';
                    if (btnSpinner) btnSpinner.style.display = 'none';
                    playBtn.disabled = false;
                    if (progressContainer) progressContainer.style.display = 'none';
                    this._launching = false;
                    return;
                }
                if (selectedFeatures.length > 0) {
                    enabledFeatures = selectedFeatures;
                    if (!configClient.instances_features) configClient.instances_features = {};
                    configClient.instances_features[options.name] = enabledFeatures;
                    await this.db.updateData('configClient', configClient);
                }

                    if (progressText) progressText.innerHTML = `Sincronizando modpack con el servidor...`;

                // Read stored version for this instance
                const storedVersion = configClient.instances_versions?.[options.name] || null;

                const instancePath = path.join(gamePath, 'instances', options.name);

                const modpackSync = new ModpackSync(options.modpack_url, instancePath, {
                    enabledFeatures
                });

                this.showDownload(options.name, options.title || options.name);

                const result = await modpackSync.sync((progress, size, message) => {
                    const pct = ((progress / size) * 100).toFixed(0);
                    if (progressText) progressText.innerHTML = `${message} (${progress}/${size})`;
                    ipcRenderer.send('main-window-progress', { progress, size });
                    if (wavyBar) wavyBar.style.width = `${pct}%`;
                    if (progressPct) progressPct.innerHTML = `${pct}%`;
                    this.updateDownload(options.name, pct, message);
                }, storedVersion);

                this.hideDownload(options.name);

                if (result && result.version) {
                    // Store the new version
                    if (!configClient.instances_versions) configClient.instances_versions = {};
                    configClient.instances_versions[options.name] = result.version;
                    await this.db.updateData('configClient', configClient);

                    // Refresh instances grid so installed pack moves from "Todas" to "Instaladas"
                    await this.initInstances();
                    await this.selectInstance(options);

                    // Re-acquire DOM references after selectInstance replaced the play button via cloneNode
                    playBtn = document.getElementById('detail-play-btn');
                    btnContent = document.getElementById('detail-play-btn-content');
                    btnSpinner = document.getElementById('detail-play-btn-spinner');
                    progressContainer = document.getElementById('detail-progress');
                    progressText = document.getElementById('detail-progress-text');
                    progressPct = document.getElementById('detail-progress-pct');
                    if (progressContainer) progressContainer.style.display = 'flex';

                    // Re-apply loading state for remaining phases (NeoForge install, game launch)
                    if (btnContent) btnContent.style.display = 'none';
                    if (btnSpinner) btnSpinner.style.display = 'flex';
                    if (playBtn) playBtn.disabled = true;
                } else {
                    // Modpack sync skipped or failed (e.g. 404) — continue to NeoForge without mods
                    // DOM references from lines 1183-1185 are still valid (selectInstance was NOT called)
                }
            } catch (err) {
                this.hideDownload(options.name);
                let popupError = new popup();
                popupError.openPopup({
                    title: 'Error de Sincronización',
                    content: err.message,
                    color: 'red',
                    options: true
                });

                // Restore button state
                if (btnContent) btnContent.style.display = 'flex';
                if (btnSpinner) btnSpinner.style.display = 'none';
                playBtn.disabled = false;
                if (progressContainer) progressContainer.style.display = 'none';
                this._launching = false;
                this._launchingInstance = null;

                new logger(pkg.name, '#7289da');
                this.minecraftProcess = null;
                return;
            }
        }

        const sessionStartTime = Date.now();

        const endSession = async () => {
            try {
                const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
                if (elapsed > 5) {
                    let sessions = await this.db.readAllData('sessions') || [];
                    const existing = sessions.find(s => s.instance === options.name && !s.endTime);
                    if (!existing) {
                        await this.db.createData('sessions', {
                            instance: options.name,
                            playtime_seconds: elapsed,
                            startTime: sessionStartTime,
                            endTime: Date.now()
                        });
                    } else {
                        existing.playtime_seconds += elapsed;
                        existing.endTime = Date.now();
                        await this.db.updateData('sessions', existing, existing.ID);
                    }
                }
            } catch (e) {
                console.error('Failed to save session:', e);
            }
        };

        launch.Launch(opt);

        this.minecraftProcess = launch;

        launch.on('progress', (progress, size) => {
            const pct = ((progress / size) * 100).toFixed(0);
            if (progressText) progressText.innerHTML = `Descargando dependencias (${progress}/${size})`;
            if (wavyBar) wavyBar.style.width = `${pct}%`;
            if (progressPct) progressPct.innerHTML = `${pct}%`;
            ipcRenderer.send('main-window-progress', { progress, size });
        });

        launch.on('check', (progress, size) => {
            const pct = ((progress / size) * 100).toFixed(0);
            if (progressText) progressText.innerHTML = `Verificando archivos (${progress}/${size})`;
            if (wavyBar) wavyBar.style.width = `${pct}%`;
            if (progressPct) progressPct.innerHTML = `${pct}%`;
            ipcRenderer.send('main-window-progress', { progress, size });
        });

        launch.on('data', (e) => {
            new logger('Minecraft', '#7289da').info(e.trim());
        });

        launch.on('close', async code => {
            await endSession();
            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send('main-window-show');
            }
            ipcRenderer.send('main-window-progress-reset');

            if (btnContent) btnContent.style.display = 'flex';
            if (btnSpinner) btnSpinner.style.display = 'none';
            playBtn.disabled = false;
            if (progressContainer) progressContainer.style.display = 'none';
            this._launching = false;

            new logger(pkg.name, '#7289da').info(`Minecraft cerrado (código ${code})`);
            this.minecraftProcess = null;
        });

        launch.on('error', async err => {
            await endSession();

            let errorMsg = err.error || err.message || err;
            if (typeof errorMsg === 'string' && errorMsg.includes('Could not create the Java Virtual Machine')) {
                errorMsg = 'No se pudo iniciar la máquina virtual de Java. Esto suele ocurrir cuando la memoria asignada es demasiado alta para tu sistema o cuando usas Java 32 bits.\n\nProbá reducir la memoria en Ajustes → RAM.';
            }
            let popupError = new popup();
            popupError.openPopup({
                title: 'Error de Inicio',
                content: errorMsg,
                color: 'red',
                options: true
            });

            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show");
            }
            ipcRenderer.send('main-window-progress-reset');

            if (btnContent) btnContent.style.display = 'flex';
            if (btnSpinner) btnSpinner.style.display = 'none';
            playBtn.disabled = false;
            if (progressContainer) progressContainer.style.display = 'none';
            this._launching = false;

            new logger(pkg.name, '#7289da');
            this.minecraftProcess = null;
        });
    }

    /* ==========================================================================
       MERGED GENERAL SETTINGS CONTROLLER LOGIC
       ========================================================================== */
    async initSettings() {
        await this.settingsRam();
        await this.settingsJavaPath();
        await this.settingsResolution();
        await this.settingsLauncher();
    }

    async settingsRam() {
        let activeConfig = await this.db.readData('configClient');
        let totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        let freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;

        const totalEl = document.getElementById("total-ram");
        const freeEl = document.getElementById("free-ram");
        if (totalEl) totalEl.textContent = `${totalMem} GB`;
        if (freeEl) freeEl.textContent = `${freeMem} GB`;

        const maxSlider = Math.max(1, Math.trunc((80 * totalMem) / 100));

        let ram = activeConfig?.java_config?.java_memory || { min: 1, max: 2 };

        const minInput = document.querySelector('.ram-min-input');
        const maxInput = document.querySelector('.ram-max-input');
        const stepBtns = document.querySelectorAll('.ram-step-btn');

        if (minInput) minInput.value = Math.round(ram.min * 10) / 10;
        if (maxInput) maxInput.value = Math.round(ram.max * 10) / 10;

        const clamp = (val) => Math.round(Math.min(Math.max(val, 0.5), maxSlider) * 10) / 10;

        const saveRam = async (min, max) => {
            let cfg = await this.db.readData('configClient');
            if (!cfg.java_config) cfg.java_config = {};
            cfg.java_config.java_memory = { min: clamp(min), max: clamp(max) };
            await this.db.updateData('configClient', cfg);
        };

        if (minInput) {
            const syncMax = () => {
                const m = clamp(parseFloat(minInput.value) || 1);
                const M = clamp(parseFloat(maxInput.value) || 2);
                if (m > M) { minInput.value = M; }
            };
            minInput.addEventListener('change', async () => {
                let val = clamp(parseFloat(minInput.value) || 1);
                let M = clamp(parseFloat(maxInput.value) || 2);
                if (val > M) val = M;
                minInput.value = val;
                await saveRam(val, M);
            });
            minInput.addEventListener('input', syncMax);
        }

        if (maxInput) {
            const syncMin = () => {
                const m = clamp(parseFloat(minInput?.value) || 1);
                const M = clamp(parseFloat(maxInput.value) || 2);
                if (M < m) { maxInput.value = m; }
            };
            maxInput.addEventListener('change', async () => {
                let val = clamp(parseFloat(maxInput.value) || 2);
                let m = clamp(parseFloat(minInput?.value) || 1);
                if (val < m) val = m;
                maxInput.value = val;
                await saveRam(m, val);
            });
            maxInput.addEventListener('input', syncMin);
        }

        if (stepBtns) {
            stepBtns.forEach(btn => {
                btn.addEventListener('click', async () => {
                    const target = btn.dataset.target;
                    const dir = parseInt(btn.dataset.dir);
                    const inp = target === 'min' ? minInput : maxInput;
                    if (!inp) return;
                    let current = clamp((parseFloat(inp.value) || 1) + dir * 0.5);
                    let other = target === 'min'
                        ? clamp(parseFloat(maxInput?.value) || 2)
                        : clamp(parseFloat(minInput?.value) || 1);
                    if (target === 'min' && current > other) current = other;
                    if (target === 'max' && current < other) current = other;
                    inp.value = current;
                    await saveRam(
                        clamp(parseFloat(minInput?.value) || 1),
                        clamp(parseFloat(maxInput?.value) || 2)
                    );
                });
            });
        }
    };

    async settingsJavaPath() {
        let javaPathText = document.querySelector(".java-path-txt");
        if (javaPathText) {
            javaPathText.textContent = `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}/runtime`;
        }

        let configClient = await this.db.readData('configClient');
        let javaPath = configClient?.java_config?.java_path || 'Utiliser la version de java livre avec le launcher';
        let javaPathInputTxt = document.querySelector(".java-path-input-text");
        let javaPathInputFile = document.querySelector(".java-path-input-file");
        if (javaPathInputTxt) javaPathInputTxt.value = javaPath;

        const setBtn = document.querySelector(".java-path-set");
        setBtn?.replaceWith(setBtn.cloneNode(true));
        document.querySelector(".java-path-set")?.addEventListener("click", async () => {
            javaPathInputFile.value = '';
            javaPathInputFile.click();
            await new Promise((resolve) => {
                let interval;
                interval = setInterval(() => {
                    if (javaPathInputFile.value != '') resolve(clearInterval(interval));
                }, 100);
            });

            if (javaPathInputFile.value.replace(".exe", '').endsWith("java") || javaPathInputFile.value.replace(".exe", '').endsWith("javaw")) {
                let currentConfig = await this.db.readData('configClient');
                let file = javaPathInputFile.files[0].path;
                javaPathInputTxt.value = file;
                currentConfig.java_config.java_path = file;
                await this.db.updateData('configClient', currentConfig);
            } else alert("El nombre del archivo debe ser java o javaw");
        });

        const resetBtn = document.querySelector(".java-path-reset");
        resetBtn?.replaceWith(resetBtn.cloneNode(true));
        document.querySelector(".java-path-reset")?.addEventListener("click", async () => {
            let currentConfig = await this.db.readData('configClient');
            javaPathInputTxt.value = 'Utiliser la version de java livre avec le launcher';
            currentConfig.java_config.java_path = null;
            await this.db.updateData('configClient', currentConfig);
        });
    }

    async settingsResolution() {
        let configClient = await this.db.readData('configClient');
        let resolution = configClient?.game_config?.screen_size || { width: 1920, height: 1080 };

        let width = document.querySelector(".width-size");
        let height = document.querySelector(".height-size");
        let resolutionReset = document.querySelector(".size-reset");

        if (width) width.value = resolution.width;
        if (height) height.value = resolution.height;

        width?.replaceWith(width.cloneNode(true));
        const newWidth = document.querySelector(".width-size");
        newWidth?.addEventListener("change", async () => {
            let currentConfig = await this.db.readData('configClient');
            currentConfig.game_config.screen_size.width = newWidth.value;
            await this.db.updateData('configClient', currentConfig);
        });

        height?.replaceWith(height.cloneNode(true));
        const newHeight = document.querySelector(".height-size");
        newHeight?.addEventListener("change", async () => {
            let currentConfig = await this.db.readData('configClient');
            currentConfig.game_config.screen_size.height = newHeight.value;
            await this.db.updateData('configClient', currentConfig);
        });

        resolutionReset?.replaceWith(resolutionReset.cloneNode(true));
        document.querySelector(".size-reset")?.addEventListener("click", async () => {
            let currentConfig = await this.db.readData('configClient');
            currentConfig.game_config.screen_size = { width: '854', height: '480' };
            newWidth.value = '854';
            newHeight.value = '480';
            await this.db.updateData('configClient', currentConfig);
        });
    }

    async settingsLauncher() {
        let configClient = await this.db.readData('configClient');

        let maxDownloadFiles = configClient?.launcher_config?.download_multi || 5;
        let maxDownloadFilesInput = document.querySelector(".max-files");
        let maxDownloadFilesReset = document.querySelector(".max-files-reset");
        if (maxDownloadFilesInput) maxDownloadFilesInput.value = maxDownloadFiles;

        maxDownloadFilesInput?.replaceWith(maxDownloadFilesInput.cloneNode(true));
        const newMaxFiles = document.querySelector(".max-files");
        newMaxFiles?.addEventListener("change", async () => {
            let currentConfig = await this.db.readData('configClient');
            currentConfig.launcher_config.download_multi = newMaxFiles.value;
            await this.db.updateData('configClient', currentConfig);
        });

        maxDownloadFilesReset?.replaceWith(maxDownloadFilesReset.cloneNode(true));
        document.querySelector(".max-files-reset")?.addEventListener("click", async () => {
            let currentConfig = await this.db.readData('configClient');
            newMaxFiles.value = 5;
            currentConfig.launcher_config.download_multi = 5;
            await this.db.updateData('configClient', currentConfig);
        });

        let closeBox = document.querySelector(".close-box");
        let closeLauncher = configClient?.launcher_config?.closeLauncher || "close-launcher";

        // Remove old active classes
        document.querySelectorAll('.behavior-btn').forEach(b => b.classList.remove('active-close'));

        if (closeLauncher == "close-launcher") {
            document.querySelector('.close-launcher')?.classList.add('active-close');
        } else if (closeLauncher == "close-all") {
            document.querySelector('.close-all')?.classList.add('active-close');
        } else if (closeLauncher == "close-none") {
            document.querySelector('.close-none')?.classList.add('active-close');
        }

        closeBox?.replaceWith(closeBox.cloneNode(true));
        const newCloseBox = document.querySelector(".close-box");
        newCloseBox?.addEventListener("click", async e => {
            if (e.target.classList.contains('behavior-btn')) {
                let activeClose = document.querySelector('.active-close');
                if (e.target.classList.contains('active-close')) return;
                activeClose?.classList.remove('active-close');

                let currentConfig = await this.db.readData('configClient');

                if (e.target.classList.contains('close-launcher')) {
                    e.target.classList.add('active-close');
                    currentConfig.launcher_config.closeLauncher = "close-launcher";
                } else if (e.target.classList.contains('close-all')) {
                    e.target.classList.add('active-close');
                    currentConfig.launcher_config.closeLauncher = "close-all";
                } else if (e.target.classList.contains('close-none')) {
                    e.target.classList.add('active-close');
                    currentConfig.launcher_config.closeLauncher = "close-none";
                }
                await this.db.updateData('configClient', currentConfig);
            }
        });
    }

    async setBackground(theme) {
        if (typeof theme == 'undefined') {
            let databaseLauncher = new database();
            let configClient = await databaseLauncher.readData('configClient');
            theme = configClient?.launcher_config?.theme || "auto";
            theme = await ipcRenderer.invoke('is-dark-theme', theme).then(res => res);
        }
        let body = document.body;
        body.className = theme ? 'dark global' : 'light global';
    }

    getdate(e) {
        let date = new Date(e);
        let year = date.getFullYear();
        let month = date.getMonth() + 1;
        let day = date.getDate();
        let allMonth = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        return { year: year, month: allMonth[month - 1], day: day };
    };
}

export default Home;