/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const pkg = require('../package.json');
const nodeFetch = require("node-fetch");
const convert = require('xml-js');
let url = pkg.url ? (pkg.user ? `${pkg.url}/${pkg.user}` : pkg.url) : '';

// Si es un alojamiento estático (ej. GitHub Pages), añadimos la extensión .json
const isStatic = url ? (url.includes('github.io') || url.includes('raw.githubusercontent.com') || url.includes('githack')) : false;

let config = isStatic ? `${url}/config.json` : `${url}/config`;
let articles = isStatic ? `${url}/articles.json` : `${url}/articles`;

class Config {
    GetConfig() {
        return new Promise((resolve) => {
            if (!url) {
                return resolve(this.getDefaultConfig());
            }
            nodeFetch(config).then(async res => {
                if (res.status === 200) {
                    return resolve(res.json());
                } else {
                    return resolve(this.getDefaultConfig());
                }
            }).catch(() => {
                return resolve(this.getDefaultConfig());
            });
        });
    }

    getDefaultConfig() {
        return {
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
    }

    async getInstanceList() {
        if (!url) {
            return this.getDefaultInstances();
        }
        let urlInstance = isStatic ? `${url}/instances.json` : `${url}/instances`;
        try {
            let instances = await nodeFetch(urlInstance).then(res => res.json()).catch(() => null);
            let instancesList = [];
            if (instances && typeof instances === 'object' && !instances.error) {
                instances = Object.entries(instances);
                for (let [name, data] of instances) {
                    let instance = data;
                    instancesList.push(instance);
                }
            }
            if (instancesList.length === 0) {
                return this.getDefaultInstances();
            }
            return instancesList;
        } catch (e) {
            return this.getDefaultInstances();
        }
    }

    getDefaultInstances() {
        return [
            {
                name: "Modpack-3-Lime",
                title: "Modpack 3",
                status: "operationnel",
                gameVersion: "1.20.1",
                url: "",
                loader: {
                    type: "neoforge",
                    build: "1.20.1-47.1.106",
                    enable: true,
                    loader_type: "neoforge",
                    loader_version: "1.20.1-47.1.106",
                    minecraft_version: "1.20.1"
                },
                verify: true,
                ignored: [],
                themeColor: "lime",
                playTime: "2.20h"
            },
            {
                name: "Modpack-3-Orange",
                title: "Modpack 3",
                status: "operationnel",
                gameVersion: "1.20.1",
                url: "",
                loader: {
                    type: "forge",
                    build: "47.2.0",
                    enable: true,
                    loader_type: "forge",
                    loader_version: "47.2.0",
                    minecraft_version: "1.20.1"
                },
                verify: true,
                ignored: [],
                themeColor: "orange",
                playTime: "2.20h"
            },
            {
                name: "Modpack-3-Emerald",
                title: "Modpack 3",
                status: "operationnel",
                gameVersion: "1.20.1",
                url: "",
                loader: {
                    type: "fabric",
                    build: "0.15.7",
                    enable: true,
                    loader_type: "fabric",
                    loader_version: "0.15.7",
                    minecraft_version: "1.20.1"
                },
                verify: true,
                ignored: [],
                themeColor: "emerald",
                playTime: "2.20h"
            },
            {
                name: "Modpack-3-Green",
                title: "Modpack 3",
                status: "operationnel",
                gameVersion: "1.20.1",
                url: "",
                loader: {
                    type: "vanilla",
                    build: "",
                    enable: false,
                    loader_type: "none",
                    loader_version: "",
                    minecraft_version: "1.20.1"
                },
                verify: true,
                ignored: [],
                themeColor: "green",
                playTime: "2.20h"
            }
        ];
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
            return new Promise((resolve) => {
                if (!url) return resolve(this.getDefaultNews());
                nodeFetch(articles).then(async res => {
                    if (res.status === 200) return resolve(res.json());
                    else return resolve(this.getDefaultNews());
                }).catch(() => {
                    return resolve(this.getDefaultNews());
                });
            });
        }
    }

    getDefaultNews() {
        return [
            {
                title: "Actualizacion 1.0",
                content: "El modpack se ha actualizado y publicado exitosamente en GitHub Pages. ¡A jugar! Nuevos mods optimizados y corrección de bugs añadida en esta versión. Disfruta de la mejor experiencia de juego.",
                author: "Yusup Client",
                publish_date: new Date().toISOString()
            }
        ];
    }
}

export default new Config;