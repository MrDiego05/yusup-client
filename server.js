/**
 * Yusup Client — Servidor público de modpacks
 *
 * Uso:
 *   node server.js          → iniciar servidor en puerto 3456
 *   node generate-instances → escanea www/ y genera instances.json
 *
 * Tailscale / ZeroTier (recomendado para clientes remotos):
 *   - Instalá Tailscale en tu PC y en los PCs de tus usuarios
 *   - Todos se conectan a la misma red
 *   - Tailscale te asigna una IP 100.x.x.x
 *   - El server detecta Tailscale automáticamente y usa esa IP
 *   - Los clientes se conectan a la IP virtual de Tailscale
 *
 * Alternativa: forzar una IP manual:
 *   node server.js 100.x.x.x
 *
 * Config:
 *   www/config.json                 → { "client_id": "tu-id-azure", ... }
 *   data/creator-modpacks.json      → modpacks del Creator Tools (se carga automático)
 *   www/instances.json              → catálogo (opcional, se genera automático)
 *   www/<packId>/objects/           → archivos del modpack (opcional)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 3456;
const WWW_DIR = path.join(__dirname, 'www');
const SERVER_CONFIG_PATH = path.join(__dirname, 'creator-server.json');

// ── detectar IPs ────────────────────────────────────────

function getTailscaleIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        if (name.toLowerCase().includes('tailscale') || name.toLowerCase().includes('zerotier')) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4') return iface.address;
            }
        }
    }
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && iface.address.startsWith('100.')) return iface.address;
        }
    }
    return null;
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return '127.0.0.1';
}

function getServerIP() {
    const cliArg = process.argv[2];
    if (cliArg && cliArg.includes('.')) return cliArg;
    const ts = getTailscaleIP();
    if (ts) return ts;
    return getLocalIP();
}

const MIME_TYPES = {
    '.json': 'application/json',
    '.jar': 'application/java-archive',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.cfg': 'text/plain',
    '.toml': 'text/plain',
    '.yml': 'text/plain',
    '.yaml': 'text/plain',
    '.zip': 'application/zip',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
    '.nbt': 'application/octet-stream',
    '.dat': 'application/octet-stream',
};

// ── cargar modpacks del Creator Tools ───────────────────

function loadCreatorModpacks() {
    const possiblePaths = [
        path.join(__dirname, 'data', 'creator-modpacks.json'),
        path.join(__dirname, 'data', 'Launcher', 'creator-modpacks.json'),
        ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'yusup-client', 'creator-modpacks.json')] : []),
        ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'yusup-client', 'creator-modpacks.json')] : []),
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            try {
                const data = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (Array.isArray(data) && data.length > 0) return data;
            } catch (e) {
                console.warn(`⚠️  No se pudo leer ${p}: ${e.message}`);
            }
        }
    }
    return [];
}

// ── server ───────────────────────────────────────────────

function startServer() {
    if (!fs.existsSync(WWW_DIR)) {
        fs.mkdirSync(WWW_DIR, { recursive: true });
    }

    // Leer config.json
    let configData = null;
    const configPath = path.join(WWW_DIR, 'config.json');
    if (fs.existsSync(configPath)) {
        try { configData = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
        catch (e) { console.warn(`⚠️  www/config.json inválido: ${e.message}`); }
    }

    // Cargar modpacks del Creator Tools
    const creatorModpacks = loadCreatorModpacks();

    // Construir mapa packId → { location, metadata }
    const packs = {};
    for (const m of creatorModpacks) {
        const loc = m.location ? path.resolve(m.location) : null;
        if (loc && fs.existsSync(loc)) {
            packs[m.id] = { location: loc, meta: m };
        }
    }

    // Leer instancias desde www/ y creator-modpacks
    let instancesData = null;
    const instancesPath = path.join(WWW_DIR, 'instances.json');
    if (fs.existsSync(instancesPath)) {
        try { instancesData = JSON.parse(fs.readFileSync(instancesPath, 'utf8')); }
        catch (e) { console.warn(`⚠️  www/instances.json inválido: ${e.message}`); }
    }

    const serverIP = getServerIP();
    const serverUrl = `http://${serverIP}:${PORT}`;
    const isTailscale = serverIP.startsWith('100.');

    // ── resolver archivos ──
    function resolveFile(packId, subPath) {
        // 1. Buscar en www/<packId>/
        const wwwPack = path.join(WWW_DIR, packId, subPath);
        if (fs.existsSync(wwwPack) && fs.statSync(wwwPack).isFile()) return wwwPack;

        // 2. Buscar en la location del Creator Tools
        if (packs[packId]) {
            const fromLocation = path.join(packs[packId].location, subPath);
            if (fs.existsSync(fromLocation) && fs.statSync(fromLocation).isFile()) return fromLocation;
        }

        // 3. Buscar directo en www/
        const wwwDirect = path.join(WWW_DIR, subPath);
        if (fs.existsSync(wwwDirect) && fs.statSync(wwwDirect).isFile()) return wwwDirect;

        return null;
    }

    function safeResolve(packId, subPath) {
        const resolved = resolveFile(packId, subPath);
        if (!resolved) return null;

        // Validar que esté dentro de www/ o de la location del pack
        const resolvedReal = path.resolve(resolved);
        if (resolvedReal.startsWith(path.resolve(WWW_DIR))) return resolved;

        if (packs[packId]) {
            const packLoc = path.resolve(packs[packId].location);
            if (resolvedReal.startsWith(packLoc)) return resolved;
        }
        return null;
    }

    const server = http.createServer((req, res) => {
        const urlPath = req.url.split('?')[0];
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Status
        if (urlPath === '/status' || urlPath === '/') {
            const packCount = Object.keys(packs).length;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                server: 'Yusup Modpack Server',
                url: serverUrl,
                network: isTailscale ? 'tailscale' : 'local',
                config: !!configData,
                instances: instancesData ? (Array.isArray(instancesData) ? instancesData.length : 1) : packCount,
                creator_packs: packCount,
                timestamp: new Date().toISOString()
            }, null, 2));
            return;
        }

        // config.json
        if (urlPath === '/config.json') {
            if (configData) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(configData, null, 2));
            } else {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'config.json no encontrado' }));
            }
            return;
        }

        // instances.json — mezclar www/ + creator-modpacks
        if (urlPath === '/instances.json') {
            const result = [];

            // Agregar desde www/instances.json
            if (instancesData) {
                const list = Array.isArray(instancesData) ? instancesData : [instancesData];
                for (const inst of list) {
                    const name = inst.name || inst.id || '';
                    const loaderType = (typeof inst.loader === 'string' ? inst.loader : inst.loader?.type || 'vanilla').toLowerCase();
                    result.push({
                        ...inst,
                        loader: typeof inst.loader === 'string' || !inst.loader
                            ? { type: loaderType, build: inst.loaderVersion || '', enable: loaderType !== 'vanilla' }
                            : inst.loader,
                        modpack_url: inst.modpack_url && inst.modpack_url.startsWith('http')
                            ? inst.modpack_url : `${serverUrl}/${name}/modpack.json`,
                        poster: inst.poster
                            ? (inst.poster.startsWith('http') ? inst.poster : `${serverUrl}/${name}/${inst.poster}`)
                            : null,
                        banner: inst.banner
                            ? (inst.banner.startsWith('http') ? inst.banner : `${serverUrl}/${name}/${inst.banner}`)
                            : null,
                    });
                }
            }

            // Agregar desde Creator Tools
            for (const [id, pack] of Object.entries(packs)) {
                // No duplicar si ya está en www/
                if (result.some(r => (r.name || r.id) === id)) continue;

                const manifestPath = path.join(pack.location, 'modpack.json');
                let manifest = null;
                try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {}

                const posterPath = path.join(pack.location, 'poster.png');
                const bannerPath = path.join(pack.location, 'banner.png');

                const loaderType = (pack.meta.loader || manifest?.loader?.type || 'vanilla').toLowerCase();
                result.push({
                    name: id,
                    title: pack.meta.title || manifest?.title || id,
                    description: pack.meta.description || manifest?.description || '',
                    tags: pack.meta.tags || manifest?.tags || [],
                    gameVersion: pack.meta.gameVersion || manifest?.gameVersion || '1.20.1',
                    loader: {
                        type: loaderType,
                        build: pack.meta.loaderVersion || manifest?.loader?.build || '',
                        enable: loaderType !== 'vanilla'
                    },
                    poster: fs.existsSync(posterPath) ? `${serverUrl}/${id}/poster.png` : null,
                    banner: fs.existsSync(bannerPath) ? `${serverUrl}/${id}/banner.png` : null,
                    modpack_url: `${serverUrl}/${id}/modpack.json`,
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result, null, 2));
            return;
        }

        // Route: /<pack-id>/<subpath>
        const match = urlPath.match(/^\/([^/]+)\/(.+)$/);
        if (match) {
            const packId = match[1];
            const fileSubPath = match[2];
            // No atrapar /config.json o /instances.json como pack
            if (packId !== 'config.json' && packId !== 'instances.json' && packId !== 'status') {
                const filePath = safeResolve(packId, fileSubPath);
                if (filePath) {
                    const ext = path.extname(filePath).toLowerCase();
                    res.writeHead(200, {
                        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
                    });
                    fs.createReadStream(filePath).pipe(res);
                } else {
                    res.writeHead(404);
                    res.end('Not Found');
                }
                return;
            }
        }

        // Fallback: archivo directo en www/
        const safePath = path.resolve(path.join(WWW_DIR, '.' + urlPath));
        if (safePath.startsWith(path.resolve(WWW_DIR)) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
            const ext = path.extname(safePath).toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
            fs.createReadStream(safePath).pipe(res);
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        try {
            fs.writeFileSync(SERVER_CONFIG_PATH, JSON.stringify({ url: serverUrl }, null, 4));
        } catch (e) {
            console.error(`❌ No se pudo escribir creator-server.json: ${e.message}`);
        }

        const packCount = Object.keys(packs).length;

        console.log('');
        console.log('═══════════════════════════════════════════');
        console.log('  🟢 Yusup Modpack Server');
        console.log('═══════════════════════════════════════════');
        console.log(`  Local:        http://localhost:${PORT}`);
        if (serverIP !== '127.0.0.1') {
            console.log(`  Red virtual:  ${serverUrl}`);
        }
        console.log('───────────────────────────────────────────');
        if (isTailscale) {
            console.log('  🌐 Clientes: instalan Tailscale');
            console.log('     y se conectan a esta IP');
        }
        console.log('───────────────────────────────────────────');
        if (configData) console.log(`  📄 config.json            ✅`);
        else console.log(`  ⚠️  config.json            NO EXISTE`);
        if (instancesData) {
            const count = Array.isArray(instancesData) ? instancesData.length : 1;
            console.log(`  📦 www/instances.json      ✅ (${count})`);
        } else {
            console.log(`  📦 www/instances.json      automático`);
        }
        console.log(`  📦 Creator Tools modpacks  ✅ (${packCount})`);
        console.log('───────────────────────────────────────────');
        if (packCount > 0) {
            for (const [id, pack] of Object.entries(packs)) {
                const title = pack.meta.title || id;
                const hasObjects = fs.existsSync(path.join(pack.location, 'objects'));
                const hasMods = fs.existsSync(path.join(pack.location, 'mods'));
                console.log(`     ${id.padEnd(16)} ${title}${hasObjects ? ' [objects]' : ''}${hasMods ? ' [mods]' : ''}`);
            }
        }
        console.log('═══════════════════════════════════════════');
        console.log('');
        console.log('  Presioná Ctrl+C para detener');
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`❌ Puerto ${PORT} ya está en uso.`);
        } else {
            console.error(`❌ Error: ${err.message}`);
        }
        process.exit(1);
    });
}

startServer();
