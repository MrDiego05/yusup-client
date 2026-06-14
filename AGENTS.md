# Yusup Client (Minecraft Launcher)

Electron app that launches Minecraft with modpack support (fork of Luuxis/Selvania-Launcher).

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Dev mode (`NODE_ENV=dev`, no dev tools) |
| `npm run dev` | Dev mode with nodemon auto-restart + DevTools (`DEV_TOOL=open`) |
| `npm run creator` | Open modpack creator tool (`CREATOR_MODE=true`) |
| `npm run build` | Production build (obfuscate + electron-builder) |
| `npm run icon` | Generate .ico/.icns from `src/assets/images/icon/icon.png` |

## Architecture

- **Main process**: `src/app.js` — Electron entry, IPC handlers, auto-updater
- **Windows**: `src/assets/js/windows/{updateWindow,mainWindow,creatorWindow}.js`
- **Renderer entrypoints**:
  - `src/index.html` → `src/assets/js/index.js` (update/splash window)
  - `src/launcher.html` → `src/assets/js/launcher.js` (main launcher, ES module)
  - `src/creator.html` → `src/assets/js/creator.js` (modpack creator)
- **Panels** (loaded dynamically in launcher): `src/panels/{home,login,settings}.html` + `src/assets/js/panels/{home,login,settings}.js`

## Security notes

All windows use `contextIsolation: false` + `nodeIntegration: true` — renderer has full Node.js access. IPC calls directly from renderer. No sandbox.

## Config

Config is fetched from `package.json#url` → `{url}/config.json` (remote JSON or GitHub Pages static file). Falls back to hardcoded defaults in `src/assets/js/utils/config.js` if fetch fails. Default remote URL: `https://mrdiego05.github.io/yusup-client`.

## Instance loading (production)

`getInstanceList()` chain:
1. Try `creator-server.json` in userData (local dev server from Creator Tools)
2. Try `{remoteUrl}/instances.json` from GitHub Pages
3. Return `[]` if both fail

## Storage

`electron-store` with encryption (skipped in dev mode). Stores accounts, client config. Encrypted via `key.txt` in userData path.

## GitHub Pages host config

Launcher fetches config from `package.json#url` (default: `https://mrdiego05.github.io/yusup-client`). Required files in `docs/`:

- `config.json` — must contain a valid `client_id` from Azure App Registration for Microsoft login
- `instances.json` — modpack catalog (keyed by name, each entry has `loader`, `gameVersion`, `modpack_url`)
- `articles.json` — news feed (optional, falls back to hardcoded defaults)

## SKCraft-style modpack format (v2)

Both the creator tool and `ModpackSync` now support a SKCraft-inspired manifest format alongside the legacy flat array.

### Manifest format

```json
{
  "version": "20240526-a1b2c3",
  "name": "mymodpack",
  "title": "My Modpack",
  "gameVersion": "1.20.1",
  "baseUrl": "https://example.com/mods/",
  "features": [
    { "name": "SomeMinimap", "description": "A minimap mod", "selected": true, "recommendation": "starred" }
  ],
  "tasks": [
    { "type": "file", "hash": "sha1hex", "location": "mods/MyMod.jar", "to": "mods/MyMod.jar", "size": 12345 },
    { "type": "file", "hash": "...", "location": "config/myconfig.cfg", "to": "config/myconfig.cfg", "size": 456, "userFile": true },
    { "type": "file", "when": { "if": "requireAny", "features": ["SomeMinimap"] }, "hash": "...", "to": "mods/SomeMinimap.jar", "size": 789 },
    { "type": "file", "url": "https://external-cdn.com/mod.jar", "hash": "...", "to": "mods/external.jar", "size": 111 }
  ]
}
```

- `version` — change this to trigger client re-sync. Stored per-instance in `electron-store` → `configClient.instances_versions`
- `tasks[].userFile` — if true and file already exists locally, it is never overwritten
- `tasks[].when` — conditions for optional features (`requireAny` / `requireAll`)
- `tasks[].url` — absolute URL override; if absent, resolved relative to `baseUrl` or manifest URL
- Hashing uses **SHA1** (was MD5 in legacy format)

### Source directory structure (`src/`)

```
pack-location/
├── src/
│   ├── config/              → .minecraft/config/
│   ├── mods/                → .minecraft/mods/
│   ├── resourcepacks/       → .minecraft/resourcepacks/
│   ├── options.txt          → .minecraft/options.txt
│   ├── _CLIENT/             → client-only (path stripped)
│   │   └── mods/SpecialMod.jar
│   ├── _SERVER/             → excluded from client builds entirely
│   ├── _OPTIONAL/           → feature-gated (user chooses)
│   │   └── mods/ToggleMod.jar
│   ├── mods/SomeMod.jar.info.json    → defines feature for SomeMod.jar
│   └── mods/SomeMod.jar.url.txt      → external URL override (first line = URL)
```

### Directory conventions in `src/`

| Prefix | Behavior |
|--------|----------|
| `.` (dot) | Skipped entirely |
| `_CLIENT/` | Included, path segment stripped in manifest |
| `_SERVER/` | Excluded from client builds |
| `_OPTIONAL/` | Included, feature-gated via `when` condition |
| `*.info.json` | Sidecar: defines feature metadata for sibling file |
| `*.url.txt` | Sidecar: first line = external download URL |

### Builder behavior

- If `src/` exists → **SKCraft build**: walks full tree with `walkSrcDir()`, SHA1 hashes, supports conventions above
- If only `mods/` exists → **Legacy build**: scans ALL files recursively from `mods/`, SHA1 hashes, supports subdirectories
- Builder copies files to `objects/` alongside the manifest for local serving
- Both modes write `modpack.json` at the pack root

### Personal file/folder exclusions (`walkSrcDir`)

The following are automatically excluded from SKCraft builds (they are user-specific, not modpack content):

| Type | Items |
|------|-------|
| **Directories** | `screenshots/`, `world/`, `world_nether/`, `world_the_end/`, `end_poi/`, `logs/`, `crash-reports/`, `debug/`, `downloads/`, `DIM1/`, `DIM-1/`, `advancements/`, `stats/`, `data/` |
| **Files** | `options.txt`, `optionsof.txt`, `servers.dat`, `servers.dat_old`, `hotbar.nbt`, `controls.json` |

### Content-addressed storage

When `objects/` exists alongside the manifest, files are stored as `objects/{task.location}` (mirroring SKCraft's layout but without the two-level hash prefix for simplicity).

### Client-side flow (ModpackSync)

1. Fetch manifest from `modpack_url`
2. If features exist, user is shown a modal to select/deselect optional mods
3. Compare stored `version` against manifest `version` — skip if same
4. For each task:
   - Skip if `userFile: true` and file exists locally
   - SHA1-check local file against `task.hash` — skip if match
   - Queue for download otherwise
5. Clean stale files across **all** subdirectories (not just `mods/`)
6. Remove empty directories after cleanup
7. Download queued files from `task.url` or resolved from manifest `baseUrl`
8. Store new version in `configClient.instances_versions`

### Known issues

- `renderer-error.log` shows repeated `Cannot find module '../utils.js'` in `launcher.html` — stale/unfixed import resolution failure; renderer continues loading via import map in `src/assets/js/launcher.js`
- `addAccount` fails with `Cannot read properties of null (reading 'appendChild')` when account list container elements are missing from the DOM
- `initFrame` fails when platform-specific `.frame` element not found in `launcher.html`
- Microsoft login falls back to `minecraft-java-core`'s default client_id (`00000000402b5328`) when config has empty/placeholder client_id — works without remote config
- Calendar button is permanently visible in sidebar (before settings) — calendar events only show if creator tool has synced events
- Admin rank toggle has been removed — the creator tools section in instances view is now always shown (if creator-modpacks.json exists)

## Standalone Server (`server.js`)

Servidor HTTP independiente para servir modpacks en red local o pública.

```
node server.js          → iniciar servidor en puerto 3456
node generate-instances → escanea www/ y genera instances.json
```

### Tailscale / ZeroTier (recomendado para clientes remotos)

Sin abrir puertos ni exponer tu IP:

1. Instalá [Tailscale](https://tailscale.com) en tu PC y en los PCs de tus usuarios
2. Todos inician sesión y se conectan a la misma red
3. Tailscale te asigna una IP `100.x.x.x`
4. Corré el servidor: `node server.js`
5. El server detecta Tailscale automáticamente y usa esa IP
6. Los clientes se conectan a la IP virtual de Tailscale

Alternativa: forzar una IP manual:
```bash
node server.js 100.x.x.x
```

### Estructura esperada de `www/`

```
www/
├── config.json            → { "client_id": "...", ... }
├── instances.json         → catálogo de modpacks
├── <packId>/
│   ├── modpack.json       → manifest (generado por Creator Tools)
│   ├── poster.png         → (opcional)
│   ├── banner.png         → (opcional)
│   └── objects/           → archivos del modpack
│       ├── mods/...
│       └── config/...
```

El server:
- Escribe `creator-server.json` automáticamente → el launcher lo detecta
- Sirve `config.json`, `instances.json`, modpacks, posters, banners
- Resuelve URLs relativas en `instances.json` con la IP real del server
- Protección anti path traversal
- MIME types para `.jar`, `.png`, `.json`, `.cfg`, etc.

## Build

`node build.js --obf=true --build=platform` runs JS obfuscation (medium) then electron-builder. Output in `dist/`. Uses `npm ci` in CI (node 18.x). CI triggers on push to `master`.

## Miscellaneous

- License: Luuxis License v1.0 (custom, requires public fork, no commercial use, must retain original license)
- No TypeScript, no linter, no test framework configured
- `nodemon` watches `.js,.html,.css` (ignores `test/`)
- `data/` is gitignored — runtime data (config, modpacks, user data)
- `app/` is gitignored — build output (obfuscated copy of src)

## Build & Auto-update

Run `node build.js --obf=true --build=platform` to produce a distributable `.exe` (NSIS installer) in `dist/`. The build:
1. Obfuscates JS files (medium preset) from `src/` to `app/`
2. Runs `electron-builder` with NSIS (Windows), DMG+ZIP (macOS), or AppImage (Linux)
3. Configures GitHub publisher for `electron-updater` (auto-update)

On startup, the launcher checks GitHub releases for updates. If found, it auto-downloads (Windows) or opens a download link (Mac). Requires `GH_TOKEN` env var when building with publish.
