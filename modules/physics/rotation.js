/**
 * Map intrinsic body Euler XYZ, world quaternions and vectors across the body/world boundary.
 * Inputs: Z-up body vectors, schema-order Euler orientations or Rapier world quaternions.
 * Outputs: Newly allocated vectors, world quaternions or body Euler XYZ orientations.
 * Side effects: None; rejects an explicitly unsupported orientation order.
 * Coupling: contracts supplies the order label; physics and solid contacts use the basis conversion.
 */
const { vector } = require('./vector');
const { orientationOrder } = require('../contracts');
// Intrinsic Euler XYZ in the Z-up body frame, followed by the contract basis
// conversion (x,y,z) -> (x,z,-y). Do not apply world-space Euler rotations here.
/** Apply intrinsic Euler XYZ and the body-to-world basis; return a new world vector. */
function rotateBodyToWorld(value, orientation) {
    if (orientation?.order && orientation.order !== orientationOrder) throw new Error('Unsupported Euler order');
    const v = vector(value), o = vector(orientation);
    const cx = Math.cos(o.x), sx = Math.sin(o.x), cy = Math.cos(o.y), sy = Math.sin(o.y), cz = Math.cos(o.z), sz = Math.sin(o.z);
    const xz = cz * v.x - sz * v.y, yz = sz * v.x + cz * v.y;
    const xy = cy * xz + sy * v.z, zy = -sy * xz + cy * v.z;
    const y = cx * yz - sx * zy, z = sx * yz + cx * zy;
    return { x: xy, y: z, z: -y };
}
const basis = { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
/** Multiply unit quaternions, composing b then a; neither operand is mutated. */
function multiply(a, b) {
    return { x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
        y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
        z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
        w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z };
}
/** Conjugate a unit quaternion for the inverse basis/frame transform. */
function inverse(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
/** Convert wire body Euler XYZ to a Rapier world quaternion; inputs remain unchanged. */
function worldQuaternion(o = {}) {
    const c1 = Math.cos((o.x || 0)/2), c2 = Math.cos((o.y || 0)/2), c3 = Math.cos((o.z || 0)/2);
    const s1 = Math.sin((o.x || 0)/2), s2 = Math.sin((o.y || 0)/2), s3 = Math.sin((o.z || 0)/2);
    return multiply(basis, { x: s1*c2*c3 + c1*s2*s3, y: c1*s2*c3 - s1*c2*s3,
        z: c1*c2*s3 + s1*s2*c3, w: c1*c2*c3 - s1*s2*s3 });
}
/** Convert a Rapier world quaternion back to wire body Euler XYZ, including gimbal-lock handling. */
function bodyOrientation(rotation) {
    const { x, y, z, w } = multiply(inverse(basis), rotation);
    const m13 = Math.max(-1, Math.min(1, 2*(x*z + w*y)));
    return { x: Math.abs(m13) < 0.9999999 ? Math.atan2(2*(w*x - y*z), 1 - 2*(x*x + y*y)) : Math.atan2(2*(y*z + w*x), 1 - 2*(x*x + z*z)),
        y: Math.asin(m13), z: Math.abs(m13) < 0.9999999 ? Math.atan2(2*(w*z - x*y), 1 - 2*(y*y + z*z)) : 0,
        order: orientationOrder };
}
/** Rotate a vector by a quaternion; inverse=true maps world vectors back to actor-local axes. */
function rotateVector(value, rotation, invert = false) {
    const q = invert ? inverse(rotation) : rotation;
    const result = multiply(multiply(q, { ...value, w: 0 }), inverse(q));
    return { x: result.x, y: result.y, z: result.z };
}
module.exports = { rotateBodyToWorld, worldQuaternion, bodyOrientation, rotateVector };
