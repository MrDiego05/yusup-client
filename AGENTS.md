# Yusup Client (Minecraft Launcher)

Electron app that launches Minecraft with modpack support (fork of Luuxis/Selvania-Launcher).

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Dev mode (hot reload, dev tools) |
| `npm run creator` | Open modpack creator tool |
| `npm run dev` | Dev mode with nodemon (auto-restart on JS/HTML/CSS changes) |
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

Config is fetched from `package.json#url` (remote JSON or GitHub Pages static file). Falls back to hardcoded defaults in `src/assets/js/utils/config.js` if fetch fails.

## Storage

`electron-store` with encryption (skipped in dev mode). Stores accounts, client config. Encrypted via `key.txt` in userData path.

## GitHub Pages host config

Launcher fetches config from `package.json#url` (default: `https://mrdiego05.github.io/yusup-client`). Required files in `docs/`:

- `config.json` — must contain a valid `client_id` from Azure App Registration for Microsoft login
- `instances.json` — modpack catalog (keyed by name, each entry has `loader`, `gameVersion`, `modpack_url`)
- `articles.json` — news feed (optional, falls back to hardcoded defaults)

## Analytics

Play sessions are tracked locally in `electron-store` under the `sessions` table. Each record stores `username`, `instance`, `start_time`, `end_time`, `playtime_seconds`. No external server involved.

## Known issues

- `renderer-error.log` shows repeated `Cannot find module '../utils.js'` in `launcher.html` — stale/unfixed import resolution failure; renderer continues loading via import map in `src/assets/js/launcher.js`
- `addAccount` fails with `Cannot read properties of null (reading 'appendChild')` when account list container elements are missing from the DOM
- `initFrame` fails when platform-specific `.frame` element not found in `launcher.html`
- Microsoft login requires a valid Azure App client_id in the remote `config.json` — the default (`00000000-0000-0000-0000-000000000000`) is a placeholder and will be rejected
- Admin rank toggle has been removed — the creator tools section in instances view is now always shown (if creator-modpacks.json exists)

## Build

`node build.js --obf=true --build=platform` runs JS obfuscation (medium) then electron-builder. Output in `dist/`. Uses `npm ci` in CI (node 18.x). CI triggers on push to `master`.

## Miscellaneous

- License: Luuxis License v1.0 (custom, requires public fork, no commercial use, must retain original license)
- No TypeScript, no linter, no test framework configured
- `nodemon` watches `.js,.html,.css` (ignores `test/`)
- `data/` is gitignored — runtime data (config, modpacks, user data)
- `app/` is gitignored — build output (obfuscated copy of src)
