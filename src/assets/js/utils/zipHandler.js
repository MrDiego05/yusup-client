const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const extractZip = require('extract-zip');

class ZipHandler {
    async downloadAndExtract(zipUrl, instanceDir, progressCallback) {
        const tmpPath = path.join(instanceDir, '..', `_tmp_${Date.now()}.zip`);

        if (!fs.existsSync(instanceDir)) {
            fs.mkdirSync(instanceDir, { recursive: true });
        }

        const response = await fetch(zipUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ZIP`);
        if (!response.body) throw new Error('Sin cuerpo de respuesta');

        const contentLength = response.headers.get('content-length');
        const total = parseInt(contentLength, 10) || 0;
        let downloaded = 0;

        const destStream = fs.createWriteStream(tmpPath);

        response.body.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total && progressCallback) {
                progressCallback(downloaded, total);
            }
        });

        await new Promise((resolve, reject) => {
            destStream.on('error', reject);
            response.body.on('error', reject);
            response.body.pipe(destStream);
            destStream.on('finish', resolve);
        });

        await extractZip(tmpPath, { dir: instanceDir });

        try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
}

export default new ZipHandler;
