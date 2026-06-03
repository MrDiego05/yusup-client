const { ipcRenderer, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const { Launch } = require('minecraft-java-core');
const nodeFetch = require('node-fetch');

// State
let selectedPackId = null;
let selectedNewLocation = null;
let selectedGitLocation = null;
let modpacks = [];
let _dbPath = null;
let _gitConfigPath = null;
let _pathsInitialized = false;

async function ensurePaths() {
    if (_pathsInitialized) return;
    const userDataPath = await ipcRenderer.invoke('path-user-data');
    _dbPath = path.join(userDataPath, 'creator-modpacks.json');
    _gitConfigPath = path.join(userDataPath, 'creator-git-config.json');
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

// Load git config
async function loadGitConfig() {
    await ensurePaths();
    if (fs.existsSync(_gitConfigPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(_gitConfigPath, 'utf8'));
            if (config.gitDir) {
                selectedGitLocation = config.gitDir;
                document.getElementById('git-dir-path').textContent = config.gitDir;
            }
        } catch (e) {}
    } else {
        // Check legacy path for migration
        const legacyPath = path.resolve('./data/creator-git-config.json');
        if (fs.existsSync(legacyPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
                if (config.gitDir) {
                    selectedGitLocation = config.gitDir;
                    document.getElementById('git-dir-path').textContent = config.gitDir;
                }
                fs.writeFileSync(_gitConfigPath, JSON.stringify(config, null, 4));
            } catch (e) {}
        }
    }
}

function saveGitConfig(gitDir) {
    if (!_gitConfigPath) return;
    fs.writeFileSync(_gitConfigPath, JSON.stringify({ gitDir }, null, 4));
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
            const res = await nodeFetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
            if (res.status !== 200) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const mapped = new Set();
            for (const [key, ver] of Object.entries(data.promos || {})) {
                if (key.startsWith(mcVersion + '-')) mapped.add(ver);
            }
            versions = [...mapped].sort();
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

document.getElementById('btn-select-banner').addEventListener('click', () => {
    document.getElementById('new-banner-input').click();
});

document.getElementById('new-banner-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    selectedBannerPath = file.path || file.name;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const preview = document.getElementById('new-banner-preview');
        preview.style.backgroundImage = `url(${ev.target.result})`;
        preview.style.display = 'block';
        document.getElementById('new-banner-path').textContent = selectedBannerPath;
        document.getElementById('btn-clear-banner').style.display = 'inline';
    };
    reader.readAsDataURL(file);
});

document.getElementById('btn-clear-banner').addEventListener('click', () => {
    selectedBannerPath = null;
    document.getElementById('new-banner-input').value = '';
    document.getElementById('new-banner-path').textContent = 'No seleccionada';
    document.getElementById('new-banner-preview').style.display = 'none';
    document.getElementById('btn-clear-banner').style.display = 'none';
});

document.getElementById('btn-select-poster').addEventListener('click', () => {
    document.getElementById('new-poster-input').click();
});

document.getElementById('new-poster-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    selectedPosterPath = file.path || file.name;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const preview = document.getElementById('new-poster-preview');
        preview.style.backgroundImage = `url(${ev.target.result})`;
        preview.style.display = 'block';
        document.getElementById('new-poster-path').textContent = selectedPosterPath;
        document.getElementById('btn-clear-poster').style.display = 'inline';
    };
    reader.readAsDataURL(file);
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
    const bannerFile = copyImageToModpack(selectedBannerPath, selectedNewLocation, 'banner.png');
    const posterFile = copyImageToModpack(selectedPosterPath, selectedNewLocation, 'poster.png');

    const newPack = {
        id,
        title,
        description,
        tags,
        gameVersion: gameVer,
        loader,
        loaderVersion: loaderVer,
        location: selectedNewLocation,
        banner: bannerFile,
        poster: posterFile
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
    const bannerPath = pack.banner ? path.join(pack.location, pack.banner) : null;
    selectedBannerPath = bannerPath;
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
    const posterPath = pack.poster ? path.join(pack.location, pack.poster) : null;
    selectedPosterPath = posterPath;
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

// Core publish to GitHub Pages (reusable)
async function publishToGitHubPages(pack, commitMsg, onDone) {
    const ghPagesUrl = await getGitHubPagesUrl(selectedGitLocation);
    log(`[GitHub Pages] URL base: ${ghPagesUrl}`, 'info');

    const pagesDir = path.join(selectedGitLocation, 'docs');
    if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });

    // 1. Leer compilar si no existe modpack.json
    const srcJson = path.join(pack.location, 'modpack.json');
    if (!fs.existsSync(srcJson)) {
        progressStatus.textContent = 'Compilando antes de publicar...';
        const srcDir = path.join(pack.location, 'src');
        const modsDir = path.join(pack.location, 'mods');
        
        let manifest;
        if (fs.existsSync(srcDir)) {
            const cb = (msg) => { progressStatus.textContent = msg; };
            manifest = await buildSKCraftManifest(pack, cb);
        } else if (fs.existsSync(modsDir)) {
            const files = fs.readdirSync(modsDir);
            const jarFiles = files.filter(f => f.toLowerCase().endsWith('.jar'));
            if (jarFiles.length === 0) throw new Error('La carpeta mods/ está vacía.');
            const tasks = [];
            for (const file of jarFiles) {
                progressStatus.textContent = `Hasheando: ${file}...`;
                const sha1 = await calculateSHA1(path.join(modsDir, file));
                const stat = fs.statSync(path.join(modsDir, file));
                tasks.push({ type: 'file', hash: sha1, location: `mods/${file}`, to: `mods/${file}`, size: stat.size });
            }
            const version = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' +
                Math.random().toString(36).slice(2, 8);
            manifest = { version, name: pack.id, title: pack.title, gameVersion: pack.gameVersion, tasks };
        } else {
            throw new Error('No existe src/ ni mods/ en el modpack.');
        }
        fs.writeFileSync(srcJson, JSON.stringify(manifest, null, 4));
        log('Compilación automática completada.', 'success');
    }

    const manifest = JSON.parse(fs.readFileSync(srcJson, 'utf8'));

    // Build the remote manifest with absolute URLs
    const remoteManifest = JSON.parse(JSON.stringify(manifest));

    // Set baseUrl for relative path resolution
    remoteManifest.baseUrl = ghPagesUrl + '/';

    for (const task of remoteManifest.tasks) {
        if (!task.url) {
            task.url = ghPagesUrl + '/' + task.location;
        }
    }

    // Escribir {pack.id}.json
    fs.writeFileSync(path.join(pagesDir, `${pack.id}.json`), JSON.stringify(remoteManifest, null, 4));
    log(`Manifest copiado a docs/${pack.id}.json`);

    // Copiar archivos (objects/ o mods/)
    progressStatus.textContent = 'Copiando archivos...';

    // Use source: prefer src/ over mods/
    const srcDir = path.join(pack.location, 'src');
    const modsDir = path.join(pack.location, 'mods');
    const objectsDir = path.join(pack.location, 'objects');

    if (fs.existsSync(objectsDir)) {
        // Copy objects/ content-addressed structure
        const destObjects = path.join(pagesDir, 'objects');
        copyRecursive(objectsDir, destObjects);
        log('Archivos copiados desde objects/');
    } else if (fs.existsSync(srcDir)) {
        // Flat copy from src/
        for (const task of manifest.tasks) {
            const srcFile = path.join(srcDir, task.to);
            const destFile = path.join(pagesDir, task.location);
            const destDir = path.dirname(destFile);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(srcFile, destFile);
        }
        log('Archivos copiados desde src/');
    } else if (fs.existsSync(modsDir)) {
        // Legacy: just copy mods/
        const destMods = path.join(pagesDir, 'mods');
        if (!fs.existsSync(destMods)) fs.mkdirSync(destMods, { recursive: true });
        fs.readdirSync(modsDir).forEach(mod => {
            if (mod.toLowerCase().endsWith('.jar')) {
                fs.copyFileSync(path.join(modsDir, mod), path.join(destMods, mod));
            }
        });
        log('Mods copiados desde mods/');
    }

    // Actualizar instances.json
    const destInstancesPath = path.join(pagesDir, 'instances.json');
    let instancesObj = {};
    if (fs.existsSync(destInstancesPath)) {
        try { instancesObj = JSON.parse(fs.readFileSync(destInstancesPath, 'utf8')); } catch (e) {}
    }
    instancesObj[pack.id] = {
        name: pack.id, title: pack.title, description: pack.description || '', tags: pack.tags || [],
        status: "operationnel", gameVersion: pack.gameVersion,
        modpack_url: `${ghPagesUrl}/${pack.id}.json`,
        loader: { type: pack.loader, build: pack.loaderVersion, enable: pack.loader !== 'vanilla',
            loader_type: pack.loader, loader_version: pack.loaderVersion, minecraft_version: pack.gameVersion },
        verify: true, ignored: [], themeColor: 'lime', playTime: '0.0h',
        whitelistActive: pack.whitelistActive || false, whitelist: pack.whitelist || []
    };
    fs.writeFileSync(destInstancesPath, JSON.stringify(instancesObj, null, 4));
    log(`docs/instances.json actualizado.`);

    // Crear config/articles por defecto si no existen
    for (const [file, content] of [
        ['config.json', { rss: null, status: { server: { ip: "127.0.0.1", port: 25565 } }, maintenance: false }],
        ['articles.json', [{ title: `¡Modpack ${pack.title} listo!`, content: 'Publicado desde Yusup Creator Tools.', author: 'Yusup Creator Tools', publish_date: 'Ahora' }]]
    ]) {
        const fp = path.join(pagesDir, file);
        if (!fs.existsSync(fp)) fs.writeFileSync(fp, JSON.stringify(content, null, 4));
    }

    // Git commands
    progressStatus.textContent = 'Ejecutando Git...';
    exec(`git add .`, { cwd: selectedGitLocation }, (err) => {
        if (err) { log(`[Git Error] add: ${err.message}`, 'error'); if (onDone) onDone(false); return; }
        exec(`git commit -m "${commitMsg || 'Modpack update'}"`, { cwd: selectedGitLocation }, (err) => {
            if (err && !err.message.includes('nothing to commit')) {
                log(`[Git Error] commit: ${err.message}`, 'error');
                if (onDone) onDone(false); return;
            }
            exec(`git push`, { cwd: selectedGitLocation }, (err) => {
                if (err) {
                    log(`[Git Error] push: ${err.message}. Verificá permisos SSH/HTTPS.`, 'error');
                } else {
                    log('🚀 Publicado en GitHub Pages con éxito!', 'success');
                    log(`📋 URL del launcher: ${ghPagesUrl}`, 'info');
                }
                if (onDone) onDone(!err);
            });
        });
    });
}

// Deploy / Push to GitHub Pages
document.getElementById('btn-push-github').addEventListener('click', async () => {
    const pack = getSelectedPack();
    if (!pack) { log('Error: Selecciona un modpack.', 'error'); return; }
    if (!selectedGitLocation) { log('Error: Configurá el repo Git primero.', 'error'); return; }

    progressContainer.style.display = 'flex';
    progressStatus.textContent = 'Publicando...';
    await publishToGitHubPages(pack, document.getElementById('git-commit-msg').value.trim() || 'Modpack update', (ok) => {
        modalGithub.style.display = 'none';
        progressStatus.textContent = ok ? '¡Publicado!' : 'Error al publicar';
    });
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
    const launcherDataDir = path.join(path.dirname(_dbPath), 'modpacks');
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
        location: instanceDir, whitelist: pack.whitelist || [], whitelistActive: pack.whitelistActive || false
    };

    if (existingIdx >= 0) creatorModpacks[existingIdx] = entry;
    else creatorModpacks.push(entry);
    fs.writeFileSync(_dbPath, JSON.stringify(creatorModpacks, null, 4));

    // 4. Actualizar docs/ local
    progressStatus.textContent = `Actualizando docs/ para ${pack.id}...`;
    const projectRoot = path.resolve(__dirname, '..', '..', '..');
    const pagesDir = path.join(projectRoot, 'docs');
    if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });

    const localManifest = JSON.parse(JSON.stringify(manifest));
    for (const task of localManifest.tasks) {
        if (!task.url) task.url = task.location;
    }
    fs.writeFileSync(path.join(pagesDir, `${pack.id}.json`), JSON.stringify(localManifest, null, 4));

    if (packFiles.type === 'src') {
        const objectsDir = path.join(pack.location, 'objects');
        if (fs.existsSync(objectsDir)) {
            copyRecursive(objectsDir, path.join(pagesDir, 'objects'));
        }
        for (const task of manifest.tasks) {
            if (task.url) continue;
            const srcFile = path.join(packFiles.path, task.to);
            const destFile = path.join(pagesDir, task.location);
            const destDir = path.dirname(destFile);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(srcFile, destFile);
        }
    } else {
        const docsMods = path.join(pagesDir, 'mods');
        if (!fs.existsSync(docsMods)) fs.mkdirSync(docsMods, { recursive: true });
        fs.readdirSync(packFiles.path).forEach(mod => {
            fs.copyFileSync(path.join(packFiles.path, mod), path.join(docsMods, mod));
        });
    }

    // Actualizar docs/instances.json
    const destInstancesPath = path.join(pagesDir, 'instances.json');
    let instancesObj = {};
    if (fs.existsSync(destInstancesPath)) {
        try { instancesObj = JSON.parse(fs.readFileSync(destInstancesPath, 'utf8')); } catch (e) {}
    }
    instancesObj[pack.id] = {
        name: pack.id, title: pack.title, description: pack.description || '', tags: pack.tags || [],
        status: "operationnel", gameVersion: pack.gameVersion,
        modpack_url: `${pack.id}.json`,
        loader: { type: pack.loader, build: pack.loaderVersion, enable: pack.loader !== 'vanilla',
            loader_type: pack.loader, loader_version: pack.loaderVersion, minecraft_version: pack.gameVersion },
        verify: true, ignored: [], themeColor: 'lime', playTime: '0.0h',
        whitelistActive: pack.whitelistActive || false, whitelist: pack.whitelist || []
    };
    fs.writeFileSync(destInstancesPath, JSON.stringify(instancesObj, null, 4));

    log(`✅ "${pack.title}" instalado en el launcher (${instanceDir})`, 'success');

    // Push to GitHub Pages if configured
    if (selectedGitLocation && selectedGitLocation === projectRoot) {
        progressStatus.textContent = `Subiendo ${pack.id} a GitHub Pages...`;
        exec(`git add docs/`, { cwd: projectRoot }, (err) => {
            if (err) { log(`[Git Error] add: ${err.message}`, 'error'); return; }
            exec(`git commit -m "Instalación automática: ${pack.title}"`, { cwd: projectRoot }, (err) => {
                if (err && !err.message.includes('nothing to commit')) {
                    log(`[Git Error] commit: ${err.message}`, 'error'); return;
                }
                exec(`git push`, { cwd: projectRoot }, (err) => {
                    if (err) log(`[Git Error] push: ${err.message}`, 'error');
                    else log(`🚀 ${pack.id} publicado en GitHub Pages`, 'success');
                });
            });
        });
    }
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

// Start up
(async () => {
    await loadDb();
    await loadGitConfig();
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
})();
