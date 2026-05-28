const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { ipcRenderer } = require('electron');

class ModpackSync {
    constructor(modpackUrl, instancePath, options = {}) {
        this.modpackUrl = modpackUrl;
        this.instancePath = instancePath;
        this.enabledFeatures = options.enabledFeatures || [];
        this.manifest = null;
        this.isLocal = false;
        this.manifestBaseDir = null;
    }

    calculateSHA1(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha1');
            const stream = fs.createReadStream(filePath);
            stream.on('error', err => reject(err));
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
        });
    }

    async downloadFile(fileUrl, destPath) {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        if (this.isLocal && this.manifestBaseDir) {
            // Local file copy — resolve relative paths against manifest directory
            const srcPath = path.resolve(this.manifestBaseDir, fileUrl);
            fs.copyFileSync(srcPath, destPath);
            return;
        }

        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error(`Error al descargar ${fileUrl}: ${response.statusText}`);

        const fileStream = fs.createWriteStream(destPath);
        return new Promise((resolve, reject) => {
            response.body.pipe(fileStream);
            response.body.on('error', err => {
                fileStream.close();
                reject(err);
            });
            fileStream.on('finish', () => resolve());
        });
    }

    shouldIncludeTask(task) {
        if (!task.when) return true;
        const condition = task.when;
        if (condition.if === 'requireAny') {
            return condition.features.some(f => this.enabledFeatures.includes(f));
        }
        if (condition.if === 'requireAll') {
            return condition.features.every(f => this.enabledFeatures.includes(f));
        }
        return true;
    }

    collectAllFiles(dir, prefix = '') {
        const results = [];
        if (!fs.existsSync(dir)) return results;
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            const fullPath = path.join(dir, entry);
            const relPath = prefix ? `${prefix}/${entry}` : entry;
            if (fs.statSync(fullPath).isDirectory()) {
                results.push(...this.collectAllFiles(fullPath, relPath));
            } else {
                results.push(relPath);
            }
        }
        return results;
    }

    async sync(progressCallback, storedVersion) {
        progressCallback(0, 100, "Obteniendo información del modpack...");

        let manifest;
        try {
            if (fs.existsSync(this.modpackUrl)) {
                this.isLocal = true;
                this.manifestBaseDir = path.dirname(this.modpackUrl);
                const raw = fs.readFileSync(this.modpackUrl, 'utf8');
                manifest = JSON.parse(raw);
            } else {
                const res = await fetch(this.modpackUrl);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                manifest = await res.json();
            }
        } catch (error) {
            console.warn(`ModpackSync: no se pudo obtener el manifest (${error.message}), se omite la sincronización`);
            return null;
        }

        this.manifest = manifest;
        const tasks = manifest.tasks || [];

        if (storedVersion && storedVersion === manifest.version) {
            progressCallback(100, 100, "El modpack ya está actualizado.");
            this.saveManifest(manifest);
            return { updated: false, version: manifest.version };
        }

        const filesToDownload = [];
        const validLocalFiles = new Set();
        const baseUrl = manifest.baseUrl || '';

        let checkedCount = 0;
        const totalToCheck = tasks.length;

        for (const task of tasks) {
            if (task.type !== 'file') continue;
            if (!this.shouldIncludeTask(task)) continue;

            const toPath = task.to;
            const localPath = path.join(this.instancePath, toPath);
            const displayName = path.basename(toPath);

            progressCallback(checkedCount, totalToCheck, `Verificando ${displayName}...`);

            if (task.userFile && fs.existsSync(localPath)) {
                validLocalFiles.add(path.resolve(localPath));
                checkedCount++;
                continue;
            }

            if (fs.existsSync(localPath)) {
                try {
                    const localHash = await this.calculateSHA1(localPath);
                    if (localHash === task.hash) {
                        validLocalFiles.add(path.resolve(localPath));
                        checkedCount++;
                        continue;
                    }
                } catch (e) {
                    // If we can't read it, re-download
                }
            }

            filesToDownload.push(task);
            checkedCount++;
        }

        // Clean stale files across all directories
        const allLocalFiles = new Set(
            this.collectAllFiles(this.instancePath).map(f => path.resolve(this.instancePath, f))
        );

        const protectedFiles = new Set([
            path.resolve(this.instancePath, 'modpack.json'),
            path.resolve(this.instancePath, 'launcher_profiles.json'),
        ]);

        for (const localFile of allLocalFiles) {
            if (protectedFiles.has(localFile)) continue;
            if (!validLocalFiles.has(localFile) && !filesToDownload.some(t =>
                path.resolve(this.instancePath, t.to) === localFile
            )) {
                try {
                    fs.unlinkSync(localFile);
                } catch (e) {
                    // File might be in use or already deleted
                }
            }
        }

        // Remove empty directories after cleanup
        this.removeEmptyDirs(this.instancePath);

        // Download queued files
        let downloadedCount = 0;
        const totalToDownload = filesToDownload.length;

        for (const task of filesToDownload) {
            const displayName = path.basename(task.to);
            progressCallback(downloadedCount, totalToDownload, `Descargando ${displayName}...`);

            const destPath = path.join(this.instancePath, task.to);
            const fileUrl = task.url || task.location || task.to;

            try {
                await this.downloadFile(fileUrl, destPath);
            } catch (err) {
                throw new Error(`Error descargando ${displayName}: ${err.message}`);
            }

            downloadedCount++;
        }

        this.saveManifest(manifest);
        progressCallback(100, 100, "Sincronización completada.");
        return { updated: true, version: manifest.version };
    }

    saveManifest(manifest) {
        const manifestPath = path.join(this.instancePath, 'modpack.json');
        try {
            if (!fs.existsSync(this.instancePath)) fs.mkdirSync(this.instancePath, { recursive: true });
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        } catch (e) {
            console.error('Error saving modpack.json:', e);
        }
    }

    removeEmptyDirs(dir) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            const fullPath = path.join(dir, entry);
            if (fs.statSync(fullPath).isDirectory()) {
                this.removeEmptyDirs(fullPath);
            }
        }
        if (fs.readdirSync(dir).length === 0 && dir !== this.instancePath) {
            fs.rmdirSync(dir);
        }
    }
}

export default ModpackSync;
