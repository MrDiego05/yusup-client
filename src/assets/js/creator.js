const { ipcRenderer, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const { Launch } = require('minecraft-java-core');
const nodeFetch = require('node-fetch');

// State
let selectedPackId = null;
let selectedNewLocation = null;
let modpacks = [];
let _dbPath = null;
let _pathsInitialized = false;

// HTTP server
const SERVER_PORT = 3456;
let _httpServer = null;
let _serverPort = 0;
let _serverConfigPath = null;

function getLocalIP() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

function startServer() {
    if (_httpServer) {
        log('El servidor ya está en ejecución.', 'error');
        return;
    }

    if (modpacks.length === 0 || !modpacks.some(m => m.location)) {
        log('No hay modpacks con ubicación válida para servir.', 'error');
        return;
    }

    _httpServer = http.createServer((req, res) => {
        const urlPath = req.url.split('?')[0];

        // Status endpoint
        if (urlPath === '/status' || urlPath === '/') {
            const status = {
                status: 'ok',
                modpacks: modpacks.filter(m => m.location).map(m => ({
                    id: m.id,
                    title: m.title,
                    gameVersion: m.gameVersion,
                    loader: m.loader
                })),
                timestamp: new Date().toISOString()
            };
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(status, null, 2));
            return;
        }

        // Instances list
        if (urlPath === '/instances.json') {
            const base = `http://${getLocalIP()}:${SERVER_PORT}`;
            const instances = modpacks.filter(m => m.location).map(m => ({
                name: m.id,
                title: m.title,
                description: m.description || '',
                tags: m.tags || [],
                gameVersion: m.gameVersion,
                loader: {
                    type: m.loader,
                    build: m.loaderVersion || '',
                    enable: m.loader !== 'vanilla'
                },
                poster: m.poster ? `${base}/${m.id}/${m.poster}` : null,
                banner: m.banner ? `${base}/${m.id}/${m.banner}` : null,
                modpack_url: `${base}/${m.id}/modpack.json`
            }));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(instances, null, 2));
            return;
        }

        // Route: /<pack-id>/modpack.json or /<pack-id>/objects/<path>
        const match = urlPath.match(/^\/([^/]+)\/(.+)$/);
        if (match) {
            const packId = match[1];
            const fileSubPath = match[2];
            const pack = modpacks.find(m => m.id === packId && m.location);
            if (!pack) {
                res.writeHead(404);
                res.end('Modpack not found');
                return;
            }
            const fullPath = path.join(pack.location, fileSubPath);
            if (!fullPath.startsWith(path.resolve(pack.location))) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                const ext = path.extname(fullPath).toLowerCase();
                const mimeTypes = {
                    '.json': 'application/json',
                    '.jar': 'application/java-archive',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.txt': 'text/plain',
                    '.cfg': 'text/plain',
                    '.toml': 'text/plain'
                };
                res.writeHead(200, {
                    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                    'Access-Control-Allow-Origin': '*'
                });
                fs.createReadStream(fullPath).pipe(res);
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    });

    _httpServer.listen(SERVER_PORT, '0.0.0.0', () => {
        _serverPort = SERVER_PORT;
        const ip = getLocalIP();
        const serverUrl = `http://${ip}:${SERVER_PORT}`;

        // Write server config file for the launcher
        try {
            fs.writeFileSync(_serverConfigPath, JSON.stringify({ url: serverUrl }, null, 4));
        } catch (e) {
            log(`❌ No se pudo escribir ${_serverConfigPath}: ${e.message}`, 'error');
        }

        // Update UI
        const serverStatus = document.getElementById('server-status');
        const serverDot = document.getElementById('server-dot');
        const serverLabel = document.getElementById('server-label');
        const serverInfo = document.getElementById('server-info');
        if (serverStatus) serverStatus.style.display = 'flex';
        if (serverDot) serverDot.className = 'server-dot online';
        if (serverLabel) serverLabel.textContent = 'Servidor activo';
        if (serverInfo) serverInfo.textContent = serverUrl;
        document.getElementById('btn-start-server').textContent = '🛑 Detener Servidor';
        log(`🌐 Servidor HTTP iniciado en ${serverUrl}`, 'success');
        log(`   Archivo de configuración escrito: ${_serverConfigPath}`, 'info');
    });

    _httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            log(`❌ El puerto ${SERVER_PORT} ya está en uso. Cerrá el otro programa o cambiá SERVER_PORT.`, 'error');
        } else {
            log(`❌ Error del servidor: ${err.message}`, 'error');
        }
        stopServer();
    });
}

function stopServer() {
    if (!_httpServer) return;
    _httpServer.close(() => {
        _httpServer = null;
        _serverPort = 0;

        // Delete server config file so the launcher knows it's offline
        try {
            if (fs.existsSync(_serverConfigPath)) fs.unlinkSync(_serverConfigPath);
        } catch (e) {}

        const serverStatus = document.getElementById('server-status');
        const serverDot = document.getElementById('server-dot');
        const serverLabel = document.getElementById('server-label');
        const serverInfo = document.getElementById('server-info');
        if (serverDot) serverDot.className = 'server-dot offline';
        if (serverLabel) serverLabel.textContent = 'Servidor detenido';
        if (serverInfo) serverInfo.textContent = '';
        document.getElementById('btn-start-server').textContent = '🌐 Iniciar Servidor';
        log('🛑 Servidor HTTP detenido.', 'info');
    });
}

function checkForUpdates(pack) {
    if (!pack || !pack.location) {
        log('Selecciona un modpack primero.', 'error');
        return;
    }
    const modpackJsonPath = path.join(pack.location, 'modpack.json');
    if (!fs.existsSync(modpackJsonPath)) {
        log(`ℹ️  "${pack.title}" aún no ha sido compilado. Usá "Compilar Modpack" primero.`, 'info');
        return;
    }

    const manifest = JSON.parse(fs.readFileSync(modpackJsonPath, 'utf8'));
    const manifestMtime = fs.statSync(modpackJsonPath).mtimeMs;

    // Check src/ directory if it exists (SKCraft mode)
    const srcDir = path.join(pack.location, 'src');
    const modsDir = path.join(pack.location, 'mods');

    let latestMtime = manifestMtime;

    const checkDirs = [];
    if (fs.existsSync(srcDir)) checkDirs.push(srcDir);
    if (fs.existsSync(modsDir)) checkDirs.push(modsDir);

    if (checkDirs.length === 0) {
        log(`ℹ️  No se encontraron src/ ni mods/ en "${pack.title}". No se puede verificar.`, 'error');
        return;
    }

    // Walk directories to find newest file
    function walkDir(dir) {
        let newest = 0;
        try {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                const entryPath = path.join(dir, entry);
                if (entry === '_SERVER') continue; // Skip server-only files
                try {
                    const stat = fs.statSync(entryPath);
                    if (stat.isDirectory()) {
                        const sub = walkDir(entryPath);
                        if (sub > newest) newest = sub;
                    } else {
                        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
                    }
                } catch (e) {}
            }
        } catch (e) {}
        return newest;
    }

    for (const d of checkDirs) {
        const dirNewest = walkDir(d);
        if (dirNewest > latestMtime) latestMtime = dirNewest;
    }

    const buildDate = new Date(manifestMtime).toLocaleString();
    const sourceDate = new Date(latestMtime).toLocaleString();

    if (latestMtime > manifestMtime) {
        log(`🔄 ¡Actualización disponible para "${pack.title}"!`, 'error');
        log(`   Última compilación: ${buildDate}`, 'info');
        log(`   Archivos modificados: ${sourceDate}`, 'info');
        log(`   Recomendación: Usá "Compilar Modpack" para actualizar.`, 'info');
    } else {
        log(`✅ "${pack.title}" está actualizado.`, 'success');
        log(`   Última compilación: ${buildDate}`, 'info');
    }
}

async function ensurePaths() {
    if (_pathsInitialized) return;
    const userDataPath = await ipcRenderer.invoke('path-user-data');
    _dbPath = path.join(userDataPath, 'creator-modpacks.json');
    _serverConfigPath = path.join(userDataPath, 'creator-server.json');
    const dbDir = path.dirname(_dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    _pathsInitialized = true;
}

// Load database
async function loadDb() {
    await ensurePaths();
    if (fs.existsSync(_dbPath)) {
        try {
            modpacks = JSON.parse(fs.readFileSync(_dbPath, 'utf8'));
        } catch (e) {
            modpacks = [];
        }
    } else {
        // Check legacy path for migration
        const legacyPath = path.resolve('./data/creator-modpacks.json');
        if (fs.existsSync(legacyPath)) {
            try {
                modpacks = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
                saveDb();
                return;
            } catch (e) {}
        }
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
    if (!_dbPath) return;
    fs.writeFileSync(_dbPath, JSON.stringify(modpacks, null, 4));
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
            <td style="width:32px;"><input type="checkbox" class="pack-check" data-id="${pack.id}"></td>
            <td><strong>${pack.id}</strong></td>
            <td>${pack.title}</td>
            <td>${pack.gameVersion} (${pack.loader})</td>
            <td style="font-size:0.8em; color:#94a3b8; word-break:break-all;">${pack.location}</td>
        `;

        tr.querySelector('input[type="checkbox"]').addEventListener('click', e => e.stopPropagation());

        tr.addEventListener('click', () => {
            document.querySelectorAll('#modpack-list tr').forEach(r => r.classList.remove('selected'));
            tr.classList.add('selected');
            selectedPackId = pack.id;
            log(`Modpack seleccionado: ${pack.title} (${pack.id})`);
        });

        listElement.appendChild(tr);
    });
}

// Get checked packs
function getCheckedPacks() {
    const checked = document.querySelectorAll('.pack-check:checked');
    return Array.from(checked).map(cb => modpacks.find(p => p.id === cb.dataset.id)).filter(Boolean);
}

// "Select All" checkbox handler
document.getElementById('check-all')?.addEventListener('change', e => {
    document.querySelectorAll('.pack-check').forEach(cb => cb.checked = e.target.checked);
});

// Selected helper
function getSelectedPack() {
    return modpacks.find(p => p.id === selectedPackId);
}

// Hashing Helpers
function calculateMD5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function calculateSHA1(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

// SKCraft-style src/ walker
// Walks src/ directory and returns: { files: [], features: [] }
// Conventions:
//   src/mods/*.jar          → to "mods/*.jar"
//   src/config/*            → to "config/*"
//   src/_CLIENT/mods/*.jar  → to "mods/*.jar" (_CLIENT stripped)
//   src/_SERVER/            → skipped entirely in client builds
//   src/_OPTIONAL/mods/*.jar → to "mods/*.jar" (feature-gated)
//   src/mods/SomeMod.jar.info.json → defines feature for SomeMod.jar
//   src/mods/SomeMod.jar.url.txt   → external URL override
function walkSrcDir(srcPath) {
    const files = [];
    const features = [];
    const featureMap = {};

    function walk(dir, relativePath, isOptional) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            if (entry.startsWith('.')) continue;
            const fullPath = path.join(dir, entry);
            const isDir = fs.statSync(fullPath).isDirectory();

            if (isDir) {
                if (entry === '_SERVER') continue;
                if (entry === '_CLIENT') {
                    walk(fullPath, relativePath, isOptional);
                    continue;
                }
                if (entry === '_OPTIONAL') {
                    walk(fullPath, relativePath, true);
                    continue;
                }
                walk(fullPath, relativePath ? `${relativePath}/${entry}` : entry, isOptional);
            } else {
                if (entry.endsWith('.info.json')) continue;
                if (entry.endsWith('.url.txt')) continue;

                // Skip player-specific config files (controls, graphics)
                const excludedConfigFiles = ['options.txt', 'optionsof.txt', 'servers.dat', 'servers.dat_old'];
                if (excludedConfigFiles.includes(entry)) continue;

                const relFilePath = relativePath ? `${relativePath}/${entry}` : entry;
                let associatedFeature = null;

                // Check for .info.json sidecar
                const infoPath = fullPath + '.info.json';
                if (fs.existsSync(infoPath)) {
                    try {
                        const infoData = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                        if (infoData.feature) {
                            const featName = infoData.feature.name;
                            if (!featureMap[featName]) {
                                featureMap[featName] = infoData.feature;
                                features.push(infoData.feature);
                            }
                            associatedFeature = featName;
                        }
                    } catch (e) {
                        log(`Error parsing ${entry}.info.json: ${e.message}`, 'error');
                    }
                }

                // Check for .url.txt sidecar
                let externalUrl = null;
                const urlPath = fullPath + '.url.txt';
                if (fs.existsSync(urlPath)) {
                    try {
                        const urlContent = fs.readFileSync(urlPath, 'utf8').trim();
                        const firstLine = urlContent.split('\n')[0].trim();
                        if (firstLine) externalUrl = firstLine;
                    } catch (e) {}
                }

                files.push({
                    fullPath,
                    relativePath: relFilePath,
                    isOptional: isOptional || !!associatedFeature,
                    feature: associatedFeature,
                    externalUrl
                });
            }
        }
    }

    walk(srcPath, '', false);
    return { files, features };
}

// Build SKCraft-style manifest from src/ directory
async function buildSKCraftManifest(pack, progressCallback) {
    const srcDir = path.join(pack.location, 'src');
    if (!fs.existsSync(srcDir)) return null;

    progressCallback('Analizando estructura src/...');
    const { files, features } = walkSrcDir(srcDir);

    if (files.length === 0) {
        throw new Error('La carpeta src/ está vacía o no contiene archivos.');
    }

    const tasks = [];
    let processed = 0;

    for (const file of files) {
        progressCallback(`Hasheando: ${file.relativePath}...`);
        const sha1 = await calculateSHA1(file.fullPath);
        const stat = fs.statSync(file.fullPath);

        const task = {
            type: 'file',
            hash: sha1,
            location: file.relativePath,
            to: file.relativePath,
            size: stat.size
        };

        if (file.externalUrl) {
            task.url = file.externalUrl;
        }

        if (file.feature) {
            task.when = { if: 'requireAny', features: [file.feature] };
        }

        tasks.push(task);
        processed++;
    }

    const version = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' +
        Math.random().toString(36).slice(2, 8);

    return {
        version,
        name: pack.id,
        title: pack.title,
        gameVersion: pack.gameVersion,
        features: features.length > 0 ? features : undefined,
        tasks,
        launch: {}
    };
}

// --- LOADER VERSION FETCHER ---
async function fetchLoaderVersions(loader, mcVersion) {
    const select = document.getElementById('new-loader-version');
    select.innerHTML = '<option value="">Cargando...</option>';
    select.disabled = true;

    try {
        let versions = [];

        if (loader === 'fabric') {
            const res = await nodeFetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
            if (res.status !== 200) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            versions = data.map(e => e.loader.version);
        } else if (loader === 'forge') {
            const res = await nodeFetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
            if (res.status !== 200) throw new Error('HTTP ' + res.status);
            const xml = await res.text();
            const matches = xml.match(/<version>([^<]+)<\/version>/g);
            if (matches) {
                const prefix = mcVersion + '-';
                versions = matches
                    .map(m => m.replace(/<\/?version>/g, ''))
                    .filter(v => v.startsWith(prefix))
                    .sort();
            }
        } else if (loader === 'neoforge') {
            const res = await nodeFetch('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
            const xml = await res.text();
            const matches = xml.match(/<version>([^<]+)<\/version>/g);
            if (matches) {
                versions = matches.map(m => m.replace(/<\/?version>/g, ''));
            }
        }

        if (versions.length === 0) {
            select.innerHTML = '<option value="">Sin versiones disponibles</option>';
        } else {
            select.innerHTML = '<option value="">Seleccioná una versión</option>';
            versions.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v;
                select.appendChild(opt);
            });
        }
    } catch (e) {
        select.innerHTML = '<option value="">Error al cargar</option>';
        log(`Error fetching ${loader} versions: ${e.message}`, 'error');
    }

    select.disabled = false;
}

// --- TOOLBAR & DIALOG ACTIONS ---
let editingPackId = null;

// New Pack Modal
const modalNewPack = document.getElementById('modal-new-pack');
document.getElementById('btn-new-pack').addEventListener('click', () => {
    editingPackId = null;
    document.getElementById('new-id').value = '';
    document.getElementById('new-title').value = '';
    document.getElementById('new-description').value = '';
    document.getElementById('new-tags').value = '';
    document.getElementById('new-game-version').value = '1.20.1';
    document.getElementById('new-loader').value = 'neoforge';
    document.getElementById('new-loader-version').innerHTML = '<option value="">Cargando...</option>';
    selectedNewLocation = null;
    document.getElementById('new-location-path').textContent = 'No seleccionada';
    // Clear banner/poster
    selectedBannerPath = null;
    selectedPosterPath = null;
    document.getElementById('new-banner-input').value = '';
    document.getElementById('new-banner-path').textContent = 'No seleccionada';
    document.getElementById('new-banner-preview').style.display = 'none';
    document.getElementById('btn-clear-banner').style.display = 'none';
    document.getElementById('new-poster-input').value = '';
    document.getElementById('new-poster-path').textContent = 'No seleccionada';
    document.getElementById('new-poster-preview').style.display = 'none';
    document.getElementById('btn-clear-poster').style.display = 'none';
    modalNewPack.style.display = 'flex';
    updateLoaderVersions();
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

// Banner file picker
let selectedBannerPath = null;
let selectedPosterPath = null;

function copyImageToModpack(src, destDir, filename) {
    if (!src || !destDir) return null;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const dest = path.resolve(destDir, filename);
    try {
        const srcResolved = path.resolve(src);
        if (srcResolved.toLowerCase() !== dest.toLowerCase()) {
            fs.copyFileSync(src, dest);
        }
        return filename;
    } catch (e) {
        log(`Error copiando imagen: ${e.message}`, 'error');
        return null;
    }
}

document.getElementById('btn-select-banner').addEventListener('click', async () => {
    const filePath = await ipcRenderer.invoke('select-image');
    if (!filePath) return;
    selectedBannerPath = filePath;
    try {
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
        const preview = document.getElementById('new-banner-preview');
        preview.style.backgroundImage = `url('data:${mime};base64,${buf.toString('base64')}')`;
        preview.style.display = 'block';
    } catch (_) {}
    document.getElementById('new-banner-path').textContent = filePath;
    document.getElementById('btn-clear-banner').style.display = 'inline';
});

document.getElementById('btn-clear-banner').addEventListener('click', () => {
    selectedBannerPath = null;
    document.getElementById('new-banner-input').value = '';
    document.getElementById('new-banner-path').textContent = 'No seleccionada';
    document.getElementById('new-banner-preview').style.display = 'none';
    document.getElementById('btn-clear-banner').style.display = 'none';
});

document.getElementById('btn-select-poster').addEventListener('click', async () => {
    const filePath = await ipcRenderer.invoke('select-image');
    if (!filePath) return;
    selectedPosterPath = filePath;
    try {
        const buf = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
        const preview = document.getElementById('new-poster-preview');
        preview.style.backgroundImage = `url('data:${mime};base64,${buf.toString('base64')}')`;
        preview.style.display = 'block';
    } catch (_) {}
    document.getElementById('new-poster-path').textContent = filePath;
    document.getElementById('btn-clear-poster').style.display = 'inline';
});

document.getElementById('btn-clear-poster').addEventListener('click', () => {
    selectedPosterPath = null;
    document.getElementById('new-poster-input').value = '';
    document.getElementById('new-poster-path').textContent = 'No seleccionada';
    document.getElementById('new-poster-preview').style.display = 'none';
    document.getElementById('btn-clear-poster').style.display = 'none';
});

// Dynamic loader version dropdown
const gameVerInput = document.getElementById('new-game-version');
const loaderSelect = document.getElementById('new-loader');

async function updateLoaderVersions() {
    const ver = gameVerInput.value.trim();
    const loader = loaderSelect.value;
    if (!ver || loader === 'vanilla') {
        const sel = document.getElementById('new-loader-version');
        sel.innerHTML = '<option value="">' + (loader === 'vanilla' ? 'Vanilla no necesita loader' : 'Ingresá una versión de MC') + '</option>';
        return;
    }
    await fetchLoaderVersions(loader, ver);
}

gameVerInput.addEventListener('change', updateLoaderVersions);
loaderSelect.addEventListener('change', updateLoaderVersions);

document.getElementById('btn-save-new').addEventListener('click', () => {
    const id = document.getElementById('new-id').value.trim();
    const title = document.getElementById('new-title').value.trim();
    const gameVer = document.getElementById('new-game-version').value.trim();
    const loader = document.getElementById('new-loader').value;
    const loaderVer = document.getElementById('new-loader-version').value.trim();
    const description = document.getElementById('new-description').value.trim();
    const tagsRaw = document.getElementById('new-tags').value.trim();

    if (!id || !title || !selectedNewLocation) {
        log('Error: Todos los campos del nuevo modpack son requeridos.', 'error');
        alert('Por favor, rellena todos los campos e indica la carpeta.');
        return;
    }

    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    // Copy banner/poster images to the modpack folder
    // Only overwrite if user explicitly selected new ones
    let bannerFile, posterFile;
    if (selectedBannerPath) {
        bannerFile = copyImageToModpack(selectedBannerPath, selectedNewLocation, 'banner.png');
    }
    if (selectedPosterPath) {
        posterFile = copyImageToModpack(selectedPosterPath, selectedNewLocation, 'poster.png');
    }

    const newPack = {
        id,
        title,
        description,
        tags,
        gameVersion: gameVer,
        loader,
        loaderVersion: loaderVer,
        location: selectedNewLocation,
        banner: bannerFile ?? (editingPackId ? modpacks.find(m => m.id === editingPackId)?.banner : null),
        poster: posterFile ?? (editingPackId ? modpacks.find(m => m.id === editingPackId)?.poster : null)
    };

    if (editingPackId) {
        const idx = modpacks.findIndex(m => m.id === editingPackId);
        if (idx >= 0) {
            // Preservar whitelist si ya existe
            const existing = modpacks[idx];
            newPack.whitelist = existing.whitelist || [];
            newPack.whitelistActive = existing.whitelistActive || false;
            modpacks[idx] = newPack;
        }
        editingPackId = null;
        log(`Modpack actualizado: ${title}`, 'success');
    } else {
        newPack.whitelist = [];
        newPack.whitelistActive = false;
        modpacks.push(newPack);
        log(`Modpack guardado: ${title}`, 'success');
        if (!fs.existsSync(selectedNewLocation)) {
            fs.mkdirSync(selectedNewLocation, { recursive: true });
            fs.mkdirSync(path.join(selectedNewLocation, 'mods'), { recursive: true });
        }
    }

    saveDb();
    renderModpacks();

    // Reset image state after save
    selectedBannerPath = null;
    selectedPosterPath = null;
    document.getElementById('new-banner-input').value = '';
    document.getElementById('new-banner-path').textContent = 'No seleccionada';
    document.getElementById('new-banner-preview').style.display = 'none';
    document.getElementById('btn-clear-banner').style.display = 'none';
    document.getElementById('new-poster-input').value = '';
    document.getElementById('new-poster-path').textContent = 'No seleccionada';
    document.getElementById('new-poster-preview').style.display = 'none';
    document.getElementById('btn-clear-poster').style.display = 'none';
    
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
    document.getElementById('new-description').value = pack.description || '';
    document.getElementById('new-tags').value = (pack.tags || []).join(', ');
    document.getElementById('new-game-version').value = pack.gameVersion;
    document.getElementById('new-loader').value = pack.loader;
    document.getElementById('new-loader-version').innerHTML = '<option value="">Cargando...</option>';
    selectedNewLocation = pack.location;
    document.getElementById('new-location-path').textContent = pack.location;
    // Reset file inputs so change event always fires
    document.getElementById('new-banner-input').value = '';
    document.getElementById('new-poster-input').value = '';

    // Pre-fill banner
    const baseLoc = pack.location || '';
    let bannerPath = null;
    if (pack.banner) {
        bannerPath = path.resolve(baseLoc, pack.banner);
        // Also try direct path if banner already includes dir
        if (!fs.existsSync(bannerPath)) {
            bannerPath = path.resolve(pack.banner);
        }
    }
    selectedBannerPath = (bannerPath && fs.existsSync(bannerPath)) ? bannerPath : null;
    if (bannerPath && fs.existsSync(bannerPath)) {
        const preview = document.getElementById('new-banner-preview');
        try {
            const buf = fs.readFileSync(bannerPath);
            const ext = path.extname(bannerPath).toLowerCase();
            const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
            preview.style.backgroundImage = `url('data:${mime};base64,${buf.toString('base64')}')`;
        } catch (_) {
            preview.style.backgroundImage = '';
        }
        preview.style.display = 'block';
        document.getElementById('new-banner-path').textContent = bannerPath;
        document.getElementById('btn-clear-banner').style.display = 'inline';
    } else {
        document.getElementById('new-banner-preview').style.display = 'none';
        document.getElementById('new-banner-path').textContent = 'No seleccionada';
        document.getElementById('btn-clear-banner').style.display = 'none';
    }

    // Pre-fill poster
    let posterPath = null;
    if (pack.poster) {
        posterPath = path.resolve(baseLoc, pack.poster);
        if (!fs.existsSync(posterPath)) {
            posterPath = path.resolve(pack.poster);
        }
    }
    selectedPosterPath = (posterPath && fs.existsSync(posterPath)) ? posterPath : null;
    if (posterPath && fs.existsSync(posterPath)) {
        const preview = document.getElementById('new-poster-preview');
        try {
            const buf = fs.readFileSync(posterPath);
            const ext = path.extname(posterPath).toLowerCase();
            const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
            preview.style.backgroundImage = `url('data:${mime};base64,${buf.toString('base64')}')`;
        } catch (_) {
            preview.style.backgroundImage = '';
        }
        preview.style.display = 'block';
        document.getElementById('new-poster-path').textContent = posterPath;
        document.getElementById('btn-clear-poster').style.display = 'inline';
    } else {
        document.getElementById('new-poster-preview').style.display = 'none';
        document.getElementById('new-poster-path').textContent = 'No seleccionada';
        document.getElementById('btn-clear-poster').style.display = 'none';
    }

    modalNewPack.style.display = 'flex';
    updateLoaderVersions().then(() => {
        const sel = document.getElementById('new-loader-version');
        if (pack.loaderVersion) {
            sel.value = pack.loaderVersion;
        }
    });
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

// --- WHITELIST / ROLES ---
const modalWhitelist = document.getElementById('modal-whitelist');
let whitelistEditingPackId = null;

document.getElementById('btn-whitelist').addEventListener('click', () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack primero.', 'error');
        return;
    }
    whitelistEditingPackId = pack.id;
    document.getElementById('wl-active').checked = pack.whitelistActive || false;
    renderWhitelist(pack.whitelist || []);
    modalWhitelist.style.display = 'flex';
});

document.getElementById('btn-cancel-wl').addEventListener('click', () => {
    modalWhitelist.style.display = 'none';
});

document.getElementById('btn-wl-add').addEventListener('click', () => {
    const name = document.getElementById('wl-player-name').value.trim();
    const role = document.getElementById('wl-player-role').value;
    if (!name) return;
    const pack = modpacks.find(m => m.id === whitelistEditingPackId);
    if (!pack) return;
    if (!pack.whitelist) pack.whitelist = [];
    if (pack.whitelist.find(w => w.name.toLowerCase() === name.toLowerCase())) {
        log(`El jugador ${name} ya está en la lista.`, 'error');
        return;
    }
    pack.whitelist.push({ name, role });
    document.getElementById('wl-player-name').value = '';
    renderWhitelist(pack.whitelist);
});

document.getElementById('btn-save-wl').addEventListener('click', () => {
    const pack = modpacks.find(m => m.id === whitelistEditingPackId);
    if (!pack) return;
    pack.whitelistActive = document.getElementById('wl-active').checked;
    saveDb();
    modalWhitelist.style.display = 'none';
    log(`Roles guardados para "${pack.title}"`, 'success');
});

function renderWhitelist(list) {
    const tbody = document.getElementById('wl-list');
    tbody.innerHTML = '';
    list.forEach((entry, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="padding:6px 12px;">${entry.name}</td>
            <td style="padding:6px 12px; color:${entry.role === 'admin' ? '#3b82f6' : '#10b981'};">${entry.role}</td>
            <td style="padding:6px 12px;"><button class="tool-btn" data-idx="${idx}" style="padding:2px 8px; font-size:0.8em; background:rgba(239,68,68,0.2); border-color:rgba(239,68,68,0.4);">✕</button></td>
        `;
        tr.querySelector('button').addEventListener('click', () => {
            const pack = modpacks.find(m => m.id === whitelistEditingPackId);
            if (!pack) return;
            pack.whitelist.splice(idx, 1);
            renderWhitelist(pack.whitelist);
        });
        tbody.appendChild(tr);
    });
}

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

    const srcDir = path.join(pack.location, 'src');
    const modsDir = path.join(pack.location, 'mods');
    const hasSrc = fs.existsSync(srcDir);
    const hasMods = fs.existsSync(modsDir);

    if (!hasSrc && !hasMods) {
        log(`Error: No existe src/ ni mods/ en ${pack.location}`, 'error');
        return;
    }

    try {
        log(`Iniciando compilación del modpack "${pack.title}"...`, 'info');
        progressContainer.style.display = 'flex';
        compileProgress.value = 0;

        let manifest;

        if (hasSrc) {
            // SKCraft-style build
            log('Modo SKCraft: compilando desde src/...', 'info');
            const progressCallback = (msg) => {
                progressStatus.textContent = msg;
            };
            manifest = await buildSKCraftManifest(pack, progressCallback);

            // Copy files alongside manifest for local serving
            const objectsDir = path.join(pack.location, 'objects');
            if (!fs.existsSync(objectsDir)) fs.mkdirSync(objectsDir, { recursive: true });

            for (const task of manifest.tasks) {
                const srcFile = path.join(srcDir, task.to);
                const objPath = path.join(objectsDir, task.location);
                const objDir = path.dirname(objPath);
                if (!fs.existsSync(objDir)) fs.mkdirSync(objDir, { recursive: true });
                fs.copyFileSync(srcFile, objPath);
            }

            const jsonOutPath = path.join(pack.location, 'modpack.json');
            fs.writeFileSync(jsonOutPath, JSON.stringify(manifest, null, 4));

            log(`¡Compilación SKCraft completada!`, 'success');
            log(`Se procesaron ${manifest.tasks.length} archivos.`, 'success');
            if (manifest.features) {
                log(`Features opcionales detectados: ${manifest.features.map(f => f.name).join(', ')}`, 'info');
            }
        } else {
            // Legacy build (mods/ only)
            log('Modo legacy: compilando desde mods/...', 'info');
            const files = fs.readdirSync(modsDir);
            const jarFiles = files.filter(f => f.toLowerCase().endsWith('.jar'));

            if (jarFiles.length === 0) {
                throw new Error('La carpeta mods/ está vacía.');
            }

            const tasks = [];
            let processed = 0;

            for (const file of jarFiles) {
                const filePath = path.join(modsDir, file);
                progressStatus.textContent = `Hasheando: ${file}...`;
                const sha1 = await calculateSHA1(filePath);
                const stat = fs.statSync(filePath);

                tasks.push({
                    type: 'file',
                    hash: sha1,
                    location: `mods/${file}`,
                    to: `mods/${file}`,
                    size: stat.size
                });

                processed++;
                compileProgress.value = Math.round((processed / jarFiles.length) * 100);
            }

            const version = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' +
                Math.random().toString(36).slice(2, 8);

            manifest = {
                version,
                name: pack.id,
                title: pack.title,
                gameVersion: pack.gameVersion,
                tasks
            };

            const jsonOutPath = path.join(pack.location, 'modpack.json');
            fs.writeFileSync(jsonOutPath, JSON.stringify(manifest, null, 4));

            log(`¡Compilación completada!`, 'success');
            log(`Se procesaron ${jarFiles.length} mods.`, 'success');
        }

        progressStatus.textContent = '¡Completado con éxito!';
    } catch (e) {
        log(`Error al compilar modpack: ${e.message}`, 'error');
        progressStatus.textContent = 'Error en la compilación.';
    }
});



function findPackFiles(pack) {
    const srcDir = path.join(pack.location, 'src');
    const modsDir = path.join(pack.location, 'mods');
    if (fs.existsSync(srcDir)) return { type: 'src', path: srcDir };
    if (fs.existsSync(modsDir)) return { type: 'mods', path: modsDir };
    return null;
}

// Install a single pack into the launcher (reusable)
async function installPackInLauncher(pack) {
    const packFiles = findPackFiles(pack);
    if (!packFiles) {
        throw new Error(`No existe src/ ni mods/ en ${pack.location}`);
    }

    log(`Instalando "${pack.title}" en el launcher...`, 'info');
    progressStatus.textContent = `Compilando ${pack.id}...`;

    // 1. Compilar
    let manifest;
    const jsonOutPath = path.join(pack.location, 'modpack.json');

    if (packFiles.type === 'src') {
        const cb = (msg) => { progressStatus.textContent = msg; };
        manifest = await buildSKCraftManifest(pack, cb);

        const objectsDir = path.join(pack.location, 'objects');
        if (!fs.existsSync(objectsDir)) fs.mkdirSync(objectsDir, { recursive: true });
        for (const task of manifest.tasks) {
            if (task.url) continue;
            const srcFile = path.join(packFiles.path, task.to);
            const objPath = path.join(objectsDir, task.location);
            const objDir = path.dirname(objPath);
            if (!fs.existsSync(objDir)) fs.mkdirSync(objDir, { recursive: true });
            fs.copyFileSync(srcFile, objPath);
        }
    } else {
        const files = fs.readdirSync(packFiles.path);
        const jarFiles = files.filter(f => f.toLowerCase().endsWith('.jar'));
        if (jarFiles.length === 0) throw new Error(`La carpeta mods/ de ${pack.id} está vacía.`);

        const tasks = [];
        for (const file of jarFiles) {
            const filePath = path.join(packFiles.path, file);
            const sha1 = await calculateSHA1(filePath);
            const stat = fs.statSync(filePath);
            tasks.push({ type: 'file', hash: sha1, location: `mods/${file}`, to: `mods/${file}`, size: stat.size });
        }
        const version = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' +
            Math.random().toString(36).slice(2, 8);
        manifest = { version, name: pack.id, title: pack.title, gameVersion: pack.gameVersion, tasks };
        compileProgress.value = 100;
    }

    fs.writeFileSync(jsonOutPath, JSON.stringify(manifest, null, 4));

    // 2. Copiar al directorio de instancias del launcher
    progressStatus.textContent = `Copiando ${pack.id} al launcher...`;
    await ensurePaths();
    
    const Store = require('electron-store');
    const appDataPath = await ipcRenderer.invoke('appData');
    const store = new Store({
        name: 'launcher-data',
        cwd: path.dirname(_dbPath)
    });
    const configClient = store.get('configClient', []);
    const configObj = Array.isArray(configClient) ? configClient[0] : configClient;
    const gamePath = configObj?.gamePath || path.join(appDataPath, '.yusup');

    const launcherDataDir = path.join(gamePath, 'instances');
    if (!fs.existsSync(launcherDataDir)) fs.mkdirSync(launcherDataDir, { recursive: true });

    const instanceDir = path.join(launcherDataDir, pack.id);
    if (!fs.existsSync(instanceDir)) fs.mkdirSync(instanceDir, { recursive: true });

    fs.copyFileSync(jsonOutPath, path.join(instanceDir, 'modpack.json'));

    if (packFiles.type === 'src') {
        const objectsDir = path.join(pack.location, 'objects');
        if (fs.existsSync(objectsDir)) {
            copyRecursive(objectsDir, path.join(instanceDir, 'objects'));
        } else {
            for (const task of manifest.tasks) {
                if (task.url) continue;
                const srcFile = path.join(packFiles.path, task.to);
                const destFile = path.join(instanceDir, task.to);
                const destDir = path.dirname(destFile);
                if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
                fs.copyFileSync(srcFile, destFile);
            }
        }
    } else {
        const destMods = path.join(instanceDir, 'mods');
        if (!fs.existsSync(destMods)) fs.mkdirSync(destMods, { recursive: true });
        fs.readdirSync(packFiles.path).forEach(mod => {
            fs.copyFileSync(path.join(packFiles.path, mod), path.join(destMods, mod));
        });
    }

    // 2.5 Copy poster/banner images to instance directory
    if (pack.banner) {
        const srcBanner = path.join(pack.location || packFiles.path, pack.banner);
        if (fs.existsSync(srcBanner)) {
            fs.copyFileSync(srcBanner, path.join(instanceDir, pack.banner));
        }
    }
    if (pack.poster) {
        const srcPoster = path.join(pack.location || packFiles.path, pack.poster);
        if (fs.existsSync(srcPoster)) {
            fs.copyFileSync(srcPoster, path.join(instanceDir, pack.poster));
        }
    }

    // 3. Registrar en creator-modpacks.json
    await ensurePaths();
    let creatorModpacks = [];
    if (fs.existsSync(_dbPath)) {
        try { creatorModpacks = JSON.parse(fs.readFileSync(_dbPath, 'utf8')); } catch (e) { creatorModpacks = []; }
    }

    const existingIdx = creatorModpacks.findIndex(m => m.id === pack.id);
    const entry = {
        id: pack.id, title: pack.title, description: pack.description || '', tags: pack.tags || [],
        gameVersion: pack.gameVersion, loader: pack.loader, loaderVersion: pack.loaderVersion,
        location: instanceDir, whitelist: pack.whitelist || [], whitelistActive: pack.whitelistActive || false,
        banner: pack.banner || null, poster: pack.poster || null
    };

    if (existingIdx >= 0) creatorModpacks[existingIdx] = entry;
    else creatorModpacks.push(entry);
    fs.writeFileSync(_dbPath, JSON.stringify(creatorModpacks, null, 4));

    // Sync in-memory modpacks with what was written to disk so HTTP server returns fresh data
    const modIdx = modpacks.findIndex(m => m.id === pack.id);
    if (modIdx >= 0) {
        modpacks[modIdx].banner = entry.banner;
        modpacks[modIdx].poster = entry.poster;
        modpacks[modIdx].location = entry.location;
    }

    log(`✅ "${pack.title}" instalado en el launcher (${instanceDir})`, 'success');
}

// Install checked packs
document.getElementById('btn-install-launcher').addEventListener('click', async () => {
    const packs = getCheckedPacks();
    if (packs.length === 0) {
        log('Error: Marcá al menos un modpack con el checkbox para instalar.', 'error');
        return;
    }

    progressContainer.style.display = 'flex';
    compileProgress.value = 0;
    progressStatus.textContent = 'Iniciando instalación por lotes...';

    let successCount = 0;
    let failCount = 0;
    const total = packs.length;

    for (let i = 0; i < total; i++) {
        const pack = packs[i];
        compileProgress.value = Math.round((i / total) * 100);
        progressStatus.textContent = `[${i + 1}/${total}] Instalando ${pack.id}...`;

        try {
            await installPackInLauncher(pack);
            successCount++;
        } catch (e) {
            log(`❌ Error instalando "${pack.title}": ${e.message}`, 'error');
            failCount++;
        }

        if (i < total - 1) {
            progressStatus.textContent = `✅ ${successCount} completados. Siguiente: ${packs[i + 1].id}...`;
        }
    }

    compileProgress.value = 100;
    log(`📦 Instalación por lotes finalizada: ${successCount} exitosos, ${failCount} fallidos.`, 'success');
    progressStatus.textContent = successCount > 0 ? '¡Instalación completada!' : 'Error en la instalación.';
});

// Install all packs
document.getElementById('btn-install-all').addEventListener('click', async () => {
    if (modpacks.length === 0) {
        log('Error: No hay modpacks registrados.', 'error');
        return;
    }

    // Check all boxes first
    document.querySelectorAll('.pack-check').forEach(cb => cb.checked = true);

    // Reuse the same handler
    document.getElementById('btn-install-launcher').click();
});

// HTTP server toggle
document.getElementById('btn-start-server').addEventListener('click', () => {
    if (_httpServer) stopServer();
    else startServer();
});

// Check for updates
document.getElementById('btn-check-updates').addEventListener('click', () => {
    const pack = getSelectedPack();
    if (!pack) {
        log('Error: Selecciona un modpack primero.', 'error');
        return;
    }
    checkForUpdates(pack);
});

// Launch client (switch from creator to launcher)
document.getElementById('btn-launch-client').addEventListener('click', () => {
    if (!_httpServer) {
        log('Iniciando servidor automáticamente...', 'info');
        startServer();
    }
    if (_httpServer) {
        log('Abriendo el launcher...', 'info');
        ipcRenderer.send('open-launcher-from-creator');
    } else {
        log('Error: No se pudo iniciar el servidor.', 'error');
    }
});

// Auto-stop server on window close
document.getElementById('close').addEventListener('click', () => {
    if (_httpServer) stopServer();
});

// Recursive directory copy helper
function copyRecursive(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        if (fs.statSync(srcPath).isDirectory()) {
            copyRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/* ==========================================================================
   CALENDAR EVENT MANAGEMENT
   ========================================================================== */

let _calendarEvents = [];
let _calendarEventsPath = null;

async function loadCalendarEvents() {
    await ensurePaths();
    const dbDir = path.dirname(_dbPath);
    _calendarEventsPath = path.join(dbDir, 'calendar-events.json');
    if (fs.existsSync(_calendarEventsPath)) {
        try {
            _calendarEvents = JSON.parse(fs.readFileSync(_calendarEventsPath, 'utf8'));
        } catch (e) {
            _calendarEvents = [];
        }
    } else {
        _calendarEvents = [];
    }
}

function saveCalendarEvents() {
    if (_calendarEventsPath) {
        fs.writeFileSync(_calendarEventsPath, JSON.stringify(_calendarEvents, null, 4));
    }
}

function renderCalendarEventsTable() {
    const tbody = document.getElementById('cal-events-table');
    if (!tbody) return;
    tbody.innerHTML = '';
    const sorted = [..._calendarEvents].sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
    sorted.forEach((ev, idx) => {
        const tr = document.createElement('tr');
        const dateObj = new Date(ev.date + 'T' + (ev.time || '00:00'));
        const dateStr = dateObj.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
        tr.innerHTML = `
            <td style="padding:8px 12px;">${dateStr}</td>
            <td style="padding:8px 12px;">${ev.time || 'Todo el día'}</td>
            <td style="padding:8px 12px;">${ev.title}</td>
            <td style="padding:8px 12px;"><button class="cal-event-del" data-idx="${idx}" style="background:none; border:none; color:#666; cursor:pointer; font-size:16px;">×</button></td>
        `;
        tr.querySelector('.cal-event-del').addEventListener('click', () => {
            _calendarEvents.splice(idx, 1);
            saveCalendarEvents();
            renderCalendarEventsTable();
            log(`🗑️ Evento eliminado del calendario.`, 'info');
        });
        tbody.appendChild(tr);
    });
}

// Calendar button in toolbar
document.getElementById('btn-calendar')?.addEventListener('click', async () => {
    await loadCalendarEvents();
    renderCalendarEventsTable();
    // Set default date to today
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('cal-event-date').value = today;
    document.getElementById('cal-event-time').value = '';
    document.getElementById('cal-event-title').value = '';
    document.getElementById('modal-calendar').style.display = 'flex';
});

// Add event
document.getElementById('btn-cal-add')?.addEventListener('click', () => {
    const date = document.getElementById('cal-event-date').value;
    const time = document.getElementById('cal-event-time').value;
    const title = document.getElementById('cal-event-title').value.trim();
    if (!date || !title) {
        log('❌ Completá la fecha y el título del evento.', 'error');
        return;
    }
    _calendarEvents.push({ date, time, title });
    saveCalendarEvents();
    renderCalendarEventsTable();
    document.getElementById('cal-event-title').value = '';
    log(`📅 Evento "${title}" agregado al calendario.`, 'success');
});

// Close calendar modal
document.getElementById('btn-close-cal')?.addEventListener('click', () => {
    document.getElementById('modal-calendar').style.display = 'none';
});

// Start up
(async () => {
    await loadDb();
    await ensurePaths();
    renderModpacks();
    log('Yusup Modpack Creator cargado correctamente.', 'success');
    log('--- SERVIDOR HTTP ---', 'info');
    log(`Puerto: ${SERVER_PORT}`, 'info');
    log('Iniciá el servidor con el botón "🌐 Iniciar Servidor" en la barra de herramientas.', 'info');
    log('El launcher se conectará automáticamente al servidor cuando esté activo.', 'info');
})();
