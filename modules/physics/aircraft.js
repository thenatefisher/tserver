/**
 * Compute simplified wing acceleration from attitude and COM airflow.
 * Inputs: world velocity, body quaternion, gravity magnitude and contract physics policy.
 * Output: world lift acceleration; no mutations or other side effects.
 * Coupling: controllers apply the returned acceleration through Rapier; invariants own tuning.
 */
const { rotateVector } = require('./rotation');
const { cross, normalize, scale } = require('./vector');

/** Return bounded, signed lift normal to pitch-plane airflow; reverse flight produces no lift. */
function aircraftLift(velocity, quaternion, gravity, policy) {
    const body = rotateVector(velocity, quaternion, true);
    if (body.x <= 0) return { x: 0, y: 0, z: 0 };
    // Positive incidence means the nose is above its flight path. A nose-down command
    // reduces lift immediately, rather than retaining a speed-only upward force.
    const alpha = Math.atan2(-body.z, body.x);
    const coefficient = Math.max(-1, Math.min(1 + policy.aircraftLiftSlope * alpha, 2));
    const load = Math.max(-policy.aircraftMaxLiftG, Math.min(policy.aircraftMaxLiftG,
        (body.x / policy.aircraftLiftSpeed) ** 2 * coefficient));
    const left = rotateVector({ x: 0, y: 1, z: 0 }, quaternion);
    const pitchFlow = rotateVector({ x: body.x, y: 0, z: body.z }, quaternion);
    // Excluding sideslip keeps this arcade wing model symmetric without making lift
    // perform work along the airflow. Bank still tilts the resulting lift vector.
    return scale(normalize(cross(pitchFlow, left)), gravity * load);
}
module.exports = { aircraftLift };
