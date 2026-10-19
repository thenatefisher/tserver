/**
 * Convert schema acceleration inputs into physical world/body accelerations.
 * Inputs: Actor orientation, complete action and environment gravity.
 * Outputs: World linear acceleration and body-axis angular acceleration.
 * Side effects: None.
 * Coupling: contracts defines standard gravity; rotation maps Z-up body axes to Y-up world axes.
 */
const { add, scale, number, vector } = require('./vector');
const { rotateBodyToWorld } = require('./rotation');
const { invariants } = require('../contracts');
const standardGravity = invariants.input.standardGravityMetersPerSecondSquared;
/** Return physical accelerations: linear g converted to world m/s², angular kept in body rad/s². */
function accelerations(actor, action, limits) {
    return {
        linear: add(rotateBodyToWorld(scale(action.linear, standardGravity), actor.orientation), { x: 0, y: -number(limits.gravity, standardGravity), z: 0 }),
        // Input angular components already have physical units about body axes.
        angular: vector(action.angular)
    };
}
module.exports = { accelerations };
