/**
 * Apply assisted arcade flight using bounded velocity and body-rate servos.
 * Inputs: Rapier actor record, complete controls, terrain support, timestep and policy.
 * Outputs: Forces/torques on the body; no pose or velocity assignments.
 * Side effects: Adds Rapier actuation for this substep.
 * Coupling: controllers resets actuation; contracts owns tuning; Rapier resolves impacts.
 */
const { rotateVector } = require('./rotation');
const { add, scale, clampVector } = require('./vector');

/** Steer velocity toward the nose and angular rates toward input; preserve terrain contact at rest. */
function applyAircraft(record, frame, support, dt, policy, gravity) {
    const { rb, shape, actor } = record, q = rb.rotation();
    const forward = rotateVector({ x: 1, y: 0, z: 0 }, q);
    const left = rotateVector({ x: 0, y: 1, z: 0 }, q);
    const up = rotateVector({ x: 0, y: 0, z: 1 }, q);
    const speed = frame.move.x * actor.physicsProfile.maxSpeed * (1 - frame.brake);
    const desired = scale(forward, speed);
    const acceleration = clampVector(scale(add(desired, scale(rb.linvel(), -1)), 1 / Math.max(dt, policy.aircraftVelocityResponse)), policy.aircraftAcceleration);
    // Runway contact retains gravity. Nose-up travel requests takeoff; airborne flight
    // cancels gravity so clients do not need lift/airspeed/altitude compensation loops.
    const launching = speed > policy.aircraftTakeoffSpeed && frame.rotate.y < 0 && Math.hypot(rb.linvel().x, rb.linvel().z) > policy.aircraftTakeoffSpeed;
    if (!support || desired.y > policy.aircraftTakeoffVerticalSpeed || launching) acceleration.y += gravity;
    rb.addForce(scale(acceleration, rb.mass()), true);
    const omega = rotateVector(rb.angvel(), q, true);
    const bank = Math.atan2(left.y, up.y);
    const target = scale(frame.rotate, policy.aircraftAngularRate);
    if (frame.rotate.x === 0 && policy.aircraftAutoLevel) target.x = -bank * policy.aircraftLevelGain;
    // Banking requests a coordinated heading change; explicit yaw remains available.
    if (!support) {
        const headingRate = Math.max(-policy.aircraftBankTurnRate, Math.min(policy.aircraftBankTurnRate,
            -gravity * Math.tan(Math.max(-1, Math.min(1, bank))) / Math.max(5, Math.abs(speed))));
        // Coordinate heading about WORLD vertical, not the banked body's up axis.
        // A banked body-yaw command changes nose elevation; world heading preserves it.
        const headingBody = rotateVector({ x: 0, y: headingRate, z: 0 }, q, true);
        target.x += headingBody.x; target.y += headingBody.y; target.z += headingBody.z;
    }
    const correction = clampVector(scale(add(clampVector(target, policy.aircraftAngularRate), scale(omega, -1)),
        1 / Math.max(dt, policy.aircraftRateResponse)), policy.aircraftAngularAcceleration);
    rb.addTorque(rotateVector({ x: correction.x * shape.inertia.x, y: correction.y * shape.inertia.y,
        z: correction.z * shape.inertia.z }, q), true);
}
module.exports = { applyAircraft };
