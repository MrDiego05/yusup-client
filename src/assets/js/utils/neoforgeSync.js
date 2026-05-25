const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

class NeoForgeSync {
    constructor(gamePath, javaPath) {
        this.gamePath = gamePath;
        this.javaPath = javaPath;
    }

    async getInstallerUrl(mcVersion, nfVersion) {
        // Formato para NeoForge: https://maven.neoforged.net/releases/net/neoforged/neoforge/<nfVersion>/neoforge-<nfVersion>-installer.jar
        return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${nfVersion}/neoforge-${nfVersion}-installer.jar`;
    }

    async install(mcVersion, nfVersion, progressCallback) {
        return new Promise(async (resolve, reject) => {
            try {
                // Verificar si ya está instalado
                const versionFolderName = `neoforge-${nfVersion}`;
                const versionJsonPath = path.join(this.gamePath, 'versions', versionFolderName, `${versionFolderName}.json`);
                
                if (fs.existsSync(versionJsonPath)) {
                    progressCallback(100, 100, "NeoForge ya está instalado.");
                    return resolve(versionFolderName);
                }

                progressCallback(0, 100, "Descargando instalador de NeoForge...");
                const installerUrl = await this.getInstallerUrl(mcVersion, nfVersion);
                
                const installerDir = path.join(this.gamePath, 'temp');
                if (!fs.existsSync(installerDir)) fs.mkdirSync(installerDir, { recursive: true });
                const installerJarPath = path.join(installerDir, `neoforge-${nfVersion}-installer.jar`);

                const response = await fetch(installerUrl);
                if (!response.ok) throw new Error(`Fallo al descargar NeoForge: ${response.statusText}`);

                const fileStream = fs.createWriteStream(installerJarPath);
                await new Promise((res, rej) => {
                    response.body.pipe(fileStream);
                    response.body.on('error', rej);
                    fileStream.on('finish', res);
                });

                progressCallback(50, 100, "Instalando NeoForge (esto puede tardar un poco)...");

                const process = spawn(this.javaPath, ['-jar', installerJarPath, '--install-client', this.gamePath]);

                process.stdout.on('data', (data) => {
                    console.log(`[NeoForge Installer]: ${data}`);
                });

                process.stderr.on('data', (data) => {
                    console.error(`[NeoForge Installer Error]: ${data}`);
                });

                process.on('close', (code) => {
                    if (fs.existsSync(installerJarPath)) fs.unlinkSync(installerJarPath);
                    if (code === 0) {
                        progressCallback(100, 100, "NeoForge instalado correctamente.");
                        
                        // Determinar el nombre de la versión leyendo launcher_profiles.json
                        let installedVersionId = versionFolderName;
                        const profilesPath = path.join(this.gamePath, 'launcher_profiles.json');
                        if (fs.existsSync(profilesPath)) {
                            try {
                                const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
                                for (const key in profiles.profiles) {
                                    if (key.toLowerCase().includes('neoforge') || profiles.profiles[key].lastVersionId?.includes('neoforge')) {
                                        installedVersionId = profiles.profiles[key].lastVersionId;
                                    }
                                }
                            } catch (e) {
                                console.error('Error leyendo launcher_profiles.json:', e);
                            }
                        }

                        resolve(installedVersionId);
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
