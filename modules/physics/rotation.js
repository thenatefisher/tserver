/**
 * Map intrinsic body Euler XYZ rotations into world coordinates.
 * Inputs: A Z-up body vector and optional schema-order Euler orientation.
 * Outputs: A newly allocated Y-up world vector.
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
module.exports = { rotateBodyToWorld };
