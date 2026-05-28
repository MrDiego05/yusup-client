const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

class NeoForgeSync {
    constructor(gamePath, javaPath) {
        this.gamePath = gamePath;
        this.javaPath = javaPath;
    }

    getInstallerUrls(nfVersion) {
        const base = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
        return [
            `${base}/${nfVersion}/neoforge-${nfVersion}-installer.jar`,
            `${base}/${nfVersion}-beta/neoforge-${nfVersion}-beta-installer.jar`,
        ];
    }

    async install(mcVersion, nfVersion, progressCallback) {
        return new Promise(async (resolve, reject) => {
            try {
                const versionFolderName = `neoforge-${nfVersion}`;
                const versionJsonPath = path.join(this.gamePath, 'versions', versionFolderName, `${versionFolderName}.json`);

                if (fs.existsSync(versionJsonPath)) {
                    progressCallback(100, 100, "NeoForge ya está instalado.");
                    return resolve(versionFolderName);
                }

                progressCallback(0, 100, "Descargando instalador de NeoForge...");
                const installerUrls = this.getInstallerUrls(nfVersion);

                const installerDir = path.join(this.gamePath, 'temp');
                if (!fs.existsSync(installerDir)) fs.mkdirSync(installerDir, { recursive: true });
                const installerJarPath = path.join(installerDir, `neoforge-${nfVersion}-installer.jar`);

                let response = null;
                for (const url of installerUrls) {
                    const controller = new AbortController();
                    const fetchTimeout = setTimeout(() => controller.abort(), 30000);
                    try {
                        const resp = await fetch(url, { signal: controller.signal });
                        clearTimeout(fetchTimeout);
                        if (resp.ok) { response = resp; break; }
                        clearTimeout(fetchTimeout);
                    } catch {
                        clearTimeout(fetchTimeout);
                    }
                }
                if (!response) throw new Error('No se pudo descargar el instalador de NeoForge (404 en todas las URLs).');

                const fileStream = fs.createWriteStream(installerJarPath);
                await new Promise((res, rej) => {
                    response.body.pipe(fileStream);
                    response.body.on('error', rej);
                    fileStream.on('finish', res);
                });

                progressCallback(50, 100, "Instalando NeoForge (esto puede tardar un poco)...");

                const profilesPath = path.join(this.gamePath, 'launcher_profiles.json');
                if (!fs.existsSync(profilesPath)) {
                    const defaultProfiles = {
                        profiles: {},
                        selectedProfile: '(Default)',
                        clientToken: '00000000-0000-0000-0000-000000000000'
                    };
                    fs.writeFileSync(profilesPath, JSON.stringify(defaultProfiles, null, 2));
                }

                const process = spawn(this.javaPath, ['-jar', installerJarPath, '--install-client', this.gamePath]);
                let processTimedOut = false;
                const processTimeout = setTimeout(() => {
                    processTimedOut = true;
                    process.kill();
                }, 300000);

                process.stdout.on('data', (data) => {
                    console.log(`[NeoForge Installer]: ${data}`);
                });

                process.stderr.on('data', (data) => {
                    console.error(`[NeoForge Installer Error]: ${data}`);
                });

                process.on('error', (err) => {
                    clearTimeout(processTimeout);
                    if (fs.existsSync(installerJarPath)) fs.unlinkSync(installerJarPath);
                    reject(new Error(`No se pudo iniciar el instalador de NeoForge: ${err.message}`));
                });

                process.on('close', (code) => {
                    clearTimeout(processTimeout);
                    if (fs.existsSync(installerJarPath)) fs.unlinkSync(installerJarPath);
                    if (processTimedOut) {
                        reject(new Error('El instalador de NeoForge tardó demasiado y fue cancelado.'));
                        return;
                    }
                    if (code === 0) {
                        progressCallback(100, 100, "NeoForge instalado correctamente.");

                        const versionsDir = path.join(this.gamePath, 'versions');
                        let actualVersion = versionFolderName;
                        if (fs.existsSync(versionsDir)) {
                            try {
                                const entries = fs.readdirSync(versionsDir);
                                const neoForgeEntry = entries.find(e =>
                                    e.toLowerCase().includes(nfVersion.toLowerCase()) &&
                                    fs.existsSync(path.join(versionsDir, e, `${e}.json`))
                                );
                                if (neoForgeEntry) actualVersion = neoForgeEntry;
                            } catch (e) {
                                console.error('Error scanning versions folder:', e);
                            }
                        }

                        resolve(actualVersion);
                    } else {
                        reject(new Error(`El instalador de NeoForge falló con el código ${code}`));
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
    }
}

export default NeoForgeSync;
