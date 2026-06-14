import { config, database, logger, changePanel, appdata, setStatus, pkg, popup, ModpackSync, skin2D, accountSelect } from '../utils.js';

const { Launch } = require('minecraft-java-core');
const { shell, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fetch = require('node-fetch');
const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);

class Home {
    static id = "home";
    _launching = false;
    _launchingInstance = null;
    _instanceStatus = new Map(); // instanceName → 'downloading' | 'installing' | 'running'

    async init(config) {
        this.config = config;
        this.db = new database();
        this.minecraftProcess = null;

        const gamePath = `${await appdata()}/.yusup`;
        this.gamePath = gamePath;

        // Initialize user skin / head avatar
        await this.initUserAvatar();

        // Header frame controls (minimize/close)
        this.setupHeaderControls();

        // Account dropdown toggle
        this.setupAccountDropdown();

        // 1. Load news section
        this.news();

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
        this._allInstancesCache = [];

        // Clear stale running_instance — app restarted, process is gone
        const ccCheck = await this.db.readData('configClient');
        if (ccCheck && ccCheck.running_instance) {
            delete ccCheck.running_instance;
            await this.db.updateData('configClient', ccCheck);
        }

        // Refresh button
        document.getElementById('btn-refresh-instances')?.addEventListener('click', () => {
            this.initInstances();
        });

        // 4. Initialize Settings
        await this.initSettings();

        // 5. Initialize Calendar
        this.initCalendar();

        // 6. Initialize Search Overlay
        this.setupSearchOverlay();

        // Auto-refresh instances every 30s
        this._refreshTimer = setInterval(() => {
            this.initInstances();
        }, 30000);
    }

    async initUserAvatar() {
        try {
            let configClient = await this.db.readData('configClient');
            let auth = configClient?.account_selected ? await this.db.readData('accounts', configClient.account_selected) : null;
            const setAvatar = async (el) => {
                if (!el) return;
                try {
                    if (auth) {
                        let skinUrl = await this._getSkinUrl(auth);
                        if (skinUrl) {
                            el.style.background = `url(${skinUrl}) center / cover`;
                            el.innerHTML = '';
                            return;
                        }
                    }
                } catch (e) {}
                // Ultimate fallback: always show something
                try {
                    const defaultPath = path.join(__dirname, '../../images/default/setve.png');
                    if (fs.existsSync(defaultPath)) {
                        const buf = fs.readFileSync(defaultPath);
                        const b64 = buf.toString('base64');
                        el.style.background = `url('data:image/png;base64,${b64}') center / cover`;
                        el.innerHTML = '';
                        return;
                    }
                } catch (e) {}
                el.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
                el.innerHTML = '<span style="color:#fff;font-size:16px;font-weight:700;">' + (auth?.name ? auth.name.charAt(0).toUpperCase() : '?') + '</span>';
            };
            setAvatar(document.querySelector('#top-profile-avatar'));
            setAvatar(document.querySelector('#dropdown-avatar-large'));
        } catch (e) {}
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
                            <img src="assets/images/png/home.png" width="32" height="32" alt="news">
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

    setupHeaderControls() {
        const minimizeBtn = document.getElementById('header-btn-minimize');
        if (minimizeBtn) {
            minimizeBtn.addEventListener('click', () => {
                const { ipcRenderer } = require('electron');
                ipcRenderer.send('main-window-minimize');
            });
        }
        const closeBtn = document.getElementById('header-btn-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                const { ipcRenderer } = require('electron');
                ipcRenderer.send('main-window-close');
            });
        }
    }

    setupSearchOverlay() {
        const container = document.getElementById('search-container');
        const searchBtn = document.getElementById('header-search-btn');
        const input = document.getElementById('search-input-field');
        const dropdown = document.getElementById('search-results-dropdown');
        if (!container || !searchBtn || !input || !dropdown) return;

        let allInstances = [];
        let allEvents = [];

        const searchColors = ['#192E03','#3B5E0B','#5C8F14','#7DBF1C','#9EEF24','#D8F999','#A8B87C','#6B8E23','#556B2F','#4A7C59'];

        const refreshData = () => {
            allInstances = this._instancesList || [];
            allEvents = this._calEvents || [];
        };

        const getInitial = (name) => (name ? name.charAt(0).toUpperCase() : '?');

        const getColor = (name) => {
            if (!name) return searchColors[0];
            let hash = 0;
            for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
            return searchColors[Math.abs(hash) % searchColors.length];
        };

        const renderResults = (query) => {
            const q = query.trim().toLowerCase();
            dropdown.innerHTML = '';

            // Modpacks
            const filteredPacks = q
                ? allInstances.filter(p => (p.title || p.name).toLowerCase().includes(q))
                : allInstances;

            // Events
            const filteredEvents = q
                ? allEvents.filter(e => e.title.toLowerCase().includes(q))
                : allEvents;

            const hasPacks = filteredPacks.length > 0;
            const hasEvents = filteredEvents.length > 0;

            if (!hasPacks && !hasEvents) {
                dropdown.innerHTML = '<p class="search-result-hint">No se encontraron resultados.</p>';
                return;
            }

            if (hasPacks) {
                const title = document.createElement('div');
                title.className = 'search-result-section-title';
                title.textContent = 'Modpacks';
                dropdown.appendChild(title);

                filteredPacks.forEach(pack => {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    const name = pack.title || pack.name;
                    const initial = getInitial(name);
                    const color = getColor(name);
                    const searchThumb = pack.banner || pack.poster || '';
                    let iconHtml;
                    if (searchThumb) {
                        iconHtml = `<div class="search-result-icon"><img src="${searchThumb}" alt=""></div>`;
                    } else {
                        iconHtml = `<div class="search-result-icon" style="background:${color}">${initial}</div>`;
                    }
                    const loaderLabel = (pack.loader?.type || '').toUpperCase();
                    item.innerHTML = `
                        ${iconHtml}
                        <div class="search-result-info">
                            <span class="search-result-name">${name}</span>
                            <span class="search-result-meta">${pack.gameVersion || pack.loader?.minecraft_version || ''} ${loaderLabel ? '· ' + loaderLabel : ''}</span>
                        </div>
                        ${loaderLabel ? `<span class="search-result-tag">${loaderLabel}</span>` : ''}
                    `;
                    item.addEventListener('click', () => {
                        container.classList.remove('open');
                        this.selectInstance(pack);
                    });
                    dropdown.appendChild(item);
                });
            }

            if (hasEvents) {
                const title = document.createElement('div');
                title.className = 'search-result-section-title';
                title.textContent = 'Eventos';
                dropdown.appendChild(title);

                filteredEvents.forEach(ev => {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';
                    const dateStr = ev.date || '';
                    const timeStr = ev.time || 'Todo el día';
                    item.innerHTML = `
                        <span class="search-result-dot"></span>
                        <div class="search-result-info">
                            <span class="search-result-name">${ev.title}</span>
                            <span class="search-result-meta">${dateStr} · ${timeStr}</span>
                        </div>
                    `;
                    item.addEventListener('click', () => {
                        container.classList.remove('open');
                        // Switch to calendar view and select this date
                        document.getElementById('nav-btn-calendar')?.click();
                        if (ev.date) {
                            this._calSelectedDate = ev.date;
                            this.renderEventsForDay(ev.date);
                        }
                    });
                    dropdown.appendChild(item);
                });
            }
        };

        searchBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await refreshData();
            const isOpen = container.classList.contains('open');
            if (isOpen) {
                container.classList.remove('open');
            } else {
                container.classList.add('open');
                setTimeout(() => input.focus(), 100);
            }
        });

        input.addEventListener('input', () => {
            if (input.value.trim()) {
                renderResults(input.value);
            } else {
                const dropdown = document.getElementById('search-results-dropdown');
                if (dropdown) dropdown.innerHTML = '';
            }
        });

        input.addEventListener('blur', () => {
            setTimeout(() => {
                if (!input.value.trim()) container.classList.remove('open');
            }, 200);
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#search-container')) {
                container.classList.remove('open');
            }
        });
    }

    setupNavigation() {
        const navButtons = document.querySelectorAll('.sidebar-item.nav-btn');
        const views = document.querySelectorAll('.dashboard-view');

        navButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                let targetViewId = '';
                if (btn.id === 'nav-btn-home') { targetViewId = 'view-home'; }
                else if (btn.id === 'nav-btn-instances') { targetViewId = 'view-instances'; }
                else if (btn.id === 'nav-btn-settings') { targetViewId = 'view-settings'; }
                else if (btn.id === 'nav-btn-calendar') { targetViewId = 'view-calendar'; }

                if (!targetViewId) return;

                navButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                views.forEach(v => v.classList.remove('active'));
                document.getElementById(targetViewId)?.classList.add('active');

                // Close account dropdown
                const accDropdown = document.querySelector('.account-dropdown-overlay');
                if (accDropdown) accDropdown.classList.remove('open');
            });
        });

        // Logo click -> Home
        const logoBtn = document.getElementById('top-logo-btn');
        if (logoBtn) {
            logoBtn.addEventListener('click', () => {
                navButtons.forEach(b => b.classList.remove('active'));
                document.getElementById('nav-btn-home')?.classList.add('active');
                views.forEach(v => v.classList.remove('active'));
                document.getElementById('view-home')?.classList.add('active');
            });
        }
    }

    setupAccountDropdown() {
        this._accountOverlay = document.querySelector('.account-dropdown-overlay');
        const avatar = document.getElementById('top-profile-btn');
        if (!avatar || !this._accountOverlay) return;

        avatar.addEventListener('click', async (e) => {
            e.stopPropagation();
            const isOpen = this._accountOverlay.classList.contains('open');
            document.querySelectorAll('.account-dropdown-overlay').forEach(d => d.classList.remove('open'));
            const menu = document.querySelector('.account-dropdown-menu');
            if (menu) menu.classList.remove('expanded-dropdown');
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
            addBtn.addEventListener('click', async () => {
                if (this._accountOverlay) this._accountOverlay.classList.remove('open');
                const accounts = await this.db.readAllData('accounts');
                const show = accounts?.length > 0;
                document.querySelectorAll('.cancel-login').forEach(el => {
                    el.style.display = show ? 'inline' : 'none';
                });
                changePanel('login');
            });
        }

        // Logout button: delete current account and go to login
        const logoutBtn = document.getElementById('dropdown-btn-logout');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async () => {
                if (this._accountOverlay) this._accountOverlay.classList.remove('open');
                let configClient = await this.db.readData('configClient');
                const selectedId = configClient.account_selected;

                // Remove DOM elements for the deleted account
                if (selectedId) {
                    document.getElementById(selectedId)?.remove();
                    document.getElementById(`delete-${selectedId}`)?.closest('.account')?.remove();
                    document.getElementById(`switch-${selectedId}`)?.remove();
                    await this.db.deleteData('accounts', selectedId);
                }

                configClient.account_selected = null;
                await this.db.updateData('configClient', configClient);

                // Reset avatars to default gradient
                const avatarEl = document.querySelector('#top-profile-avatar');
                if (avatarEl) {
                    avatarEl.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
                    avatarEl.style.backgroundImage = 'none';
                    avatarEl.innerHTML = '<span style="color:#fff;font-size:16px;font-weight:700;">?</span>';
                }
                const largeAvatar = document.querySelector('#dropdown-avatar-large');
                if (largeAvatar) {
                    largeAvatar.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
                    largeAvatar.style.backgroundImage = 'none';
                    largeAvatar.innerHTML = '<span style="color:#fff;font-size:24px;font-weight:700;">?</span>';
                }

                // Auto-switch to another account or go to login
                let accounts = await this.db.readAllData('accounts');
                if (accounts.length > 0) {
                    configClient.account_selected = accounts[0].ID;
                    await this.db.updateData('configClient', configClient);
                    await accountSelect(accounts[0]);
                    await this.initUserAvatar();
                    await this.setupAccountView();
                    await this.initInstances();
                    await this.populateAccountDropdown();
                    document.querySelectorAll('.cancel-login').forEach(el => {
                        el.style.display = 'inline';
                    });
                    document.dispatchEvent(new Event('accounts-changed'));
                } else {
                    await this.db.updateData('configClient', configClient);
                    changePanel('login');
                }
            });
        }

        // Listen for account changes and refresh the dropdown and avatar
        document.addEventListener('accounts-changed', () => {
            this.initUserAvatar();
            this.populateAccountDropdown(false);
            // If dropdown is open and expanded, re-render the list immediately
            if (this._accountOverlay && this._accountOverlay.classList.contains('open')) {
                const section = document.getElementById('dropdown-accounts-section');
                const listEl = document.getElementById('dropdown-accounts-list');
                if (section && section.classList.contains('expanded') && listEl) {
                    this.db.readData('configClient').then(cc => {
                        this.db.readAllData('accounts').then(accounts => {
                            this._renderAccountList(listEl, accounts, cc.account_selected, this._accountOverlay);
                        });
                    });
                }
            }
            this.loadAccountsSwitcherList();
        });
    }

    async populateAccountDropdown(resetState = true) {
        const overlay = this._accountOverlay;
        let configClient = await this.db.readData('configClient');
        let accounts = await this.db.readAllData('accounts');
        const currentAccount = configClient.account_selected
            ? accounts.find(a => a.ID === configClient.account_selected)
            : null;

        // Update current account header
        const nameEl = document.getElementById('dropdown-current-name');
        if (nameEl) nameEl.textContent = currentAccount?.name || 'Sin cuenta';
        this._loadAvatarToEl('dropdown-avatar-large', currentAccount);

        // Setup expandable section
        const section = document.getElementById('dropdown-accounts-section');
        const toggle = document.getElementById('dropdown-section-toggle');
        const body = document.getElementById('dropdown-accounts-body');
        const listEl = document.getElementById('dropdown-accounts-list');
        const menu = document.querySelector('.account-dropdown-menu');
        if (!section || !toggle || !body || !listEl) return;

        if (resetState) {
            section.classList.remove('expanded');
            if (menu) menu.classList.remove('expanded-dropdown');
        }

        // Remove old listeners by cloning
        const newToggle = toggle.cloneNode(true);
        toggle.replaceWith(newToggle);

        newToggle.addEventListener('click', () => {
            section.classList.toggle('expanded');
            const isExpanded = section.classList.contains('expanded');
            if (menu) menu.classList.toggle('expanded-dropdown', isExpanded);
            const span = newToggle.querySelector('span');
            if (span) {
                span.textContent = isExpanded ? 'Ocultar más cuentas' : 'Cambiar de cuenta';
            }
            if (isExpanded) {
                this._renderAccountList(listEl, accounts, configClient.account_selected, overlay);
            }
        });
    }

    // Helper: load avatar into any element
    _loadAvatarToEl(elId, account) {
        const el = document.getElementById(elId);
        if (!el || !account) return;
        // Set initial gradient
        el.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
        el.innerHTML = '<span style="color:#fff;font-size:16px;font-weight:700;">' + (account.name ? account.name.charAt(0).toUpperCase() : '?') + '</span>';
        // Load avatar in background
        this._getSkinUrl(account).then(url => {
            if (url) {
                el.style.background = `url(${url}) center / cover`;
                el.innerHTML = '';
            }
        }).catch(() => {});
    }


    // Cache skin URLs to avoid repeated fetches
    _skinCache = new Map();
    async _getSkinUrl(acc) {
        if (this._skinCache.has(acc.ID)) return this._skinCache.get(acc.ID);
        try {
            let headUrl = null;
            // 1. Try base64 skin -> render head
            if (acc?.profile?.skins?.[0]?.base64) {
                try {
                    headUrl = await new skin2D().creatHeadTexture(acc.profile.skins[0].base64);
                } catch (e) {}
            }
            // 2. Try skin URL -> fetch image -> render head
            if (!headUrl && acc?.profile?.skins?.[0]?.url) {
                try {
                    const res = await fetch(acc.profile.skins[0].url);
                    if (res.ok) {
                        const blob = await res.blob();
                        const reader = new FileReader();
                        headUrl = await new Promise((resolve) => {
                            reader.onload = async () => {
                                const b64 = reader.result.split(',')[1];
                                try {
                                    const head = await new skin2D().creatHeadTexture(b64);
                                    resolve(head);
                                } catch { resolve(null); }
                            };
                            reader.readAsDataURL(blob);
                        });
                    }
                } catch (e) {}
            }
            // 3. Try Mojang sessionserver for premium accounts
            if (!headUrl && acc.uuid && (acc.meta?.type === 'Xbox' || acc.meta?.type === 'Mojang')) {
                try {
                    const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${acc.uuid.replace(/-/g, '')}`);
                    if (res.ok) {
                        const profile = await res.json();
                        const texProp = profile.properties?.find(p => p.name === 'textures');
                        if (texProp?.value) {
                            const tex = JSON.parse(Buffer.from(texProp.value, 'base64').toString());
                            if (tex.textures?.SKIN?.url) {
                                const skinRes = await fetch(tex.textures.SKIN.url);
                                if (skinRes.ok) {
                                    const blob = await skinRes.blob();
                                    const reader = new FileReader();
                                    headUrl = await new Promise((resolve) => {
                                        reader.onload = async () => {
                                            const b64 = reader.result.split(',')[1];
                                            try {
                                                const head = await new skin2D().creatHeadTexture(b64);
                                                resolve(head);
                                            } catch { resolve(null); }
                                        };
                                        reader.readAsDataURL(blob);
                                    });
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
            // 4. Fallback for offline accounts: try mc-heads (more reliable)
            if (!headUrl) {
                try {
                    const res = await fetch(`https://mc-heads.net/avatar/${acc.name || 'Steve'}/64`);
                    if (res.ok) {
                        const blob = await res.blob();
                        const reader = new FileReader();
                        headUrl = await new Promise((resolve) => {
                            reader.onload = () => resolve(reader.result);
                            reader.readAsDataURL(blob);
                        });
                    }
                } catch (e) {}
            }
            // 5. Ultimate fallback: use local setve.png image
            if (!headUrl) {
                try {
                    const defaultPath = path.join(__dirname, '../../images/default/setve.png');
                    if (fs.existsSync(defaultPath)) {
                        const buf = fs.readFileSync(defaultPath);
                        headUrl = `data:image/png;base64,${buf.toString('base64')}`;
                    }
                } catch (e) {}
            }
            if (headUrl) {
                this._skinCache.set(acc.ID, headUrl);
            }
            return headUrl;
        } catch (e) {
            return null;
        }
    }

    _getOfflineUuid(username) {
        const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username).digest('hex');
        return md5.substring(0, 8) + '-' + md5.substring(8, 12) + '-' + md5.substring(12, 16) + '-' + md5.substring(16, 20) + '-' + md5.substring(20, 32);
    }

    async _renderAccountList(listEl, accounts, selectedId, overlay) {
        listEl.innerHTML = '';
        for (let acc of accounts) {
            const item = document.createElement('div');
            const isActive = acc.ID === selectedId;
            item.className = 'dropdown-account-item' + (isActive ? ' active-account' : '');
            item.innerHTML = `
                <div class="dropdown-account-avatar" style="background:linear-gradient(135deg,var(--green-dark),var(--green-mid));display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:14px;font-weight:700;">${acc.name ? acc.name.charAt(0).toUpperCase() : '?'}</span></div>
                <div class="dropdown-account-name">${acc.name}</div>
            `;

            // Lazy load avatar
            this._getSkinUrl(acc).then(url => {
                if (url) {
                    const av = item.querySelector('.dropdown-account-avatar');
                    if (av) {
                        av.style.background = `url(${url}) center/cover`;
                        av.innerHTML = '';
                    }
                }
            }).catch(() => {});

            if (!isActive) {
                item.addEventListener('click', async (e) => {
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

                    document.dispatchEvent(new Event('accounts-changed'));
                    popupSwitch.closePopup();
                    overlay.classList.remove('open');
                });
            }

            listEl.appendChild(item);
        }
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

    _nameToHue(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return Math.abs(hash) % 360;
    }

    async setupAccountView() {
        // Account view removed from settings.
        // Still bind the Add Friend button (called during init).
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
        if (!selectedId) {
            const cc = await this.db.readData('configClient');
            selectedId = cc?.account_selected;
        }
        container.innerHTML = '';

        let accounts = await this.db.readAllData('accounts');
        for (let acc of accounts) {
            const accSkin = await this._getSkinUrl(acc).catch(() => null);
            const fallbackSkin = accSkin ? null : 'background:linear-gradient(135deg,var(--green-dark),var(--green-mid));display:flex;align-items:center;justify-content:center;';
            const fallbackContent = accSkin ? '' : `<span style="color:#fff;font-size:24px;font-weight:700;">${acc.name ? acc.name.charAt(0).toUpperCase() : '?'}</span>`;

            const card = document.createElement('div');
            card.classList.add('account');
            if (acc.ID === selectedId) {
                card.classList.add('account-select');
            }
            card.id = `switch-${acc.ID}`;
            card.innerHTML = `
                <div class="profile-image" style="${accSkin ? `background-image: url(${accSkin}); background-size: cover; background-position: center;` : fallbackSkin}">${fallbackContent}</div>
                <div class="profile-infos">
                    <div class="profile-pseudo">${acc.name}</div>
                    <div class="profile-uuid">${acc.uuid}</div>
                </div>
                <div class="delete-profile" id="delete-${acc.ID}">
                    <img src="assets/images/iconInterface/close.svg" width="14" height="14" alt="del">
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
                await this.loadAccountsSwitcherList(acc.ID);
                document.dispatchEvent(new Event('accounts-changed'));

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
                    await this.initUserAvatar();
                }
                await this.loadAccountsSwitcherList(currentConfig.account_selected);
                document.dispatchEvent(new Event('accounts-changed'));

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
                    <img src="assets/images/iconInterface/close.svg" width="14" height="14" alt="x">
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

        // Clear stale instance statuses on init
        this._instanceStatus.clear();
        this._launching = false;
        this._launchingInstance = null;

        // Detect creator server URL
        this._serverUrl = '';
        try {
            const userDataPath = await ipcRenderer.invoke('path-user-data');
            const serverConfigPath = path.join(userDataPath, 'creator-server.json');
            if (fs.existsSync(serverConfigPath)) {
                const sc = JSON.parse(fs.readFileSync(serverConfigPath, 'utf8'));
                if (sc.url) this._serverUrl = sc.url.replace(/\/+$/, '');
            }
        } catch (e) {}

        // Cache instances for offline use
        const serverOnline = instancesList.length > 0;
        if (serverOnline) {
            configClient.creator_server_cache = instancesList;
            await this.db.updateData('configClient', configClient);
        } else if (configClient.creator_server_cache) {
            instancesList = configClient.creator_server_cache;
        }
        this._serverOnline = serverOnline;
        this._instancesList = instancesList;

        // Normalize loader: support both string (legacy) and object formats
        instancesList = instancesList.map(pack => {
            if (typeof pack.loader === 'string') {
                pack.loader = {
                    type: pack.loader,
                    build: pack.loaderVersion || '',
                    enable: pack.loader !== 'vanilla'
                };
            }
            return pack;
        });

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

        // 2. Merge creator tools modpacks — only when creator server is OFFLINE
        //    (when server is online, instancesList already includes them)
        if (!this._serverOnline) {
        const userDataPath = await ipcRenderer.invoke('path-user-data');
        const creatorPath = path.join(userDataPath, 'creator-modpacks.json');
        const resolvedCreatorPath = fs.existsSync(creatorPath) ? creatorPath : null;
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
                        whitelist: c.whitelist || [],
                        poster: c.poster ? `file:///${path.resolve(c.location, c.poster).replace(/\\/g, '/')}` : null,
                        banner: c.banner ? `file:///${path.resolve(c.location, c.banner).replace(/\\/g, '/')}` : null
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
        }

        // Deduplicate: remove packs with duplicate names (prefer remote over creator-local)
        const seen = new Set();
        installedPacks = installedPacks.filter(p => {
            if (seen.has(p.name)) return false;
            seen.add(p.name);
            return true;
        });
        allPacks = allPacks.filter(p => {
            if (seen.has(p.name)) return false;
            seen.add(p.name);
            return true;
        });

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
            const isAll = containerId === 'instances-grid-all';
            const msg = isAll && !this._serverOnline
                ? 'Servidor del Creator apagado. Abrí el Creator Tools e iniciá el servidor HTTP.'
                : 'No hay modpacks en esta sección.';
            gridContainer.innerHTML = `<div style="grid-column: span 4; color: #64748b; font-size: 0.85em; text-align: center; padding: 20px;">${msg}</div>`;
            return;
        }

        const now = Date.now();

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
            if (status === 'downloading') statusTag = '<span class="modpack-grid-tag descargando">Descargando</span>';
            else if (status === 'installing') statusTag = '<span class="modpack-grid-tag instalando">Instalando</span>';
            else if (status === 'running' || status === 'playing') statusTag = '<span class="modpack-grid-tag jugando">Jugando</span>';

            // "Nuevo" tag: show if pack was created/added in the last 7 days
            let newTag = '';
            const firstSeen = pack._firstSeen || this._getFirstSeen(pack.name);
            if (firstSeen && (now - firstSeen) < 7 * 24 * 60 * 60 * 1000) {
                newTag = '<span class="modpack-grid-tag nuevo">Nuevo</span>';
            }

            const tags = pack.tags || [];
            let tagsHtml = '';
            if (tags.length > 0) {
                tagsHtml = `<div class="modpack-grid-tags">${tags.slice(0, 3).map(t => `<span class="modpack-grid-tag-item">${t}</span>`).join('')}${tags.length > 3 ? `<span class="modpack-grid-tag-overflow">+${tags.length - 3}</span>` : ''}</div>`;
            }

            const thumbSrc = pack.banner || pack.poster || '';
            const thumbStyle = thumbSrc ? `style="background-image: url('${thumbSrc}'); background-size: cover; background-position: center;"` : '';
            card.innerHTML = `
                <div class="modpack-grid-thumb" ${thumbStyle}>
                    ${!thumbSrc ? `<img src="assets/images/png/logo.png" width="28" height="28" alt="pack">` : ''}
                    ${statusTag}
                    ${newTag}
                </div>
                <div class="modpack-grid-info">
                    <div class="modpack-grid-info-top">
                        <h3 class="modpack-grid-name">${pack.title || pack.name}</h3>
                        ${totalSeconds > 0 ? `<span class="modpack-grid-playtime">${playtimeStr}</span>` : ''}
                    </div>
                    ${tagsHtml}
                </div>
            `;

            card.addEventListener('click', () => {
                this.selectInstance(pack);
            });

            gridContainer.appendChild(card);
        });
    }

    _getFirstSeen(instanceName) {
        try {
            const firstSeenPath = path.join(this.gamePath, 'instances', instanceName, '.first-seen');
            if (fs.existsSync(firstSeenPath)) {
                return parseInt(fs.readFileSync(firstSeenPath, 'utf8').trim(), 10);
            }
        } catch (e) {}
        return null;
    }

    refreshInstanceStatus(name, status) {
        if (status) this._instanceStatus.set(name, status);
        else this._instanceStatus.delete(name);
        const label = status === 'running' ? 'Jugando' : status === 'playing' ? 'Jugando' : status === 'downloading' ? 'Descargando' : status === 'installing' ? 'Instalando' : '';
        document.querySelectorAll(`.modpack-grid-card[data-instance-name="${name}"]`).forEach(card => {
            const thumb = card.querySelector('.modpack-grid-thumb');
            if (!thumb) return;
            let existing = thumb.querySelector('.modpack-grid-tag');
            if (existing) existing.remove();
            if (!label) return;
            const tag = document.createElement('span');
            if (status === 'running' || status === 'playing') {
                tag.className = 'modpack-grid-tag jugando';
            } else if (status === 'downloading') {
                tag.className = 'modpack-grid-tag descargando';
            } else if (status === 'installing') {
                tag.className = 'modpack-grid-tag instalando';
            } else {
                tag.className = 'modpack-grid-tag';
            }
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
        if (this._launching) {
            if (progressContainer) progressContainer.style.display = 'none';
        } else {
            if (progressContainer) progressContainer.style.display = 'none';
        }

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
            });
        }

        // Fill detail viewport floating card content
        document.getElementById('detail-title').textContent = pack.title || pack.name;

        // Set poster as full background of the detail view + thumbnail inside card
        const posterSrc = pack.poster || pack.banner || pack.image || '';
        const detailView = document.getElementById('view-detail');
        if (detailView) {
            if (posterSrc) {
                detailView.style.backgroundImage = `url('${posterSrc}')`;
                detailView.style.backgroundSize = 'cover';
                detailView.style.backgroundPosition = 'center';
            } else {
                detailView.style.backgroundImage = 'none';
                detailView.style.backgroundColor = 'var(--background)';
            }
        }
        const posterImg = document.getElementById('detail-poster-img');
        if (posterImg) {
            if (posterSrc) {
                posterImg.src = posterSrc;
                posterImg.style.display = '';
                posterImg.alt = (pack.title || pack.name) + ' poster';
                posterImg.onerror = () => {
                    posterImg.style.display = 'none';
                };
            } else {
                posterImg.style.display = 'none';
            }
        }

        // Dynamic tags
        const tagsContainer = document.getElementById('detail-tags');
        if (tagsContainer) {
            const loaderName = (pack.loader?.type || pack.loader?.loader_type || 'vanilla').toUpperCase();
            const mcVersion = pack.gameVersion || pack.loader?.minecraft_version || '';
            const customTags = pack.tags || [];
            let tagsHtml = '';
            if (mcVersion) tagsHtml += `<span>MC ${mcVersion}</span>`;
            customTags.forEach(t => { tagsHtml += `<span>${t}</span>`; });
            tagsContainer.innerHTML = tagsHtml;
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
            playBtnLabel.textContent = hasDownloaded ? '' : 'Descargar';
        }

        // Setup launcher control listeners
        this.setupLauncherControls(pack, effectiveGamePath);

        // Update breadcrumb
        this.updateBreadcrumb(pack.title || pack.name);
    }

    updateBreadcrumb(subPage) {
        // Breadcrumb removed - logo only
    }

    setupLauncherControls(pack, gamePath) {
        const playBtn = document.getElementById('detail-play-btn');
        const optionsBtn = document.getElementById('detail-options-btn');
        const dropdown = document.getElementById('detail-fab-menu');

        if (!playBtn || !optionsBtn || !dropdown) return;

        // 1. Play Button Click
        playBtn.replaceWith(playBtn.cloneNode(true));
        const newPlayBtn = document.getElementById('detail-play-btn');
        newPlayBtn.addEventListener('click', () => {
            this.startGame(pack, gamePath);
        });

        // 2. Toggle Quick Menu Dropdown
        optionsBtn.replaceWith(optionsBtn.cloneNode(true));
        const newOptionsBtn = document.getElementById('detail-options-btn');
        newOptionsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dropdown) dropdown.classList.toggle('open');
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

        document.getElementById('opt-btn-folder').onclick = () => openFolder('');

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

                    let cc = await this.db.readData('configClient');
                    if (cc.instances_versions) delete cc.instances_versions[pack.name];
                    if (cc.instances_features) delete cc.instances_features[pack.name];
                    await this.db.updateData('configClient', cc);

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
                    await this.initInstances();
                    await this.selectInstance(pack);
                } catch (err) {
                    alert(`Error al eliminar la instancia: ${err.message}`);
                }
            }
        };

        // Dropdown Option: Update modpack (re-sync without deleting user data)
        const updateBtn = document.getElementById('opt-btn-update');
        if (updateBtn) {
            updateBtn.onclick = async () => {
                if (dropdown) dropdown.classList.remove('open');
                if (!pack.modpack_url) {
                    alert('Este modpack no tiene una URL de sincronización configurada.');
                    return;
                }
                if (this._launching) {
                    alert('No se puede actualizar mientras el juego está en ejecución.');
                    return;
                }
                if (!fs.existsSync(localPackDir)) {
                    if (confirm('Esta instancia aún no se instaló. ¿Querés descargarla ahora?')) {
                        this.startGame(pack, gamePath);
                    }
                    return;
                }
                try {
                    // Re-sync modpack preserving user data
                    let configClientUpd = await this.db.readData('configClient');
                    let enabledFeatures = configClientUpd.instances_features?.[pack.name] || [];
                    const selectedFeatures = await this.showFeaturesModal(pack.modpack_url);
                    if (selectedFeatures === undefined) return;
                    if (selectedFeatures.length > 0) {
                        enabledFeatures = selectedFeatures;
                        if (!configClientUpd.instances_features) configClientUpd.instances_features = {};
                        configClientUpd.instances_features[pack.name] = enabledFeatures;
                        await this.db.updateData('configClient', configClientUpd);
                    }

                    const packBaseUrl = pack.modpack_url.replace(/\/modpack\.json$/, '');
                    const modpackSyncUpd = new ModpackSync(pack.modpack_url, localPackDir, {
                        enabledFeatures,
                        serverBaseUrl: packBaseUrl || this._serverUrl || ''
                    });

                    new logger(pkg.name, '#7289da').info(`Actualizando ${pack.title || pack.name}...`);
                    const currentVersion = configClientUpd.instances_versions?.[pack.name] || null;
                    const result = await modpackSyncUpd.sync((progress, size, message) => {
                        new logger(pkg.name, '#7289da').info(`[${progress}/${size}] ${message}`);
                    }, null);

                    if (result && result.version) {
                        if (!configClientUpd.instances_versions) configClientUpd.instances_versions = {};
                        configClientUpd.instances_versions[pack.name] = result.version;
                        await this.db.updateData('configClient', configClientUpd);
                        alert('Modpack actualizado correctamente.');
                        await this.initInstances();
                        await this.selectInstance(pack);
                    } else {
                        alert('El modpack ya está actualizado o no hubo cambios.');
                    }
                } catch (err) {
                    alert(`Error al actualizar: ${err.message}`);
                }
            };
        }

        // Dropdown Option: Force Close Game (Forzar Cierre)
        document.getElementById('opt-btn-kill').onclick = () => {
            if (dropdown) dropdown.classList.remove('open');
            const instName = this._launchingInstance;
            const proc = this.minecraftProcess?._process;
            if (proc) {
                proc.kill();
                this.minecraftProcess = null;
                new logger('Minecraft', '#ef4444').info('Minecraft finalizado por el usuario.');
            } else {
                const { exec } = require('child_process');
                if (process.platform === 'win32') {
                    exec('taskkill /f /im javaw.exe');
                } else {
                    exec('killall -9 java');
                }
            }
            this._launching = false;
            this._launchingInstance = null;
            if (instName) this.refreshInstanceStatus(instName);
            alert('Procesos cerrados. El estado se ha reiniciado.');
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
        // NeoForge uses its own versioning (e.g. "21.1.1"), do NOT prepend MC version
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

        const isOffline = authenticator?.meta?.type === 'Offline';

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
            bypassOffline: isOffline,

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
            const reset = confirm('Ya hay una instancia en ejecución. Si el juego se cerró inesperadamente, presioná OK para reiniciar el estado.');
            if (reset) {
                this._launching = false;
                this._launchingInstance = null;
                this.minecraftProcess = null;
                // clean running_instance from config
                let ccReset = await this.db.readData('configClient');
                if (ccReset && ccReset.running_instance) {
                    delete ccReset.running_instance;
                    await this.db.updateData('configClient', ccReset);
                }
            } else {
                return;
            }
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
        const playBtnLoading = document.getElementById('detail-play-btn');
        const btnContentLoading = document.getElementById('detail-play-btn-content');
        const btnSpinnerLoading = document.getElementById('detail-play-btn-spinner');
        if (btnContentLoading) btnContentLoading.style.display = 'none';
        if (btnSpinnerLoading) btnSpinnerLoading.style.display = 'flex';
        if (playBtnLoading) playBtnLoading.disabled = true;

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
                    const playBtnCancel = document.getElementById('detail-play-btn');
                    const btnContentCancel = document.getElementById('detail-play-btn-content');
                    const btnSpinnerCancel = document.getElementById('detail-play-btn-spinner');
                    if (btnContentCancel) btnContentCancel.style.display = 'flex';
                    if (btnSpinnerCancel) btnSpinnerCancel.style.display = 'none';
                    if (playBtnCancel) playBtnCancel.disabled = false;
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

                const packBaseUrl = options.modpack_url.replace(/\/modpack\.json$/, '');
                const modpackSync = new ModpackSync(options.modpack_url, instancePath, {
                    enabledFeatures,
                    serverBaseUrl: packBaseUrl || this._serverUrl || ''
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

                    // Write .first-seen for "Nuevo" badge
                    try {
                        const firstSeenPath = path.join(instancePath, '.first-seen');
                        if (!fs.existsSync(firstSeenPath)) {
                            fs.writeFileSync(firstSeenPath, String(Date.now()));
                        }
                    } catch (e) {}

                    // Refresh instances grid so installed pack moves from "Todas" to "Instaladas"
                    await this.initInstances();
                    await this.selectInstance(options);

                    progressContainer = document.getElementById('detail-progress');
                    progressText = document.getElementById('detail-progress-text');
                    progressPct = document.getElementById('detail-progress-pct');
                    if (progressContainer) progressContainer.style.display = 'flex';
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

                const playBtnRestore = document.getElementById('detail-play-btn');
                const btnContentRestore = document.getElementById('detail-play-btn-content');
                const btnSpinnerRestore = document.getElementById('detail-play-btn-spinner');
                if (btnContentRestore) btnContentRestore.style.display = 'flex';
                if (btnSpinnerRestore) btnSpinnerRestore.style.display = 'none';
                if (playBtnRestore) playBtnRestore.disabled = false;
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

        // Cache posters locally when server is online
        const posterCacheDir = path.join(this.gamePath, 'poster-cache');
        if (this._serverOnline) {
            try {
                if (!fs.existsSync(posterCacheDir)) fs.mkdirSync(posterCacheDir, { recursive: true });
                for (const pack of (this._instancesList || [])) {
                    if (!pack.poster) continue;
                    const ext = path.extname(pack.poster.split('?')[0].split('#')[0]) || '.jpg';
                    const cachedPath = path.join(posterCacheDir, pack.name + ext);
                    try {
                        const res = await fetch(pack.poster);
                        if (res.ok) {
                            const buffer = await res.buffer();
                            fs.writeFileSync(cachedPath, buffer);
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        } else if (fs.existsSync(posterCacheDir)) {
            // Rewrite poster URLs to cached versions when server is offline
            for (const pack of (this._instancesList || [])) {
                if (!pack.poster) continue;
                const ext = path.extname(pack.poster.split('?')[0].split('#')[0]) || '.jpg';
                const cachedPath = path.join(posterCacheDir, pack.name + ext);
                if (fs.existsSync(cachedPath)) {
                    pack.poster = `file:///${cachedPath.replace(/\\/g, '/')}`;
                }
            }
        }
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

        // Persist running instance to survive renderer crashes
        const persistLaunch = async (instanceName) => {
            let cc = await this.db.readData('configClient');
            cc.running_instance = instanceName;
            await this.db.updateData('configClient', cc);
        };
        persistLaunch(options.name);
        this.refreshInstanceStatus(options.name, 'running');

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
            // Clear persisted running instance
            let ccClose = await this.db.readData('configClient');
            delete ccClose.running_instance;
            await this.db.updateData('configClient', ccClose);
            // Refresh instance status to remove running tag
            this.refreshInstanceStatus(options.name);
            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send('main-window-show');
            }
            ipcRenderer.send('main-window-progress-reset');

            const playBtnRestore2 = document.getElementById('detail-play-btn');
            const btnContentRestore2 = document.getElementById('detail-play-btn-content');
            const btnSpinnerRestore2 = document.getElementById('detail-play-btn-spinner');
            if (btnContentRestore2) btnContentRestore2.style.display = 'flex';
            if (btnSpinnerRestore2) btnSpinnerRestore2.style.display = 'none';
            if (playBtnRestore2) playBtnRestore2.disabled = false;
            if (progressContainer) progressContainer.style.display = 'none';
            this._launching = false;

            new logger(pkg.name, '#7289da').info(`Minecraft cerrado (código ${code})`);
            this.minecraftProcess = null;
        });

        launch.on('error', async err => {
            await endSession();
            // Clear persisted running instance
            let ccErr = await this.db.readData('configClient');
            delete ccErr.running_instance;
            await this.db.updateData('configClient', ccErr);
            this.refreshInstanceStatus(options.name);

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

            const playBtnRestore3 = document.getElementById('detail-play-btn');
            const btnContentRestore3 = document.getElementById('detail-play-btn-content');
            const btnSpinnerRestore3 = document.getElementById('detail-play-btn-spinner');
            if (btnContentRestore3) btnContentRestore3.style.display = 'flex';
            if (btnSpinnerRestore3) btnSpinnerRestore3.style.display = 'none';
            if (playBtnRestore3) playBtnRestore3.disabled = false;
            if (progressContainer) progressContainer.style.display = 'none';
            this._launching = false;

            new logger(pkg.name, '#7289da');
            this.minecraftProcess = null;
        });
    }

    /* ==========================================================================
       CALENDAR
       ========================================================================== */

    _calCurrentDate = new Date();
    _calSelectedDate = null;
    _calEvents = [];

        initCalendar() {
        this.loadCalendarEvents();
        this.renderCalendar();
        this.setupCalendarNav();
    }

    loadCalendarEvents() {
        this._calEvents = [];
        try {
            const userDataPath = require('electron').ipcRenderer ? true : false;
            const { ipcRenderer } = require('electron');
            ipcRenderer.invoke('path-user-data').then(userDataPath => {
                const calPath = require('path').join(userDataPath, 'calendar-events.json');
                if (require('fs').existsSync(calPath)) {
                    this._calEvents = JSON.parse(require('fs').readFileSync(calPath, 'utf8'));
                    if (this._isCalendarViewActive()) this.renderEventsForDay(this._calSelectedDate);
                }
            }).catch(() => {});
        } catch (e) {}
    }

    _isCalendarViewActive() {
        return document.getElementById('view-calendar')?.classList.contains('active');
    }

    renderCalendar() {
        const grid = document.getElementById('calendar-grid');
        const monthYear = document.getElementById('cal-month-year');
        if (!grid || !monthYear) return;

        const date = this._calCurrentDate;
        const year = date.getFullYear();
        const month = date.getMonth();

        const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
        monthYear.textContent = `${months[month]} ${year}`;

        grid.innerHTML = '';

        const dayHeaders = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
        dayHeaders.forEach(d => {
            const el = document.createElement('div');
            el.className = 'cal-day-header';
            el.textContent = d;
            grid.appendChild(el);
        });

        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrevMonth = new Date(year, month, 0).getDate();
        const today = new Date();

        for (let i = firstDay - 1; i >= 0; i--) {
            const el = document.createElement('div');
            el.className = 'cal-day other-month';
            el.textContent = daysInPrevMonth - i;
            grid.appendChild(el);
        }

        for (let d = 1; d <= daysInMonth; d++) {
            const el = document.createElement('div');
            el.className = 'cal-day';
            el.textContent = d;

            const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

            if (d === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
                el.classList.add('today');
            }

            if (this._calSelectedDate === dateStr) {
                el.classList.add('selected');
            }

            if (this._calEvents.some(e => e.date === dateStr)) {
                el.classList.add('has-event');
            }

            el.addEventListener('click', () => {
                document.querySelectorAll('.cal-day.selected').forEach(e => e.classList.remove('selected'));
                el.classList.add('selected');
                this._calSelectedDate = dateStr;
                this.renderEventsForDay(dateStr);
            });

            grid.appendChild(el);
        }

        const totalCells = firstDay + daysInMonth;
        const remaining = (7 - (totalCells % 7)) % 7;
        for (let i = 1; i <= remaining; i++) {
            const el = document.createElement('div');
            el.className = 'cal-day other-month';
            el.textContent = i;
            grid.appendChild(el);
        }
    }

    setupCalendarNav() {
        const prev = document.getElementById('cal-prev');
        const next = document.getElementById('cal-next');
        if (prev) {
            prev.addEventListener('click', () => {
                this._calCurrentDate = new Date(this._calCurrentDate.getFullYear(), this._calCurrentDate.getMonth() - 1, 1);
                this.renderCalendar();
            });
        }
        if (next) {
            next.addEventListener('click', () => {
                this._calCurrentDate = new Date(this._calCurrentDate.getFullYear(), this._calCurrentDate.getMonth() + 1, 1);
                this.renderCalendar();
            });
        }
    }

    renderEventsForDay(dateStr) {
        const list = document.getElementById('cal-events-list');
        if (!list) return;

        const dayEvents = this._calEvents.filter(e => e.date === dateStr);

        if (dayEvents.length === 0) {
            list.innerHTML = '<p style="font-size:12px; color:var(--text-secondary);">No hay eventos para este día.</p>';
            return;
        }

        list.innerHTML = '';
        dayEvents.forEach(ev => {
            const item = document.createElement('div');
            item.className = 'cal-event-item';
            item.innerHTML = `
                <span class="event-dot"></span>
                <span class="event-time">${ev.time || 'Todo el día'}</span>
                <span class="event-title">${ev.title}</span>
            `;
            list.appendChild(item);
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
        await this.settingsAccount();
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
            javaPathText.textContent = `${await appdata()}/.yusup/runtime`;
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

    async settingsAccount() {
        let configClient = await this.db.readData('configClient');
        let auth = configClient.account_selected
            ? await this.db.readData('accounts', configClient.account_selected)
            : null;

        const nameEl = document.getElementById('acc-active-name');
        const typeEl = document.getElementById('acc-active-type');
        const avatarEl = document.getElementById('acc-active-avatar');

        if (nameEl) nameEl.textContent = auth?.name || 'Sin cuenta';
        if (typeEl) typeEl.textContent = auth?.meta?.type || 'Offline';

        if (avatarEl && auth) {
            const skinUrl = await this._getSkinUrl(auth);
            if (skinUrl) {
                avatarEl.style.backgroundImage = `url(${skinUrl})`;
                avatarEl.style.backgroundSize = 'cover';
                avatarEl.style.backgroundPosition = 'center';
                avatarEl.innerHTML = '';
            } else {
                avatarEl.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
                avatarEl.style.backgroundImage = 'none';
                avatarEl.innerHTML = '<span style="color:#fff;font-size:24px;font-weight:700;">' + (auth.name ? auth.name.charAt(0).toUpperCase() : '?') + '</span>';
            }
        }
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