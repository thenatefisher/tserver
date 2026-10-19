const { vector, number, add, scale } = require('./vector');
const { normalizeAction } = require('./actions');
const { accelerations, applyFriction } = require('./forces');
const { orientationOrder } = require('../contracts');
const { constrain } = require('./constraints');
function integrateActor(actor, action, dt, limits = {}) {
    if (!Number.isFinite(dt) || dt <= 0) throw new Error('Physics dt must be positive and finite');
    const position = vector(actor.position), velocity = vector(actor.velocity), rates = vector(actor.rotationalRates);
    const groundAt = p => typeof limits.groundHeight === 'function' ? number(limits.groundHeight(p), NaN) : number(limits.groundHeight, NaN);
    const forces = accelerations(actor, normalizeAction(action), limits);
    if (position.y <= groundAt(position) + 1e-4) {
        const horizontal = applyFriction({ ...velocity, y: 0 }, { ...forces.linear, y: 0 }, number(limits.groundFriction, 6), dt);
        forces.linear.x = horizontal.x; forces.linear.z = horizontal.z;
        forces.angular = applyFriction(rates, forces.angular, number(limits.angularFriction, 0.3), dt);
    }
    const next = {
        ...actor,
        position: add(position, add(scale(velocity, dt), scale(forces.linear, 0.5 * dt * dt))),
        velocity: add(velocity, scale(forces.linear, dt)),
        rotationalRates: add(rates, scale(forces.angular, dt))
    };
    constrain(next, limits, groundAt(next.position));
    next.orientation = { ...add(vector(actor.orientation), scale(next.rotationalRates, dt)), order: orientationOrder };
    return next;
}
module.exports = { integrateActor };
