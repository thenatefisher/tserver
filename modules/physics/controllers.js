/**
 * Translate normalized intent into server-owned forces for five actor controller modes.
 * Inputs: Rapier body, immutable shape, complete frame, contact normal, timestep and policy.
 * Outputs: Forces/torques applied to the body and a jump-held latch on its private record.
 * Side effects: Resets prior actuation, adds forces/torques/impulses; never sets the body's pose.
 * Coupling: Rapier integrates contacts; contract invariants own tuning, rotation/vector own frame math.
 */
const { rotateVector } = require('./rotation');
const { add, scale, dot, cross, normalize, tangent } = require('./vector');
const { invariants } = require('../contracts');
const { aircraftLift } = require('./aircraft');

/** Apply acceleration at COM as force; controls never overwrite collision-generated velocities. */
function accelerate(rb, acceleration) { rb.addForce(scale(acceleration, rb.mass()), true); }
/** Apply body-axis angular acceleration using the configured visual-box inertia approximation. */
function angularControl(rb, shape, effort, policy) {
    const torque = Object.fromEntries(['x', 'y', 'z'].map(a => [a, effort[a] * shape.inertia[a] * policy.angularAcceleration]));
    rb.addTorque(rotateVector(torque, rb.rotation()), true);
}
/** Damped attitude servo aligns body up to support normal while preserving free heading; adds torque only. */
function stabilize(rb, shape, normal, policy) {
    const up = rotateVector({ x: 0, y: 0, z: 1 }, rb.rotation());
    let error = cross(up, normal);
    // An exactly inverted chassis has zero cross product: choose a reproducible recovery axis.
    if (dot(up, normal) < -0.99 && Math.hypot(error.x, error.y, error.z) < 0.01) error = rotateVector({ x: 1, y: 0, z: 0 }, rb.rotation());
    const omega = rb.angvel(), correction = add(scale(error, policy.attitudeStiffness), scale(tangent(omega, normal), -policy.attitudeDamping));
    const local = rotateVector(correction, rb.rotation(), true);
    rb.addTorque(rotateVector({ x: local.x * shape.inertia.x, y: local.y * shape.inertia.y, z: local.z * shape.inertia.z }, rb.rotation()), true);
}
/** Add bounded tangent grip/braking without a force that can reverse velocity in one step. */
function resist(rb, direction, deceleration, dt) {
    const speed = dot(rb.linvel(), direction);
    accelerate(rb, scale(direction, -Math.sign(speed) * Math.min(Math.abs(speed) / dt, deceleration)));
}
/** Return grounded steering sign from actual forward speed, falling back to throttle near rest; no side effects. */
function steeringDirection(speed, throttle, threshold) {
    return Math.abs(speed) > threshold ? Math.sign(speed) : throttle < 0 ? -1 : 1;
}
/** Apply one controller substep and consume rising jump edges even when airborne or unsupported. */
function applyController(record, frame, support, dt, environment) {
    const { rb, shape, actor } = record, p = { ...invariants.physics, ...environment };
    rb.resetForces(false); rb.resetTorques(false);
    const q = rb.rotation(), mode = actor.physicsProfile?.controller || 'ground';
    const local = v => rotateVector(v, q);
    const risingJump = frame.jump && !record.jumpHeld;
    record.jumpHeld = frame.jump;
    const groundMode = mode === 'ground' || mode === 'mecha';
    const up = { x: 0, y: 1, z: 0 };
    if (groundMode && support) {
        const forward = normalize(tangent(local({ x: 1, y: 0, z: 0 }), support)), left = normalize(cross(support, forward));
        // Support cancels gravity along the slope and provides grip through a bounded servo.
        // Rapier still resolves normal impact/bounce and actor-to-actor impulses.
        const gravity = environment.gravity ?? invariants.input.standardGravityMetersPerSecondSquared;
        accelerate(rb, scale(tangent({ x: 0, y: -gravity, z: 0 }, support), -1));
        accelerate(rb, scale(forward, frame.move.x * p.forwardAcceleration));
        // Combine grip/coasting/braking before clamping, so independent resistors cannot overshoot zero.
        const lateralResistance = (mode === 'ground' || frame.move.y === 0 ? Math.abs(dot(rb.linvel(), left)) * p.lateralGrip : 0) +
            (mode === 'mecha' ? (frame.move.y === 0 ? p.coastDeceleration : 0) + frame.brake * p.brakeDeceleration : 0);
        resist(rb, left, lateralResistance, dt);
        if (mode === 'mecha') accelerate(rb, scale(left, frame.move.y * p.lateralAcceleration));
        resist(rb, forward, p.rollingDeceleration + (frame.move.x === 0 ? p.coastDeceleration : 0) + frame.brake * p.brakeDeceleration, dt);
        stabilize(rb, shape, support, p);
        // Ground yaw is deliberate steering; pitch/roll commands cannot fight terrain alignment.
        const steeringSign = steeringDirection(dot(rb.linvel(), forward), frame.move.x, p.steeringReverseThreshold);
        angularControl(rb, shape, { x: 0, y: 0, z: frame.rotate.z * steeringSign }, p);
        if (risingJump) rb.applyImpulse(scale(support, rb.mass() * p.jumpSpeed), true);
    } else if (groundMode) {
        // Airborne ground vehicles can adjust attitude, but have no translational thrusters.
        angularControl(rb, shape, frame.rotate, p);
    } else {
        const effort = { x: frame.move.x * p.forwardAcceleration, y: frame.move.y * p.lateralAcceleration, z: frame.move.z * p.verticalAcceleration };
        if (mode === 'aircraft') {
            effort.y = 0; effort.z = 0;
            const gravity = environment.gravity ?? invariants.input.standardGravityMetersPerSecondSquared;
            accelerate(rb, aircraftLift(rb.linvel(), q, gravity, p));
            accelerate(rb, scale(rb.linvel(), -p.aircraftDrag));
        } else if (mode === 'hover') {
            const center = rb.worldCom(), h = environment.terrain?.heightAt(center.x, center.z);
            if (Number.isFinite(h)) {
                const gravity = environment.gravity ?? invariants.input.standardGravityMetersPerSecondSquared;
                accelerate(rb, { x: 0, y: Math.max(0, gravity + (h + p.hoverHeight - center.y) * p.hoverStiffness - rb.linvel().y * p.hoverDamping), z: 0 });
            }
            stabilize(rb, shape, up, p);
        } else if (mode === 'boat') {
            effort.y = 0; effort.z = 0;
            const depth = p.waterLevel - rb.worldCom().y;
            // Buoyancy acts only when immersed; water is a plane, not a simulated fluid.
            if (depth > -0.5) {
                const gravity = environment.gravity ?? invariants.input.standardGravityMetersPerSecondSquared;
                accelerate(rb, { x: 0, y: Math.max(0, gravity + depth * p.buoyancyStiffness - rb.linvel().y * p.buoyancyDamping), z: 0 });
                accelerate(rb, scale(tangent(rb.linvel(), up), -1.5));
                stabilize(rb, shape, up, p);
            } else effort.x = 0;
        }
        accelerate(rb, local(effort));
        angularControl(rb, shape, mode === 'boat' ? { x: 0, y: 0, z: frame.rotate.z } : frame.rotate, p);
        const velocity = rb.linvel(), speed = Math.hypot(velocity.x, velocity.y, velocity.z);
        if (speed > 0) resist(rb, scale(velocity, 1 / speed), frame.brake * p.brakeDeceleration, dt);
    }
    // Yaw has damping when controls are neutral; collisions remain free to rotate the body.
    rb.setAngularDamping(groundMode && support ? 2 : 0.3);
}
module.exports = { applyController };
