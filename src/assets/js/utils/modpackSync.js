const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { ipcRenderer } = require('electron');

class ModpackSync {
    constructor(modpackUrl, instancePath) {
        this.modpackUrl = modpackUrl;
        this.instancePath = instancePath;
    }

    /**
     * Calcula el hash MD5 de un archivo local.
     */
    calculateMD5(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('md5');
            const stream = fs.createReadStream(filePath);
            stream.on('error', err => reject(err));
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
        });
    }

    /**
     * Descarga un archivo con barra de progreso.
     */
    async downloadFile(url, destPath) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Error al descargar ${url}: ${response.statusText}`);

        const totalSize = parseInt(response.headers.get('content-length'), 10);
        let downloadedSize = 0;

        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const fileStream = fs.createWriteStream(destPath);

        return new Promise((resolve, reject) => {
            response.body.on('data', chunk => {
                downloadedSize += chunk.length;
                // Opcional: enviar progreso individual si es necesario
            });
            response.body.pipe(fileStream);
            response.body.on('error', err => {
                fileStream.close();
                reject(err);
            });
            fileStream.on('finish', () => resolve());
        });
    }

    /**
     * Sincroniza el modpack leyendo el JSON remoto.
     * @param {Function} progressCallback - Callback para actualizar la UI (progress, total, message)
     */
    async sync(progressCallback) {
        progressCallback(0, 100, "Obteniendo información del modpack...");
        
        // 1. Obtener modpack.json
        let modpackData;
        try {
            const res = await fetch(this.modpackUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            modpackData = await res.json();
        } catch (error) {
            throw new Error(`Error al obtener modpack.json: ${error.message}`);
        }

        const modsToDownload = [];
        const validLocalMods = new Set();
        
        let checkedCount = 0;
        const totalToCheck = modpackData.length;

        // 2. Verificar archivos locales
        for (const fileData of modpackData) {
            progressCallback(checkedCount, totalToCheck, `Verificando ${fileData.name}...`);
            const localPath = path.join(this.instancePath, fileData.path);
            
            if (fs.existsSync(localPath)) {
                const localMd5 = await this.calculateMD5(localPath);
                if (localMd5 === fileData.md5) {
                    validLocalMods.add(path.resolve(localPath));
                    checkedCount++;
                    continue;
                }
            }
            
            // Si no existe o el MD5 es diferente, lo agregamos a la lista de descargas
            modsToDownload.push(fileData);
            checkedCount++;
        }

        // 3. Limpiar mods viejos (Opcional, pero recomendado en modpacks de solo lectura)
        const modsDir = path.join(this.instancePath, 'mods');
        if (fs.existsSync(modsDir)) {
            const localFiles = fs.readdirSync(modsDir);
            for (const file of localFiles) {
                const fullPath = path.resolve(modsDir, file);
                if (fs.statSync(fullPath).isFile() && !validLocalMods.has(fullPath) && !modsToDownload.some(m => path.resolve(this.instancePath, m.path) === fullPath)) {
                    fs.unlinkSync(fullPath);
                }
            }
        }

        // 4. Descargar archivos faltantes/actualizados
        let downloadedCount = 0;
        const totalToDownload = modsToDownload.length;

        for (const fileData of modsToDownload) {
            progressCallback(downloadedCount, totalToDownload, `Descargando ${fileData.name}...`);
            const destPath = path.join(this.instancePath, fileData.path);
            await this.downloadFile(fileData.url, destPath);
            downloadedCount++;
        }

        progressCallback(100, 100, "Sincronización completada.");
    }
}

export default ModpackSync;
