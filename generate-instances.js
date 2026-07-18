/**
 * Escanea modpacks y genera instances.json para www/ y docs/
 *
 * Uso: node generate-instances.js
 *   node generate-instances.js --pages   → solo docs/
 *   node generate-instances.js --server  → solo www/
 *   node generate-instances.js            → ambos
 */

const fs = require('fs');
const path = require('path');

const WWW_DIR = path.join(__dirname, 'www');
const DOCS_DIR = path.join(__dirname, 'docs');
const GITHUB_PAGES = 'https://mrdiego05.github.io/yusup-client';

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Metadata overrides for packs not in creator-modpacks.json
const MANUAL_META = {
    'chuckyforge': { loader: 'forge', loaderVersion: '36.2.34', gameVersion: '1.16.5' },
};

function loadCreatorMetadata() {
    const dbPaths = [
        path.join(__dirname, 'data', 'creator-modpacks.json'),
        path.join(__dirname, 'data', 'Launcher', 'creator-modpacks.json'),
        ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'yusup-client', 'creator-modpacks.json')] : []),
    ];
    for (const dbPath of dbPaths) {
        if (!fs.existsSync(dbPath)) continue;
        try {
            const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            if (Array.isArray(db)) return db;
        } catch (e) {}
    }
    return [];
}

function metaFor(packId, creatorMeta) {
    return creatorMeta.find(m => m.id === packId) || MANUAL_META[packId];
}

function pickLoader(packId, manifest, creatorMeta) {
    const meta = metaFor(packId, creatorMeta);
    const loaderField = manifest?.loader;
    if (loaderField) {
        const t = (typeof loaderField === 'string' ? loaderField : loaderField.type || 'vanilla').toLowerCase();
        return {
            type: t,
            build: typeof loaderField === 'string' ? (meta?.loaderVersion || '') : (loaderField.build || ''),
            enable: t !== 'vanilla'
        };
    }
    if (meta) {
        const t = (meta.loader || 'vanilla').toLowerCase();
        return { type: t, build: meta.loaderVersion || '', enable: t !== 'vanilla' };
    }
    return { type: 'vanilla', build: '', enable: false };
}

function pickTags(packId, manifest, creatorMeta) {
    const meta = metaFor(packId, creatorMeta);
    return manifest?.tags || meta?.tags || [];
}

function pickDescription(packId, manifest, creatorMeta) {
    const meta = metaFor(packId, creatorMeta);
    return meta?.description || manifest?.description || '';
}

function pickGameVersion(packId, manifest, creatorMeta) {
    const meta = metaFor(packId, creatorMeta);
    return meta?.gameVersion || manifest?.gameVersion || '1.20.1';
}

// ── 1. Escanear www/ ──
function scanWww(creatorMeta) {
    const packs = [];
    if (!fs.existsSync(WWW_DIR)) return packs;
    const entries = fs.readdirSync(WWW_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const packDir = path.join(WWW_DIR, entry.name);
        const manifestPath = path.join(packDir, 'modpack.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const packId = manifest.name || entry.name;
            const meta = metaFor(packId, creatorMeta);
            packs.push({
                name: packId,
                title: manifest.title || packId,
                description: pickDescription(packId, manifest, creatorMeta),
                tags: pickTags(packId, manifest, creatorMeta),
                gameVersion: pickGameVersion(packId, manifest, creatorMeta),
                loader: pickLoader(packId, manifest, creatorMeta),
                poster: fs.existsSync(path.join(packDir, 'poster.png')) ? `${entry.name}/poster.png` : null,
                banner: fs.existsSync(path.join(packDir, 'banner.png')) ? `${entry.name}/banner.png` : null,
                modpack_url: `${entry.name}/modpack.json`,
                zipUrl: manifest?.zipUrl || undefined,
                instancePassword: meta?.instancePassword || manifest?.instancePassword || undefined
            });
            console.log(`  ✅ www/${entry.name} — ${manifest.title || packId}`);
        } catch (e) {
            console.warn(`  ⚠️  www/${entry.name}/modpack.json inválido`);
        }
    }
    return packs;
}

// ── 2. Escanear docs/ ──
function scanDocs(creatorMeta) {
    const packs = [];
    if (!fs.existsSync(DOCS_DIR)) return packs;
    const entries = fs.readdirSync(DOCS_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        if (entry.name === 'instances.json' || entry.name === 'config.json' || entry.name === 'articles.json') continue;
        const filePath = path.join(DOCS_DIR, entry.name);
        try {
            const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!manifest.tasks || !Array.isArray(manifest.tasks)) continue;
            const packId = manifest.name || entry.name.replace(/\.json$/, '');
            const posterPath = fs.existsSync(path.join(DOCS_DIR, packId, 'poster.png'))
                ? `${GITHUB_PAGES}/${packId}/poster.png` : null;
            const bannerPath = fs.existsSync(path.join(DOCS_DIR, packId, 'banner.png'))
                ? `${GITHUB_PAGES}/${packId}/banner.png` : null;

            // baseUrl priority: CDN already in manifest > GitHub Pages fallback
            // Only inject GitHub Pages when the manifest has no baseUrl at all
            if (manifest.baseUrl) {
                if (!manifest.baseUrl.startsWith(GITHUB_PAGES)) {
                    console.log(`  🌐 ${entry.name}: baseUrl CDN preservado (${manifest.baseUrl})`);
                }
            } else {
                manifest.baseUrl = GITHUB_PAGES;
                fs.writeFileSync(filePath, JSON.stringify(manifest, null, 4) + '\n');
                console.log(`  📝 ${entry.name}: baseUrl GitHub Pages agregado`);
            }

            const meta = metaFor(packId, creatorMeta);
            packs.push({
                name: packId,
                title: manifest.title || packId,
                description: pickDescription(packId, manifest, creatorMeta),
                tags: pickTags(packId, manifest, creatorMeta),
                gameVersion: pickGameVersion(packId, manifest, creatorMeta),
                loader: pickLoader(packId, manifest, creatorMeta),
                poster: posterPath,
                banner: bannerPath,
                modpack_url: `${GITHUB_PAGES}/${entry.name}`,
                zipUrl: manifest?.zipUrl || undefined,
                instancePassword: meta?.instancePassword || manifest?.instancePassword || undefined
            });
            console.log(`  ✅ docs/${entry.name} — ${manifest.title || packId}`);
        } catch (e) {
            // Not a modpack manifest, skip silently
        }
    }
    return packs;
}

// ── 3. Escanear creator-modpacks.json (para www/ cuando no hay manifest) ──
function scanCreator(creatorMeta, existingPacks) {
    const packs = [...existingPacks];
    for (const m of creatorMeta) {
        if (!m.location) continue;
        const loc = path.resolve(m.location);
        if (!fs.existsSync(loc)) continue;
        const id = m.id;
        if (packs.some(p => p.name === id)) continue;

        const manifestPath = path.join(loc, 'modpack.json');
        let manifest = null;
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {}

        // baseUrl priority: CDN already in manifest > GitHub Pages fallback
        if (manifest) {
            if (manifest.baseUrl) {
                if (!manifest.baseUrl.startsWith(GITHUB_PAGES)) {
                    console.log(`  🌐 ${id}/modpack.json: baseUrl CDN preservado (${manifest.baseUrl})`);
                }
            } else {
                manifest.baseUrl = GITHUB_PAGES;
                fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
                console.log(`  📝 ${id}/modpack.json: baseUrl GitHub Pages agregado`);
            }
        }

        packs.push({
            name: id,
            title: m.title || manifest?.title || id,
            description: pickDescription(id, manifest, creatorMeta),
            tags: pickTags(id, manifest, creatorMeta),
            gameVersion: pickGameVersion(id, manifest, creatorMeta),
            loader: pickLoader(id, manifest, creatorMeta),
            poster: m.poster ? (m.poster.startsWith('http') ? m.poster : `${id}/${m.poster}`) : null,
            banner: m.banner ? (m.banner.startsWith('http') ? m.banner : `${id}/${m.banner}`) : null,
            modpack_url: `${id}/modpack.json`,
            zipUrl: m.zipUrl || manifest?.zipUrl || undefined,
            instancePassword: m.instancePassword || manifest?.instancePassword || undefined
        });
        console.log(`  ✅ ${id} — ${m.title || id} (desde Creator Tools)`);
    }
    return packs;
}

// ── Main ──
const args = process.argv.slice(2);
const mode = args.includes('--pages') ? 'pages' : args.includes('--server') ? 'server' : 'all';
const creatorMeta = loadCreatorMetadata();
const allPacks = [];

if (mode === 'server' || mode === 'all') {
    ensureDir(WWW_DIR);
    console.log('\n📁 Escaneando www/...');
    allPacks.push(...scanCreator(creatorMeta, scanWww(creatorMeta)));
    const wwwList = [];
    for (const p of allPacks) {
        if (!wwwList.some(x => x.name === p.name)) wwwList.push(p);
    }
    fs.writeFileSync(path.join(WWW_DIR, 'instances.json'), JSON.stringify(wwwList, null, 4));
    console.log(`\n📦 ${wwwList.length} modpacks escritos en www/instances.json`);
}

if (mode === 'pages' || mode === 'all') {
    ensureDir(DOCS_DIR);
    console.log('\n📁 Escaneando docs/...');
    const docsPacks = scanDocs(creatorMeta);
    fs.writeFileSync(path.join(DOCS_DIR, 'instances.json'), JSON.stringify(docsPacks, null, 4));
    console.log(`\n📦 ${docsPacks.length} modpacks escritos en docs/instances.json`);
}

console.log('');
