/**
 * Own one game session, immutable terrain model, physics instance and publication timers.
 * Inputs: Session configuration, optional initial world, environment and physics factory.
 * Outputs: Public snapshots, metrics, session summaries and lifecycle/update events.
 * Side effects: Generates/clones terrain, advances physics, mirrors actor motion and versions public resources.
 * Coupling: TerrainModel, PhysicsModel, ActorManager and SessionData are session-local collaborators.
 */
const { EventEmitter } = require('node:events');
const { SessionData } = require('./data-store');
const { PhysicsModel, normalizeAction } = require('../physics');
const { TerrainModel } = require('../terrain/model');
const { ActorManager } = require('../actors/manager');
const { validate, invariants } = require('../contracts');
const { createMap, validateMap, resetTargets } = require('../terrain');

class GameSession extends EventEmitter {
    /** Generate or clone a session terrain, build its physics/data/actor owners and leave timers stopped. */
    constructor({ id, name = id, map = createMap(), tickRate = invariants.network.simulationFrequencyHz, environment = {}, physicsFactory = options => new PhysicsModel(undefined, undefined, options) }) {
        super();
        if (!Number.isFinite(tickRate) || tickRate <= 0) throw new Error('Invalid tick rate');
        this.id = id; this.name = name; this.tickRate = tickRate; this.startedAt = Date.now();
        validateMap(map);
        Object.defineProperty(this, 'terrain', { value: new TerrainModel(map.terrain), enumerable: true, configurable: true });
        this.data = new SessionData(id, { ...structuredClone(map), terrain: this.terrain.grid });
        this.hitEvents = [];
        this.physics = physicsFactory({
            gravity: invariants.input.standardGravityMetersPerSecondSquared, density: invariants.physics.density,
            ...environment, bounds: map.bounds, terrain: this.terrain
        });
        this.actors = new ActorManager(this.data, this.physics, { density: environment.density ?? invariants.physics.density, terrain: this.terrain });
        this.timers = [];
    }
    /** Return public identity and connection/actor counts for discovery. */
    description() { return { id: this.id, name: this.name, actorCount: this.data.actors.size, clientCount: [...this.data.clients.values()].filter(c => !c.connection.admin).length, tickRate: this.tickRate }; }
    /** Validate/publish a public state resource and drain queued transient hit events. */
    snapshot() {
        const state = this.physics.getState();
        const publicState = {
            actors: state.actors.map(({ id, name, health, position, velocity, orientation, rotationalRates, grounded = false, lastInputSequence = -1 }) => ({ id, name, health, position, velocity, orientation, rotationalRates, grounded, lastInputSequence })),
            projectiles: state.projectiles,
            hitEvents: this.hitEvents.splice(0)
        };
        validate('state', publicState);
        this.data.set('state', publicState);
        return publicState;
    }
    /** Advance session physics and mirror its motion/contact fields into actor records. */
    tick() {
        const actions = Object.fromEntries([...this.data.actors].map(([id, actor]) => [id, actor.action]));
        const state = this.physics.step(actions, 1 / this.tickRate);
        for (const moved of state.actors) {
            const actor = this.data.actors.get(moved.id);
            if (actor) for (const field of ['position', 'velocity', 'orientation', 'rotationalRates', 'centerVelocity', 'grounded', 'lastInputSequence']) actor[field] = moved[field];
        }
        this.emit('tick');
    }
    /** Replace practice targets and republish the world wrapper; the terrain grid/model stays identical. */
    resetTargets() {
        resetTargets(this.data.map);
        this.data.set('terrain', this.data.map);
        this.emit('data_changed');
    }
    /** Remove practice targets from this session and publish an updated world resource. */
    removeTargets() {
        const removed = this.data.map.targets?.length || 0;
        this.data.map.targets = [];
        const version = this.data.set('terrain', this.data.map);
        this.emit('data_changed');
        return { sessionId: this.id, removed, version };
    }
    /** Enable terrain-only collision diagnostics without removing actors, assets or registrations. */
    disableObjectCollisions() {
        const affectedColliders = this.physics.disableObjectCollisions();
        return { sessionId: this.id, terrainOnlyCollisions: true, affectedColliders };
    }
    /** Flatten this session to world Y=0, republish terrain/state and settle actors without reconnecting clients. */
    flattenTerrain() {
        const map = structuredClone(this.data.map);
        map.terrain.depthMap.fill(0);
        delete map.terrain.noDataValue; // Flattening fills former holes with valid zero-elevation terrain.
        for (const target of map.targets || []) target.y = 2;
        validateMap(map);
        const terrain = new TerrainModel(map.terrain);
        const sequences = Object.fromEntries([...this.data.actors].map(([id, actor]) => [id, actor.action.sequence]));
        const state = this.physics.flattenTerrain(terrain, sequences);
        Object.defineProperty(this, 'terrain', { value: terrain });
        this.actors.terrain = terrain;
        map.terrain = terrain.grid;
        const version = this.data.replaceTerrain(map);
        for (const moved of state.actors) {
            const actor = this.data.actors.get(moved.id);
            Object.assign(actor, moved, { action: normalizeAction({ sequence: sequences[moved.id] }) });
        }
        this.snapshot(); this.emit('data_changed');
        return { sessionId: this.id, elevation: 0, version };
    }
    /** Validate and copy a hit into the pending transient event queue. */
    queueHit(event) { validate('state', { actors: [], projectiles: [], hitEvents: [event] }); this.hitEvents.push(structuredClone(event)); }
    /** Build session/client telemetry without mutating simulation state. */
    metrics(transport = () => undefined) {
        return {
            sessionId: this.id, uptime: (Date.now() - this.startedAt) / 1000,
            actorCount: [...this.data.clients.values()].filter(c => !c.connection.admin).length, tickRate: this.tickRate, totalFires: 0, totalJumps: 0,
            clients: [...this.data.clients].filter(([, c]) => !c.connection.admin).map(([id, c]) => {
                const actor = this.data.actors.get(id) || { id, name: 'Unregistered', clientType: 'unregistered', connectedAt: c.connection.connectedAt, health: 100, maxHealth: 100, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
                const mesh = this.data.meshes.get(actor.id);
                return {
                    id: actor.id, name: actor.name, clientType: actor.clientType, connectedAt: actor.connectedAt,
                    registered: Boolean(mesh), transport: transport(actor.id), health: actor.health, maxHealth: actor.maxHealth,
                    position: actor.position, velocity: actor.velocity, meshBytes: mesh?.buffer.length || 0, triangles: mesh?.triangles || 0
                };
            })
        };
    }
    /** Start this instance’s listener/timers if not already active; returns or resolves its runtime. */
    start() {
        if (this.timers.length) return;
        this.timers.push(setInterval(() => this.tick(), 1000 / this.tickRate));
        this.timers.push(setInterval(() => { this.snapshot(); this.emit('state'); }, 1000 / invariants.network.stateBroadcastFrequencyHz));
        this.timers.push(setInterval(() => this.emit('metrics'), 1000));
    }
    /** Clear this session’s timers without disposing its stored game data. */
    stop() { this.timers.forEach(clearInterval); this.timers = []; }
    /** Release owned listeners, sockets, timers and session state; does not delete external files. */
    close() { this.stop(); this.removeAllListeners(); this.actors.bans.clear(); this.data.clear(); this.physics.close(); }
}
module.exports = { GameSession };
