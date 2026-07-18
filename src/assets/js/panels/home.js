import { config, database, logger, changePanel, appdata, setStatus, pkg, popup, ModpackSync, skin2D, accountSelect, zipHandler } from '../utils.js';

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

const { Launch } = require('minecraft-java-core');
const { shell, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fetch = require('node-fetch');
const __filename = require('url').fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Preload Steve skin fallback at module level
const _steveSkinDataUrl = (() => {
    try {
        const p = path.join(__dirname, '../../images/default/setve.png');
        if (fs.existsSync(p)) {
            const buf = fs.readFileSync(p);
            return `data:image/png;base64,${buf.toString('base64')}`;
        }
    } catch (e) {}
    return null;
})();

const _defaultPosterDataUrl = (() => {
    try {
        const p = path.join(__dirname, '../../images/default/icon-modpack.png');
        if (fs.existsSync(p)) {
            const buf = fs.readFileSync(p);
            return `data:image/png;base64,${buf.toString('base64')}`;
        }
    } catch (e) {}
    return null;
})();

const _defaultBannerDataUrl = (() => {
    try {
        const p = path.join(__dirname, '../../images/default/banner-modpack.png');
        if (fs.existsSync(p)) {
            const buf = fs.readFileSync(p);
            return `data:image/png;base64,${buf.toString('base64')}`;
        }
    } catch (e) {}
    return null;
})();

class Home {
    static id = "home";
    _launching = false;
    _launchingInstance = null;
    _instanceStatus = new Map(); // instanceName → 'downloading' | 'installing' | 'running'
    _navHistory = [];
    _navHistoryIndex = -1;

    async init(config) {
        this.config = config;
        this.db = new database();
        this.minecraftProcess = null;

        const gamePath = `${await appdata()}/.yusup`;
        this.gamePath = gamePath;

        // Initialize user skin / head avatar
        await this.initUserAvatar();

        // Populate account dropdown so the name appears immediately
        await this.populateAccountDropdown();

        // Track login for creator tools (badges / whitelist)
        await this._trackLogin();

        // Header frame controls (minimize/close)
        this.setupHeaderControls();

        // Account dropdown toggle
        this.setupAccountDropdown();

        // 1. Load news section
        this.news();

        // Download queue floating panel
        this.setupDownloadsPanel();

        // 2. Setup Navigation & Account View
        this.setupNavigation();
        await this.setupAccountView();

        // 4. Render and initialize modpacks
        await this.initInstances();
        await this.populateRecentInstance();
        this._allInstancesCache = [];

        // Clear stale running_instance — app restarted, process is gone
        const ccCheck = await this.db.readData('configClient');
        if (ccCheck && ccCheck.running_instance) {
            delete ccCheck.running_instance;
            await this.db.updateData('configClient', ccCheck);
        }

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

    async initSocial() {
    }

    async initUserAvatar() {
        try {
            let configClient = await this.db.readData('configClient');
            let auth = configClient?.account_selected ? await this.db.readData('accounts', configClient.account_selected) : null;
            const setAvatar = async (el, useRealSkin) => {
                if (!el) return;
                // Always set local Steve skin first
                if (_steveSkinDataUrl) {
                    el.style.background = `url('${_steveSkinDataUrl}') center / cover`;
                    el.innerHTML = '';
                } else {
                    el.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
                    el.innerHTML = '<span style="color:#fff;font-size:16px;font-weight:700;">' + (auth?.name ? auth.name.charAt(0).toUpperCase() : '?') + '</span>';
                }
                // Then try real skin in background if requested
                if (useRealSkin && auth) {
                    let skinUrl = await this._getSkinUrl(auth);
                    if (skinUrl && skinUrl !== _steveSkinDataUrl) {
                        el.style.background = `url(${skinUrl}) center / cover`;
                        el.innerHTML = '';
                    }
                }
            };
            setAvatar(document.querySelector('#top-profile-avatar'), true);
        } catch (e) {}
    }

    async _trackLogin() {
        try {
            let configClient = await this.db.readData('configClient');
            let auth = configClient?.account_selected ? await this.db.readData('accounts', configClient.account_selected) : null;
            if (!auth) return;
            const knownPath = path.join(this.gamePath, 'known-users.json');
            let known = [];
            try { known = JSON.parse(fs.readFileSync(knownPath, 'utf8')); } catch (e) {}
            const existing = known.find(u => u.id === auth.ID || u.name === auth.name);
            if (existing) {
                existing.lastLogin = new Date().toISOString();
            } else {
                known.push({
                    id: auth.ID,
                    name: auth.name,
                    uuid: auth.uuid || '',
                    type: auth.meta?.type || 'Offline',
                    firstLogin: new Date().toISOString(),
                    lastLogin: new Date().toISOString()
                });
            }
            fs.writeFileSync(knownPath, JSON.stringify(known, null, 4));
        } catch (e) {}
    }

    async news() {
        let newsElement = document.querySelector('.news-list');
        if (!newsElement) return;
        newsElement.innerHTML = '';

        let news = await config.getNews(this.config).then(res => res).catch(() => false);
        const events = news && news.length ? news.slice(0, 4) : [
            { title: 'Mision 1 - DesafíoMine II', content: 'Destruye el crater', day: '12' },
            { title: 'Mision 1 - DesafíoMine II', content: 'Destruye el crater', day: '13' }
        ];

        events.forEach((event, index) => {
            let blockNews = document.createElement('div');
            blockNews.classList.add('news-block');
            const eventDate = event.date ? new Date(event.date) : null;
            const day = event.day || (eventDate && !Number.isNaN(eventDate) ? String(eventDate.getDate()).padStart(2, '0') : String(12 + index).padStart(2, '0'));
            const month = event.month || (eventDate && !Number.isNaN(eventDate) ? eventDate.toLocaleDateString('es-ES', { month: 'long' }) : 'Junio');
            blockNews.innerHTML = `
                <div class="event-date-badge">
                    <span>${month}</span>
                    <strong>${day}</strong>
                </div>
                <div class="news-header">
                    <div class="title">${event.title || 'Evento'}</div>
                    <div class="news-content">
                        <p>${(event.content || event.description || 'Sin descripción').replace(/\n/g, '</br>')}</p>
                    </div>
                </div>`;
            newsElement.appendChild(blockNews);
        });
        return;
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
        const overlay = document.getElementById('search-popup-overlay');
        const input = document.getElementById('search-popup-input');
        const closeBtn = document.getElementById('search-popup-close');
        const results = document.getElementById('search-popup-results');
        const searchBtn = document.getElementById('top-search-btn');
        if (!overlay || !input || !closeBtn || !results) return;

        const open = () => {
            overlay.classList.add('open');
            setTimeout(() => input.focus(), 100);
            this._allInstancesCache = [...(this._instancesList || []), ...(this._fullInstancesList || [])];
        };

        const close = () => {
            overlay.classList.remove('open');
            input.value = '';
            results.innerHTML = '';
        };

        if (searchBtn) searchBtn.addEventListener('click', open);
        closeBtn.addEventListener('click', close);

        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            results.innerHTML = '';
            if (!q) return;

            const filtered = this._allInstancesCache.filter(p =>
                (p.title || p.name || '').toLowerCase().includes(q)
            );

            filtered.forEach(pack => {
                const item = document.createElement('div');
                item.className = 'search-result-item';
                const name = pack.title || pack.name;
                const thumb = pack.poster || pack.banner || '';
                const initial = name ? name.charAt(0).toUpperCase() : '?';
                let iconHtml;
                if (thumb) {
                    iconHtml = `<div class="search-result-icon"><img src="${thumb}" alt=""></div>`;
                } else {
                    iconHtml = `<div class="search-result-icon" style="background:var(--green-dark);color:#fff;font-size:18px;font-weight:700;">${initial}</div>`;
                }
                item.innerHTML = `
                    ${iconHtml}
                    <div class="search-result-info">
                        <span class="search-result-name">${name}</span>
                        <span class="search-result-meta">${pack.gameVersion || ''}</span>
                    </div>
                `;
                item.addEventListener('click', () => {
                    close();
                    this.selectInstance(pack);
                });
                results.appendChild(item);
            });

            // Password unlock check
            const match = this._fullInstancesList?.find(p => p.instancePassword && p.instancePassword === q);
            if (match && !filtered.some(p => p.name === match.name)) {
                const area = document.createElement('div');
                area.className = 'search-password-result';
                area.innerHTML = `
                    <div class="search-result-icon" style="background:var(--green-dark);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;">${(match.title || match.name || '?').charAt(0).toUpperCase()}</div>
                    <div class="search-result-info">
                        <span class="search-result-name">${match.title || match.name}</span>
                        <span class="search-result-meta">Instancia protegida · Click para agregar</span>
                    </div>
                `;
                area.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px;cursor:pointer;border-radius:8px;margin-top:8px;';
                area.addEventListener('click', () => {
                    close();
                    this._preloadAndUnlock(match);
                });
                results.appendChild(area);
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
    }

    _navigateTo(viewId, btnId) {
        const navButtons = document.querySelectorAll('.sidebar-item.nav-btn');
        const views = document.querySelectorAll('.dashboard-view');

        navButtons.forEach(b => b.classList.remove('active'));
        if (btnId) document.getElementById(btnId)?.classList.add('active');

        views.forEach(v => v.classList.remove('active'));
        document.getElementById(viewId)?.classList.add('active');

        const isHome = viewId === 'view-home';

        // Show/hide back button
        const topBackBtn = document.getElementById('top-back-btn');
        if (topBackBtn) topBackBtn.style.display = isHome ? 'none' : 'flex';

        this._closeAccountDropdown();
    }

    _pushNav(viewId, btnId) {
        // Remove any forward history
        this._navHistory = this._navHistory.slice(0, this._navHistoryIndex + 1);
        // Skip if same as last entry
        const last = this._navHistory[this._navHistory.length - 1];
        if (last && last.viewId === viewId) return;
        this._navHistory.push({ viewId, btnId });
        this._navHistoryIndex = this._navHistory.length - 1;
        this._updateNavButtons();
    }

    _updateNavButtons() {
        const backBtn = document.getElementById('history-back-btn');
        const forwardBtn = document.getElementById('history-forward-btn');
        if (backBtn) backBtn.disabled = this._navHistoryIndex <= 0;
        if (forwardBtn) forwardBtn.disabled = this._navHistoryIndex >= this._navHistory.length - 1;
    }

    _goBack() {
        if (this._navHistoryIndex <= 0) return;
        this._navHistoryIndex--;
        const entry = this._navHistory[this._navHistoryIndex];
        if (entry) this._navigateTo(entry.viewId, entry.btnId);
        this._updateNavButtons();
    }

    _goForward() {
        if (this._navHistoryIndex >= this._navHistory.length - 1) return;
        this._navHistoryIndex++;
        const entry = this._navHistory[this._navHistoryIndex];
        if (entry) this._navigateTo(entry.viewId, entry.btnId);
        this._updateNavButtons();
    }

    setupNavigation() {
        const navButtons = document.querySelectorAll('.sidebar-item.nav-btn');
        const views = document.querySelectorAll('.dashboard-view');

        // Push initial state
        this._pushNav('view-home', 'nav-btn-home');

        navButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                let targetViewId = '';
                let targetBtnId = btn.id;
                if (btn.id === 'nav-btn-home') { targetViewId = 'view-home'; }
                if (!targetViewId) return;

                this._navigateTo(targetViewId, targetBtnId);
                this._pushNav(targetViewId, targetBtnId);
            });
        });

        // Back/Forward buttons
        const backBtn = document.getElementById('history-back-btn');
        const forwardBtn = document.getElementById('history-forward-btn');
        if (backBtn) backBtn.addEventListener('click', () => this._goBack());
        if (forwardBtn) forwardBtn.addEventListener('click', () => this._goForward());
    }

    async updateSidebarAccount() {
        let configClient = await this.db.readData('configClient');
        let auth = configClient?.account_selected ? await this.db.readData('accounts', configClient.account_selected) : null;
    }

    async populateRecentInstance() {
        const section = document.getElementById('sidebar-recents');
        const list = document.getElementById('sidebar-recents-list');
        if (!section || !list) return;
        let sessions = await this.db.readAllData('sessions') || [];
        sessions = sessions.filter(s => s.endTime);
        if (sessions.length === 0) { section.style.display = 'none'; return; }
        // Get unique instances from last 5 sessions
        const seen = new Set();
        const recent = [];
        sessions.sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
        for (const s of sessions) {
            if (!seen.has(s.instance) && s.instance) {
                seen.add(s.instance);
                recent.push(s.instance);
                if (recent.length >= 5) break;
            }
        }
        if (recent.length === 0) { section.style.display = 'none'; return; }
        section.style.display = '';
        list.innerHTML = '';
        for (const name of recent) {
            const pack = (this._instancesList || []).find(i => i.name === name)
                || (this._fullInstancesList || []).find(i => i.name === name);
            const btn = document.createElement('button');
            btn.className = 'sidebar-recent-btn';
            btn.title = pack?.title || name;
            const thumb = pack?.poster || pack?.banner || _defaultPosterDataUrl || '';
            if (thumb) {
                btn.style.background = `url('${thumb}') center / cover`;
            } else {
                btn.textContent = (name.charAt(0) || '?').toUpperCase();
                btn.style.background = 'var(--green-dark)';
                btn.style.color = '#fff';
                btn.style.fontWeight = '700';
                btn.style.fontSize = '16px';
            }
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (pack) this.selectInstance(pack);
            });
            list.appendChild(btn);
        }
    }

    _closeAccountDropdown() {
        const dropdown = document.getElementById('top-profile-dropdown');
        if (dropdown) dropdown.classList.remove('open');
        const chevron = document.querySelector('.top-profile-chevron');
        if (chevron) chevron.classList.remove('open');
    }

    _openLoginModal() {
        const loginPanel = document.querySelector('.panel.login');
        if (!loginPanel) return;
        loginPanel.classList.add('modal-mode', 'active');
    }

    _closeLoginModal() {
        const loginPanel = document.querySelector('.panel.login');
        if (!loginPanel) return;
        loginPanel.classList.remove('modal-mode', 'active');
    }

    setupAccountDropdown() {
        const profile = document.querySelector('.top-profile');
        const dropdown = document.getElementById('top-profile-dropdown');
        if (!profile || !dropdown) return;

        profile.addEventListener('click', async (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.contains('open');
            const chevron = profile.querySelector('.top-profile-chevron');
            if (!isOpen) {
                chevron?.classList.add('open');
                dropdown.classList.add('open');
                await this.populateAccountDropdown();
            } else {
                this._closeAccountDropdown();
            }
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.top-profile') && !e.target.closest('.top-profile-dropdown')) {
                this._closeAccountDropdown();
            }
        });

        document.getElementById('dropdown-btn-add-account')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            this._closeAccountDropdown();
            let allAccounts = await this.db.readAllData('accounts');
            if (allAccounts && allAccounts.length > 0) {
                this._openLoginModal();
            } else {
                changePanel('login');
            }
        });

        document.getElementById('dropdown-btn-settings')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            this._closeAccountDropdown();
            this.openSettingsModal();
        });

        document.getElementById('dropdown-btn-logout')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            this._closeAccountDropdown();
            let configClient = await this.db.readData('configClient');
            const selectedId = configClient.account_selected;

            if (selectedId) {
                await this.db.deleteData('accounts', selectedId);
            }

            configClient.account_selected = null;
            await this.db.updateData('configClient', configClient);

            const setLogoutAvatar = () => {
                const el = document.getElementById('top-profile-avatar');
                if (!el) return;
                if (_steveSkinDataUrl) {
                    el.style.background = `url('${_steveSkinDataUrl}') center / cover`;
                    el.innerHTML = '';
                } else {
                    el.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
                    el.innerHTML = '';
                }
            };
            setLogoutAvatar();

            let accounts = await this.db.readAllData('accounts');
            if (accounts.length > 0) {
                configClient.account_selected = accounts[0].ID;
                await this.db.updateData('configClient', configClient);
                await accountSelect(accounts[0]);
                await this.initUserAvatar();
                await this.setupAccountView();
                await this.initInstances();
                await this.populateAccountDropdown();
                document.dispatchEvent(new Event('accounts-changed'));
            } else {
                await this.db.updateData('configClient', configClient);
                changePanel('login');
            }
        });

        document.addEventListener('accounts-changed', () => {
            this.initUserAvatar();
            this._trackLogin();
            this.populateAccountDropdown();
            this.loadAccountsSwitcherList();
        });
    }

    async populateAccountDropdown() {
        let configClient = (await this.db.readData('configClient')) || {};
        let rawAccounts = await this.db.readAllData('accounts');
        let accounts = Array.isArray(rawAccounts) ? rawAccounts : [];

        const currentAccount = configClient.account_selected
            ? accounts.find(a => a.ID === configClient.account_selected)
            : null;

        // Update name in top bar trigger
        const nameEl = document.getElementById('top-profile-name');
        if (nameEl) nameEl.textContent = currentAccount?.name || 'Sin cuenta';

        try {
        const listEl = document.getElementById('top-profile-accounts');
        if (!listEl) { console.error('[populateAccountDropdown] listEl not found'); return; }
        listEl.innerHTML = accounts.map(a => {
            const isActive = a.ID === configClient.account_selected;
            return `<div class="discord-account-item${isActive ? ' discord-current-account' : ''}" data-acc-id="${a.ID}">
                <div class="discord-account-item-avatar" style="${_steveSkinDataUrl ? `background:url('${_steveSkinDataUrl}') center/cover` : 'background:linear-gradient(135deg,var(--green-dark),var(--green-mid));display:flex;align-items:center;justify-content:center;'}">${_steveSkinDataUrl ? '' : (a.name ? a.name.charAt(0).toUpperCase() : '?')}</div>
                <div class="discord-account-item-info">
                    <div class="discord-account-item-name">${a.name || 'Sin nombre'}</div>
                    <div class="discord-account-item-type">${a.meta?.type === 'Xbox' ? 'Microsoft' : 'Offline'}</div>
                </div>
                ${isActive ? '<span class="discord-account-item-check"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>' : ''}
                ${!isActive ? '<button class="discord-account-item-delete" title="Eliminar cuenta" data-acc-id="' + a.ID + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6.4 19L5 17.6L10.6 12L5 6.4L6.4 5L12 10.6L17.6 5L19 6.4L13.4 12L19 17.6L17.6 19L12 13.4L6.4 19Z" fill="currentColor"/></svg></button>' : ''}
            </div>`;
        }).join('');
        listEl._delHandler = (e) => {
            const delBtn = e.target.closest('.discord-account-item-delete');
            if (!delBtn) return;
            const accId = parseInt(delBtn.dataset.accId);
            if (!accId) return;
            this._deleteAccount(accId);
        };
        listEl.removeEventListener('click', listEl._delHandler);
        listEl.addEventListener('click', listEl._delHandler);
        listEl._switchHandler = (e) => {
            if (e.target.closest('.discord-account-item-delete')) return;
            const item = e.target.closest('.discord-account-item');
            if (!item || item.classList.contains('discord-current-account')) return;
            const accId = parseInt(item.dataset.accId);
            if (!accId) return;
            this._switchAccount(accId);
        };
        listEl.removeEventListener('click', listEl._switchHandler);
        listEl.addEventListener('click', listEl._switchHandler);
        for (const a of accounts) {
            this._getSkinUrl(a).then(url => {
                if (!url) return;
                const avatarEl = listEl.querySelector(`.discord-account-item[data-acc-id="${a.ID}"] .discord-account-item-avatar`);
                if (!avatarEl) return;
                avatarEl.style.background = `url('${url}') center / cover`;
                avatarEl.textContent = '';
            }).catch(() => {});
        }
        } catch (e) {
            console.error('[populateAccountDropdown] render error: ' + (e.stack || e.message || e));
        }
    }

    async _deleteAccount(accId) {
        await this.db.deleteData('accounts', accId);
        let cc = await this.db.readData('configClient');
        if (cc.account_selected === accId) {
            let remaining = await this.db.readAllData('accounts');
            if (remaining.length > 0) {
                cc.account_selected = remaining[0].ID;
                await this.db.updateData('configClient', cc);
                await accountSelect(remaining[0]);
                await this.initUserAvatar();
                await this.setupAccountView();
                await this.initInstances();
            } else {
                cc.account_selected = null;
                await this.db.updateData('configClient', cc);
                this._closeAccountDropdown();
                changePanel('login');
                return;
            }
        }
        document.dispatchEvent(new Event('accounts-changed'));
        this._closeAccountDropdown();
    }

    async _switchAccount(accId) {
        let popupSwitch = new popup();
        popupSwitch.openPopup({ title: 'Conexión', content: 'Cargando cuenta...', color: 'var(--color)' });
        let cc = await this.db.readData('configClient');
        cc.account_selected = accId;
        let instancesList = await config.getInstanceList();
        if (instancesList.length > 0) cc.instance_select = instancesList[0].name;
        await this.db.updateData('configClient', cc);
        const acc = await this.db.readData('accounts', accId);
        if (acc) await accountSelect(acc);
        await this.initUserAvatar();
        await this.setupAccountView();
        await this.initInstances();
        document.dispatchEvent(new Event('accounts-changed'));
        popupSwitch.closePopup();
        this._closeAccountDropdown();
    }

    // Helper: load avatar into any element
    _loadAvatarToEl(elId, account) {
        const el = document.getElementById(elId);
        if (!el || !account) return;
        // Set Steve skin first
        if (_steveSkinDataUrl) {
            el.style.background = `url('${_steveSkinDataUrl}') center / cover`;
            el.innerHTML = '';
        } else {
            el.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
            el.innerHTML = '<span style="color:#fff;font-size:16px;font-weight:700;">' + (account.name ? account.name.charAt(0).toUpperCase() : '?') + '</span>';
        }
        // Load real avatar in background
        this._getSkinUrl(account).then(url => {
            if (url && url !== _steveSkinDataUrl) {
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
            // 5. Ultimate fallback: use preloaded Steve skin
            if (!headUrl && _steveSkinDataUrl) {
                headUrl = _steveSkinDataUrl;
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
            const avatarStyle = _steveSkinDataUrl
                ? `background:url('${_steveSkinDataUrl}') center/cover;background-size:cover;`
                : `background:linear-gradient(135deg,var(--green-dark),var(--green-mid));display:flex;align-items:center;justify-content:center;`;
            const avatarContent = _steveSkinDataUrl ? '' : `<span style="color:#fff;font-size:14px;font-weight:700;">${acc.name ? acc.name.charAt(0).toUpperCase() : '?'}</span>`;
            item.innerHTML = `
                <div class="dropdown-account-avatar" style="${avatarStyle}">${avatarContent}</div>
                <div class="dropdown-account-name">${acc.name}</div>
            `;

            // Lazy load real avatar
            this._getSkinUrl(acc).then(url => {
                if (url && url !== _steveSkinDataUrl) {
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
        // Account view — no-op, social is now in social section
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
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6.4 19L5 17.6L10.6 12L5 6.4L6.4 5L12 10.6L17.6 5L19 6.4L13.4 12L19 17.6L17.6 19L12 13.4L6.4 19Z" fill="currentColor"/></svg>
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
        // Allow search bar listener to re-register on next render
        this._searchBarInitialized = false;

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

        // Keep the full list (including password-protected) for unlock lookup
        this._fullInstancesList = [...instancesList];

        // Hide password-protected instances from normal grid (show only if already installed)
        instancesList = instancesList.filter(pack => {
            if (!pack.instancePassword) return true; // no password → always visible
            // Visible if already installed locally
            const localPackDir = path.join(this.gamePath, 'instances', pack.name);
            const hasVersion = configClient.instances_versions?.[pack.name];
            const hasManifest = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
            const hasZipDir = pack.zipUrl && fs.existsSync(localPackDir) && fs.readdirSync(localPackDir).length > 0;
            return !!(hasVersion || hasManifest || hasZipDir);
        });

        // Auto select first instance if none selected
        if (!currentSelect && instancesList.length > 0) {
            currentSelect = instancesList[0].name;
            configClient.instance_select = currentSelect;
            await this.db.updateData('configClient', configClient);
        } else if (instancesList.length === 0) {
            console.warn('initInstances: empty instances list (server offline or no instances.json)');
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
            const hasZipDir = pack.zipUrl && fs.existsSync(localPackDir) && fs.readdirSync(localPackDir).length > 0;
            if (hasVersion || hasManifestFile || hasZipDir) {
                installedPacks.push(pack);
            } else {
                allPacks.push(pack);
            }
        }

        // 2. Merge creator tools modpacks (local packs from creator tools)
        //    Also try loading generated instances.json from userData
        const _passwordPacks = [];
        {
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
                        instancePassword: c.instancePassword || undefined,
                        whitelistActive: c.whitelistActive || false,
                        whitelist: c.whitelist || [],
                        zipUrl: c.zipUrl || undefined,
                        poster: c.poster ? `file:///${path.resolve(c.location, c.poster).replace(/\\/g, '/')}` : null,
                        banner: c.banner ? `file:///${path.resolve(c.location, c.banner).replace(/\\/g, '/')}` : null
                    };
                    const localPackDir = path.join(this.gamePath, 'instances', pack.name);
                    const hasVersion = configClient.instances_versions?.[pack.name];
                    const hasManifestFile = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
                    const hasZipDir = pack.zipUrl && fs.existsSync(localPackDir) && fs.readdirSync(localPackDir).length > 0;
                    const hasLocal = hasVersion || hasManifestFile || hasZipDir;
                    if (hasLocal) {
                        installedPacks.push(pack);
                    } else if (!pack.instancePassword) {
                        allPacks.push(pack);
                    } else {
                        _passwordPacks.push(pack);
                    }
                }
            } catch (e) {
                console.error('Error reading creator tools modpacks:', e);
            }
        }

        // 2b. Also load generated instances.json from userData (if launcher can't reach creator server)
        try {
            const userDataPath = await ipcRenderer.invoke('path-user-data');
            const generatedPath = path.join(userDataPath, 'instances.json');
            if (fs.existsSync(generatedPath)) {
                const generated = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
                if (Array.isArray(generated)) {
                    for (let pack of generated) {
                        if (typeof pack.loader === 'string') {
                            pack.loader = { type: pack.loader, build: pack.loaderVersion || '', enable: pack.loader !== 'vanilla' };
                        }
                        if (!pack.name && pack.title) pack.name = pack.title.toLowerCase().replace(/\s+/g, '-');
                        const existsInList = instancesList.some(p => p.name === pack.name);
                        if (!existsInList) {
                            const localPackDir = path.join(this.gamePath, 'instances', pack.name);
                            const hasVersion = configClient.instances_versions?.[pack.name];
                            const hasManifestFile = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
                            const hasZipDir = pack.zipUrl && fs.existsSync(localPackDir) && fs.readdirSync(localPackDir).length > 0;
                            const hasLocal = hasVersion || hasManifestFile || hasZipDir;
                            if (hasLocal) {
                                installedPacks.push(pack);
                            } else if (!pack.instancePassword) {
                                allPacks.push(pack);
                            } else {
                                _passwordPacks.push(pack);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Error loading generated instances.json:', e);
        }
        }

        // Add all password-protected creator/generated packs to full list for unlock search
        for (const p of [...allPacks, ...installedPacks]) {
            if (p.instancePassword && !this._fullInstancesList.some(f => f.name === p.name)) {
                this._fullInstancesList.push(p);
            }
        }
        // Also add password-protected packs that were excluded from both lists (not installed)
        for (const p of _passwordPacks) {
            if (!this._fullInstancesList.some(f => f.name === p.name)) {
                this._fullInstancesList.push(p);
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

        // 4. Store for filtering
        this._installedPacks = installedPacks;
        this._allPacks = allPacks;
        this._playtimeMap = playtimeMap;

        // 5. Render sections
        this.renderInstancesGrid(installedPacks, 'instances-grid-installed', playtimeMap);
        this.renderInstancesGrid(allPacks, 'instances-grid-all', playtimeMap);
        await this.updateSidebarAccount();

        // 6. Search handled by setupSearchOverlay
    }

    /* ── Search bar: name filter + password-based instance unlock ── */

    _initSearchBar() { /* replaced by setupSearchOverlay */ }

    _applySearch(raw) {
        const query = (raw || '').trim().toLowerCase();

        // — Name filter on visible grids —
        const filterByName = (packs) => {
            if (!query) return packs;
            return packs.filter(p =>
                (p.title || p.name || '').toLowerCase().includes(query) ||
                (p.description || '').toLowerCase().includes(query)
            );
        };

        this.renderInstancesGrid(
            filterByName(this._installedPacks || []),
            'instances-grid-installed',
            this._playtimeMap || {}
        );
        this.renderInstancesGrid(
            filterByName(this._allPacks || []),
            'instances-grid-all',
            this._playtimeMap || {}
        );

        // — Password check: look for a hidden instance whose password matches exactly —
        this._renderPasswordUnlock(query);
    }

    _renderPasswordUnlock(query) {
        // Remove any existing unlock card
        document.getElementById('cf-password-unlock-area')?.remove();

        if (!query) return;

        // All instances including password-protected ones (stored in _fullInstancesList)
        const allKnown = this._fullInstancesList || [];
        const match = allKnown.find(p =>
            p.instancePassword && p.instancePassword === query
        );
        if (!match) return;

        // Don't show unlock card if the instance is already installed/visible
        const alreadyVisible = [...(this._installedPacks || []), ...(this._allPacks || [])]
            .some(p => p.name === match.name);
        if (alreadyVisible) return;

        const area = document.createElement('div');
        area.id = 'cf-password-unlock-area';

        const thumb = match.banner || match.poster || '';
        const iconHtml = thumb
            ? `<div class="cf-password-unlock-icon" style="background-image:url('${thumb}');"></div>`
            : `<div class="cf-password-unlock-icon">${(match.title || match.name || '?').charAt(0).toUpperCase()}</div>`;

        area.innerHTML = `
            <div class="cf-password-unlock-card" id="cf-unlock-card-${match.name}">
                ${iconHtml}
                <div class="cf-password-unlock-info">
                    <div class="cf-password-unlock-title">${match.title || match.name}</div>
                    <div class="cf-password-unlock-sub" id="cf-unlock-sub-${match.name}">
                        ${match.gameVersion || ''} · Instancia protegida desbloqueada
                    </div>
                    <div class="cf-password-unlock-progress" id="cf-unlock-progress-${match.name}" style="display:none;"></div>
                </div>
                <button class="cf-password-unlock-btn" id="cf-unlock-btn-${match.name}">
                    Agregar instancia
                </button>
            </div>
        `;

        // Insert above the installed section
        const viewport = document.querySelector('.instances-viewport-scroll');
        const filterBar = document.getElementById('cf-filter-bar');
        if (filterBar && viewport) {
            filterBar.after(area);
        } else if (viewport) {
            viewport.prepend(area);
        }

        document.getElementById(`cf-unlock-btn-${match.name}`)
            ?.addEventListener('click', () => this._preloadAndUnlock(match));
    }

    async _preloadAndUnlock(pack) {
        const btn = document.getElementById(`cf-unlock-btn-${pack.name}`);
        const sub = document.getElementById(`cf-unlock-sub-${pack.name}`);
        const progressEl = document.getElementById(`cf-unlock-progress-${pack.name}`);

        if (btn) btn.disabled = true;

        const setStatus = (msg) => {
            if (progressEl) { progressEl.style.display = 'block'; progressEl.textContent = msg; }
        };

        try {
            setStatus('Preparando...');

            // If it has a zipUrl — download and extract first
            if (pack.zipUrl) {
                const instancePath = path.join(this.gamePath, 'instances', pack.name);
                if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

                let configClient = await this.db.readData('configClient');
                const storedVersion = configClient?.instances_versions?.[pack.name] || null;

                if (storedVersion !== (pack.zipVersion || 'v1')) {
                    setStatus('Descargando modpack...');
                    this.showDownload(pack.name, pack.title || pack.name);

                    await zipHandler.downloadAndExtract(pack.zipUrl, instancePath, (downloaded, total) => {
                        const pct = total > 0 ? ((downloaded / total) * 100).toFixed(0) : 0;
                        setStatus(`Descargando... ${pct}%`);
                        this.updateDownload(pack.name, downloaded, total);
                    });

                    configClient = await this.db.readData('configClient');
                    if (!configClient.instances_versions) configClient.instances_versions = {};
                    configClient.instances_versions[pack.name] = pack.zipVersion || 'v1';
                    await this.db.updateData('configClient', configClient);
                    this.finishDownload(pack.name);
                }

            } else if (pack.modpack_url) {
                // SKCraft/manifest-based pack — pre-sync files
                const instancePath = path.join(this.gamePath, 'instances', pack.name);
                if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });

                let configClient = await this.db.readData('configClient');
                const storedVersion = configClient?.instances_versions?.[pack.name] || null;
                const packBaseUrl = pack.modpack_url.replace(/\/modpack\.json$/, '');

                setStatus('Verificando archivos...');
                this.showDownload(pack.name, pack.title || pack.name);

                const sync = new ModpackSync(pack.modpack_url, instancePath, {
                    enabledFeatures: [],
                    serverBaseUrl: packBaseUrl
                });

                const result = await sync.sync((progress, size, message) => {
                    setStatus(message || `${progress}/${size}`);
                    if (size > 0) this.updateDownload(pack.name, progress, size);
                }, storedVersion);

                if (result?.version) {
                    configClient = await this.db.readData('configClient');
                    if (!configClient.instances_versions) configClient.instances_versions = {};
                    configClient.instances_versions[pack.name] = result.version;
                    await this.db.updateData('configClient', configClient);
                }
                this.finishDownload(pack.name);
            }

            // Preload images
            if (pack.poster || pack.banner) {
                setStatus('Cargando imágenes...');
                await Promise.allSettled([
                    pack.poster ? fetch(pack.poster) : Promise.resolve(),
                    pack.banner ? fetch(pack.banner) : Promise.resolve(),
                ]);
            }

            setStatus('¡Listo!');

            // Add to the all-packs list and re-render so it appears in the grid
            if (!this._allPacks) this._allPacks = [];
            if (!this._allPacks.some(p => p.name === pack.name)) {
                this._allPacks.push(pack);
            }

            document.getElementById('cf-password-unlock-area')?.remove();

            this.renderInstancesGrid(this._installedPacks || [], 'instances-grid-installed', this._playtimeMap || {});
            this.renderInstancesGrid(this._allPacks, 'instances-grid-all', this._playtimeMap || {});

        } catch (err) {
            setStatus(`Error: ${err.message}`);
            if (btn) btn.disabled = false;
        }
    }

    renderInstancesGrid(packs, containerId, playtimeMap = {}) {
        const gridContainer = document.getElementById(containerId);
        if (!gridContainer) return;
        gridContainer.innerHTML = '';

        if (packs.length === 0) {
            const isAll = containerId === 'instances-grid-all';
            const isInstalled = containerId === 'instances-grid-installed';
            // Don't show empty message for "Mis Instancias" if there are truly no installed packs
            if (isInstalled) {
                gridContainer.innerHTML = '';
                return;
            }
            const msg = isAll && !this._serverOnline
                ? 'Servidor del Creator apagado. Abrí el Creator Tools e iniciá el servidor HTTP.'
                : 'No hay modpacks disponibles.';
            gridContainer.innerHTML = `<div class="cf-grid-empty">${msg}</div>`;
            return;
        }

        const now = Date.now();

        packs.forEach(pack => {
            const card = document.createElement('div');
            card.classList.add('cf-card');
            card.dataset.instanceName = pack.name;

            const loaderType = (pack.loader?.type || pack.loader?.loader_type || '').toLowerCase();
            const mcVersion = pack.gameVersion || pack.loader?.minecraft_version || '';

            const status = this._instanceStatus.get(pack.name);
            let statusLabel = '';
            if (status === 'downloading') statusLabel = 'Descargando';
            else if (status === 'installing') statusLabel = 'Instalando';
            else if (status === 'running' || status === 'playing') statusLabel = 'Jugando';

            // "New" badge: shown for packs seen within the last 7 days
            const firstSeen = pack._firstSeen || this._getFirstSeen(pack.name);
            const isNew = firstSeen && (now - firstSeen) < 7 * 24 * 60 * 60 * 1000;

            // Thumbnail
            const thumbSrc = pack.banner || pack.poster || _defaultBannerDataUrl || '';
            const thumbStyle = thumbSrc ? `style="background-image: url('${thumbSrc}');"` : '';

            // Loader display name
            const loaderDisplayMap = { forge: 'Forge', fabric: 'Fabric', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla', none: 'Vanilla' };
            const loaderDisplay = loaderDisplayMap[loaderType] || (loaderType ? loaderType.charAt(0).toUpperCase() + loaderType.slice(1) : 'Forge');

            // Description (capped)
            const desc = (pack.description || '').slice(0, 80) + ((pack.description || '').length > 80 ? '…' : '');

            card.innerHTML = `
                <div class="cf-card-thumb" ${thumbStyle}>
                    ${!thumbSrc ? '<div class="cf-card-thumb-fallback"></div>' : ''}
                    ${statusLabel ? `<span class="cf-card-badge cf-badge-status">${statusLabel}</span>` : ''}
                    ${isNew ? '<span class="cf-card-badge cf-badge-new">New</span>' : ''}
                </div>
                <div class="cf-card-body">
                    <h3 class="cf-card-title">${pack.title || pack.name}</h3>
                    ${desc ? `<div class="cf-card-author">${desc}</div>` : ''}
                    <div class="cf-card-tags-row">
                        ${mcVersion ? `<span class="cf-card-tag">${mcVersion}</span>` : ''}
                        ${loaderDisplay ? `<span class="cf-card-tag cf-card-tag-loader">${loaderDisplay}</span>` : ''}
                    </div>
                </div>
            `;

            card.packData = pack;

            card.addEventListener('click', () => {
                this.selectInstance(pack);
            });

            gridContainer.appendChild(card);
        });
    }

    /* ── Card Hover Detail Panel ── */

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
        document.querySelectorAll(`.cf-card[data-instance-name="${name}"]`).forEach(card => {
            const thumb = card.querySelector('.cf-card-thumb');
            if (!thumb) return;
            let existing = thumb.querySelector('.cf-card-badge');
            if (existing) existing.remove();
            if (!label) return;
            const tag = document.createElement('span');
            tag.className = 'cf-card-badge cf-badge-status';
            tag.textContent = label;
            thumb.prepend(tag);
        });
    }

    async selectInstance(pack) {
        // Save selection in DB
        let configClient = await this.db.readData('configClient');
        configClient.instance_select = pack.name;
        await this.db.updateData('configClient', configClient);

        // Switch to detail view
        this._navigateTo('view-detail', null);
        this._pushNav('view-detail', null);

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
                this._navigateTo('view-home', 'nav-btn-home');
                this._pushNav('view-home', 'nav-btn-home');
            });
        }

        // Show top back button
        const topBackBtn = document.getElementById('top-back-btn');
        if (topBackBtn) {
            topBackBtn.style.display = 'flex';
            topBackBtn.replaceWith(topBackBtn.cloneNode(true));
            const newTopBack = document.getElementById('top-back-btn');
            newTopBack.addEventListener('click', () => {
                this._navigateTo('view-home', 'nav-btn-home');
                this._pushNav('view-home', 'nav-btn-home');
            });
        }

        // Fill detail viewport floating card content
        document.getElementById('detail-title').textContent = pack.title || pack.name;

        // Creator
        const creatorEl = document.getElementById('detail-creator');
        if (creatorEl) {
            creatorEl.textContent = pack.author || pack.creator || '';
        }

        // Tags
        const tagsContainer = document.getElementById('detail-tags');
        if (tagsContainer) {
            const customTags = pack.tags || [];
            let tagsHtml = '';
            customTags.forEach(t => { tagsHtml += `<span>${t}</span>`; });
            tagsContainer.innerHTML = tagsHtml;
        }

        // Description
        const descEl = document.getElementById('detail-desc');
        if (descEl) {
            descEl.textContent = pack.description || '';
        }

        // Size
        const sizeEl = document.getElementById('detail-size');
        if (sizeEl && pack.size) {
            const bytes = parseInt(pack.size);
            if (!isNaN(bytes)) {
                const gb = (bytes / (1024*1024*1024)).toFixed(2);
                sizeEl.textContent = gb + ' GB';
            } else {
                sizeEl.textContent = pack.size;
            }
        } else if (sizeEl) {
            sizeEl.textContent = '';
        }

        // Modpack version (not MC version)
        const packVersionEl = document.getElementById('detail-pack-version');
        if (packVersionEl) {
            packVersionEl.textContent = pack.version || pack.modpack_version || '';
        }

        // Set banner image
        const bannerSrc = pack.banner || _defaultBannerDataUrl || '';
        const bannerImg = document.getElementById('detail-banner-img');
        if (bannerImg) {
            bannerImg.src = bannerSrc;
            bannerImg.style.display = bannerSrc ? '' : 'none';
        }

        // Set poster image
        const posterSrc = pack.poster || pack.image || _defaultPosterDataUrl || '';
        const posterImg = document.getElementById('detail-poster-img');
        if (posterImg) {
            posterImg.src = posterSrc;
            posterImg.style.display = posterSrc ? '' : 'none';
            posterImg.alt = (pack.title || pack.name) + ' poster';
        }

        // Verify if already downloaded
        let hasDownloaded = false;
        let effectiveGamePath = this.gamePath;
        const localPackDir = path.join(this.gamePath, 'instances', pack.name);
        const hasVersion = configClient.instances_versions?.[pack.name];
        const hasManifestFile = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
        const hasZipDir = pack.zipUrl && fs.existsSync(localPackDir) && fs.readdirSync(localPackDir).length > 0;
        hasDownloaded = hasVersion || hasManifestFile || hasZipDir;

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
                if (!pack.modpack_url && !pack.zipUrl) {
                    alert('Este modpack no tiene URL de sincronización configurada.');
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

                // ZIP update: delete and re-download
                if (pack.zipUrl) {
                    if (confirm('¿Re-descargar el modpack ZIP? Se reemplazarán todos los archivos.')) {
                        try {
                            fs.rmSync(localPackDir, { recursive: true, force: true });
                            let cc = await this.db.readData('configClient');
                            if (cc.instances_versions) delete cc.instances_versions[pack.name];
                            await this.db.updateData('configClient', cc);
                            this.startGame(pack, gamePath);
                        } catch (err) {
                            alert(`Error al actualizar: ${err.message}`);
                        }
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

            verify: (options.modpack_url || options.zipUrl) ? false : (options.verify ?? true),
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

        // 1. Download ZIP pack (if applicable)
        if (options.zipUrl) {
            const instancePath = path.join(gamePath, 'instances', options.name);
            const storedVersion = configClient.instances_versions?.[options.name] || null;

            // Skip if already downloaded with same version
            if (storedVersion !== (options.zipVersion || 'v1')) {
                try {
                    if (progressText) progressText.innerHTML = `Descargando modpack...`;

                    this.showDownload(options.name, options.title || options.name);

                    const instanceDir = path.join(gamePath, 'instances', options.name);
                    if (!fs.existsSync(instanceDir)) {
                        fs.mkdirSync(instanceDir, { recursive: true });
                    }

                    await zipHandler.downloadAndExtract(options.zipUrl, instanceDir, (downloaded, total) => {
                        const pct = ((downloaded / total) * 100).toFixed(0);
                        if (progressText) progressText.innerHTML = `Descargando... ${pct}%`;
                        ipcRenderer.send('main-window-progress', { progress: downloaded, size: total });
                        if (wavyBar) wavyBar.style.width = `${pct}%`;
                        if (progressPct) progressPct.innerHTML = `${pct}%`;
                        this.updateDownload(options.name, pct, 'Descargando...');
                    });

                    this.hideDownload(options.name);

                    // Store version
                    if (!configClient.instances_versions) configClient.instances_versions = {};
                    configClient.instances_versions[options.name] = options.zipVersion || 'v1';
                    await this.db.updateData('configClient', configClient);

                    // Write .first-seen for "Nuevo" badge
                    try {
                        const firstSeenPath = path.join(instancePath, '.first-seen');
                        if (!fs.existsSync(firstSeenPath)) {
                            fs.writeFileSync(firstSeenPath, String(Date.now()));
                        }
                    } catch (e) {}

                    await this.initInstances();
                    await this.selectInstance(options);

                    progressContainer = document.getElementById('detail-progress');
                    progressText = document.getElementById('detail-progress-text');
                    progressPct = document.getElementById('detail-progress-pct');
                    if (progressContainer) progressContainer.style.display = 'flex';
                } catch (err) {
                    this.hideDownload(options.name);
                    let popupError = new popup();
                    popupError.openPopup({
                        title: 'Error de Descarga',
                        content: err.message,
                        color: 'red',
                        options: true
                    });
                    const playBtnErr = document.getElementById('detail-play-btn');
                    const btnContentErr = document.getElementById('detail-play-btn-content');
                    const btnSpinnerErr = document.getElementById('detail-play-btn-spinner');
                    if (btnContentErr) btnContentErr.style.display = 'flex';
                    if (btnSpinnerErr) btnSpinnerErr.style.display = 'none';
                    if (playBtnErr) playBtnErr.disabled = false;
                    if (progressContainer) progressContainer.style.display = 'none';
                    this._launching = false;
                    return;
                }
            }
        }

        // 2. Sync modpack (if applicable) — SKCraft-style with feature gating and version tracking
        if (options.modpack_url && !options.zipUrl) {
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

            await this.populateRecentInstance();
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
    _popupVisible = false;

        initCalendar() {
        this.loadCalendarEvents();
        this.renderCalendar();
        this.setupCalendarNav();

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._popupVisible) this.hideEventPopup();
        });
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
                    if (this._isCalendarViewActive() && this._calSelectedDate) {
                        this.showEventPopup(null, this._calSelectedDate);
                    }
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

            const dayEvents = this._calEvents.filter(e => e.date === dateStr);
            if (dayEvents.length > 0) {
                el.classList.add('has-event');
                dayEvents.slice(0, 3).forEach(ev => {
                    const label = document.createElement('div');
                    label.className = 'cal-day-event-name';
                    label.textContent = ev.title;
                    el.appendChild(label);
                });
                if (dayEvents.length > 3) {
                    const more = document.createElement('div');
                    more.className = 'cal-day-event-name';
                    more.textContent = `+${dayEvents.length - 3} más`;
                    el.appendChild(more);
                }
            }

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.cal-day.selected').forEach(el2 => el2.classList.remove('selected'));
                el.classList.add('selected');
                this._calSelectedDate = dateStr;
                this.showEventPopup(el, dateStr);
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

    showEventPopup(anchorEl, dateStr) {
        const popup = document.getElementById('cal-popup');
        if (!popup) return;

        const dayEvents = this._calEvents.filter(e => e.date === dateStr);

        if (dayEvents.length === 0) {
            this.hideEventPopup();
            return;
        }

        const [y, m, d] = dateStr.split('-');
        const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
        const dateLabel = `${d} de ${months[parseInt(m)-1]} de ${y}`;

        let eventsHtml = '';
        dayEvents.forEach(ev => {
            eventsHtml += `
                <div class="cal-popup-event">
                    <span class="event-dot"></span>
                    <div class="event-info">
                        <div class="event-title">${ev.title}</div>
                        <div class="event-time">${ev.time || 'Todo el día'}</div>
                        ${ev.description ? `<div class="event-description">${ev.description}</div>` : ''}
                    </div>
                </div>
            `;
        });

        popup.innerHTML = `
            <div class="cal-popup-header">
                <span class="cal-popup-date">${dateLabel}</span>
                <button class="cal-popup-close" id="cal-popup-close">✕</button>
            </div>
            ${eventsHtml}
        `;

        document.getElementById('cal-popup-close').addEventListener('click', (e) => {
            e.stopPropagation();
            this.hideEventPopup();
        });

        let overlay = document.getElementById('cal-popup-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'cal-popup-overlay';
            overlay.className = 'calendar-popup-overlay';
            const view = document.getElementById('view-calendar');
            if (view) view.appendChild(overlay);
        }

        popup.classList.add('visible');
        overlay.classList.add('visible');
        this._popupVisible = true;

        overlay.addEventListener('click', () => this.hideEventPopup());
    }

    hideEventPopup() {
        const popup = document.getElementById('cal-popup');
        const overlay = document.getElementById('cal-popup-overlay');
        if (popup) {
            popup.classList.remove('visible');
            popup.innerHTML = '';
        }
        if (overlay) overlay.classList.remove('visible');
        this._popupVisible = false;
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
                avatarEl.style.background = `url(${skinUrl}) center / cover`;
                avatarEl.innerHTML = '';
            } else if (_steveSkinDataUrl) {
                avatarEl.style.background = `url('${_steveSkinDataUrl}') center / cover`;
                avatarEl.innerHTML = '';
            } else {
                avatarEl.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
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

    /* ── Floating Settings Modal ── */

    openSettingsModal() {
        const overlay = document.getElementById('settings-modal-overlay');
        if (!overlay) return;
        overlay.classList.add('open');
        this._initSettingsModal();
    }

    closeSettingsModal() {
        const overlay = document.getElementById('settings-modal-overlay');
        if (overlay) overlay.classList.remove('open');
    }

    async _initSettingsModal() {
        // Populate modal account info
        let configClient = await this.db.readData('configClient');
        let auth = configClient.account_selected
            ? await this.db.readData('accounts', configClient.account_selected)
            : null;

        const nameEl = document.getElementById('modal-acc-active-name');
        const typeEl = document.getElementById('modal-acc-active-type');
        const avatarEl = document.getElementById('modal-acc-active-avatar');

        if (nameEl) nameEl.textContent = auth?.name || 'Sin cuenta';
        if (typeEl) typeEl.textContent = auth?.meta?.type || 'Offline';

        if (avatarEl && auth) {
            const skinUrl = await this._getSkinUrl(auth);
            if (skinUrl) {
                avatarEl.style.background = `url(${skinUrl}) center / cover`;
                avatarEl.innerHTML = '';
            } else if (_steveSkinDataUrl) {
                avatarEl.style.background = `url('${_steveSkinDataUrl}') center / cover`;
                avatarEl.innerHTML = '';
            } else {
                avatarEl.style.background = 'linear-gradient(135deg, var(--green-dark), var(--green-mid))';
                avatarEl.innerHTML = '<span style="color:#fff;font-size:24px;font-weight:700;">' + (auth.name ? auth.name.charAt(0).toUpperCase() : '?') + '</span>';
            }
        }

        // Wire up close button
        const closeBtn = document.getElementById('settings-modal-close');
        if (closeBtn) {
            closeBtn.replaceWith(closeBtn.cloneNode(true));
            document.getElementById('settings-modal-close').addEventListener('click', () => this.closeSettingsModal());
        }

        // Close on overlay click
        const overlay = document.getElementById('settings-modal-overlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) this.closeSettingsModal();
            });
        }

        // Bind settings controls inside the modal using querySelectorAll
        this._bindModalSettings(configClient);
    }

    _bindModalSettings(configClient) {
        const modal = document.getElementById('settings-modal-container');
        if (!modal) return;

        // RAM
        const totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        const maxSlider = Math.max(1, Math.trunc((80 * totalMem) / 100));
        let ram = configClient?.java_config?.java_memory || { min: 1, max: 2 };
        const clamp = (val) => Math.round(Math.min(Math.max(val, 0.5), maxSlider) * 10) / 10;

        const saveRam = async (min, max) => {
            let cfg = await this.db.readData('configClient');
            if (!cfg.java_config) cfg.java_config = {};
            cfg.java_config.java_memory = { min: clamp(min), max: clamp(max) };
            await this.db.updateData('configClient', cfg);
        };

        const modalMinInput = modal.querySelector('.ram-min-input');
        const modalMaxInput = modal.querySelector('.ram-max-input');
        const modalStepBtns = modal.querySelectorAll('.ram-step-btn');

        if (modalMinInput) {
            modalMinInput.value = Math.round(ram.min * 10) / 10;
            modalMinInput.addEventListener('change', async () => {
                let val = clamp(parseFloat(modalMinInput.value) || 1);
                let M = clamp(parseFloat(modalMaxInput?.value) || 2);
                if (val > M) val = M;
                modalMinInput.value = val;
                await saveRam(val, M);
            });
            modalMinInput.addEventListener('input', () => {
                const m = clamp(parseFloat(modalMinInput.value) || 1);
                const M = clamp(parseFloat(modalMaxInput?.value) || 2);
                if (m > M) modalMinInput.value = M;
            });
        }

        if (modalMaxInput) {
            modalMaxInput.value = Math.round(ram.max * 10) / 10;
            modalMaxInput.addEventListener('change', async () => {
                let val = clamp(parseFloat(modalMaxInput.value) || 2);
                let m = clamp(parseFloat(modalMinInput?.value) || 1);
                if (val < m) val = m;
                modalMaxInput.value = val;
                await saveRam(m, val);
            });
            modalMaxInput.addEventListener('input', () => {
                const m = clamp(parseFloat(modalMinInput?.value) || 1);
                const M = clamp(parseFloat(modalMaxInput.value) || 2);
                if (M < m) modalMaxInput.value = m;
            });
        }

        modalStepBtns.forEach(btn => {
            btn.addEventListener('click', async () => {
                const target = btn.dataset.target;
                const dir = parseInt(btn.dataset.dir);
                const inp = target === 'min' ? modalMinInput : modalMaxInput;
                if (!inp) return;
                let current = clamp((parseFloat(inp.value) || 1) + dir * 0.5);
                let other = target === 'min'
                    ? clamp(parseFloat(modalMaxInput?.value) || 2)
                    : clamp(parseFloat(modalMinInput?.value) || 1);
                if (target === 'min' && current > other) current = other;
                if (target === 'max' && current < other) current = other;
                inp.value = current;
                await saveRam(
                    clamp(parseFloat(modalMinInput?.value) || 1),
                    clamp(parseFloat(modalMaxInput?.value) || 2)
                );
            });
        });

        // Java path
        const javaPathText = modal.querySelector(".java-path-txt");
        if (javaPathText) {
            appdata().then(p => { javaPathText.textContent = `${p}/.yusup/runtime`; });
        }
        const javaPathInputTxt = modal.querySelector(".java-path-input-text");
        const javaPathInputFile = modal.querySelector(".java-path-input-file");
        const jp = configClient?.java_config?.java_path || 'Utiliser la version de java livre avec le launcher';
        if (javaPathInputTxt) javaPathInputTxt.value = jp;

        const setBtn = modal.querySelector(".java-path-set");
        if (setBtn) {
            setBtn.replaceWith(setBtn.cloneNode(true));
            modal.querySelector(".java-path-set")?.addEventListener("click", async () => {
                if (javaPathInputFile) {
                    javaPathInputFile.value = '';
                    javaPathInputFile.click();
                    await new Promise((resolve) => {
                        let interval = setInterval(() => {
                            if (javaPathInputFile.value != '') { clearInterval(interval); resolve(); }
                        }, 100);
                    });
                    if (javaPathInputFile.value.replace(".exe", '').endsWith("java") || javaPathInputFile.value.replace(".exe", '').endsWith("javaw")) {
                        let currentConfig = await this.db.readData('configClient');
                        let file = javaPathInputFile.files[0].path;
                        if (javaPathInputTxt) javaPathInputTxt.value = file;
                        currentConfig.java_config.java_path = file;
                        await this.db.updateData('configClient', currentConfig);
                    } else alert("El nombre del archivo debe ser java o javaw");
                }
            });
        }

        const resetBtn = modal.querySelector(".java-path-reset");
        if (resetBtn) {
            resetBtn.replaceWith(resetBtn.cloneNode(true));
            modal.querySelector(".java-path-reset")?.addEventListener("click", async () => {
                let currentConfig = await this.db.readData('configClient');
                if (javaPathInputTxt) javaPathInputTxt.value = 'Utiliser la version de java livre avec le launcher';
                currentConfig.java_config.java_path = null;
                await this.db.updateData('configClient', currentConfig);
            });
        }

        // Resolution
        let resolution = configClient?.game_config?.screen_size || { width: 1920, height: 1080 };
        const widthInput = modal.querySelector(".width-size");
        const heightInput = modal.querySelector(".height-size");
        const resetResBtn = modal.querySelector(".size-reset");

        if (widthInput) {
            widthInput.value = resolution.width;
            widthInput.addEventListener("change", async () => {
                let currentConfig = await this.db.readData('configClient');
                currentConfig.game_config.screen_size.width = widthInput.value;
                await this.db.updateData('configClient', currentConfig);
            });
        }
        if (heightInput) {
            heightInput.value = resolution.height;
            heightInput.addEventListener("change", async () => {
                let currentConfig = await this.db.readData('configClient');
                currentConfig.game_config.screen_size.height = heightInput.value;
                await this.db.updateData('configClient', currentConfig);
            });
        }
        if (resetResBtn) {
            resetResBtn.addEventListener("click", async () => {
                let currentConfig = await this.db.readData('configClient');
                currentConfig.game_config.screen_size = { width: '854', height: '480' };
                if (widthInput) widthInput.value = '854';
                if (heightInput) heightInput.value = '480';
                await this.db.updateData('configClient', currentConfig);
            });
        }

        // Toggles — read/write directly to DB
        const toggleCfg = {
            'modal-setting-console': 'console',
            'modal-setting-auto-update': 'autoUpdate',
            'modal-setting-dedicated-gpu': 'dedicatedGPU'
        };
        for (const [elId, cfgKey] of Object.entries(toggleCfg)) {
            const cb = document.getElementById(elId);
            if (!cb) continue;
            const stored = configClient?.launcher_config?.[cfgKey];
            cb.checked = stored === true || stored === 'true';
            cb.addEventListener('change', async () => {
                let currentConfig = await this.db.readData('configClient');
                if (!currentConfig.launcher_config) currentConfig.launcher_config = {};
                currentConfig.launcher_config[cfgKey] = cb.checked;
                await this.db.updateData('configClient', currentConfig);
            });
        }

        // Auto-update interval — read/write directly to DB
        const intervalSel = document.getElementById('modal-setting-auto-update-interval');
        if (intervalSel) {
            const stored = configClient?.launcher_config?.autoUpdateInterval || '60';
            intervalSel.value = stored;
            intervalSel.addEventListener('change', async () => {
                let currentConfig = await this.db.readData('configClient');
                if (!currentConfig.launcher_config) currentConfig.launcher_config = {};
                currentConfig.launcher_config.autoUpdateInterval = intervalSel.value;
                await this.db.updateData('configClient', currentConfig);
            });
        }

        // Downloads
        const maxFilesInput = modal.querySelector(".max-files");
        const maxFilesReset = modal.querySelector(".max-files-reset");
        const dlConfig = configClient?.launcher_config?.download_multi || 5;
        if (maxFilesInput) {
            maxFilesInput.value = dlConfig;
            maxFilesInput.addEventListener("change", async () => {
                let currentConfig = await this.db.readData('configClient');
                currentConfig.launcher_config.download_multi = maxFilesInput.value;
                await this.db.updateData('configClient', currentConfig);
            });
        }
        if (maxFilesReset) {
            maxFilesReset.addEventListener("click", async () => {
                let currentConfig = await this.db.readData('configClient');
                if (maxFilesInput) maxFilesInput.value = 5;
                currentConfig.launcher_config.download_multi = 5;
                await this.db.updateData('configClient', currentConfig);
            });
        }

        // Close behavior
        const closeBox = modal.querySelector(".close-box");
        if (closeBox) {
            let closeLauncher = configClient?.launcher_config?.closeLauncher || "close-launcher";
            closeBox.querySelectorAll('.behavior-btn').forEach(b => b.classList.remove('active-close'));
            const targetBtn = closeBox.querySelector('.' + closeLauncher.replace(/-/g, '-'));
            if (targetBtn) targetBtn.classList.add('active-close');

            closeBox.addEventListener("click", async e => {
                if (e.target.classList.contains('behavior-btn')) {
                    let activeClose = closeBox.querySelector('.active-close');
                    if (e.target.classList.contains('active-close')) return;
                    if (activeClose) activeClose.classList.remove('active-close');
                    e.target.classList.add('active-close');

                    let currentConfig = await this.db.readData('configClient');
                    if (e.target.classList.contains('close-launcher')) {
                        currentConfig.launcher_config.closeLauncher = "close-launcher";
                    } else if (e.target.classList.contains('close-all')) {
                        currentConfig.launcher_config.closeLauncher = "close-all";
                    } else if (e.target.classList.contains('close-none')) {
                        currentConfig.launcher_config.closeLauncher = "close-none";
                    }
                    await this.db.updateData('configClient', currentConfig);
                }
            });
        }
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
