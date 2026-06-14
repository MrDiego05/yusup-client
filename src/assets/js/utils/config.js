/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const nodeFetch = require("node-fetch");
const convert = require('xml-js');
const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

class Config {
    async getRemoteBaseUrl() {
        try {
            return await ipcRenderer.invoke('get-remote-url');
        } catch (e) {}
        return 'https://mrdiego05.github.io/yusup-client';
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

        try {
            const remoteUrl = await this.getRemoteBaseUrl();
            const res = await nodeFetch(`${remoteUrl}/config.json`);
            if (res.ok) {
                const remote = await res.json();
                return { ...defaults, ...remote };
            }
        } catch (e) {
            // fallback to hardcoded defaults
        }
        return defaults;
    }

    async getInstanceList() {
        try {
            const userDataPath = await ipcRenderer.invoke('path-user-data');
            const serverConfigPath = path.join(userDataPath, 'creator-server.json');
            if (fs.existsSync(serverConfigPath)) {
                try {
                    const serverConfig = JSON.parse(fs.readFileSync(serverConfigPath, 'utf8'));
                    if (serverConfig.url) {
                        const instances = await nodeFetch(`${serverConfig.url}/instances.json`).then(r => r.json());
                        if (Array.isArray(instances) && instances.length > 0) return instances;
                    }
                } catch (e) {}
            }

            const remoteUrl = await this.getRemoteBaseUrl();
            const res = await nodeFetch(`${remoteUrl}/instances.json`);
            if (res.ok) {
                const instances = await res.json();
                return Array.isArray(instances) ? instances : [];
            }
        } catch (e) {}
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
            return resolve(this.getDefaultNews());
        }
    }

    getDefaultNews() {
        return [
            {
                title: "Actualizacion 1.0",
                content: "¡Bienvenido a Yusup Client! Los modpacks se sirven desde el servidor del Creator.",
                author: "Yusup Client",
                publish_date: new Date().toISOString()
            }
        ];
    }
}

export default new Config;