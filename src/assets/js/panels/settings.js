
import { changePanel, accountSelect, database, config, setStatus, popup, appdata, setBackground, skin2D } from '../utils.js'
const { ipcRenderer } = require('electron');
const os = require('os');
const fetch = require('node-fetch');

class Settings {
    static id = "settings";
    async init(config) {
        this.config = config;
        this.db = new database();
        this.navBTN()
        this.ram()
        this.javaPath()
        this.resolution()
        this.launcher()
        await this.accounts()
    }

    navBTN() {
        document.querySelector('.nav-box').addEventListener('click', e => {
            if (e.target.classList.contains('nav-settings-btn')) {
                let id = e.target.id

                let activeSettingsBTN = document.querySelector('.active-settings-BTN')
                let activeContainerSettings = document.querySelector('.active-container-settings')

                if (id == 'save') {
                    if (activeSettingsBTN) activeSettingsBTN.classList.toggle('active-settings-BTN');
                    document.querySelector('#java').classList.add('active-settings-BTN');

                    if (activeContainerSettings) activeContainerSettings.classList.toggle('active-container-settings');
                    document.querySelector(`#java-tab`).classList.add('active-container-settings');
                    return changePanel('home')
                }

                if (activeSettingsBTN) activeSettingsBTN.classList.toggle('active-settings-BTN');
                e.target.classList.add('active-settings-BTN');

                if (activeContainerSettings) activeContainerSettings.classList.toggle('active-container-settings');
                document.querySelector(`#${id}-tab`).classList.add('active-container-settings');
            }
        })
    }

    async setInstance(auth) {
        let configClient = await this.db.readData('configClient')
        let instanceSelect = configClient.instance_select
        let instancesList = await config.getInstanceList()

        for (let instance of instancesList) {
            if (instance.whitelistActive) {
                let whitelist = instance.whitelist.find(whitelist => whitelist == auth.name)
                if (whitelist !== auth.name) {
                    if (instance.name == instanceSelect) {
                        let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
                        configClient.instance_select = newInstanceSelect.name
                        await setStatus(newInstanceSelect.status)
                    }
                }
            }
        }
        return configClient
    }

    async ram() {
        let config = await this.db.readData('configClient');
        let totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        let freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;

        const totalEl = document.getElementById("total-ram");
        const freeEl = document.getElementById("free-ram");
        if (totalEl) totalEl.textContent = `${totalMem} GB`;
        if (freeEl) freeEl.textContent = `${freeMem} GB`;

        const maxSlider = Math.max(1, Math.trunc((80 * totalMem) / 100));

        let ram = config?.java_config?.java_memory || { min: 1, max: 2 };

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
            minInput.addEventListener('change', async () => {
                let val = clamp(parseFloat(minInput.value) || 1);
                let M = clamp(parseFloat(maxInput.value) || 2);
                if (val > M) val = M;
                minInput.value = val;
                await saveRam(val, M);
            });
        }

        if (maxInput) {
            maxInput.addEventListener('change', async () => {
                let val = clamp(parseFloat(maxInput.value) || 2);
                let m = clamp(parseFloat(minInput?.value) || 1);
                if (val < m) val = m;
                maxInput.value = val;
                await saveRam(m, val);
            });
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
    }

    async javaPath() {
        let javaPathText = document.querySelector(".java-path-txt")
        javaPathText.textContent = `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}/runtime`;

        let configClient = await this.db.readData('configClient')
        let javaPath = configClient?.java_config?.java_path || 'Utiliser la version de java livre avec le launcher';
        let javaPathInputTxt = document.querySelector(".java-path-input-text");
        let javaPathInputFile = document.querySelector(".java-path-input-file");
        javaPathInputTxt.value = javaPath;

        document.querySelector(".java-path-set").addEventListener("click", async () => {
            javaPathInputFile.value = '';
            javaPathInputFile.click();
            await new Promise((resolve) => {
                let interval;
                interval = setInterval(() => {
                    if (javaPathInputFile.value != '') resolve(clearInterval(interval));
                }, 100);
            });

            if (javaPathInputFile.value.replace(".exe", '').endsWith("java") || javaPathInputFile.value.replace(".exe", '').endsWith("javaw")) {
                let configClient = await this.db.readData('configClient')
                let file = javaPathInputFile.files[0].path;
                javaPathInputTxt.value = file;
                configClient.java_config.java_path = file
                await this.db.updateData('configClient', configClient);
            } else alert("Le nom du fichier doit être java ou javaw");
        });

        document.querySelector(".java-path-reset").addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            javaPathInputTxt.value = 'Utiliser la version de java livre avec le launcher';
            configClient.java_config.java_path = null
            await this.db.updateData('configClient', configClient);
        });
    }

    async resolution() {
        let configClient = await this.db.readData('configClient')
        let resolution = configClient?.game_config?.screen_size || { width: 1920, height: 1080 };

        let width = document.querySelector(".width-size");
        let height = document.querySelector(".height-size");
        let resolutionReset = document.querySelector(".size-reset");

        width.value = resolution.width;
        height.value = resolution.height;

        width.addEventListener("change", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.game_config.screen_size.width = width.value;
            await this.db.updateData('configClient', configClient);
        })

        height.addEventListener("change", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.game_config.screen_size.height = height.value;
            await this.db.updateData('configClient', configClient);
        })

        resolutionReset.addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.game_config.screen_size = { width: '854', height: '480' };
            width.value = '854';
            height.value = '480';
            await this.db.updateData('configClient', configClient);
        })
    }

    async launcher() {
        let configClient = await this.db.readData('configClient');

        // Downloads
        let maxDownloadFiles = configClient?.launcher_config?.download_multi || 5;
        let maxDownloadFilesInput = document.querySelector(".max-files");
        let maxDownloadFilesReset = document.querySelector(".max-files-reset");
        maxDownloadFilesInput.value = maxDownloadFiles;

        maxDownloadFilesInput.addEventListener("change", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.launcher_config.download_multi = maxDownloadFilesInput.value;
            await this.db.updateData('configClient', configClient);
        })

        maxDownloadFilesReset.addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            maxDownloadFilesInput.value = 5
            configClient.launcher_config.download_multi = 5;
            await this.db.updateData('configClient', configClient);
        })

        // Close behavior
        let closeBox = document.querySelector(".close-box");
        let closeLauncher = configClient?.launcher_config?.closeLauncher || "close-launcher";

        if (closeLauncher == "close-launcher") {
            document.querySelector('.close-launcher').classList.add('active-close');
        } else if (closeLauncher == "close-all") {
            document.querySelector('.close-all').classList.add('active-close');
        } else if (closeLauncher == "close-none") {
            document.querySelector('.close-none').classList.add('active-close');
        }

        closeBox.addEventListener("click", async e => {
            if (e.target.classList.contains('close-btn')) {
                let activeClose = document.querySelector('.active-close');
                if (e.target.classList.contains('active-close')) return
                activeClose?.classList.toggle('active-close');

                let configClient = await this.db.readData('configClient')

                if (e.target.classList.contains('close-launcher')) {
                    e.target.classList.toggle('active-close');
                    configClient.launcher_config.closeLauncher = "close-launcher";
                    await this.db.updateData('configClient', configClient);
                } else if (e.target.classList.contains('close-all')) {
                    e.target.classList.toggle('active-close');
                    configClient.launcher_config.closeLauncher = "close-all";
                    await this.db.updateData('configClient', configClient);
                } else if (e.target.classList.contains('close-none')) {
                    e.target.classList.toggle('active-close');
                    configClient.launcher_config.closeLauncher = "close-none";
                    await this.db.updateData('configClient', configClient);
                }
            }
        })

        // Theme selector
        const themeBox = document.querySelector('.theme-box');
        const currentTheme = configClient?.launcher_config?.theme || 'auto';
        if (themeBox) {
            themeBox.querySelectorAll('.theme-option').forEach(el => {
                if (el.dataset.theme === currentTheme) {
                    el.classList.add('theme-active');
                } else {
                    el.classList.remove('theme-active');
                }
            });
            themeBox.addEventListener('click', async (e) => {
                const option = e.target.closest('.theme-option');
                if (!option) return;
                themeBox.querySelectorAll('.theme-option').forEach(el => el.classList.remove('theme-active'));
                option.classList.add('theme-active');
                let cfg = await this.db.readData('configClient');
                if (!cfg.launcher_config) cfg.launcher_config = {};
                cfg.launcher_config.theme = option.dataset.theme;
                await this.db.updateData('configClient', cfg);
                await setBackground(option.dataset.theme === 'dark' ? true : option.dataset.theme === 'light' ? false : undefined);
            });
        }

        // Toggles & Selects
        const settingConsole = document.getElementById('setting-console');
        const settingAutoUpdate = document.getElementById('setting-auto-update');
        const settingDedicatedGpu = document.getElementById('setting-dedicated-gpu');
        const settingAutoUpdateInterval = document.getElementById('setting-auto-update-interval');

        if (settingConsole) {
            settingConsole.checked = !!configClient?.launcher_config?.console;
            settingConsole.addEventListener('change', async () => {
                let cfg = await this.db.readData('configClient');
                if (!cfg.launcher_config) cfg.launcher_config = {};
                cfg.launcher_config.console = settingConsole.checked;
                await this.db.updateData('configClient', cfg);
            });
        }

        if (settingAutoUpdate) {
            settingAutoUpdate.checked = !!configClient?.launcher_config?.autoUpdate;
            settingAutoUpdate.addEventListener('change', async () => {
                let cfg = await this.db.readData('configClient');
                if (!cfg.launcher_config) cfg.launcher_config = {};
                cfg.launcher_config.autoUpdate = settingAutoUpdate.checked;
                await this.db.updateData('configClient', cfg);
            });
        }

        if (settingDedicatedGpu) {
            settingDedicatedGpu.checked = !!configClient?.launcher_config?.dedicatedGpu;
            settingDedicatedGpu.addEventListener('change', async () => {
                let cfg = await this.db.readData('configClient');
                if (!cfg.launcher_config) cfg.launcher_config = {};
                cfg.launcher_config.dedicatedGpu = settingDedicatedGpu.checked;
                await this.db.updateData('configClient', cfg);
            });
        }

        if (settingAutoUpdateInterval) {
            settingAutoUpdateInterval.value = configClient?.launcher_config?.autoUpdateInterval || '60';
            settingAutoUpdateInterval.addEventListener('change', async () => {
                let cfg = await this.db.readData('configClient');
                if (!cfg.launcher_config) cfg.launcher_config = {};
                cfg.launcher_config.autoUpdateInterval = settingAutoUpdateInterval.value;
                await this.db.updateData('configClient', cfg);
            });
        }

        // JVM args
        const jvmInput = document.querySelector('.jvm-args-input');
        const jvmReset = document.querySelector('.jvm-args-reset');
        const currentJvmArgs = configClient?.java_config?.jvm_args || '';
        if (jvmInput) {
            jvmInput.value = Array.isArray(currentJvmArgs) ? currentJvmArgs.join(' ') : currentJvmArgs;
            jvmInput.addEventListener('change', async () => {
                let cfg = await this.db.readData('configClient');
                if (!cfg.java_config) cfg.java_config = {};
                const raw = jvmInput.value.trim();
                cfg.java_config.jvm_args = raw ? raw.split(/\s+/).filter(Boolean) : [];
                await this.db.updateData('configClient', cfg);
            });
        }
        if (jvmReset) {
            jvmReset.addEventListener('click', async () => {
                if (jvmInput) jvmInput.value = '';
                let cfg = await this.db.readData('configClient');
                if (cfg.java_config) cfg.java_config.jvm_args = [];
                await this.db.updateData('configClient', cfg);
            });
        }
    }

    async accounts() {
        const listEl = document.getElementById('settings-accounts-list');
        if (!listEl) return;
        listEl.innerHTML = '<div class="settings-accounts-loading" style="text-align:center;padding:20px;color:var(--text-secondary);">Cargando cuentas...</div>';
        try {
            let configClient = await this.db.readData('configClient');
            let accounts = await this.db.readAllData('accounts');
            listEl.innerHTML = '';

            if (accounts.length === 0) {
                listEl.innerHTML = '<div class="settings-accounts-empty" style="text-align:center;padding:30px;color:var(--text-secondary);"><p>No hay cuentas vinculadas.</p><p style="font-size:0.85em;margin-top:8px;">Agregá una cuenta desde el menú de perfil o iniciando sesión.</p></div>';
                return;
            }

            // Compute total playtime per account
            let totalPlaytime = {};
            try {
                const allSessions = await this.db.readAllData('sessions') || [];
                for (let s of allSessions) {
                    if (!totalPlaytime[s.instance]) totalPlaytime[s.instance] = 0;
                    totalPlaytime[s.instance] += s.playtime_seconds || 0;
                }
            } catch (_) {}

            for (let acc of accounts) {
                const isActive = acc.ID === configClient.account_selected;
                const card = document.createElement('div');
                card.className = 'settings-account-card' + (isActive ? ' active' : '');
                const accPlaytime = totalPlaytime[acc.name] || 0;
                const hours = Math.floor(accPlaytime / 3600);
                const minutes = Math.floor((accPlaytime % 3600) / 60);
                const playtimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                card.innerHTML = `
                    <div class="settings-account-avatar" style="background-image: url('assets/images/default/setve.png'); background-size: cover; background-position: center;"></div>
                    <div class="settings-account-info">
                        <div class="settings-account-name">${acc.name}</div>
                        <div class="settings-account-detail">UUID: ${acc.uuid ? acc.uuid.substring(0, 8) + '...' : 'N/A'}</div>
                        <div class="settings-account-detail">${acc.meta?.type || 'Desconocido'}</div>
                        <div class="settings-account-detail">Tiempo jugado: ${playtimeStr}</div>
                        <div class="settings-account-status">${isActive ? '✓ Cuenta activa' : 'Hacé clic para usar esta cuenta'}</div>
                    </div>
                    <button class="settings-account-delete" title="Eliminar cuenta">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                `;

                // Lazy load avatar
                this._getSkinUrl(acc).then(url => {
                    if (url) {
                        const av = card.querySelector('.settings-account-avatar');
                        if (av) av.style.backgroundImage = `url(${url})`;
                    }
                }).catch(() => {});

                card.addEventListener('click', async (e) => {
                    if (e.target.closest('.settings-account-delete')) return;
                    if (acc.ID === configClient.account_selected) return;

                    let cc = await this.db.readData('configClient');
                    cc.account_selected = acc.ID;
                    let instancesList = await config.getInstanceList();
                    if (instancesList.length > 0) cc.instance_select = instancesList[0].name;
                    await this.db.updateData('configClient', cc);
                    await accountSelect(acc);
                    await this.accounts();
                    document.dispatchEvent(new CustomEvent('accounts-changed'));
                });

                const delBtn = card.querySelector('.settings-account-delete');
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm(`¿Eliminar la cuenta ${acc.name}?`)) return;
                    await this.db.deleteData('accounts', acc.ID);
                    document.dispatchEvent(new CustomEvent('accounts-changed'));
                    this.accounts();
                });

                listEl.appendChild(card);
            }
        } catch (e) {
            console.error('Settings accounts error:', e);
            listEl.innerHTML = '<div class="settings-accounts-error" style="text-align:center;padding:20px;color:#ef4444;">Error al cargar cuentas: ' + e.message + '</div>';
        }
    }

    async _getSkinUrl(acc) {
        try {
            let url = null;
            if (acc?.profile?.skins?.[0]?.base64) {
                const headTex = await new skin2D().creatHeadTexture(acc.profile.skins[0].base64);
                if (headTex) url = headTex;
            }
            if (!url && acc?.profile?.skins?.[0]?.url) {
                url = acc.profile.skins[0].url;
            }
            if (!url && acc.uuid) {
                const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${acc.uuid.replace(/-/g, '')}`);
                if (res.ok) {
                    const profile = await res.json();
                    const texProp = profile.properties?.find(p => p.name === 'textures');
                    if (texProp?.value) {
                        const tex = JSON.parse(Buffer.from(texProp.value, 'base64').toString());
                        if (tex.textures?.SKIN?.url) url = tex.textures.SKIN.url;
                    }
                }
            }
            return url;
        } catch (e) {
            return null;
        }
    }
}
export default Settings;