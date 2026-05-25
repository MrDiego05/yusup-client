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

async function appdata() {
    return await ipcRenderer.invoke('appData').then(path => path)
}

async function addAccount(data) {
    let skin = false
    if (data?.profile?.skins[0]?.base64) skin = await new skin2D().creatHeadTexture(data.profile.skins[0].base64);
    let div = document.createElement("div");
    div.classList.add("account");
    div.id = data.ID;
    div.innerHTML = `
        <div class="profile-image" ${skin ? 'style="background-image: url(' + skin + ');"' : ''}></div>
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
    
    // Update player head: try both legacy .player-head and new UI .player-head-nav
    const playerHeadEl = document.querySelector(".player-head") || document.querySelector(".player-head-nav");
    if (accountData?.profile?.skins && accountData.profile.skins[0] && accountData.profile.skins[0].base64) {
        if (playerHeadEl) headplayer(accountData.profile.skins[0].base64, playerHeadEl);
    } else {
        if (playerHeadEl) playerHeadEl.style.backgroundImage = `url('assets/images/default/setve.png')`;
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
    NeoForgeSync as NeoForgeSync
}