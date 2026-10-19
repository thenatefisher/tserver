/**
 * Advance one solid actor with continuous linear/angular acceleration inputs.
 * Inputs: actor state, action, dt, environment/terrain and server speed limits.
 * Outputs: a new actor state, with body geometry shared immutably.
 * Side effects: none. Coupling: forces, COM pivot, wheel friction and terrain contacts.
 */
const { vector, number, add, scale, dot, clampVector, cross } = require('./vector');
const { normalizeAction } = require('./actions');
const { accelerations } = require('./forces');
const { orientationOrder } = require('../contracts');
const { constrain } = require('./constraints');
const { rotateBodyToWorld } = require('./rotation');
const { terrainContact } = require('./contacts');
const { wheelMotion } = require('./friction');

/** Advance a small step about the visual-box COM, then project solid ground contact. */
function substep(actor, action, dt, limits) {
    const position = vector(actor.position), rates = vector(actor.rotationalRates);
    const centerOffset = rotateBodyToWorld(actor.body?.centerOfMass, actor.orientation);
    const worldRates = rotateBodyToWorld(rates, actor.orientation);
    const centerVelocity = actor.centerVelocity ? vector(actor.centerVelocity) : add(vector(actor.velocity), cross(worldRates, centerOffset));
    const forces = accelerations(actor, action, limits);
    const contact = terrainContact(actor, limits);
    // Positive normal acceleration (e.g. >1 g body +Z on level ground) lifts
    // the actor off the solid, releasing both lateral and rotational grip.
    const supported = contact.grounded && dot(centerVelocity, contact.normal) <= 1e-4 && dot(forces.linear, contact.normal) <= 1e-6;
    let velocity, previousVelocity, nextRates;
    if (supported) {
        const motion = wheelMotion(centerVelocity, forces.linear, actor.orientation, contact.normal, dt, limits);
        velocity = motion.velocity; previousVelocity = motion.previous;
        // Static contact resists all commanded spin; airborne actors remain free.
        nextRates = { x: 0, y: 0, z: 0 };
    } else {
        previousVelocity = centerVelocity;
        velocity = add(centerVelocity, scale(forces.linear, dt));
        nextRates = add(rates, scale(forces.angular, dt));
    }
    velocity = clampVector(velocity, Math.max(0, number(limits.maxSpeed, Infinity)));
    nextRates = clampVector(nextRates, Math.max(0, number(limits.maxAngularRate, Infinity)));
    const orientation = { ...add(vector(actor.orientation), scale(nextRates, dt)), order: orientationOrder };
    const nextOffset = rotateBodyToWorld(actor.body?.centerOfMass, orientation);
    // Root position follows the COM displacement minus the rotated COM offset;
    // this preserves the COM while an off-center GLB rotates around it.
    const next = { ...actor, orientation, rotationalRates: nextRates,
        position: add(add(position, centerOffset), add(scale(add(previousVelocity, velocity), dt / 2), scale(nextOffset, -1))),
        velocity, centerVelocity: velocity, grounded: false };
    const landing = terrainContact(next, limits);
    if (Number.isFinite(landing.height) && next.position.y <= landing.height + 1e-7) {
        next.position.y = Math.max(next.position.y, landing.height);
        if (dot(velocity, landing.normal) <= 1e-4) {
            const motion = wheelMotion(velocity, { x: 0, y: 0, z: 0 }, orientation, landing.normal, 0, limits);
            next.centerVelocity = motion.velocity;
            next.rotationalRates = { x: 0, y: 0, z: 0 };
            next.grounded = true;
        }
    }
    next.velocity = next.centerVelocity;
    constrain(next, limits);
    next.centerVelocity = next.velocity;
    // Public velocity is at the mesh root; internal velocity is at the COM.
    next.velocity = add(next.centerVelocity, scale(cross(rotateBodyToWorld(next.rotationalRates, next.orientation), nextOffset), -1));
    return next;
}

/** Subdivide fast motion and long time steps to reduce solid-contact tunneling. */
function integrateActor(actor, action, dt, limits = {}) {
    if (!Number.isFinite(dt) || dt <= 0) throw new Error('Physics dt must be positive and finite');
    const size = actor.body ? Math.min(...['x', 'y', 'z'].map(axis => actor.body.bounds.max[axis] - actor.body.bounds.min[axis])) : 1;
    const velocity = vector(actor.centerVelocity || actor.velocity);
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    const steps = Math.min(128, Math.max(1, Math.ceil(dt * 120), Math.ceil(speed * dt / Math.max(0.02, size / 4))));
    const normalized = normalizeAction(action);
    let next = actor;
    for (let step = 0; step < steps; step++) next = substep(next, normalized, dt / steps, limits);
    return next;
}
module.exports = { integrateActor };
