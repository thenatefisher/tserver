const { integrateActor } = require('./integration');
const { normalizeAction } = require('./actions');
const { invariants } = require('../contracts');

function cloneState(state = {}) {
    return {
        actors: Array.isArray(state.actors) ? state.actors.map(actor => ({
            ...actor,
            position: { ...(actor.position || {}) },
            velocity: { ...(actor.velocity || {}) },
            orientation: { ...(actor.orientation || {}) },
            rotationalRates: { ...(actor.rotationalRates || {}) }
        })) : [],
        hitEvents: Array.isArray(state.hitEvents) ? structuredClone(state.hitEvents) : [],
        projectiles: Array.isArray(state.projectiles) ? state.projectiles.map(projectile => ({
            ...projectile,
            position: { ...(projectile.position || {}) },
            velocity: { ...(projectile.velocity || {}) }
        })) : []
    };
}

class PhysicsModel {
    constructor(state = { actors: [], projectiles: [] }, physics = integrateActor, environment = {}) {
        this.state = cloneState(state);
        this.physics = physics;
        this.environment = environment;
    }

    step(actions = {}, dt = 1 / invariants.network.simulationFrequencyHz) {
        this.state.actors = this.state.actors.map(actor => this.physics(
            actor,
            normalizeAction(actions[actor.id]),
            dt,
            { ...(actor.physics || {}), ...(actor.physicsProfile || {}), ...this.environment }
        ));
        return cloneState(this.state);
    }

    addActor(actor) {
        this.state.actors = this.state.actors.filter(existing => existing.id !== actor.id);
        this.state.actors.push(cloneState({ actors: [actor] }).actors[0]);
    }

    removeActor(id) {
        this.state.actors = this.state.actors.filter(actor => actor.id !== id);
    }

    getState() {
        return cloneState(this.state);
    }
}

module.exports = { PhysicsModel, cloneState };
