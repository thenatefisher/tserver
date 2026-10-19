/**
 * Own and advance authoritative solid actor state for one game session.
 * Inputs: Initial state, injectable integrator, environment, actions and timestep.
 * Outputs: Cloned full model snapshots with private immutable body references.
 * Side effects: Mutates only instance state; integrates synchronized substeps and resolves solid pairs.
 * Coupling: integration, collisions and contracts; sessions project private model state to public snapshots.
 */
const { integrateActor } = require('./integration');
const { normalizeAction } = require('./actions');
const { resolveActorContacts } = require('./collisions');
const { invariants } = require('../contracts');

/** Copy mutable state vectors/arrays while safely sharing immutable collision bodies. */
function cloneState(state = {}) {
    return {
        actors: Array.isArray(state.actors) ? state.actors.map(actor => ({
            ...actor,
            position: { ...(actor.position || {}) },
            velocity: { ...(actor.velocity || {}) },
            ...(actor.centerVelocity ? { centerVelocity: { ...actor.centerVelocity } } : {}),
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
    /** Copy initial moving state and retain the injected integrator/environment; no timers start here. */
    constructor(state = { actors: [], projectiles: [] }, physics = integrateActor, environment = {}) {
        this.state = cloneState(state);
        this.physics = physics;
        this.environment = environment;
    }

    /** Advance all actors through synchronized substeps and solid contacts; return a cloned snapshot. */
    step(actions = {}, dt = 1 / invariants.network.simulationFrequencyHz) {
        if (!Number.isFinite(dt) || dt <= 0) throw new Error('Physics dt must be positive and finite');
        // Use a shared step for all actors so mesh collisions cannot be skipped
        // merely because individual actors were advanced to different times.
        const steps = Math.min(128, Math.max(Math.ceil(dt * 120), ...this.state.actors.map(actor => {
            const size = actor.body ? Math.min(...['x', 'y', 'z'].map(axis => actor.body.bounds.max[axis] - actor.body.bounds.min[axis])) : 1;
            const v = actor.centerVelocity || actor.velocity || {};
            return Math.ceil(Math.hypot(v.x || 0, v.y || 0, v.z || 0) * dt / Math.max(0.02, size / 4));
        })));
        for (let step = 0; step < steps; step++) {
            this.state.actors = this.state.actors.map(actor => this.physics(
                actor, normalizeAction(actions[actor.id]), dt / steps,
                { ...(actor.physics || {}), ...(actor.physicsProfile || {}), ...this.environment }
            ));
            resolveActorContacts(this.state.actors, this.environment);
        }
        return cloneState(this.state);
    }

    /** Replace any matching model actor with a copied state, sharing immutable collision geometry. */
    addActor(actor) {
        this.state.actors = this.state.actors.filter(existing => existing.id !== actor.id);
        this.state.actors.push(cloneState({ actors: [actor] }).actors[0]);
    }

    /** Delete the actor from the owned store/model; other instances are unaffected. */
    removeActor(id) {
        this.state.actors = this.state.actors.filter(actor => actor.id !== id);
    }

    /** Return a state copy so callers cannot mutate internal motion vectors. */
    getState() {
        return cloneState(this.state);
    }
}

module.exports = { PhysicsModel, cloneState };
