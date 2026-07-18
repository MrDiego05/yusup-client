/**
 * SocialClient — Cliente para el Social Server
 * Maneja registro, presencia, amigos y badges.
 */

const fetch = require('node-fetch');

class SocialClient {
    constructor() {
        this.serverUrl = '';
        this.user = null;
        this._heartbeatInterval = null;
        this._onPresenceChange = null;
    }

    setServerUrl(url) {
        this.serverUrl = url.replace(/\/+$/, '');
    }

    get headers() {
        const h = { 'Content-Type': 'application/json' };
        if (this.user?.xbox_id) h['X-Xbox-Id'] = this.user.xbox_id;
        return h;
    }

    async _fetch(path, options = {}) {
        if (!this.serverUrl) throw new Error('Social server no configurado');
        const url = `${this.serverUrl}${path}`;
        try {
            const res = await fetch(url, {
                ...options,
                headers: { ...this.headers, ...options.headers },
            });
            return await res.json();
        } catch (e) {
            console.warn(`SocialClient: Error en ${path}:`, e.message);
            return null;
        }
    }

    // ── Registro ──

    async register(xboxId, minecraftName) {
        const data = await this._fetch('/api/social/register', {
            method: 'POST',
            body: JSON.stringify({ xbox_id: xboxId, minecraft_name: minecraftName }),
        });
        if (data && data.id) {
            this.user = data;
            this.user.xbox_id = xboxId;
            return data;
        }
        return null;
    }

    // ── Presencia ──

    async updatePresence(isOnline, currentInstance = null) {
        return this._fetch('/api/social/presence', {
            method: 'POST',
            body: JSON.stringify({ is_online: isOnline, current_instance: currentInstance }),
        });
    }

    startHeartbeat(intervalMs = 30000) {
        this.stopHeartbeat();
        this._heartbeatInterval = setInterval(() => {
            this.updatePresence(true, this._currentInstance).catch(() => {});
        }, intervalMs);
    }

    stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    setCurrentInstance(instance) {
        this._currentInstance = instance;
    }

    // ── Usuarios ──

    async getOnlineUsers() {
        const data = await this._fetch('/api/social/users/online');
        return data?.users || [];
    }

    async searchUsers(query) {
        const data = await this._fetch(`/api/social/users/search?q=${encodeURIComponent(query)}`);
        return data?.users || [];
    }

    async getUser(userId) {
        return this._fetch(`/api/social/users/${userId}`);
    }

    async getMe() {
        const data = await this._fetch('/api/social/me');
        if (data && data.id) this.user = data;
        return data;
    }

    // ── Amigos ──

    async getFriends(userId) {
        const data = await this._fetch(`/api/social/friends/${userId}`);
        return data?.friends || [];
    }

    async sendFriendRequest(friendName) {
        return this._fetch('/api/social/friends/request', {
            method: 'POST',
            body: JSON.stringify({ friend_name: friendName }),
        });
    }

    async acceptFriendRequest(requestId) {
        return this._fetch('/api/social/friends/accept', {
            method: 'POST',
            body: JSON.stringify({ request_id: requestId }),
        });
    }

    async rejectFriendRequest(requestId) {
        return this._fetch('/api/social/friends/reject', {
            method: 'POST',
            body: JSON.stringify({ request_id: requestId }),
        });
    }

    async removeFriend(friendId) {
        return this._fetch('/api/social/friends/remove', {
            method: 'POST',
            body: JSON.stringify({ friend_id: friendId }),
        });
    }

    async getFriendRequests(userId) {
        const data = await this._fetch(`/api/social/friends/requests/${userId}`);
        return data?.requests || [];
    }

    // ── Badges ──

    async getBadges() {
        const data = await this._fetch('/api/social/badges');
        return data?.badges || [];
    }

    async createBadge(name, icon, color) {
        return this._fetch('/api/social/badges', {
            method: 'POST',
            body: JSON.stringify({ name, icon, color }),
        });
    }

    async deleteBadge(badgeId) {
        return this._fetch(`/api/social/badges/${badgeId}`, { method: 'DELETE' });
    }

    async assignBadge(userId, badgeId) {
        return this._fetch(`/api/social/users/${userId}/badge`, {
            method: 'PUT',
            body: JSON.stringify({ badge_id: badgeId }),
        });
    }

    // ── Admin ──

    async verifyAdmin() {
        const data = await this._fetch('/api/social/admin/verify');
        return data?.is_admin || false;
    }
}

export default SocialClient;
