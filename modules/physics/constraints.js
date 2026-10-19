const { clampVector, number } = require('./vector');
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
