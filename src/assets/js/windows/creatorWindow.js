const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");
const os = require("os");
let dev = process.env.DEV_TOOL === 'open';
let creatorWindow = undefined;

function getWindow() {
    return creatorWindow;
}

function destroyWindow() {
    if (!creatorWindow) return;
    app.quit();
    creatorWindow = undefined;
}

function createWindow() {
    destroyWindow();
    creatorWindow = new BrowserWindow({
        title: "Yusup Creator Tools",
        width: 1000,
        height: 650,
        resizable: true,
        icon: `./src/assets/images/icon/icon.${os.platform() === "win32" ? "ico" : "png"}`,
        frame: false,
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true
        },
    });
    Menu.setApplicationMenu(null);
    creatorWindow.setMenuBarVisibility(false);
    creatorWindow.loadFile(path.join(`${app.getAppPath()}/src/creator.html`));
    creatorWindow.once('ready-to-show', () => {
        if (creatorWindow) {
            if (dev) creatorWindow.webContents.openDevTools({ mode: 'detach' })
            creatorWindow.show()
        }
    });
}

module.exports = {
    getWindow,
    createWindow,
    destroyWindow,
};
