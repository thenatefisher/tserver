// Acknowledgments refer to a resource version within one session, not a socket send.
class SessionData {
    constructor(sessionId, map) {
        this.sessionId = sessionId;
        this.actors = new Map();
        this.registrations = new Map();
        this.meshes = new Map();
        this.resources = new Map();
        this.clients = new Map();
        this.set('terrain', map);
        this.set('registrations', {});
        this.set('state', { actors: [], projectiles: [], hitEvents: [] });
    }
    set(key, value, deleted = false) {
        const version = (this.resources.get(key)?.version || 0) + 1;
        this.resources.set(key, { version, value, deleted });
        return version;
    }
    get map() { return this.resources.get('terrain').value; }
    get state() { return this.resources.get('state').value; }
    register(id, descriptor, geometry) {
        this.registrations.set(id, descriptor);
        this.meshes.set(id, geometry);
        this.set(`mesh:${id}`, geometry);
        this.set('registrations', Object.fromEntries(this.registrations));
    }
    removeActor(id) {
        this.actors.delete(id);
        if (this.registrations.delete(id)) {
            this.meshes.delete(id);
            this.set(`mesh:${id}`, null, true);
            this.set('registrations', Object.fromEntries(this.registrations));
        }
    }
    addClient(id, connection = {}) {
        this.clients.set(id, { connection, subscriptions: new Set(['terrain', 'registrations', 'state']), sent: new Map(), acknowledged: new Map(), sentVersions: new Map() });
    }
    subscribe(id, resource) {
        const client = this.clients.get(id);
        if (!client || !this.resources.has(resource)) return false;
        client.subscriptions.add(resource);
        return true;
    }
    sent(id, resource, version) {
        const client = this.clients.get(id);
        if (!client) return;
        client.sent.set(resource, version);
        if (!client.sentVersions.has(resource)) client.sentVersions.set(resource, new Set());
        const versions = client.sentVersions.get(resource);
        versions.add(version);
        if (versions.size > 256) versions.delete(versions.values().next().value);
    }
    acknowledge(id, resource, version) {
        const client = this.clients.get(id);
        if (!client || !Number.isSafeInteger(version) || version < 1) return false;
        if (version === client.acknowledged.get(resource)) return true;
        if (!client.sentVersions.get(resource)?.has(version)) return false;
        client.acknowledged.set(resource, Math.max(version, client.acknowledged.get(resource) || 0));
        return true;
    }
    pending(id, retry = false) {
        const client = this.clients.get(id);
        if (!client) return [];
        return [...client.subscriptions].filter(key => {
            const version = this.resources.get(key)?.version || 0;
            return version > ((retry ? client.acknowledged : client.sent).get(key) || 0);
        });
    }
    manifest(id) {
        const client = this.clients.get(id);
        if (!client) return null;
        return { sessionId: this.sessionId, resources: [...this.resources].map(([resource, entry]) => ({
            resource, version: entry.version, deleted: entry.deleted,
            subscribed: client.subscriptions.has(resource),
            sentVersion: client.sent.get(resource) || 0,
            acknowledgedVersion: client.acknowledged.get(resource) || 0,
            needsUpdate: entry.version > (client.acknowledged.get(resource) || 0)
        })) };
    }
    clear() {
        for (const store of [this.actors, this.registrations, this.meshes, this.resources, this.clients]) store.clear();
    }
}
module.exports = { SessionData };
