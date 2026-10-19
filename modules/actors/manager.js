const { decodeGlb, validateGlb } = require('./glb');
const { validateMeshMetadata } = require('./validation');
const { HITBOX_SIZE, MAX_VISUAL_SIZE, DEFAULT_HEALTH } = require('./constants');
const { validate, orientationOrder } = require('../contracts');
const { mergeAction } = require('../physics/actions');
const { sampleTerrainHeight } = require('../terrain');

class ActorManager {
    constructor(data, physics) {
        this.data = data;
        this.physics = physics;
        this.bans = new Set();
    }
    isBanned(address) { return this.bans.has(address); }
    create(id, address) {
        if (this.isBanned(address)) throw new Error('Client is banned from this session');
        const x = (Math.random() - 0.5) * 40, z = (Math.random() - 0.5) * 40;
        const actor = {
            id, address, connectedAt: Date.now(), name: `NodeActor_${id.slice(0, 4)}`, clientType: 'standard-node',
            position: { x, y: sampleTerrainHeight(this.data.map.terrain, x, z), z },
            velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, order: orientationOrder }, rotationalRates: { x: 0, y: 0, z: 0 },
            health: DEFAULT_HEALTH, maxHealth: DEFAULT_HEALTH, physicsProfile: {}, action: {}
        };
        this.data.actors.set(id, actor);
        this.physics.addActor(actor);
        return actor;
    }
    attach(id, address, registration) {
        const actor = this.create(id, address);
        actor.name = registration.descriptor.name;
        actor.clientType = registration.descriptor.clientType;
        actor.physicsProfile = { ...registration.physicsProfile };
        this.physics.addActor(actor);
        this.data.register(id, structuredClone(registration.descriptor), {
            ...registration.geometry, buffer: Buffer.from(registration.geometry.buffer)
        });
        return actor;
    }
    register(id, input) {
        const actor = this.data.actors.get(id);
        if (!actor) throw new Error('Player actor does not exist');
        validate('actor', input);
        // Validate before mutating the actor or publishing a new version.
        const buffer = decodeGlb(input.mesh.glb);
        const info = validateGlb(buffer);
        const metadata = validateMeshMetadata(input.mesh.metadata);
        for (const axis of ['x', 'y', 'z']) {
            const actualSize = info.bounds.max[axis] - info.bounds.min[axis];
            if (actualSize > MAX_VISUAL_SIZE[axis] || Math.abs(actualSize - metadata.visualSize[axis]) > 0.01) throw new Error('Declared visualSize does not match transformed GLB');
        }
        actor.name = input.name;
        actor.clientType = input.clientType;
        actor.physicsProfile = { ...input.physicsProfile };
        this.physics.addActor(actor);
        const descriptor = { id, name: actor.name, clientType: actor.clientType, triangles: info.triangles, hitbox: { ...HITBOX_SIZE }, metadata };
        this.data.register(id, descriptor, { id, buffer, metadata, triangles: info.triangles, hitbox: { ...HITBOX_SIZE } });
        return descriptor;
    }
    action(id, input) {
        validate('actions', input);
        const actor = this.data.actors.get(id);
        if (actor) actor.action = mergeAction(actor.action, input);
    }
    remove(id) {
        if (!this.data.actors.has(id)) return false;
        this.physics.removeActor(id);
        this.data.removeActor(id);
        return true;
    }
    kick(id, disconnect) {
        if (!this.data.actors.has(id) && !this.data.clients.has(id)) return false;
        this.remove(id);
        disconnect(id);
        return true;
    }
    ban(id, disconnect) {
        const address = this.data.actors.get(id)?.address || this.data.clients.get(id)?.connection.address;
        if (!address) return null;
        this.bans.add(address);
        const ids = new Set([
            ...[...this.data.actors.values()].filter(actor => actor.address === address).map(actor => actor.id),
            ...[...this.data.clients].filter(([, client]) => !client.connection.admin && client.connection.address === address).map(([clientId]) => clientId)
        ]);
        for (const clientId of ids) this.kick(clientId, disconnect);
        return address;
    }
    unban(address) { return this.bans.delete(address); }
}
module.exports = { ActorManager };
