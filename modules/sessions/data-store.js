/**
 * Own one session data catalog and per-client delivery/receipt manifests.
 * Inputs: World wrapper, actor registrations/GLBs, snapshots and receipt acknowledgments.
 * Outputs: Versioned resources, pending-resource lists and client synchronization manifests.
 * Side effects: Mutates session Maps, freezes terrain snapshots; ordinary writes reject terrain replacement.
 * Coupling: Distribution reads resources; actors publish registrations; sessions publish state and target updates.
 */
const { deepFreeze } = require('../shared/immutable');
class SessionData {
    /** Initialize resource/receipt Maps and freeze the supplied world’s terrain grid in place. */
    constructor(sessionId, map) {
        this.sessionId = sessionId;
        Object.defineProperty(map, 'terrain', { value: deepFreeze(map.terrain), enumerable: true, writable: false, configurable: false });
        this.actors = new Map();
        this.registrations = new Map();
        this.meshes = new Map();
        this.resources = new Map();
        this.clients = new Map();
        this.set('terrain', map);
        this.set('registrations', {});
        this.set('state', { actors: [], projectiles: [], hitEvents: [] });
    }
    /** Replace a versioned resource, rejecting changes to the session’s frozen terrain grid. */
    set(key, value, deleted = false) {
        if (key === 'terrain' && this.resources.has(key) && value.terrain !== this.map.terrain) throw new Error('Session terrain is immutable');
        if (key === 'terrain') Object.defineProperty(value, 'terrain', { value: deepFreeze(value.terrain), enumerable: true, writable: false, configurable: false });
        const version = (this.resources.get(key)?.version || 0) + 1;
        this.resources.set(key, { version, value, deleted });
        return version;
    }
    /** Publish an explicit admin terrain replacement; caller must validate and replace physics first. */
    replaceTerrain(map) {
        Object.defineProperty(map, 'terrain', { value: deepFreeze(map.terrain), enumerable: true, writable: false, configurable: false });
        const version = this.resources.get('terrain').version + 1;
        this.resources.set('terrain', { version, value: map, deleted: false });
        return version;
    }
    /** Return the live world wrapper; its grid is immutable but target data may be replaced. */
    get map() { return this.resources.get('terrain').value; }
    /** Return the latest public snapshot resource; callers must not edit stored snapshots. */
    get state() { return this.resources.get('state').value; }
    /** Store accepted descriptors/geometry and advance their resource versions; validation is external. */
    register(id, descriptor, geometry) {
        this.registrations.set(id, descriptor);
        this.meshes.set(id, geometry);
        this.set(`mesh:${id}`, geometry);
        this.set('registrations', Object.fromEntries(this.registrations));
    }
    /** Delete catalog records and publish a mesh tombstone; the actor manager removes model state. */
    removeActor(id) {
        this.actors.delete(id);
        if (this.registrations.delete(id)) {
            this.meshes.delete(id);
            this.set(`mesh:${id}`, null, true);
            this.set('registrations', Object.fromEntries(this.registrations));
        }
    }
    /** Initialize subscriptions/receipts and connection metadata for a new session member. */
    addClient(id, connection = {}) {
        this.clients.set(id, { connection, subscriptions: new Set(['terrain', 'registrations', 'state']), sent: new Map(), acknowledged: new Map(), sentVersions: new Map() });
    }
    /** Subscribe an existing client to an available resource; return whether it was accepted. */
    subscribe(id, resource) {
        const client = this.clients.get(id);
        if (!client || !this.resources.has(resource)) return false;
        client.subscriptions.add(resource);
        return true;
    }
    /** Record a delivered version and bounded send history; this is not an acknowledgment. */
    sent(id, resource, version) {
        const client = this.clients.get(id);
        if (!client) return;
        client.sent.set(resource, version);
        if (!client.sentVersions.has(resource)) client.sentVersions.set(resource, new Set());
        const versions = client.sentVersions.get(resource);
        versions.add(version);
        if (versions.size > 256) versions.delete(versions.values().next().value);
    }
    /** Accept only a previously sent version, advancing acknowledged progress monotonically. */
    acknowledge(id, resource, version) {
        const client = this.clients.get(id);
        if (!client || !Number.isSafeInteger(version) || version < 1) return false;
        if (version === client.acknowledged.get(resource)) return true;
        if (!client.sentVersions.get(resource)?.has(version)) return false;
        client.acknowledged.set(resource, Math.max(version, client.acknowledged.get(resource) || 0));
        return true;
    }
    /** Return subscribed resources newer than sent or acknowledged versions according to retry mode. */
    pending(id, retry = false) {
        const client = this.clients.get(id);
        if (!client) return [];
        return [...client.subscriptions].filter(key => {
            const version = this.resources.get(key)?.version || 0;
            return version > ((retry ? client.acknowledged : client.sent).get(key) || 0);
        });
    }
    /** Build a public receipt manifest without including resource payloads or private actor data. */
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
    /** Empty all session-owned catalogs and receipt maps. */
    clear() {
        for (const store of [this.actors, this.registrations, this.meshes, this.resources, this.clients]) store.clear();
    }
}
module.exports = { SessionData };
