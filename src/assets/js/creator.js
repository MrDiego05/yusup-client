const { ipcRenderer, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { Launch } = require('minecraft-java-core');

// State
let selectedPackId = null;
let selectedNewLocation = null;
let selectedGitLocation = null;
let modpacks = [];

const dbPath = path.resolve('./data/creator-modpacks.json');
const gitConfigPath = path.resolve('./data/creator-git-config.json');

// Ensure db directory
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Load database
function loadDb() {
    if (fs.existsSync(dbPath)) {
        try {
            modpacks = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        } catch (e) {
            modpacks = [];
        }
    } else {
        // Initial sample packs if empty
        modpacks = [
            {
                id: 'selvania-1.20',
                title: 'Selvania Servidor 1.20',
                gameVersion: '1.20.1',
                loader: 'neoforge',
                loaderVersion: '20.4.80',
                location: path.resolve('./data/modpacks/selvania-1.20').replace(/\\/g, '/')
            }
        ];
        saveDb();
    }
}

function saveDb() {
    fs.writeFileSync(dbPath, JSON.stringify(modpacks, null, 4));
}

// Load git config
function loadGitConfig() {
    if (fs.existsSync(gitConfigPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(gitConfigPath, 'utf8'));
            if (config.gitDir) {
                selectedGitLocation = config.gitDir;
                document.getElementById('git-dir-path').textContent = config.gitDir;
            }
        } catch (e) {}
    }
}

function saveGitConfig(gitDir) {
    fs.writeFileSync(gitConfigPath, JSON.stringify({ gitDir }, null, 4));
}

// UI Logs utility
const consoleLogs = document.getElementById('console-logs');
function log(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${message}`;
    consoleLogs.appendChild(entry);
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

// Frame Events
document.getElementById('minimize').addEventListener('click', () => {
    ipcRenderer.send('creator-window-minimize');
});

document.getElementById('close').addEventListener('click', () => {
    ipcRenderer.send('creator-window-close');
});

// Dev Shortcuts (Ctrl + Shift + I)
document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.keyCode == 73 || e.keyCode == 123) {
        ipcRenderer.send('creator-window-dev-tools');
    }
});

// Render Modpacks Table
function renderModpacks() {
    const listElement = document.getElementById('modpack-list');
    listElement.innerHTML = '';

    modpacks.forEach(pack => {
        const tr = document.createElement('tr');
        tr.dataset.id = pack.id;
        if (pack.id === selectedPackId) {
            tr.className = 'selected';
        }

        tr.innerHTML = `
            <td><strong>${pack.id}</strong></td>
            <td>${pack.title}</td>
            <td>${pack.gameVersion} (${pack.loader})</td>
            <td style="font-size:0.8em; color:#94a3b8; word-break:break-all;">${pack.location}</td>
        `;

        tr.addEventListener('click', () => {
            document.querySelectorAll('#modpack-list tr').forEach(r => r.classList.remove('selected'));
            tr.classList.add('selected');
            selectedPackId = pack.id;
            log(`Modpack seleccionado: ${pack.title} (${pack.id})`);
        });

        listElement.appendChild(tr);
    });
}

// Selected helper
function getSelectedPack() {
    return modpacks.find(p => p.id === selectedPackId);
}

// Hashing MD5 Helper
function calculateMD5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

// --- TOOLBAR & DIALOG ACTIONS ---
let editingPackId = null;

// New Pack Modal
const modalNewPack = document.getElementById('modal-new-pack');
document.getElementById('btn-new-pack').addEventListener('click', () => {
    editingPackId = null;
    document.getElementById('new-id').value = '';
    document.getElementById('new-title').value = '';
    document.getElementById('new-game-version').value = '1.20.1';
    document.getElementById('new-loader').value = 'neoforge';
    document.getElementById('new-loader-version').value = '20.4.80';
    selectedNewLocation = null;
    document.getElementById('new-location-path').textContent = 'No seleccionada';
    modalNewPack.style.display = 'flex';
});

document.getElementById('btn-cancel-new').addEventListener('click', () => {
    modalNewPack.style.display = 'none';
});

document.getElementById('btn-select-new-location').addEventListener('click', async () => {
    const folder = await ipcRenderer.invoke('select-directory');
    if (folder) {
        selectedNewLocation = folder.replace(/\\/g, '/');
        document.getElementById('new-location-path').textContent = selectedNewLocation;
    }
});

document.getElementById('btn-save-new').addEventListener('click', () => {
    const id = document.getElementById('new-id').value.trim();
    const title = document.getElementById('new-title').value.trim();
    const gameVer = document.getElementById('new-game-version').value.trim();
    const loader = document.getElementById('new-loader').value;
    const loaderVer = document.getElementById('new-loader-version').value.trim();

    if (!id || !title || !selectedNewLocation) {
        log('Error: Todos los campos del nuevo modpack son requeridos.', 'error');
        alert('Por favor, rellena todos los campos e indica la carpeta.');
        return;
    }

    const newPack = {
        id,
        title,
        gameVersion: gameVer,
        loader,
        loaderVersion: loaderVer,
        location: selectedNewLocation
    };

    if (editingPackId) {
        // Modo edición: reemplazar el existente
        const idx = modpacks.findIndex(m => m.id === editingPackId);
        if (idx >= 0) {
            modpacks[idx] = newPack;
        }
        editingPackId = null;
        log(`Modpack actualizado: ${title}`, 'success');
    } else {
        // Modo creación: agregar nuevo
        modpacks.push(newPack);
        log(`Modpack guardado: ${title}`, 'success');
        // Crear carpeta si no existe
        if (!fs.existsSync(selectedNewLocation)) {
            fs.mkdirSync(selectedNewLocation, { recursive: true });
            fs.mkdirSync(path.join(selectedNewLocation, 'mods'), { recursive: true });
        }
    }

    saveDb();
    renderModpacks();
    
    modalNewPack.style.display = 'none';
});

// Add Existing
document.getElementById('btn-add-existing').addEventListener('click', async () => {
    const folder = await ipcRenderer.invoke('select-directory');
    if (folder) {
        const cleanPath = folder.replace(/\\/g, '/');
        const folderName = path.basename(cleanPath);
        
        const newPack = {
            id: folderName.toLowerCase().replace(/[^a-z0-9]/g, '-'),
            title: folderName,
            gameVersion: '1.20.1',
            loader: 'neoforge',
            loaderVersion: '20.4.80',
            location: cleanPath
        };

        modpacks.push(newPack);
        saveDb();
        renderModpacks();
        log(`Modpack importado: ${folderName}`, 'success');
    }
});

// Modify Select
document.getElementById('btn-modify').addEventListener('click', () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack para modificar.', 'error');
        return;
    }
    editingPackId = pack.id;
    document.getElementById('new-id').value = pack.id;
    document.getElementById('new-title').value = pack.title;
    document.getElementById('new-game-version').value = pack.gameVersion;
    document.getElementById('new-loader').value = pack.loader;
    document.getElementById('new-loader-version').value = pack.loaderVersion;
    selectedNewLocation = pack.location;
    document.getElementById('new-location-path').textContent = pack.location;

    modalNewPack.style.display = 'flex';
});

// Open Folder
document.getElementById('btn-open-folder').addEventListener('click', () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack primero.', 'error');
        return;
    }
    if (fs.existsSync(pack.location)) {
        shell.openPath(pack.location);
        log(`Abriendo carpeta: ${pack.location}`);
    } else {
        log(`Error: La carpeta no existe: ${pack.location}`, 'error');
    }
});

// Delete Modpack
document.getElementById('btn-delete-pack').addEventListener('click', () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack para eliminar.', 'error');
        return;
    }
    if (!confirm(`¿Eliminar "${pack.title}" de la lista? Los archivos locales no se borrarán.`)) return;
    modpacks = modpacks.filter(m => m.id !== pack.id);
    saveDb();
    if (selectedPackId === pack.id) selectedPackId = null;
    renderModpacks();
    log(`Modpack eliminado: ${pack.title}`, 'success');
});

// Check Modpack
document.getElementById('btn-check').addEventListener('click', () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack primero.', 'error');
        return;
    }
    log(`Iniciando verificación de: ${pack.title}...`);

    const modsDir = path.join(pack.location, 'mods');
    if (!fs.existsSync(modsDir)) {
        log(`[Advertencia] No existe carpeta de mods en ${modsDir}. Creando una...`, 'error');
        fs.mkdirSync(modsDir, { recursive: true });
        return;
    }

    const files = fs.readdirSync(modsDir);
    const jarFiles = files.filter(f => f.toLowerCase().endsWith('.jar'));
    
    log(`Verificación de mods terminada:`, 'success');
    log(`- Total archivos en mods/: ${files.length}`);
    log(`- Mods (.jar) detectados: ${jarFiles.length}`);
    jarFiles.forEach(j => log(`  > Detectado: ${j}`));
});

// TEST LAUNCH MODPACK (Local test client!)
document.getElementById('btn-test').addEventListener('click', async () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack para probar.', 'error');
        return;
    }

    log(`[TEST] Iniciando cliente de prueba para: ${pack.title}...`, 'info');
    log(`[TEST] Versión: ${pack.gameVersion} | Loader: ${pack.loader} | Ruta: ${pack.location}`);

    try {
        const launch = new Launch();

        const opt = {
            authenticator: {
                user_properties: '{}',
                access_token: '00000000-0000-0000-0000-000000000000',
                client_token: '00000000-0000-0000-0000-000000000000',
                uuid: '00000000-0000-0000-0000-000000000000',
                name: 'TestDev',
                meta: {
                    type: 'mojang',
                    online: false
                }
            },
            timeout: 10000,
            path: path.dirname(pack.location),
            instance: path.basename(pack.location),
            version: pack.gameVersion,
            loader: {
                type: pack.loader,
                build: pack.loaderVersion,
                enable: pack.loader !== 'vanilla'
            },
            java: {
                path: 'java'
            },
            memory: {
                max: '4096M',
                min: '2048M'
            }
        };

        log('[TEST] Resolviendo librerías y dependencias de Minecraft...', 'info');
        
        launch.Launch(opt);

        launch.on('progress', (progress, size) => {
            log(`[TEST-Minecraft] Descargando dependencias: ${((progress/size)*100).toFixed(0)}%`);
        });

        launch.on('check', (progress, size) => {
            log(`[TEST-Minecraft] Verificando archivos: ${((progress/size)*100).toFixed(0)}%`);
        });

        launch.on('data', (e) => {
            log(`[Minecraft] ${e.trim()}`);
        });

        launch.on('close', code => {
            log(`[TEST] El cliente de prueba se cerró con código: ${code}`, 'success');
        });

        launch.on('error', err => {
            log(`[TEST-Error] Falló la ejecución: ${err.error}`, 'error');
        });

    } catch (e) {
        log(`[TEST-Error] Error de arranque: ${e.message}`, 'error');
    }
});

// COMPILAR MODPACK
const progressContainer = document.getElementById('progress-container');
const progressStatus = document.getElementById('progress-status');
const compileProgress = document.getElementById('compile-progress');

document.getElementById('btn-build').addEventListener('click', async () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack para compilar.', 'error');
        return;
    }

    const modsDir = path.join(pack.location, 'mods');
    if (!fs.existsSync(modsDir)) {
        log(`Error: No existe la carpeta mods/ en ${pack.location}`, 'error');
        return;
    }

    try {
        log(`Iniciando compilación del modpack "${pack.title}"...`, 'info');
        progressContainer.style.display = 'flex';
        compileProgress.value = 0;

        const files = fs.readdirSync(modsDir);
        const jarFiles = files.filter(f => f.toLowerCase().endsWith('.jar'));

        if (jarFiles.length === 0) {
            throw new Error('La carpeta mods/ está vacía.');
        }

        const modpackJson = [];
        let processed = 0;

        for (const file of jarFiles) {
            const filePath = path.join(modsDir, file);
            progressStatus.textContent = `Hasheando: ${file}...`;
            
            const md5 = await calculateMD5(filePath);
            
            modpackJson.push({
                name: file,
                url: `https://mi-servidor.com/mods/${file}`, // Placeholder editable posterior
                md5: md5,
                path: `mods/${file}`
            });

            processed++;
            compileProgress.value = Math.round((processed / jarFiles.length) * 100);
        }

        // Guardar modpack.json localmente
        const jsonOutPath = path.join(pack.location, 'modpack.json');
        fs.writeFileSync(jsonOutPath, JSON.stringify(modpackJson, null, 4));

        log(`¡Compilación completada!`, 'success');
        log(`modpack.json generado con éxito en: ${jsonOutPath}`);
        log(`Se procesaron ${jarFiles.length} mods correctamente.`, 'success');

        progressStatus.textContent = '¡Completado con éxito!';
    } catch (e) {
        log(`Error al compilar modpack: ${e.message}`, 'error');
        progressStatus.textContent = 'Error en la compilación.';
    }
});

// --- GITHUB PAGES PUBLISH FLOW ---
const modalGithub = document.getElementById('modal-github');

document.getElementById('btn-github').addEventListener('click', () => {
    modalGithub.style.display = 'flex';
});

document.getElementById('btn-cancel-github').addEventListener('click', () => {
    modalGithub.style.display = 'none';
});

document.getElementById('btn-select-git-dir').addEventListener('click', async () => {
    const folder = await ipcRenderer.invoke('select-directory');
    if (folder) {
        selectedGitLocation = folder.replace(/\\/g, '/');
        document.getElementById('git-dir-path').textContent = selectedGitLocation;
        saveGitConfig(selectedGitLocation);
    }
});

// Obtener la URL de GitHub Pages a partir del Git Remote origin
function getGitHubPagesUrl(gitDir) {
    return new Promise((resolve) => {
        exec('git remote get-url origin', { cwd: gitDir }, (err, stdout) => {
            if (err || !stdout) {
                resolve('https://usuario.github.io/repositorio');
                return;
            }
            const remote = stdout.trim();
            // Match git@github.com:username/repo.git o https://github.com/username/repo.git
            const match = remote.match(/github\.com[:/]([^/]+)\/([^.]+)/);
            if (match) {
                const username = match[1];
                let repo = match[2];
                if (repo.endsWith('.git')) {
                    repo = repo.slice(0, -4);
                }
                resolve(`https://${username}.github.io/${repo}`);
            } else {
                resolve('https://usuario.github.io/repositorio');
            }
        });
    });
}

// Deploy / Push to GitHub Pages
document.getElementById('btn-push-github').addEventListener('click', async () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona el modpack que deseas subir.', 'error');
        alert('Selecciona un modpack antes de publicar.');
        return;
    }

    if (!selectedGitLocation) {
        log('Error: Debes seleccionar el repositorio local de Git.', 'error');
        alert('Por favor selecciona la carpeta del repositorio Git.');
        return;
    }

    const commitMsg = document.getElementById('git-commit-msg').value.trim() || 'Modpack update';

    try {
        log('[GitHub Pages] Iniciando proceso de publicación...', 'info');
        progressContainer.style.display = 'flex';
        progressStatus.textContent = 'Calculando URL de GitHub Pages...';

        const ghPagesUrl = await getGitHubPagesUrl(selectedGitLocation);
        log(`[GitHub Pages] URL base detectada: ${ghPagesUrl}`, 'info');

        // Los archivos se escriben en docs/ porque el Pages está configurado desde /docs
        const pagesDir = path.join(selectedGitLocation, 'docs');
        if (!fs.existsSync(pagesDir)) {
            fs.mkdirSync(pagesDir, { recursive: true });
        }

        // 1. Leer el modpack.json local
        const srcJson = path.join(pack.location, 'modpack.json');
        if (!fs.existsSync(srcJson)) {
            throw new Error('Primero debes COMPILAR el modpack antes de subirlo.');
        }

        const localJsonContent = JSON.parse(fs.readFileSync(srcJson, 'utf8'));

        // Modificar las URLs de descarga para apuntar a GitHub Pages
        const finalJsonContent = localJsonContent.map(mod => {
            return {
                ...mod,
                url: `${ghPagesUrl}/mods/${mod.name}`
            };
        });

        // Guardar el modpack.json modificado en docs/
        const targetJsonName = `${pack.id}.json`;
        const destJson = path.join(pagesDir, targetJsonName);
        fs.writeFileSync(destJson, JSON.stringify(finalJsonContent, null, 4));
        log(`Copiado y ajustado modpack.json en: ${destJson}`);

        // Copiar carpeta de mods a docs/mods/
        progressStatus.textContent = 'Copiando mods al repositorio...';
        const srcMods = path.join(pack.location, 'mods');
        const destMods = path.join(pagesDir, 'mods');
        if (fs.existsSync(srcMods)) {
            if (!fs.existsSync(destMods)) fs.mkdirSync(destMods, { recursive: true });
            const mods = fs.readdirSync(srcMods);
            mods.forEach(mod => {
                fs.copyFileSync(path.join(srcMods, mod), path.join(destMods, mod));
            });
            log('Copias de mods realizadas al repositorio git en docs/mods/.');
        }

        // 2. Leer o crear docs/instances.json
        const destInstancesPath = path.join(pagesDir, 'instances.json');
        let instancesObj = {};
        if (fs.existsSync(destInstancesPath)) {
            try {
                instancesObj = JSON.parse(fs.readFileSync(destInstancesPath, 'utf8'));
            } catch (e) {
                instancesObj = {};
            }
        }

        // Agregar o actualizar el modpack en instances.json
        instancesObj[pack.id] = {
            name: pack.id,
            title: pack.title,
            status: "operationnel",
            gameVersion: pack.gameVersion,
            modpack_url: `${ghPagesUrl}/${pack.id}.json`,
            loader: {
                type: pack.loader,
                build: pack.loaderVersion,
                enable: pack.loader !== 'vanilla'
            },
            whitelistActive: false,
            whitelist: []
        };

        fs.writeFileSync(destInstancesPath, JSON.stringify(instancesObj, null, 4));
        log(`[GitHub Pages] Actualizado docs/instances.json en el repositorio.`);

        // 3. Crear docs/config.json y docs/articles.json si no existen
        const destConfigPath = path.join(pagesDir, 'config.json');
        if (!fs.existsSync(destConfigPath)) {
            const defaultConfig = {
                rss: null,
                status: {
                    server: {
                        ip: "127.0.0.1",
                        port: 25565
                    }
                },
                maintenance: false
            };
            fs.writeFileSync(destConfigPath, JSON.stringify(defaultConfig, null, 4));
            log(`[GitHub Pages] Creado docs/config.json por defecto.`);
        }

        const destArticlesPath = path.join(pagesDir, 'articles.json');
        if (!fs.existsSync(destArticlesPath)) {
            const defaultArticles = [
                {
                    title: `¡Modpack ${pack.title} listo!`,
                    content: `El modpack se ha actualizado y publicado exitosamente en GitHub Pages. ¡A jugar!`,
                    author: "Yusup Creator Tools",
                    publish_date: "Ahora"
                }
            ];
            fs.writeFileSync(destArticlesPath, JSON.stringify(defaultArticles, null, 4));
            log(`[GitHub Pages] Creado articles.json por defecto.`);
        }

        // 4. Ejecutar comandos GIT en la consola
        progressStatus.textContent = 'Ejecutando Git commands...';
        log('[Git] Ejecutando: git add .');
        
        exec(`git add .`, { cwd: selectedGitLocation }, (err, stdout, stderr) => {
            if (err) {
                log(`[Git Error] Add failed: ${err.message}`, 'error');
                return;
            }
            log('[Git] Ejecutando commit...');
            exec(`git commit -m "${commitMsg}"`, { cwd: selectedGitLocation }, (err, stdout, stderr) => {
                log('[Git] Ejecutando push...');
                exec(`git push`, { cwd: selectedGitLocation }, (err, stdout, stderr) => {
                    if (err) {
                        log(`[Git Error] Push failed: ${err.message}. Verifica que tengas permisos y acceso ssh/https configurados.`, 'error');
                    } else {
                        log('[GitHub Pages] ¡Publicado con éxito!', 'success');
                        log(`El modpack "${pack.title}" ya está disponible públicamente.`, 'success');
                        log(`📋 Para que el launcher lo vea, edita package.json y cambia "url" a:`, 'success');
                        log(`   "${ghPagesUrl}"`, 'success');
                        log(`Luego reinicia el launcher para que cargue las nuevas instancias.`, 'info');
                        progressStatus.textContent = '¡GitHub Pages Actualizado!';
                    }
                    modalGithub.style.display = 'none';
                });
            });
        });

    } catch (e) {
        log(`Error al subir a GitHub Pages: ${e.message}`, 'error');
        progressStatus.textContent = 'Error al subir.';
    }
});

document.getElementById('btn-install-launcher').addEventListener('click', async () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack para instalar.', 'error');
        return;
    }

    const modsDir = path.join(pack.location, 'mods');
    if (!fs.existsSync(modsDir)) {
        log(`Error: No existe la carpeta mods/ en ${pack.location}`, 'error');
        return;
    }

    try {
        log(`Instalando "${pack.title}" en el launcher...`, 'info');
        progressContainer.style.display = 'flex';
        progressStatus.textContent = 'Compilando modpack...';

        // 1. Compilar (misma lógica que btn-build)
        const files = fs.readdirSync(modsDir);
        const jarFiles = files.filter(f => f.toLowerCase().endsWith('.jar'));

        if (jarFiles.length === 0) {
            throw new Error('La carpeta mods/ está vacía.');
        }

        const modpackJson = [];
        let processed = 0;

        for (const file of jarFiles) {
            const filePath = path.join(modsDir, file);
            progressStatus.textContent = `Hasheando: ${file}...`;

            const md5 = await calculateMD5(filePath);

            modpackJson.push({
                name: file,
                url: `mods/${file}`,
                md5: md5,
                path: `mods/${file}`
            });

            processed++;
            compileProgress.value = Math.round((processed / jarFiles.length) * 100);
        }

        // 2. Escribir modpack.json local
        const jsonOutPath = path.join(pack.location, 'modpack.json');
        fs.writeFileSync(jsonOutPath, JSON.stringify(modpackJson, null, 4));
        log('Compilación completada.', 'success');

        // 3. Copiar al directorio de instancias del launcher
        progressStatus.textContent = 'Copiando al launcher...';
        const launcherDataDir = path.resolve('./data/modpacks');
        if (!fs.existsSync(launcherDataDir)) {
            fs.mkdirSync(launcherDataDir, { recursive: true });
        }

        const instanceDir = path.join(launcherDataDir, pack.id);
        if (!fs.existsSync(instanceDir)) {
            fs.mkdirSync(instanceDir, { recursive: true });
        }

        // Copiar modpack.json
        fs.copyFileSync(jsonOutPath, path.join(instanceDir, 'modpack.json'));

        // Copiar carpeta mods
        const destMods = path.join(instanceDir, 'mods');
        if (!fs.existsSync(destMods)) {
            fs.mkdirSync(destMods, { recursive: true });
        }
        const modFiles = fs.readdirSync(modsDir);
        modFiles.forEach(mod => {
            fs.copyFileSync(path.join(modsDir, mod), path.join(destMods, mod));
        });

        // 4. Registrar la instancia en creator-modpacks.json para que el launcher la detecte
        const creatorPath = path.resolve('./data/creator-modpacks.json');
        let creatorModpacks = [];
        if (fs.existsSync(creatorPath)) {
            try {
                creatorModpacks = JSON.parse(fs.readFileSync(creatorPath, 'utf8'));
            } catch (e) {
                creatorModpacks = [];
            }
        }

        const existingIdx = creatorModpacks.findIndex(m => m.id === pack.id);
        const entry = {
            id: pack.id,
            title: pack.title,
            gameVersion: pack.gameVersion,
            loader: pack.loader,
            loaderVersion: pack.loaderVersion,
            location: instanceDir
        };

        if (existingIdx >= 0) {
            creatorModpacks[existingIdx] = entry;
        } else {
            creatorModpacks.push(entry);
        }
        fs.writeFileSync(creatorPath, JSON.stringify(creatorModpacks, null, 4));

        log(`¡Modpack instalado en el launcher!`, 'success');
        log(`Ruta: ${instanceDir}`, 'info');
        progressStatus.textContent = '¡Instalado con éxito!';
        compileProgress.value = 100;
    } catch (e) {
        log(`Error al instalar: ${e.message}`, 'error');
        progressStatus.textContent = 'Error en la instalación.';
    }
});

// Start up
loadDb();
loadGitConfig();
renderModpacks();
log('Yusup Modpack Creator cargado correctamente.', 'success');
log('--- CONFIGURACIÓN REMOTA ---', 'info');
try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('./package.json'), 'utf8'));
    const launcherUrl = pkg.url || 'No configurada';
    log(`URL del launcher (package.json): ${launcherUrl}`, 'info');
    log('Los archivos se publican en docs/ (GitHub Pages config /docs)', 'info');
    if (selectedGitLocation) {
        getGitHubPagesUrl(selectedGitLocation).then(ghUrl => {
            log(`URL de GitHub Pages detectada: ${ghUrl}`, 'info');
            if (launcherUrl !== ghUrl) {
                log(`⚠️  Las URLs no coinciden. Edita package.json#url para que apunte a: ${ghUrl}`, 'error');
            } else {
                log('✅ Las URLs coinciden. El launcher ya puede ver estas instancias.', 'success');
            }
        });
    } else {
        log('ℹ️  No hay repo Git configurado. Usá "Subir a GitHub Pages" para configurar uno.', 'info');
    }
} catch (e) {
    log('No se pudo leer package.json', 'error');
}
