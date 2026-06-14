/**
 * Escanea modpacks en www/ y en creator-modpacks.json
 * y escribe www/instances.json
 *
 * Uso: node generate-instances.js
 */

const fs = require('fs');
const path = require('path');

const WWW_DIR = path.join(__dirname, 'www');

if (!fs.existsSync(WWW_DIR)) {
    fs.mkdirSync(WWW_DIR, { recursive: true });
}

const packs = [];

// 1. Escanear www/ (carpetas con modpack.json)
const entries = fs.readdirSync(WWW_DIR, { withFileTypes: true });
for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packDir = path.join(WWW_DIR, entry.name);
    const manifestPath = path.join(packDir, 'modpack.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const loaderType = (manifest.loader?.type || 'vanilla').toLowerCase();
        packs.push({
            name: manifest.name || entry.name,
            title: manifest.title || entry.name,
            description: manifest.description || '',
            tags: manifest.tags || [],
            gameVersion: manifest.gameVersion || '1.20.1',
            loader: {
                type: loaderType,
                build: manifest.loader?.build || '',
                enable: loaderType !== 'vanilla'
            },
            poster: fs.existsSync(path.join(packDir, 'poster.png')) ? `${entry.name}/poster.png` : null,
            banner: fs.existsSync(path.join(packDir, 'banner.png')) ? `${entry.name}/banner.png` : null,
            modpack_url: `${entry.name}/modpack.json`
        });
        console.log(`  ✅ www/${entry.name} — ${manifest.title || entry.name}`);
    } catch (e) {
        console.warn(`  ⚠️  www/${entry.name}/modpack.json inválido`);
    }
}

// 2. Buscar creator-modpacks.json
const dbPaths = [
    path.join(__dirname, 'data', 'creator-modpacks.json'),
    path.join(__dirname, 'data', 'Launcher', 'creator-modpacks.json'),
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'yusup-client', 'creator-modpacks.json')] : []),
];

for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    try {
        const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        if (!Array.isArray(db)) continue;
        for (const m of db) {
            if (!m.location) continue;
            const loc = path.resolve(m.location);
            if (!fs.existsSync(loc)) continue;

            const manifestPath = path.join(loc, 'modpack.json');
            let manifest = null;
            try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {}

            const id = m.id;
            if (packs.some(p => p.name === id)) continue;

            const loaderType = (m.loader || manifest?.loader?.type || 'vanilla').toLowerCase();
            packs.push({
                name: id,
                title: m.title || manifest?.title || id,
                description: m.description || manifest?.description || '',
                tags: m.tags || manifest?.tags || [],
                gameVersion: m.gameVersion || manifest?.gameVersion || '1.20.1',
                loader: {
                    type: loaderType,
                    build: m.loaderVersion || manifest?.loader?.build || '',
                    enable: loaderType !== 'vanilla'
                },
                poster: fs.existsSync(path.join(loc, 'poster.png')) ? `${id}/poster.png` : null,
                banner: fs.existsSync(path.join(loc, 'banner.png')) ? `${id}/banner.png` : null,
                modpack_url: `${id}/modpack.json`
            });
            console.log(`  ✅ ${id} — ${m.title || id} (desde Creator Tools)`);
        }
    } catch (e) {}
    break
}

const outPath = path.join(WWW_DIR, 'instances.json');
fs.writeFileSync(outPath, JSON.stringify(packs, null, 4));
console.log(`\n📦 ${packs.length} modpacks escritos en www/instances.json`);
