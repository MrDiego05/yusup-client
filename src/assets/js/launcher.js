/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
// import panel
import Login from './panels/login.js';
import Home from './panels/home.js';
import Settings from './panels/settings.js';

// import modules
import { logger, config, changePanel, database, popup, setBackground, accountSelect, addAccount, pkg } from './utils.js';
const { AZauth, Microsoft, Mojang } = require('minecraft-java-core');

// libs
const { ipcRenderer } = require('electron');
const fs = require('fs');
const os = require('os');

class Launcher {
    async init() {
        this.initLog();
        console.log('Initializing Launcher...');
        this.shortcut()
        await setBackground()
        this.initFrame();
        this.showLoading('Conectando...', 'Obteniendo configuración del servidor', 10);
        this.config = await config.GetConfig().then(res => res).catch(err => err);
        if (await this.config.error) {
            this.hideLoading();
            return this.errorConnect()
        }
        this.showLoading('Base de datos', 'Inicializando almacenamiento local', 25);
        this.db = new database();
        await this.initConfigClient();
        this.showLoading('Paneles', 'Cargando interfaz del launcher', 40);
        this.createPanels(Login, Home, Settings);
        this.showLoading('Instancias', 'Cargando catálogo de modpacks', 60);
        this.startLauncher();
    }

    showLoading(status, substatus, progress) {
        const overlay = document.getElementById('loading-overlay');
        const statusEl = document.getElementById('loading-status');
        const substatusEl = document.getElementById('loading-substatus');
        const barEl = document.getElementById('loading-bar-fill');
        if (statusEl) statusEl.textContent = status;
        if (substatusEl) substatusEl.textContent = substatus;
        if (barEl) barEl.style.width = `${Math.min(progress, 95)}%`;
        if (overlay) overlay.classList.remove('hidden');
    }

    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.classList.add('hidden');
    }

    initLog() {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.keyCode == 73 || e.keyCode == 123) {
                ipcRenderer.send('main-window-dev-tools');
            }
        })
        new logger(pkg.name, '#7289da')
    }

    shortcut() {
        document.addEventListener('keydown', e => {
            // Ctrl + W to close window
            if (e.ctrlKey && e.keyCode == 87) {
                ipcRenderer.send('main-window-close');
            }
            // Ctrl + R or F5 to Hot Reload CSS/HTML instantly
            if ((e.ctrlKey && (e.key === 'r' || e.key === 'R')) || e.key === 'F5') {
                window.location.reload();
            }
        })
    }


    errorConnect() {
        new popup().openPopup({
            title: this.config.error.code,
            content: this.config.error.message,
            color: 'red',
            exit: true,
            options: true
        });
    }

    initFrame() {
        console.log('Initializing Frame...')
        let platform = os.platform() === 'darwin' ? "darwin" : "other";
        let frameEl = document.querySelector(`.${platform} .frame`);
        
        if (!frameEl) {
            platform = "other";
            frameEl = document.querySelector(`.${platform} .frame`);
        }

        if (frameEl) {
            frameEl.style.display = 'flex';
        }

        const minimizeBtn = document.querySelector(`.${platform} .frame #minimize`);
        if (minimizeBtn) {
            minimizeBtn.addEventListener('click', () => {
                ipcRenderer.send('main-window-minimize');
            });
        }

        let maximized = false;
        let maximize = document.querySelector(`.${platform} .frame #maximize`);
        if (maximize) {
            maximize.addEventListener('click', () => {
                ipcRenderer.send('main-window-maximize');
                maximized = !maximized
                maximize.classList.toggle('icon-maximize')
                maximize.classList.toggle('icon-restore-down')
            });
        }

        const closeBtn = document.querySelector(`.${platform} .frame #close`);
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                ipcRenderer.send('main-window-close');
            });
        }
    }

    async initConfigClient() {
        console.log('Initializing Config Client...')
        let configClient = await this.db.readData('configClient')

        if (!configClient) {
            await this.db.createData('configClient', {
                account_selected: null,
                instance_select: null,
                java_config: {
                    java_path: null,
                    java_memory: {
                        min: 1,
                        max: 2
                    }
                },
                game_config: {
                    screen_size: {
                        width: 854,
                        height: 480
                    }
                },
                launcher_config: {
                    download_multi: 5,
                    theme: 'auto',
                    closeLauncher: 'close-launcher',
                    intelEnabledMac: true
                }
            })
        }
    }

    createPanels(...panels) {
        let panelsElem = document.querySelector('.panels')
        for (let panel of panels) {
            console.log(`Initializing ${panel.name} Panel...`);
            let div = document.createElement('div');
            div.classList.add('panel', panel.id)
            div.innerHTML = fs.readFileSync(`${__dirname}/panels/${panel.id}.html`, 'utf8');
            panelsElem.appendChild(div);
            new panel().init(this.config);
        }
    }

    async startLauncher() {
        let accounts = await this.db.readAllData('accounts')
        let configClient = await this.db.readData('configClient')
        let account_selected = configClient ? configClient.account_selected : null
        let popupRefresh = new popup();

        if (accounts?.length) {
            let accIdx = 0;
            for (let account of accounts) {
                accIdx++;
                this.showLoading('Cuentas', `Verificando cuenta ${accIdx}/${accounts.length}: ${account.name}`, 60 + Math.round((accIdx / accounts.length) * 25));
                let account_ID = account.ID
                if (account.error) {
                    await this.db.deleteData('accounts', account_ID)
                    continue
                }
                
                // Migración automática de cuentas offline antiguas de Mojang -> Offline
                if (account.meta && account.meta.type === 'Mojang' && account.meta.online === false) {
                    account.meta.type = 'Offline';
                    await this.db.updateData('accounts', account, account_ID);
                }

                if (account.meta.type === 'Xbox') {
                    console.log(`Account Type: ${account.meta.type} | Username: ${account.name}`);
                    popupRefresh.openPopup({
                        title: 'Conexión',
                        content: `Actualizando cuenta Tipo: ${account.meta.type} | Usuario: ${account.name}`,
                        color: 'var(--color)',
                        background: false
                    });

                    let refresh_accounts = await new Microsoft(this.config.client_id).refresh(account);

                    if (refresh_accounts.error) {
                        await this.db.deleteData('accounts', account_ID)
                        if (account_ID == account_selected) {
                            configClient.account_selected = null
                            await this.db.updateData('configClient', configClient)
                        }
                        console.error(`[Account] ${account.name}: ${refresh_accounts.errorMessage}`);
                        continue;
                    }

                    refresh_accounts.ID = account_ID
                    await this.db.updateData('accounts', refresh_accounts, account_ID)
                    await addAccount(refresh_accounts)
                    if (account_ID == account_selected) accountSelect(refresh_accounts)
                } else if (account.meta.type == 'AZauth') {
                    console.log(`Account Type: ${account.meta.type} | Username: ${account.name}`);
                    popupRefresh.openPopup({
                        title: 'Conexión',
                        content: `Actualizando cuenta Tipo: ${account.meta.type} | Usuario: ${account.name}`,
                        color: 'var(--color)',
                        background: false
                    });
                    let refresh_accounts = await new AZauth(this.config.online).verify(account);

                    if (refresh_accounts.error) {
                        this.db.deleteData('accounts', account_ID)
                        if (account_ID == account_selected) {
                            configClient.account_selected = null
                            this.db.updateData('configClient', configClient)
                        }
                        console.error(`[Account] ${account.name}: ${refresh_accounts.message}`);
                        continue;
                    }

                    refresh_accounts.ID = account_ID
                    this.db.updateData('accounts', refresh_accounts, account_ID)
                    await addAccount(refresh_accounts)
                    if (account_ID == account_selected) accountSelect(refresh_accounts)
                } else if (account.meta.type === 'Offline') {
                    console.log(`Account Type: Offline | Username: ${account.name}`);
                    popupRefresh.openPopup({
                        title: 'Conexión',
                        content: `Actualizando cuenta Tipo: Offline | Usuario: ${account.name}`,
                        color: 'var(--color)',
                        background: false
                    });
                    let refresh_accounts = await Mojang.login(account.name);
                    if (refresh_accounts.meta) {
                        refresh_accounts.meta.type = 'Offline';
                    }

                    refresh_accounts.ID = account_ID
                    await addAccount(refresh_accounts)
                    await this.db.updateData('accounts', refresh_accounts, account_ID)
                    if (account_ID == account_selected) accountSelect(refresh_accounts)
                } else if (account.meta.type == 'Mojang') {
                    console.log(`Account Type: ${account.meta.type} | Username: ${account.name}`);
                    popupRefresh.openPopup({
                        title: 'Conexión',
                        content: `Actualizando cuenta Tipo: ${account.meta.type} | Usuario: ${account.name}`,
                        color: 'var(--color)',
                        background: false
                    });

                    let refresh_accounts = await Mojang.refresh(account);

                    if (refresh_accounts.error) {
                        this.db.deleteData('accounts', account_ID)
                        if (account_ID == account_selected) {
                            configClient.account_selected = null
                            this.db.updateData('configClient', configClient)
                        }
                        console.error(`[Account] ${account.name}: ${refresh_accounts.errorMessage}`);
                        continue;
                    }

                    refresh_accounts.ID = account_ID
                    this.db.updateData('accounts', refresh_accounts, account_ID)
                    await addAccount(refresh_accounts)
                    if (account_ID == account_selected) accountSelect(refresh_accounts)
                } else {
                    console.error(`[Account] ${account.name}: Account Type Not Found`);
                    this.db.deleteData('accounts', account_ID)
                    if (account_ID == account_selected) {
                        configClient.account_selected = null
                        this.db.updateData('configClient', configClient)
                    }
                }
            }

            accounts = await this.db.readAllData('accounts')
            configClient = await this.db.readData('configClient')
            account_selected = configClient ? configClient.account_selected : null

            if (!account_selected) {
                let uuid = accounts[0].ID
                if (uuid) {
                    configClient.account_selected = uuid
                    await this.db.updateData('configClient', configClient)
                    accountSelect(uuid)
                }
            }

            if (!accounts.length) {
                config.account_selected = null
                await this.db.updateData('configClient', config);
                popupRefresh.closePopup()
                return changePanel("login");
            }

            this.showLoading('Listo', 'Cargando interfaz principal', 95);
            popupRefresh.closePopup()
            this.hideLoading();
            document.dispatchEvent(new CustomEvent('accounts-changed'));
            changePanel("home");
        } else {
            popupRefresh.closePopup()
            this.hideLoading();
            changePanel('login');
        }
    }
}

new Launcher().init();
