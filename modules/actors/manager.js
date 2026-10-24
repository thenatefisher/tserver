/**
 * Manage session actor registration, private solid shapes, actions and moderation.
 * Inputs: Session data, physics model, uniform density, terrain and validated network requests.
 * Outputs: Actor records, public registration descriptors and moderation results.
 * Side effects: Mutates actor/model/resource stores; kick and ban call a supplied disconnect callback.
 * Coupling: contracts and GLB validation guard inputs; physics/body and contacts place solids.
 */
const { decodeGlb, validateGlb } = require('./glb');
const { validateMeshMetadata } = require('./validation');
const { HITBOX_SIZE, MAX_VISUAL_SIZE, DEFAULT_HEALTH } = require('./constants');
const { validate, orientationOrder, invariants } = require('../contracts');
const { normalizeAction } = require('../physics/actions');
const { createSolidBody } = require('../physics/body');
const { terrainContact } = require('../physics/contacts');

class ActorManager {
    /** Retain session-owned stores/model and the shared terrain/density policy; allocates the session ban set. */
    constructor(data, physics, { density = invariants.physics.density, terrain } = {}) {
        this.data = data;
        this.physics = physics;
        this.density = density; this.terrain = terrain;
        this.bans = new Set();
    }
    /** Return whether the session currently bans the observed network address. */
    isBanned(address) { return this.bans.has(address); }
    /** Allocate and add a session actor to the data store and physics model; reject banned addresses. */
    create(id, address) {
        if (this.isBanned(address)) throw new Error('Client is banned from this session');
        const x = (Math.random() - 0.5) * 40, z = (Math.random() - 0.5) * 40;
        const height = this.terrain.heightAt(x, z);
        const actor = {
            id, address, connectedAt: Date.now(), name: `NodeActor_${id.slice(0, 4)}`, clientType: 'standard-node',
            position: { x, y: Number.isFinite(height) ? height : 0, z },
            velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, order: orientationOrder }, rotationalRates: { x: 0, y: 0, z: 0 },
            health: DEFAULT_HEALTH, maxHealth: DEFAULT_HEALTH, physicsProfile: {}, action: normalizeAction()
        };
        this.data.actors.set(id, actor);
        this.physics.addActor(actor);
        return actor;
    }
    /** Create a fresh session actor from an accepted registration and rebuild its density-specific solid. */
    attach(id, address, registration) {
        const actor = this.create(id, address);
        actor.name = registration.descriptor.name;
        actor.clientType = registration.descriptor.clientType;
        actor.physicsProfile = { ...registration.physicsProfile };
        actor.projectileOrigins = structuredClone(registration.descriptor.metadata.projectileOrigins);
        actor.body = createSolidBody(registration.body, this.density);
        this.place(actor);
        this.physics.addActor(actor);
        this.data.register(id, structuredClone(registration.descriptor), {
            ...registration.geometry, buffer: Buffer.from(registration.geometry.buffer)
        });
        return actor;
    }
    /** Raise a working actor above terrain using its actual mesh contacts; leaves clear airborne poses alone. */
    place(actor) {
        const contact = terrainContact(actor, { terrain: this.terrain });
        if (Number.isFinite(contact.height)) actor.position.y = Math.max(actor.position.y, contact.height);
    }
    /** Validate a registration without changing session actors, physics or resources. */
    prepare(input) {
        validate('actor', input);
        // Validate before mutating the actor or publishing a new version.
        const buffer = decodeGlb(input.mesh.glb);
        const info = validateGlb(buffer);
        const metadata = validateMeshMetadata(input.mesh.metadata);
        for (const axis of ['x', 'y', 'z']) {
            const actualSize = info.bounds.max[axis] - info.bounds.min[axis];
            if (actualSize > MAX_VISUAL_SIZE[axis] || Math.abs(actualSize - metadata.visualSize[axis]) > 0.01) throw new Error('Declared visualSize does not match transformed GLB');
        }
        const body = createSolidBody(info, this.density);
        return { buffer, info, metadata, body };
    }
    /** Validate an actor package/solid atomically, update its model and publish registration/GLB versions. */
    register(id, input) {
        const actor = this.data.actors.get(id);
        if (!actor) throw new Error('Player actor does not exist');
        const { buffer, info, metadata, body } = this.prepare(input);
        const next = { ...actor, projectileOrigins: structuredClone(metadata.projectileOrigins), position: { ...actor.position }, body, name: input.name,
            clientType: input.clientType, physicsProfile: { ...input.physicsProfile },
            action: normalizeAction(), lastInputSequence: -1 };
        this.place(next);
        // Construct the new Rapier collider before committing registration/resource mutations.
        this.physics.addActor(next);
        Object.assign(actor, next);
        const descriptor = { id, physicsProfile: { ...actor.physicsProfile }, name: actor.name, clientType: actor.clientType, triangles: info.triangles, hitbox: { ...HITBOX_SIZE }, metadata };
        this.data.register(id, descriptor, { id, buffer, metadata, triangles: info.triangles, hitbox: { ...HITBOX_SIZE } });
        return descriptor;
    }
    /** Validate and replace a complete control frame into the session actor; invalid commands leave it unchanged. */
    action(id, input) {
        validate('actions', input);
        const actor = this.data.actors.get(id);
        if (actor) {
            if (input.sequence <= actor.action.sequence) throw new Error('Input sequence must increase; v2 complete control frame required');
            actor.action = normalizeAction(input);
        }
    }
    /** Remove an actor, model state and cached registration/GLB; publish a mesh tombstone when needed. */
    remove(id) {
        if (!this.data.actors.has(id)) return false;
        this.physics.removeActor(id);
        this.data.removeActor(id);
        return true;
    }
    /** Remove a session actor and call the injected disconnect callback for its connection. */
    kick(id, disconnect) {
        if (!this.data.actors.has(id) && !this.data.clients.has(id)) return false;
        this.remove(id);
        disconnect(id);
        return true;
    }
    /** Record a session address ban and disconnect matching non-admin clients, including pending registrations. */
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
    /** Delete an address ban from this session and return whether one existed. */
    unban(address) { return this.bans.delete(address); }
}
module.exports = { ActorManager };
