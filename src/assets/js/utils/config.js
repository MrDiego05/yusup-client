/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const nodeFetch = require("node-fetch");
const convert = require('xml-js');
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

const RAW_BASE = 'https://raw.githubusercontent.com/mrdiego05/yusup-client/main';
const DOCS_BASE = `${RAW_BASE}/docs`;

class Config {
    async getRemoteBaseUrl() {
        return RAW_BASE;
    }

    async GetConfig() {
        const defaults = {
            rss: null,
            status: {
                server: {
                    ip: "127.0.0.1",
                    port: 25565,
                    nameServer: "Yusup Server"
                }
            },
            maintenance: false,
            client_id: "00000000-0000-0000-0000-000000000000"
        };

        // 1. Try remote
        try {
            const res = await nodeFetch(`${DOCS_BASE}/config.json`);
            if (res.ok) {
                const remote = await res.json();
                return { ...defaults, ...remote };
            }
        } catch (e) {}

        // 2. Fallback: local file
        try {
            const base = path.dirname(require('url').fileURLToPath(import.meta.url));
            const localPath = path.join(base, '..', '..', '..', '..', 'config.json');
            if (fs.existsSync(localPath)) {
                const data = JSON.parse(fs.readFileSync(localPath, 'utf8'));
                return { ...defaults, ...data };
            }
        } catch (e) {}

        return defaults;
    }

    async getInstanceList() {
        // 1. Try creator-server.json (local server running via server.js)
        try {
            const serverConfigPath = path.join(
                await ipcRenderer.invoke('path-user-data'),
                'creator-server.json'
            );
            if (fs.existsSync(serverConfigPath)) {
                const sc = JSON.parse(fs.readFileSync(serverConfigPath, 'utf8'));
                if (sc.url) {
                    const res = await nodeFetch(`${sc.url}/instances.json`);
                    if (res.ok) {
                        const instances = await res.json();
                        if (Array.isArray(instances) && instances.length > 0) return instances;
                    }
                }
            }
        } catch (e) {}

        // 2. Try remote GitHub Pages instances.json
        try {
            const res = await nodeFetch(`${DOCS_BASE}/instances.json`);
            if (res.ok) {
                const instances = await res.json();
                if (Array.isArray(instances) && instances.length > 0) return instances;
            }
        } catch (e) {}

        // 3. No instances available
        return [];
    }

    async getNews(config) {
        if (config.rss) {
            return new Promise((resolve) => {
                nodeFetch(config.rss).then(async res => {
                    if (res.status === 200) {
                        let news = [];
                        let response = await res.text();
                        response = (JSON.parse(convert.xml2json(response, { compact: true })))?.rss?.channel?.item;

                        if (!Array.isArray(response)) response = [response];
                        for (let item of response) {
                            news.push({
                                title: item.title._text,
                                content: item['content:encoded']._text,
                                author: item['dc:creator']._text,
                                publish_date: item.pubDate._text
                            });
                        }
                        return resolve(news);
                    }
                    else return resolve(this.getDefaultNews());
                }).catch(() => resolve(this.getDefaultNews()));
            });
        } else {
            return this.getDefaultNews();
        }
    }

    getDefaultNews() {
        return [
            {
                title: "Actualizacion 1.0",
                content: "¡Bienvenido a Yusup Client! Los modpacks se sirven desde el repositorio.",
                author: "Yusup Client",
                publish_date: new Date().toISOString()
            }
        ];
    }
}

export default new Config;
