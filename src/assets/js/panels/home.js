import { config, database, logger, changePanel, appdata, setStatus, pkg, popup, ModpackSync, NeoForgeSync, skin2D, accountSelect, Slider } from '../utils.js';

const { Launch } = require('minecraft-java-core');
const { shell, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

class Home {
    static id = "home";

    async init(config) {
        this.config = config;
        this.db = new database();
        this.minecraftProcess = null;

        const gamePath = `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`;
        this.gamePath = gamePath;

        // Initialize user skin / head avatar
        await this.initUserAvatar();

        // 1. Load news section
        this.news();

        // 2. Setup Navigation, Account View & Friends
        this.setupNavigation();
        await this.setupAccountView();

        // 3. Render and initialize modpacks
        await this.initInstances();

        // 4. Initialize Settings
        await this.initSettings();
    }

    async initUserAvatar() {
        let configClient = await this.db.readData('configClient');
        let auth = await this.db.readData('accounts', configClient.account_selected);
        const avatarEl = document.querySelector('#nav-btn-account .player-head-nav');
        if (avatarEl) {
            if (auth && auth.profile && auth.profile.skins && auth.profile.skins[0]) {
                try {
                    let headTex = await new skin2D().creatHeadTexture(auth.profile.skins[0].base64);
                    avatarEl.style.backgroundImage = `url(${headTex})`;
                    avatarEl.innerHTML = ''; // Remove default icon SVG
                } catch (e) {
                    avatarEl.style.backgroundImage = `url('assets/images/default/setve.png')`;
                }
            } else {
                avatarEl.style.backgroundImage = `url('assets/images/default/setve.png')`;
            }
        }
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
        const navButtons = document.querySelectorAll('.sidebar-circle-btn.nav-btn, #nav-btn-account');
        const views = document.querySelectorAll('.dashboard-view');
        const backBtn = document.getElementById('sidebar-back-btn');

        navButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                let targetViewId = '';
                if (btn.id === 'nav-btn-account') targetViewId = 'view-account';
                else if (btn.id === 'nav-btn-home') targetViewId = 'view-home';
                else if (btn.id === 'nav-btn-instances') targetViewId = 'view-instances';
                else if (btn.id === 'nav-btn-settings') targetViewId = 'view-settings';

                if (!targetViewId) return;

                // Toggle active buttons
                navButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Switch views
                views.forEach(v => v.classList.remove('active'));
                document.getElementById(targetViewId)?.classList.add('active');

                // Hide back button on normal tabs
                if (backBtn) backBtn.style.display = 'none';

                // Close dropdown if open
                const dropdown = document.getElementById('detail-options-dropdown');
                if (dropdown) dropdown.style.display = 'none';
            });
        });

        // BIND: Sidebar details back button
        backBtn?.addEventListener('click', () => {
            navButtons.forEach(b => b.classList.remove('active'));
            document.getElementById('nav-btn-instances')?.classList.add('active');

            views.forEach(v => v.classList.remove('active'));
            document.getElementById('view-instances')?.classList.add('active');

            if (backBtn) backBtn.style.display = 'none';
        });
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
            activeNameEl.textContent = currentAccount.name;
            activeUuidEl.textContent = `UUID: ${currentAccount.uuid || '-'}`;
            activeTypeEl.textContent = currentAccount.meta?.type || 'Offline';

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
            document.querySelector('.cancel-home').style.display = 'inline';
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
        let configClient = await this.db.readData('configClient');
        let instancesList = await config.getInstanceList();
        let currentSelect = configClient.instance_select;

        // Auto select first instance if none selected
        if (!currentSelect && instancesList.length > 0) {
            currentSelect = instancesList[0].name;
            configClient.instance_select = currentSelect;
            await this.db.updateData('configClient', configClient);
        }

        // 1. Separate installed vs available modpacks
        let installedPacks = [];
        let allPacks = [];

        for (let pack of instancesList) {
            const localPackDir = path.join(this.gamePath, pack.name);
            const hasDownloaded = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
            if (hasDownloaded) {
                installedPacks.push(pack);
            }
            allPacks.push(pack);
        }

        // 2. Render normal sections
        this.renderInstancesGrid(installedPacks, 'instances-grid-installed');
        this.renderInstancesGrid(allPacks, 'instances-grid-all');

        // 3. Render creator tools modpacks (if any exist)
        const adminSection = document.getElementById('instances-admin-section');
        let creatorModpacks = [];
        const creatorPath = path.resolve(__dirname, '..', '..', '..', 'data', 'creator-modpacks.json');
        if (fs.existsSync(creatorPath)) {
            try {
                const fileData = fs.readFileSync(creatorPath, 'utf8');
                let parsedData = JSON.parse(fileData);
                creatorModpacks = parsedData.map(c => {
                    const loaderType = (c.loader || 'none').toLowerCase();
                    const isLocalInstalled = c.location && fs.existsSync(c.location);
                    return {
                        name: c.id,
                        title: c.title,
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
                        verify: false,
                        ignored: [],
                        themeColor: 'lime',
                        playTime: '0.0h',
                        creatorTools: true,
                        localInstalled: isLocalInstalled,
                        location: c.location
                    };
                });
            } catch (e) {
                console.error('Error reading creator tools modpacks:', e);
            }
        }
        if (creatorModpacks.length > 0) {
            if (adminSection) adminSection.style.display = 'block';
            this.renderInstancesGrid(creatorModpacks, 'instances-grid-creator');
        } else {
            if (adminSection) adminSection.style.display = 'none';
        }
    }

    renderInstancesGrid(packs, containerId) {
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
            card.innerHTML = `
                <div class="modpack-grid-thumb">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                        <line x1="12" y1="22.08" x2="12" y2="12"></line>
                    </svg>
                </div>
                <h3 class="modpack-grid-name">${pack.title || pack.name}</h3>
            `;

            card.addEventListener('click', () => {
                this.selectInstance(pack);
            });

            gridContainer.appendChild(card);
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

        // Show sidebar back button
        const backBtn = document.getElementById('sidebar-back-btn');
        if (backBtn) backBtn.style.display = 'flex';

        // Fill detail viewport floating card content
        document.getElementById('detail-title').textContent = pack.title || pack.name;
        document.getElementById('detail-version').textContent = pack.gameVersion || pack.loader.minecraft_version;
        document.getElementById('detail-playtime').textContent = pack.playTime || '0.0h';

        // Dynamic tags
        const tagsContainer = document.getElementById('detail-tags');
        if (tagsContainer) {
            tagsContainer.innerHTML = `
                <span>${(pack.loader?.type || pack.loader?.loader_type || 'vanilla').toUpperCase()}</span>
                <span>Minecraft ${pack.gameVersion || pack.loader?.minecraft_version || ''}</span>
                <span>Optimizado</span>
            `;
        }

        // Dynamic Description
        const descEl = document.getElementById('detail-desc');
        if (descEl) {
            descEl.innerHTML = pack.creatorTools 
                ? `Esta es una instancia local del desarrollador creada con las herramientas del Creator Tools.<br><br><b>Ubicación local del proyecto:</b><br><code>${pack.location}</code>`
                : `Un evento único y optimizado donde experimentarás la mejor jugabilidad en Minecraft. Disfruta de rendimiento superior, mods integrados y conectividad instantánea con el servidor principal.`;
        }

        // Verify if already downloaded/available to choose Jugar / Descargar label
        let hasDownloaded = false;
        let effectiveGamePath = this.gamePath;

        if (pack.creatorTools) {
            // Creator Tools instances: use their local location folder directly
            hasDownloaded = pack.localInstalled || (pack.location && fs.existsSync(pack.location));
            // For local creator packs, the gamePath is the parent of the location folder
            if (pack.location) effectiveGamePath = path.dirname(pack.location);
        } else {
            const localPackDir = path.join(this.gamePath, pack.name);
            hasDownloaded = fs.existsSync(localPackDir) && fs.existsSync(path.join(localPackDir, 'modpack.json'));
        }

        const playBtnLabel = document.querySelector('#detail-play-btn-content span');
        if (playBtnLabel) {
            if (pack.creatorTools) {
                playBtnLabel.textContent = hasDownloaded ? 'Play (Local)' : 'Carpeta no encontrada';
            } else {
                playBtnLabel.textContent = hasDownloaded ? 'Play' : 'Descargar';
            }
        }

        // Disable play for Creator Tools if location doesn't exist
        const playBtn = document.getElementById('detail-play-btn');
        if (playBtn && pack.creatorTools && !hasDownloaded) {
            playBtn.disabled = true;
            playBtn.title = `La carpeta del modpack no existe: ${pack.location}`;
        } else if (playBtn) {
            playBtn.disabled = false;
            playBtn.title = '';
        }

        // Setup launcher control listeners
        this.setupLauncherControls(pack, effectiveGamePath);
    }

    setupLauncherControls(pack, gamePath) {
        const playBtn = document.getElementById('detail-play-btn');
        const optionsBtn = document.getElementById('detail-options-btn');
        const dropdown = document.getElementById('detail-options-dropdown');

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
            if (dropdown) {
                const isOpen = dropdown.style.display === 'flex';
                dropdown.style.display = isOpen ? 'none' : 'flex';
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            if (dropdown) dropdown.style.display = 'none';
        });

        // Dropdown Items Clicks Handlers
        const localPackDir = path.join(gamePath, pack.name);
        const openFolder = (subDir) => {
            if (dropdown) dropdown.style.display = 'none';
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
            if (dropdown) dropdown.style.display = 'none';
            if (!fs.existsSync(localPackDir)) {
                alert('Esta instancia aún no se ha instalado.');
                return;
            }

            if (confirm(`¿Estás completamente seguro de que quieres eliminar la instancia de ${pack.title || pack.name}?\nTodos tus mundos locales y capturas serán eliminados permanentemente.`)) {
                try {
                    fs.rmSync(localPackDir, { recursive: true, force: true });
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
            if (dropdown) dropdown.style.display = 'none';
            if (this.minecraftProcess) {
                this.minecraftProcess.kill();
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

        // Normalize loader fields: support both old (loader_type/loader_version) and new (type/build) formats
        const loaderType = (options.loader?.loader_type || options.loader?.type || 'none').toLowerCase();
        const loaderVersion = options.loader?.loader_version || options.loader?.build || '';
        const mcVersion = options.loader?.minecraft_version || options.gameVersion || '1.20.1';
        const loaderEnabled = loaderType !== 'none' && loaderType !== 'vanilla' && loaderVersion !== '';

        // For Creator Tools instances: use the location as the instance folder directly
        let effectivePath = gamePath;
        let instanceName = options.name;
        if (options.creatorTools && options.location) {
            // The instance folder IS the location itself; gamePath is the parent
            effectivePath = path.dirname(options.location);
            instanceName = path.basename(options.location);
        }

        let opt = {
            url: options.url || undefined,  // undefined means no remote sync
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

            // Creator Tools local instances skip remote file verification
            verify: options.creatorTools ? false : (options.verify ?? true),
            ignored: options.ignored ? [...options.ignored] : [],

            java: {
                path: configClient.java_config?.java_path || null,
            },

            JVM_ARGS: options.jvm_args ? options.jvm_args : [],
            GAME_ARGS: options.game_args ? options.game_args : [],

            screen: {
                width: configClient.game_config?.screen_size?.width || 854,
                height: configClient.game_config?.screen_size?.height || 480
            },

            memory: {
                min: `${(configClient.java_config?.java_memory?.min || 1) * 1024}M`,
                max: `${(configClient.java_config?.java_memory?.max || 2) * 1024}M`
            }
        };

        // Transition Play Button to Loading Spinner, show floating progress card
        if (btnContent) btnContent.style.display = 'none';
        if (btnSpinner) btnSpinner.style.display = 'flex';
        playBtn.disabled = true;

        progressContainer.style.display = 'flex';
        wavyBar.style.width = '0%';
        progressPct.innerHTML = '0%';
        ipcRenderer.send('main-window-progress-load');

        // 1. Sync modpack (if applicable)
        if (options.modpack_url) {
            try {
                progressText.innerHTML = `Sincronizando modpack con el servidor...`;
                const modpackSync = new ModpackSync(options.modpack_url, `${gamePath}/${options.name}`);
                await modpackSync.sync((progress, size, message) => {
                    progressText.innerHTML = `${message} (${progress}/${size})`;
                    ipcRenderer.send('main-window-progress', { progress, size });
                    const pct = ((progress / size) * 100).toFixed(0);
                    wavyBar.style.width = `${pct}%`;
                    progressPct.innerHTML = `${pct}%`;
                });
            } catch (err) {
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
                progressContainer.style.display = 'none';
                return;
            }
        }

        // 2. Install NeoForge if specified
        if (loaderType === 'neoforge') {
            try {
                progressText.innerHTML = `Instalando NeoForge en curso...`;
                const javaPath = configClient.java_config?.java_path || 'java';
                const neoForgeSync = new NeoForgeSync(effectivePath, javaPath);

                const versionName = await neoForgeSync.install(
                    mcVersion,
                    loaderVersion,
                    (progress, size, message) => {
                        progressText.innerHTML = `${message}`;
                        ipcRenderer.send('main-window-progress', { progress, size });
                        const pct = ((progress / size) * 100).toFixed(0);
                        wavyBar.style.width = `${pct}%`;
                        progressPct.innerHTML = `${pct}%`;
                    }
                );

                opt.version = versionName;
                opt.loader.enable = false; // Bypass default forge in minecraft-java-core
            } catch (err) {
                let popupError = new popup();
                popupError.openPopup({
                    title: 'Error de Instalación de NeoForge',
                    content: err.message,
                    color: 'red',
                    options: true
                });

                // Restore button state
                if (btnContent) btnContent.style.display = 'flex';
                if (btnSpinner) btnSpinner.style.display = 'none';
                playBtn.disabled = false;
                progressContainer.style.display = 'none';
                return;
            }
        }

        // Analytics: session tracking
        let sessionId = null;
        const sessionStart = async () => {
            sessionId = Date.now();
            const username = authenticator?.name || 'unknown';
            const accountUuid = authenticator?.uuid || 'unknown';
            await this.db.createData('sessions', {
                username: username,
                account_uuid: accountUuid,
                instance: options.name || 'unknown',
                start_time: new Date().toISOString(),
                end_time: null,
                playtime_seconds: 0
            });
        };
        const sessionEnd = async () => {
            if (!sessionId) return;
            let sessions = await this.db.readAllData('sessions');
            let session = sessions.find(s => s.ID === sessionId);
            if (session) {
                let start = new Date(session.start_time);
                let end = new Date();
                session.end_time = end.toISOString();
                session.playtime_seconds = Math.floor((end - start) / 1000);
                await this.db.updateData('sessions', session, sessionId);
            }
            sessionId = null;
        };

        // 3. Launch game process
        progressText.innerHTML = `Lanzando proceso del juego...`;
        const proc = launch.Launch(opt);
        this.minecraftProcess = proc;

        launch.on('extract', () => {
            ipcRenderer.send('main-window-progress-load');
        });

        launch.on('progress', (progress, size) => {
            const pct = ((progress / size) * 100).toFixed(0);
            progressText.innerHTML = `Descargando recursos: ${pct}%`;
            ipcRenderer.send('main-window-progress', { progress, size });
            wavyBar.style.width = `${pct}%`;
            progressPct.innerHTML = `${pct}%`;
        });

        launch.on('check', (progress, size) => {
            const pct = ((progress / size) * 100).toFixed(0);
            progressText.innerHTML = `Verificando integridad: ${pct}%`;
            ipcRenderer.send('main-window-progress', { progress, size });
            wavyBar.style.width = `${pct}%`;
            progressPct.innerHTML = `${pct}%`;
        });

        launch.on('patch', () => {
            progressText.innerHTML = `Aplicando parches de inicio...`;
        });

        launch.on('data', () => {
            // Restore button state and hide progress card on launch data
            if (btnContent) btnContent.style.display = 'flex';
            if (btnSpinner) btnSpinner.style.display = 'none';
            playBtn.disabled = false;
            progressContainer.style.display = 'none';

            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-hide");
            }
            new logger('Minecraft', '#36b030');
            ipcRenderer.send('main-window-progress-load');

            sessionStart();
        });

        launch.on('close', async () => {
            await sessionEnd();

            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show");
            }
            ipcRenderer.send('main-window-progress-reset');

            // Restore button state
            if (btnContent) btnContent.style.display = 'flex';
            if (btnSpinner) btnSpinner.style.display = 'none';
            playBtn.disabled = false;
            progressContainer.style.display = 'none';

            new logger(pkg.name, '#7289da');
            this.minecraftProcess = null;

            // Trigger instances grid to refresh in case playTime changed
            await this.initInstances();
            await this.selectInstance(options);
        });

        launch.on('error', async err => {
            await sessionEnd();

            let popupError = new popup();
            popupError.openPopup({
                title: 'Error de Inicio',
                content: err.error || err.message || err,
                color: 'red',
                options: true
            });

            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show");
            }
            ipcRenderer.send('main-window-progress-reset');

            // Restore button state
            if (btnContent) btnContent.style.display = 'flex';
            if (btnSpinner) btnSpinner.style.display = 'none';
            playBtn.disabled = false;
            progressContainer.style.display = 'none';

            new logger(pkg.name, '#7289da');
            this.minecraftProcess = null;
        });
    }

    /* ==========================================================================
       MERGED GENERAL SETTINGS CONTROLLER LOGIC
       ========================================================================== */
    async initSettings() {
        this.settingsRam();
        await this.settingsJavaPath();
        await this.settingsResolution();
        await this.settingsLauncher();
    }

    async settingsRam() {
        let activeConfig = await this.db.readData('configClient');
        let totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        let freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;

        document.getElementById("total-ram").textContent = `${totalMem} Go`;
        document.getElementById("free-ram").textContent = `${freeMem} Go`;

        let sliderDiv = document.querySelector(".memory-slider");
        if (sliderDiv) sliderDiv.setAttribute("max", Math.trunc((80 * totalMem) / 100));

        let ram = activeConfig?.java_config?.java_memory ? {
            ramMin: activeConfig.java_config.java_memory.min,
            ramMax: activeConfig.java_config.java_memory.max
        } : { ramMin: "1", ramMax: "2" };

        if (totalMem < ram.ramMin) {
            activeConfig.java_config.java_memory = { min: 1, max: 2 };
            await this.db.updateData('configClient', activeConfig);
            ram = { ramMin: "1", ramMax: "2" }
        }

        let slider = new Slider(".memory-slider", parseFloat(ram.ramMin), parseFloat(ram.ramMax));

        let minSpan = document.querySelector(".slider-touch-left span");
        let maxSpan = document.querySelector(".slider-touch-right span");

        minSpan.setAttribute("value", `${ram.ramMin} Go`);
        maxSpan.setAttribute("value", `${ram.ramMax} Go`);

        slider.on("change", async (min, max) => {
            let currentConfig = await this.db.readData('configClient');
            minSpan.setAttribute("value", `${min} Go`);
            maxSpan.setAttribute("value", `${max} Go`);
            currentConfig.java_config.java_memory = { min: min, max: max };
            await this.db.updateData('configClient', currentConfig);
        });
    }

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

        let themeBox = document.querySelector(".theme-box");
        let theme = configClient?.launcher_config?.theme || "auto";

        // Remove old active classes
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active-theme'));

        if (theme == "auto") {
            document.querySelector('.theme-btn-auto')?.classList.add('active-theme');
        } else if (theme == "dark") {
            document.querySelector('.theme-btn-sombre')?.classList.add('active-theme');
        } else if (theme == "light") {
            document.querySelector('.theme-btn-clair')?.classList.add('active-theme');
        }

        themeBox?.replaceWith(themeBox.cloneNode(true));
        const newThemeBox = document.querySelector(".theme-box");
        newThemeBox?.addEventListener("click", async e => {
            if (e.target.classList.contains('theme-btn')) {
                let activeTheme = document.querySelector('.active-theme');
                if (e.target.classList.contains('active-theme')) return;
                activeTheme?.classList.remove('active-theme');

                if (e.target.classList.contains('theme-btn-auto')) {
                    await this.setBackground();
                    theme = "auto";
                    e.target.classList.add('active-theme');
                } else if (e.target.classList.contains('theme-btn-sombre')) {
                    await this.setBackground(true);
                    theme = "dark";
                    e.target.classList.add('active-theme');
                } else if (e.target.classList.contains('theme-btn-clair')) {
                    await this.setBackground(false);
                    theme = "light";
                    e.target.classList.add('active-theme');
                }

                let currentConfig = await this.db.readData('configClient');
                currentConfig.launcher_config.theme = theme;
                await this.db.updateData('configClient', currentConfig);
            }
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
        body.style.backgroundImage = 'none';
        body.style.backgroundColor = theme ? '#05070c' : '#f8fafc';
    }

    getdate(e) {
        let date = new Date(e);
        let year = date.getFullYear();
        let month = date.getMonth() + 1;
        let day = date.getDate();
        let allMonth = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
        return { year: year, month: allMonth[month - 1], day: day };
    }
}

export default Home;