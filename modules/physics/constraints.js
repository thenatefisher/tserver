/**
 * Apply server speed limits and world boundary constraints to a working actor.
 * Inputs: Mutable integrated actor state, optional limits and optional scalar support height.
 * Outputs: The same constrained actor object.
 * Side effects: Mutates position and velocity; clears velocity along crossed world boundaries.
 * Coupling: vector supplies clamping; solid terrain placement is handled by contacts/integration.
 */
const { clampVector, number } = require('./vector');
/** Mutate the working actor to enforce speed/boundary limits and optional support height. */
function constrain(actor, limits, height) {
    if (Number.isFinite(height) && actor.position.y <= height) {
        actor.position.y = height;
        if (actor.velocity.y < 0) actor.velocity.y = 0;
    }
    actor.velocity = clampVector(actor.velocity, Math.max(0, number(limits.maxSpeed, Infinity)));
    actor.rotationalRates = clampVector(actor.rotationalRates, Math.max(0, number(limits.maxAngularRate, Infinity)));
    if (limits.bounds) {
        for (const [axis, min, max] of [['x', 'minX', 'maxX'], ['z', 'minZ', 'maxZ']]) {
            const coordinate = actor.position[axis];
            actor.position[axis] = Math.max(limits.bounds[min], Math.min(limits.bounds[max], coordinate));
            if (coordinate !== actor.position[axis]) actor.velocity[axis] = 0;
        }
    }
    return actor;
}
module.exports = { constrain };
