const { add, scale, number, vector } = require('./vector');
const { rotateBodyToWorld } = require('./rotation');
const { invariants } = require('../contracts');
const standardGravity = invariants.input.standardGravityMetersPerSecondSquared;
function accelerations(actor, action, limits) {
    return {
        linear: add(rotateBodyToWorld(scale(action.linear, standardGravity), actor.orientation), { x: 0, y: -number(limits.gravity, standardGravity), z: 0 }),
        // Input angular components already have physical units about body axes.
        angular: vector(action.angular)
    };
}
function applyFriction(velocity, acceleration, magnitude, dt) {
    const predicted = add(vector(velocity), scale(acceleration, dt));
    const speed = Math.hypot(predicted.x, predicted.y, predicted.z);
    return speed ? add(acceleration, scale(predicted, -Math.min(magnitude, speed / dt) / speed)) : acceleration;
}
module.exports = { accelerations, applyFriction };
