/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
const { AZauth, Mojang } = require('minecraft-java-core');
const { ipcRenderer } = require('electron');

import { popup, database, changePanel, accountSelect, addAccount, config, setStatus } from '../utils.js';

class Login {
    static id = "login";
    async init(config) {
        this.config = config;
        this.db = new database();

        // Determinar si usa AZauth (URL string) o el modo Dual (Premium/Offline)
        const isAZauth = typeof this.config.online === 'string' && this.config.online.match(/^(http|https):\/\/[^ "]+$/);

        if (!isAZauth) {
            this.getMicrosoft();
            this.getCrack();

            const loginHome = document.querySelector('.login-home');
            const loginOffline = document.querySelector('.login-offline');
            
            // Por defecto, mostrar Premium a menos que la config de online sea estrictamente false
            if (this.config.online !== false) {
                if (loginHome) loginHome.style.display = 'block';
                if (loginOffline) loginOffline.style.display = 'none';
            } else {
                if (loginHome) loginHome.style.display = 'none';
                if (loginOffline) loginOffline.style.display = 'block';
            }

            // Listeners para alternar vistas entre Online (Microsoft) y Offline (No Premium)
            document.querySelector('.switch-to-offline')?.addEventListener('click', () => {
                if (loginHome) loginHome.style.display = 'none';
                if (loginOffline) loginOffline.style.display = 'block';
            });

            document.querySelector('.switch-to-online')?.addEventListener('click', () => {
                if (loginOffline) loginOffline.style.display = 'none';
                if (loginHome) loginHome.style.display = 'block';
            });
        } else {
            this.getAZauth();
        }
        
        document.querySelector('.cancel-home').addEventListener('click', () => {
            document.querySelector('.cancel-home').style.display = 'none'
            changePanel('home')
        })
    }

    async getMicrosoft() {
        console.log('Initializing Microsoft login...');
        let popupLogin = new popup();
        let loginHome = document.querySelector('.login-home');
        let microsoftBtn = document.querySelector('.connect-home');

        microsoftBtn.addEventListener("click", () => {
            popupLogin.openPopup({
                title: 'Conexión',
                content: 'Por favor, espera...',
                color: 'var(--color)'
            });

            ipcRenderer.invoke('Microsoft-window', this.config.client_id).then(async account_connect => {
                if (account_connect == 'cancel' || !account_connect) {
                    popupLogin.closePopup();
                    return;
                } else {
                    await this.saveData(account_connect)
                    popupLogin.closePopup();
                }

            }).catch(err => {
                popupLogin.openPopup({
                    title: 'Error',
                    content: err,
                    options: true
                });
            });
        })
    }

    async getCrack() {
        console.log('Initializing offline login...');
        let popupLogin = new popup();
        let loginOffline = document.querySelector('.login-offline');

        let emailOffline = document.querySelector('.email-offline');
        let connectOffline = document.querySelector('.connect-offline');

        connectOffline.addEventListener('click', async () => {
            if (emailOffline.value.length < 3) {
                popupLogin.openPopup({
                    title: 'Error',
                    content: 'Tu nombre de usuario debe tener al menos 3 caracteres.',
                    options: true
                });
                return;
            }

            if (emailOffline.value.match(/ /g)) {
                popupLogin.openPopup({
                    title: 'Error',
                    content: 'Tu nombre de usuario no debe contener espacios.',
                    options: true
                });
                return;
            }

            let MojangConnect = await Mojang.login(emailOffline.value);

            if (MojangConnect.error) {
                popupLogin.openPopup({
                    title: 'Error',
                    content: MojangConnect.message,
                    options: true
                });
                return;
            }
            if (MojangConnect.meta) {
                MojangConnect.meta.type = 'Offline';
            }
            await this.saveData(MojangConnect)
            popupLogin.closePopup();
        });
    }

    async getAZauth() {
        console.log('Initializing AZauth login...');
        let AZauthClient = new AZauth(this.config.online);
        let PopupLogin = new popup();
        let loginAZauth = document.querySelector('.login-AZauth');
        let loginAZauthA2F = document.querySelector('.login-AZauth-A2F');

        let AZauthEmail = document.querySelector('.email-AZauth');
        let AZauthPassword = document.querySelector('.password-AZauth');
        let AZauthA2F = document.querySelector('.A2F-AZauth');
        let connectAZauthA2F = document.querySelector('.connect-AZauth-A2F');
        let AZauthConnectBTN = document.querySelector('.connect-AZauth');
        let AZauthCancelA2F = document.querySelector('.cancel-AZauth-A2F');

        loginAZauth.style.display = 'block';

        AZauthConnectBTN.addEventListener('click', async () => {
            PopupLogin.openPopup({
                title: 'Connexion en cours...',
                content: 'Veuillez patienter...',
                color: 'var(--color)'
            });

            if (AZauthEmail.value == '' || AZauthPassword.value == '') {
                PopupLogin.openPopup({
                    title: 'Error',
                    content: 'Por favor, rellene todos los campos.',
                    options: true
                });
                return;
            }

            let AZauthConnect = await AZauthClient.login(AZauthEmail.value, AZauthPassword.value);

            if (AZauthConnect.error) {
                PopupLogin.openPopup({
                    title: 'Error',
                    content: AZauthConnect.message,
                    options: true
                });
                return;
            } else if (AZauthConnect.A2F) {
                loginAZauthA2F.style.display = 'block';
                loginAZauth.style.display = 'none';
                PopupLogin.closePopup();

                AZauthCancelA2F.addEventListener('click', () => {
                    loginAZauthA2F.style.display = 'none';
                    loginAZauth.style.display = 'block';
                });

                connectAZauthA2F.addEventListener('click', async () => {
                    PopupLogin.openPopup({
                        title: 'Connexion en cours...',
                        content: 'Veuillez patienter...',
                        color: 'var(--color)'
                    });

                    if (AZauthA2F.value == '') {
                        PopupLogin.openPopup({
                            title: 'Error',
                            content: 'Por favor, introduzca el código A2F.',
                            options: true
                        });
                        return;
                    }

                    AZauthConnect = await AZauthClient.login(AZauthEmail.value, AZauthPassword.value, AZauthA2F.value);

                    if (AZauthConnect.error) {
                        PopupLogin.openPopup({
                            title: 'Error',
                            content: AZauthConnect.message,
                            options: true
                        });
                        return;
                    }

                    await this.saveData(AZauthConnect)
                    PopupLogin.closePopup();
                });
            } else if (!AZauthConnect.A2F) {
                await this.saveData(AZauthConnect)
                PopupLogin.closePopup();
            }
        });
    }

    async saveData(connectionData) {
        let configClient = await this.db.readData('configClient');
        let allAccounts = await this.db.readAllData('accounts') || [];
        let nickInUse = allAccounts.find(a => a.name?.toLowerCase() === connectionData.name?.toLowerCase());
        if (nickInUse) {
            let popupLogin = new popup();
            popupLogin.openPopup({
                title: 'Error',
                content: `El nombre "${connectionData.name}" ya está en uso por otra cuenta. Usa un nombre diferente.`,
                options: true
            });
            return;
        }
        let account = await this.db.createData('accounts', connectionData)
        let instanceSelect = configClient.instance_select
        let instancesList = await config.getInstanceList()
        configClient.account_selected = account.ID;

        for (let instance of instancesList) {
            if (instance.whitelistActive) {
                let whitelist = instance.whitelist.find(whitelist => whitelist == account.name)
                if (whitelist !== account.name) {
                    if (instance.name == instanceSelect) {
                        let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
                        configClient.instance_select = newInstanceSelect.name
                        await setStatus(newInstanceSelect.status)
                    }
                }
            }
        }

        await this.db.updateData('configClient', configClient);
        await addAccount(account);
        await accountSelect(account);
        changePanel('home');
    }
}
export default Login;