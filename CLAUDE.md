# Yusup Client - AI Agent Guide

**Yusup Client** is an Electron-based Minecraft launcher with modpack management, account handling, and auto-update capabilities. Code is in English with Spanish UI strings; comments may be in French (original author: Luuxis).

---

## Quick Start

```bash
npm install                    # Install dependencies
npm start                      # Run dev mode (Electron window opens)
npm dev                        # Dev mode with hot-reload (watches .js, .html, .css)
npm build                      # Production build (outputs to dist/)
npm run creator                # Launch in creator mode (admin panel)
```

**Important:** Changes to .js, .html, .css auto-reload in dev mode. Changes to src/app.js or IPC channels require restart.

---

## Project Structure

```
src/
├── app.js                              # Main process (Electron lifecycle, IPC, auth, updates)
├── launcher.html / creator.html        # Window templates
├── assets/
│   ├── js/
│   │   ├── launcher.js                 # Renderer: panel initialization & switching
│   │   ├── creator.js                  # Creator mode logic
│   │   ├── index.js                    # Module loader
│   │   ├── utils.js                    # Shared utilities (themes, accounts)
│   │   ├── windows/                    # Window creation (main, update, creator)
│   │   ├── panels/                     # UI logic (login, home, settings)
│   │   └── utils/                      # Core logic
│   │       ├── config.js               # Fetch remote config
│   │       ├── database.js             # electron-store persistence
│   │       ├── logger.js               # Logging utility
│   │       ├── modpackSync.js          # Modpack installation
│   │       ├── neoforgeSync.js         # NeoForge mod loader
│   │       └── skin.js                 # Minecraft skin rendering
│   └── css/                            # Panel styling
└── build.js                            # Build script (obfuscation, icons, electron-builder)
```

---

## Architecture Patterns

### Multi-Process Model

**Main Process (Node.js)** → `src/app.js`
- Electron lifecycle (create windows, handle app events)
- IPC channel handlers (`ipcMain.handle()`, `ipcMain.on()`)
- Authentication & Microsoft OAuth
- Auto-updater logic
- File system access

**Renderer Process (Browser)** → `src/assets/js/launcher.js`
- UI panels (Login, Home, Settings, Creator)
- IPC invocations (`ipcRenderer.invoke()`, `ipcRenderer.send()`)
- DOM manipulation
- Remote config fetching

### IPC Communication

Channels are named with hyphens. Examples:
```javascript
// From renderer: invoke main (request-response)
const result = await ipcRenderer.invoke('get-instances');

// From main: handle renderer requests
ipcMain.handle('get-instances', () => { /* ... */ });

// One-way: renderer → main
ipcRenderer.send('download-modpack', { id: '123' });
ipcMain.on('download-modpack', (event, data) => { /* ... */ });
```

### Panel System

UI is split into swappable panels (login, home, settings). `launcher.js` manages switching:
```javascript
showPanel(panelName) {
  // Hide current, show new panel, load panel's JS logic
}
```

Panel HTML lives in `src/panels/`, logic in `src/assets/js/panels/`.

---

## Common Development Tasks

### Add a New IPC Channel

1. **Main process** (`src/app.js`): Add handler
   ```javascript
   ipcMain.handle('my-channel', async (event, arg) => {
     return { result: arg };
   });
   ```

2. **Renderer** (`src/assets/js/panels/*.js`): Invoke
   ```javascript
   const result = await ipcRenderer.invoke('my-channel', data);
   ```

### Modify UI/CSS

- Edit HTML in `src/launcher.html` or panel files
- Edit CSS in `src/assets/css/panels/`
- Changes auto-reload in dev mode (press F5 if needed)

### Add Persistent Data

Use `electron-store` (database.js pattern):
```javascript
const Store = require('electron-store');
const store = new Store();
store.set('key', value);
const val = store.get('key');
```

### Debug

- **DevTools:** Press F12 or Ctrl+Shift+I in dev mode
- **Console Logs:** Use `logger.js` utility or console.log (visible in DevTools)
- **Main Process Logs:** Visible in terminal running `npm start`

---

## Key Dependencies

- **electron** — Desktop app framework
- **minecraft-java-core** — Minecraft auth, instance management (handles Microsoft OAuth)
- **electron-store** — Local data persistence
- **electron-updater** — Auto-update system
- **node-fetch** — HTTP requests
- **extract-zip** — Modpack installation
- **jimp** — Image processing (skins, icons)

---

## Important Conventions

1. **Naming:** camelCase for variables/functions, PascalCase for classes
2. **Modules:** Mix of ES6 `import/export` and CommonJS `require` (use what's already there)
3. **Config:** Remote config fetched from URL on startup, cached via electron-store
4. **Authentication:** Uses `minecraft-java-core` (Microsoft OAuth flow)
5. **Build:** Production uses `javascript-obfuscator` + `electron-builder`
6. **No Tests:** Test framework not configured

---

## Potential Pitfalls

- **Main Process Changes Require Restart:** Edits to `src/app.js` or IPC handlers need `npm start` restart
- **IPC Channel Names:** Must match exactly (case-sensitive, hyphens vs underscores matter)
- **Store Persistence:** Changes to electron-store happen immediately but survive only if `store.set()` is called
- **Remote Config:** Failure to fetch config falls back to defaults; ensure URL in package.json is valid
- **Obfuscation:** Production builds obfuscate code; errors become hard to debug (dev-mode only)

---

## Build & Release

- **Development:** `npm dev` (hot-reload enabled)
- **Production Build:** `npm build` (creates installers in `dist/`)
- **Icons:** `npm run icon` (generates .ico, .icns, .png from source image)
- **Obfuscation:** Enabled by default in production (`build.js --obf=true`)

---

## Debugging Production Build Issues

Production builds are obfuscated. To debug:
1. Comment out obfuscation in `build.js` temporarily
2. Run `npm build`
3. Test the built app locally
4. Re-enable obfuscation

---

## Links & Resources

- **Electron Docs:** https://www.electronjs.org/docs
- **minecraft-java-core:** https://github.com/Pierce01/MinecraftJavaCore
- **electron-store:** https://github.com/sindresorhus/electron-store
