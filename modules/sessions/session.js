const { EventEmitter } = require('node:events');
const { SessionData } = require('./data-store');
const { PhysicsModel } = require('../physics');
const { ActorManager } = require('../actors/manager');
const { validate, invariants } = require('../contracts');
const { createMap, validateMap, sampleTerrainHeight, resetTargets } = require('../terrain');

class GameSession extends EventEmitter {
    constructor({ id, name = id, map = createMap(), tickRate = invariants.network.simulationFrequencyHz, environment = {}, physicsFactory = options => new PhysicsModel(undefined, undefined, options) }) {
        super();
        if (!Number.isFinite(tickRate) || tickRate <= 0) throw new Error('Invalid tick rate');
        this.id = id; this.name = name; this.tickRate = tickRate; this.startedAt = Date.now();
        validateMap(map);
        this.data = new SessionData(id, map);
        this.hitEvents = [];
        this.physics = physicsFactory({
            gravity: invariants.input.standardGravityMetersPerSecondSquared, groundFriction: 6, angularFriction: 0.3,
            ...environment, bounds: map.bounds,
            groundHeight: position => sampleTerrainHeight(this.data.map.terrain, position.x, position.z)
        });
        this.actors = new ActorManager(this.data, this.physics);
        this.timers = [];
    }
    description() { return { id: this.id, name: this.name, actorCount: this.data.actors.size, clientCount: [...this.data.clients.values()].filter(c => !c.connection.admin).length, tickRate: this.tickRate }; }
    snapshot() {
        const state = this.physics.getState();
        const publicState = {
            actors: state.actors.map(({ id, name, health, position, velocity, orientation, rotationalRates }) => ({ id, name, health, position, velocity, orientation, rotationalRates })),
            projectiles: state.projectiles,
            hitEvents: this.hitEvents.splice(0)
        };
        validate('state', publicState);
        this.data.set('state', publicState);
        return publicState;
    }
    tick() {
        const actions = Object.fromEntries([...this.data.actors].map(([id, actor]) => [id, actor.action]));
        const state = this.physics.step(actions, 1 / this.tickRate);
        for (const moved of state.actors) {
            const actor = this.data.actors.get(moved.id);
            if (actor) for (const field of ['position', 'velocity', 'orientation', 'rotationalRates']) actor[field] = moved[field];
        }
        this.emit('tick');
    }
    resetTargets() {
        resetTargets(this.data.map);
        this.data.set('terrain', this.data.map);
        this.emit('data_changed');
    }
    queueHit(event) { validate('state', { actors: [], projectiles: [], hitEvents: [event] }); this.hitEvents.push(structuredClone(event)); }
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
    start() {
        if (this.timers.length) return;
        this.timers.push(setInterval(() => this.tick(), 1000 / this.tickRate));
        this.timers.push(setInterval(() => { this.snapshot(); this.emit('state'); }, 1000 / invariants.network.stateBroadcastFrequencyHz));
        this.timers.push(setInterval(() => this.emit('metrics'), 1000));
    }
    stop() { this.timers.forEach(clearInterval); this.timers = []; }
    close() { this.stop(); this.removeAllListeners(); this.actors.bans.clear(); this.data.clear(); this.physics.state = { actors: [], projectiles: [], hitEvents: [] }; }
}
module.exports = { GameSession };
