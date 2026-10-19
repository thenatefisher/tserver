/**
 * Resolve wheel-like ground traction in a terrain tangent frame.
 * Inputs: COM velocity, world acceleration, body heading, normal and timestep.
 * Outputs: previous/new tangential COM velocities and the forward contact direction.
 * Side effects: none. Coupling: rotation/vector math; called only during solid contact.
 */
const { scale, dot, normalize, tangent, number } = require('./vector');
const { rotateBodyToWorld } = require('./rotation');

/** Enforce lateral no-slip while allowing lower-resistance forward/backward rolling. */
function wheelMotion(velocity, acceleration, orientation, normal, dt, limits) {
    let forward = normalize(tangent(rotateBodyToWorld({ x: 1, y: 0, z: 0 }, orientation), normal));
    if (Math.hypot(forward.x, forward.y, forward.z) < 1e-8) forward = normalize(tangent({ x: 1, y: 0, z: 0 }, normal));
    const previous = dot(velocity, forward);
    const predicted = previous + dot(acceleration, forward) * dt;
    const friction = Math.max(0, number(limits.rollingFriction, 0.6)) * dt;
    const speed = Math.sign(predicted) * Math.max(0, Math.abs(predicted) - friction);
    return { previous: scale(forward, previous), velocity: scale(forward, speed), forward };
}
module.exports = { wheelMotion };
