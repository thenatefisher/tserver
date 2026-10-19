/**
 * Own an isolated Rapier world and authoritative actor state for one game session.
 * Inputs: Initial state, environment, v2 control frames and positive elapsed seconds.
 * Outputs: Copied wire-compatible poses plus private body/contact state.
 * Side effects: Allocates/frees WASM bodies/colliders, advances fixed substeps and consumes input sequences.
 * Coupling: runtime initializes WASM; terrain builds static solids; controllers provide actor-specific actuation.
 */
const { RAPIER, initializePhysics, isInitialized } = require('./runtime');
const { normalizeAction } = require('./actions');
const { createTerrainColliders, terrainSupport } = require('./terrain');
const { terrainOnlyCollisionPolicy } = require('./collision-policy');
const { applyController } = require('./controllers');
const { worldQuaternion, bodyOrientation, rotateVector } = require('./rotation');
const { vector, add, scale, cross, dot, clampVector } = require('./vector');
const { invariants } = require('../contracts');

/** Copy mutable state vectors/arrays while sharing immutable registered body geometry. */
function cloneState(state = {}) {
    return { actors: (state.actors || []).map(actor => ({ ...actor,
        position: vector(actor.position), velocity: vector(actor.velocity),
        ...(actor.centerVelocity ? { centerVelocity: vector(actor.centerVelocity) } : {}), orientation: { ...actor.orientation },
        rotationalRates: vector(actor.rotationalRates) })),
        projectiles: structuredClone(state.projectiles || []), hitEvents: structuredClone(state.hitEvents || []) };
}

class PhysicsModel {
    /** Queue initial actors, load WASM once and expose ready; construction never starts a timer. */
    constructor(state, unused, environment = {}) {
        this.state = cloneState(state); this.environment = environment; this.records = new Map();
        this.terrainOnlyCollisions = false;
        this.time = 0; this.accumulator = 0; this.closed = false;
        if (isInitialized()) { this.initialize(); this.ready = Promise.resolve(this); }
        else this.ready = initializePhysics().then(() => { if (!this.closed) this.initialize(); return this; });
    }
    /** Allocate session-local world/terrain and materialize actors queued before WASM initialization. */
    initialize() {
        this.world = new RAPIER.World({ x: 0, y: -(this.environment.gravity ?? invariants.input.standardGravityMetersPerSecondSquared), z: 0 });
        this.world.integrationParameters.numSolverIterations = 8;
        this.world.integrationParameters.maxCcdSubsteps = 4;
        this.terrainHandles = createTerrainColliders(this.world, this.environment.terrain, this.environment);
        for (const actor of this.state.actors) this.createBody(actor);
    }
    /** Build a convex decomposition from validated GLB and explicitly retain volume mass/box COM/inertia. */
    createBody(actor) {
        if (!actor.body) return; // Unregistered placeholders never enter the rigid-body world.
        const shape = actor.body, position = vector(actor.position), q = worldQuaternion(actor.orientation);
        const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setRotation(q)
            .setCcdEnabled(true).setCanSleep(true);
        const vertices = new Float32Array(shape.vertices.flatMap(v => [v.x, v.y, v.z]));
        // VHACD gives concave actors a bounded compound of solid convex parts.
        // This is an approximation to visual geometry; mass uses original enclosed volume.
        const convex = shape.surfaces.every(surface => {
            // Parallel faces may lie on different planes on a concave shape.
            const plane = Math.min(...surface.triangles.map(ids => dot(surface.normal, shape.vertices[ids[0]])));
            return shape.vertices.every(vertex => dot(surface.normal, vertex) <= plane + 1e-5);
        });
        const colliderDesc = convex ? RAPIER.ColliderDesc.convexHull(vertices) :
            RAPIER.ColliderDesc.convexDecomposition(vertices, new Uint32Array(shape.indices), { resolution: 32, maxConvexHulls: 16 });
        if (!colliderDesc) throw new Error('Cannot construct Rapier collision solid');
        colliderDesc.setMassProperties(shape.mass, shape.centerOfMass, shape.inertia, { x: 0, y: 0, z: 0, w: 1 })
            .setFriction(0).setRestitution(this.environment.restitution ?? invariants.physics.restitution);
        const rb = this.world.createRigidBody(desc);
        let collider;
        try { collider = this.world.createCollider(colliderDesc, rb); }
        catch (error) { this.world.removeRigidBody(rb); throw error; }
        rb.recomputeMassPropertiesFromColliders();
        const angular = rotateVector(vector(actor.rotationalRates), q);
        const offset = rotateVector(shape.centerOfMass, q);
        rb.setAngvel(angular, true);
        rb.setLinvel(actor.centerVelocity || add(vector(actor.velocity), cross(angular, offset)), true);
        this.records.set(actor.id, { actor, rb, collider, shape, sequence: -1, receivedAt: -Infinity,
            frame: normalizeAction(), jumpHeld: false });
    }
    /** Advance bounded fixed substeps, neutralizing stale controls; returns copied authoritative state. */
    step(actions = {}, dt = 1 / invariants.network.simulationFrequencyHz) {
        if (this.closed) throw new Error('Physics model is closed');
        if (!this.world) throw new Error('Await physics.ready before stepping');
        if (!Number.isFinite(dt) || dt <= 0 || dt > 1) throw new Error('Physics dt must be positive, finite and at most one second');
        for (const [id, record] of this.records) {
            const input = actions[id];
            if (input && input.sequence > record.sequence) {
                record.sequence = input.sequence; record.frame = normalizeAction(input); record.receivedAt = this.time;
            }
        }
        // Reclassify before simulation so even externally added obstacles obey the diagnostic policy.
        if (this.terrainOnlyCollisions) terrainOnlyCollisionPolicy(this.world, this.terrainHandles);
        const h = invariants.physics.fixedSubstepSeconds;
        this.accumulator += dt;
        while (this.accumulator >= h - 1e-10) {
            this.world.timestep = h;
            for (const record of this.records.values()) {
                const active = this.time - record.receivedAt < invariants.input.inputTimeoutSeconds;
                const frame = active ? record.frame : normalizeAction();
                const support = terrainSupport(this.world, record.collider, this.terrainHandles, record.rb.linvel());
                applyController(record, frame, support, h, this.environment);
            }
            this.world.step();
            for (const record of this.records.values()) this.readBody(record);
            this.time += h; this.accumulator -= h;
        }
        return this.getState();
    }
    /** Project Rapier COM velocity/world quaternion to root velocity and body Euler wire fields; enforce limits. */
    readBody(record) {
        const { rb, actor, shape } = record;
        const maxSpeed = actor.physicsProfile?.maxSpeed ?? 100;
        rb.setLinvel(clampVector(rb.linvel(), maxSpeed), false);
        rb.setAngvel(clampVector(rb.angvel(), this.environment.maxAngularSpeed ?? invariants.physics.maxAngularSpeed), false);
        const position = { ...rb.translation() }, bounds = this.environment.bounds;
        if (bounds) {
            const v = { ...rb.linvel() }; let changed = false;
            for (const [axis, lo, hi] of [['x', 'minX', 'maxX'], ['z', 'minZ', 'maxZ']]) {
                const clamped = Math.max(bounds[lo], Math.min(bounds[hi], position[axis]));
                if (clamped !== position[axis]) { position[axis] = clamped; v[axis] = 0; changed = true; }
            }
            if (changed) { rb.setTranslation(position, true); rb.setLinvel(v, true); }
        }
        const rotation = rb.rotation(), offset = rotateVector(shape.centerOfMass, rotation);
        actor.position = position; actor.centerVelocity = { ...rb.linvel() };
        actor.velocity = add(actor.centerVelocity, scale(cross(rb.angvel(), offset), -1));
        actor.orientation = bodyOrientation(rotation);
        actor.rotationalRates = rotateVector(rb.angvel(), rotation, true);
        actor.grounded = Boolean(terrainSupport(this.world, record.collider, this.terrainHandles, rb.linvel()));
        actor.lastInputSequence = record.sequence;
    }
    /** Atomically replace a matching body/state; preserve the old record if collider construction fails. */
    addActor(actor) {
        if (this.closed) throw new Error('Physics model is closed');
        const next = cloneState({ actors: [actor] }).actors[0], old = this.records.get(actor.id);
        if (this.world) this.createBody(next);
        if (old) { this.world.removeRigidBody(old.rb); if (!next.body) this.records.delete(actor.id); }
        this.state.actors = this.state.actors.filter(a => a.id !== actor.id);
        this.state.actors.push(next);
    }
    /** Remove this actor and its WASM rigid body/colliders; does not affect other sessions. */
    removeActor(id) {
        const record = this.records.get(id);
        if (record) this.world.removeRigidBody(record.rb);
        this.records.delete(id); this.state.actors = this.state.actors.filter(actor => actor.id !== id);
    }
    /** Disable every object-to-object collision for this session while preserving terrain contacts and mass. */
    disableObjectCollisions() {
        if (!this.world || this.closed) throw new Error('Physics is not ready');
        this.terrainOnlyCollisions = true;
        return terrainOnlyCollisionPolicy(this.world, this.terrainHandles);
    }
    /** Swap static terrain, settle actor roots onto a flat plane and clear motion/input without resetting sequences. */
    flattenTerrain(terrain, sequences = {}) {
        if (!this.world || this.closed) throw new Error('Physics is not ready');
        const handles = createTerrainColliders(this.world, terrain, this.environment);
        // Build replacements before removing old colliders; all operations run within one server turn.
        for (const handle of this.terrainHandles) this.world.removeCollider(this.world.getCollider(handle), false);
        this.terrainHandles = handles; this.environment.terrain = terrain;
        if (this.terrainOnlyCollisions) terrainOnlyCollisionPolicy(this.world, this.terrainHandles);
        for (const record of this.records.values()) {
            const { actor, rb } = record, forward = rotateVector({ x: 1, y: 0, z: 0 }, rb.rotation());
            const orientation = { x: 0, y: 0, z: Math.atan2(-forward.z, forward.x), order: 'XYZ' };
            rb.setRotation(worldQuaternion(orientation), true);
            const position = { ...rb.translation() }; position.y = terrain.heightAt(position.x, position.z);
            rb.setTranslation(position, true); rb.setLinvel({ x: 0, y: 0, z: 0 }, true); rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
            rb.resetForces(true); rb.resetTorques(true);
            record.sequence = Math.max(record.sequence, sequences[actor.id] ?? -1);
            record.frame = normalizeAction(); record.receivedAt = -Infinity; record.jumpHeld = false;
            Object.assign(actor, { position, orientation, velocity: { x: 0, y: 0, z: 0 }, centerVelocity: { x: 0, y: 0, z: 0 },
                rotationalRates: { x: 0, y: 0, z: 0 }, grounded: false, lastInputSequence: record.sequence });
        }
        return this.getState();
    }
    /** Return copies, keeping WASM objects and control receipt clocks private. */
    getState() { return cloneState(this.state); }
    /** Free all session-owned WASM allocations; safe before ready and on repeated calls. */
    close() {
        if (this.closed) return;
        this.closed = true; this.world?.free(); this.world = null; this.records.clear();
        this.state = { actors: [], projectiles: [], hitEvents: [] };
    }
}
module.exports = { PhysicsModel, cloneState };
