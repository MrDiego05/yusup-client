/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { ipcRenderer } = require('electron')
const { Status } = require('minecraft-java-core')
const fs = require('fs');
const pkg = require('../package.json');

import config from './utils/config.js';
import database from './utils/database.js';
import logger from './utils/logger.js';
import popup from './utils/popup.js';
import { skin2D } from './utils/skin.js';
import slider from './utils/slider.js';
import ModpackSync from './utils/modpackSync.js';
import NeoForgeSync from './utils/neoforgeSync.js';
import SocialClient from './utils/socialClient.js';
import zipHandler from './utils/zipHandler.js';

async function setBackground(theme) {
    if (typeof theme == 'undefined') {
        let databaseLauncher = new database();
        let configClient = await databaseLauncher.readData('configClient');
        theme = configClient?.launcher_config?.theme || "auto"
        theme = await ipcRenderer.invoke('is-dark-theme', theme).then(res => res)
    }
    let body = document.body;
    body.className = theme ? 'dark global' : 'light global';
}

async function changePanel(id) {
    let panel = document.querySelector(`.panel.${id}`);
    let active = document.querySelector(`.panel.active`);
    if (active) active.classList.remove("active");
    if (panel) panel.classList.add("active");
}

const socialClient = new SocialClient();

async function appdata() {
    return await ipcRenderer.invoke('appData').then(path => path)
}

function _generateAvatarSVG(seed) {
    if (!seed) seed = Math.random().toString();
    let hash = 0;
    for (let i = 0; i < String(seed).length; i++) {
        hash = String(seed).charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    const sat = 50 + (Math.abs(hash * 7) % 30);
    const lit = 40 + (Math.abs(hash * 13) % 30);
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="hsl(${hue},${sat}%,${lit}%)" rx="8"/><rect x="16" y="8" width="8" height="8" fill="rgba(0,0,0,0.15)" rx="2"/><rect x="40" y="8" width="8" height="8" fill="rgba(0,0,0,0.15)" rx="2"/><rect x="24" y="28" width="16" height="16" fill="rgba(0,0,0,0.1)" rx="4"/><rect x="16" y="44" width="32" height="8" fill="rgba(0,0,0,0.1)" rx="2"/></svg>`)}`;
}

async function addAccount(data) {
    let skin = null;
    if (data?.profile?.skins[0]?.base64) {
        try { skin = await new skin2D().creatHeadTexture(data.profile.skins[0].base64); } catch (e) {}
    }
    const initial = data?.name ? data.name.charAt(0).toUpperCase() : '?';
    const hasSkin = !!skin;
    let div = document.createElement("div");
    div.classList.add("account");
    div.id = data.ID;
    div.innerHTML = `
        <div class="profile-image" style="${hasSkin ? `background-image: url(${skin}); background-size: cover; background-position: center;` : 'background:linear-gradient(135deg,#192E03,#D8F999);display:flex;align-items:center;justify-content:center;'}">${hasSkin ? '' : `<span style="color:#fff;font-size:24px;font-weight:700;">${initial}</span>`}</div>
        <div class="profile-infos">
            <div class="profile-pseudo">${data.name}</div>
            <div class="profile-uuid">${data.uuid}</div>
        </div>
        <div class="delete-profile" id="${data.ID}">
            <div class="icon-account-delete delete-profile-icon"></div>
        </div>
    `
    // Try all possible account list containers (legacy & new UI)
    let container = document.querySelector('.accounts-list')
        || document.getElementById('accounts-buttons-container')
        || document.getElementById('account-selection-container');
    if (container) {
        let existing = document.getElementById(data.ID);
        if (existing) existing.remove();
        container.appendChild(div);
    }
}

async function accountSelect(data) {
    if (!data) return;
    
    let accountData = data;
    if (typeof data === 'string' || typeof data === 'number') {
        let db = new database();
        accountData = await db.readData('accounts', data);
        if (!accountData) return;
    }

    let accountElement = document.getElementById(`${accountData.ID}`);
    let activeAccount = document.querySelector('.account-select')

    if (activeAccount) activeAccount.classList.remove('account-select');
    if (accountElement) accountElement.classList.add('account-select');
    
    // Update player head elements
    const playerHeadEl = document.querySelector(".player-head") || document.querySelector(".player-head-nav");
    const targets = [playerHeadEl].filter(Boolean);
    if (accountData?.profile?.skins && accountData.profile.skins[0] && accountData.profile.skins[0].base64) {
        targets.forEach(el => headplayer(accountData.profile.skins[0].base64, el));
    } else {
        const initial = accountData?.name ? accountData.name.charAt(0).toUpperCase() : '?';
        targets.forEach(el => {
            el.style.background = 'linear-gradient(135deg,#192E03,#D8F999)';
            el.style.backgroundImage = 'none';
            el.style.display = 'flex';
            el.style.alignItems = 'center';
            el.style.justifyContent = 'center';
            el.innerHTML = `<span style="color:#fff;font-size:18px;font-weight:700;">${initial}</span>`;
        });
    }
}

async function headplayer(skinBase64, targetEl) {
    let skin = await new skin2D().creatHeadTexture(skinBase64);
    let el = targetEl || document.querySelector(".player-head") || document.querySelector(".player-head-nav");
    if (el) el.style.backgroundImage = `url(${skin})`;
}

async function setStatus(opt) {
    let nameServerElement = document.querySelector('.server-status-name')
    let statusServerElement = document.querySelector('.server-status-text')
    let playersOnline = document.querySelector('.status-player-count .player-count')

    if (!opt) {
        statusServerElement.classList.add('red')
        statusServerElement.innerHTML = `Ferme - 0 ms`
        document.querySelector('.status-player-count').classList.add('red')
        playersOnline.innerHTML = '0'
        return
    }

    let { ip, port, nameServer } = opt
    nameServerElement.innerHTML = nameServer
    let status = new Status(ip, port);
    let statusServer = await status.getStatus().then(res => res).catch(err => err);

    if (!statusServer.error) {
        statusServerElement.classList.remove('red')
        document.querySelector('.status-player-count').classList.remove('red')
        statusServerElement.innerHTML = `En ligne - ${statusServer.ms ? statusServer.ms : 0} ms`
        playersOnline.innerHTML = statusServer.playersConnect ? statusServer.playersConnect : '0'
    } else {
        statusServerElement.classList.add('red')
        statusServerElement.innerHTML = `Ferme - 0 ms`
        document.querySelector('.status-player-count').classList.add('red')
        playersOnline.innerHTML = '0'
    }
}


export {
    appdata as appdata,
    changePanel as changePanel,
    config as config,
    database as database,
    logger as logger,
    popup as popup,
    setBackground as setBackground,
    skin2D as skin2D,
    addAccount as addAccount,
    accountSelect as accountSelect,
    slider as Slider,
    pkg as pkg,
    setStatus as setStatus,
    ModpackSync as ModpackSync,
    socialClient as socialClient,
    zipHandler as zipHandler
}