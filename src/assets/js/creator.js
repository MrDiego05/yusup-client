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

// New Pack Modal
const modalNewPack = document.getElementById('modal-new-pack');
document.getElementById('btn-new-pack').addEventListener('click', () => {
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

    modpacks.push(newPack);
    saveDb();
    renderModpacks();
    
    modalNewPack.style.display = 'none';
    log(`Modpack guardado: ${title}`, 'success');

    // Crear carpeta si no existe
    if (!fs.existsSync(selectedNewLocation)) {
        fs.mkdirSync(selectedNewLocation, { recursive: true });
        fs.mkdirSync(path.join(selectedNewLocation, 'mods'), { recursive: true });
    }
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
    // Set form to edit
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
            gameDirectory: pack.location,
            version: pack.gameVersion,
            loader: {
                type: pack.loader,
                build: pack.loaderVersion,
                enable: pack.loader !== 'vanilla'
            },
            javaPath: 'java',
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
        progressStatus.textContent = 'Copiando archivos al repositorio...';

        // 1. Copiar modpack.json y archivos al repositorio local git
        const srcJson = path.join(pack.location, 'modpack.json');
        if (!fs.existsSync(srcJson)) {
            throw new Error('Primero debes COMPILAR el modpack antes de subirlo.');
        }

        // Copiar modpack.json al repositorio git (puedes nombrarlo según el ID)
        const targetJsonName = `${pack.id}.json`;
        const destJson = path.join(selectedGitLocation, targetJsonName);
        fs.copyFileSync(srcJson, destJson);
        log(`Copiado modpack.json a: ${destJson}`);

        // Opcional: Copiar mods si es necesario (generalmente GitHub Pages tiene límites de archivos grandes,
        // pero puedes subir archivos si son ligeros. Si no, solo el modpack.json).
        // Copiamos también la carpeta mods
        const srcMods = path.join(pack.location, 'mods');
        const destMods = path.join(selectedGitLocation, 'mods');
        if (fs.existsSync(srcMods)) {
            if (!fs.existsSync(destMods)) fs.mkdirSync(destMods, { recursive: true });
            const mods = fs.readdirSync(srcMods);
            mods.forEach(mod => {
                fs.copyFileSync(path.join(srcMods, mod), path.join(destMods, mod));
            });
            log('Copias de mods realizadas al repositorio git.');
        }

        // 2. Modificar la URL del modpack.json para que apunte a las URLs de GitHub Pages
        // Si el usuario tiene su GitHub Pages en: https://nombreusuario.github.io/repositorio/
        // Podemos leer las URLs de los mods y cambiarlas dinámicamente si es necesario.
        // Pero el json copiado al git ya es suficiente.

        // 3. Ejecutar comandos GIT en la consola
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
                        log(`El archivo modpack.json ya está disponible de forma pública en tu repositorio de GitHub Pages.`, 'success');
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

// Start up
loadDb();
loadGitConfig();
renderModpacks();
log('Yusup Modpack Creator cargado correctamente.', 'success');
