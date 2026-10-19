/**
 * Provide glTF column-major matrix and signed-volume arithmetic.
 * Inputs: Numeric transforms, vertices and triangle coordinates.
 * Outputs: New matrices, transformed points and signed tetrahedral volumes.
 * Side effects: None; inputs are never modified.
 * Coupling: Used by GLB validation; independent of physics state and rendering.
 */
/** Allocate a new column-major identity transform without shared mutable elements. */
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Multiply two column-major transforms into a new matrix. */
function multiply(a, b) {
    return Array.from({ length: 16 }, (_, n) => {
        const row = n % 4, column = Math.floor(n / 4);
        return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
    });
}
/** Compose translation, normalized quaternion and scale into a glTF transform. */
function compose(t, q, s) {
    const [x, y, z, w] = q, xx = x * x, yy = y * y, zz = z * z;
    return [(1 - 2 * (yy + zz)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
        2 * (x * y - z * w) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (y * z + x * w) * s[1], 0,
        2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
        ...t, 1];
}
/** Transform an XYZ array into a new point using a column-major affine matrix. */
function transform(v, m) {
    return { x: m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
        y: m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
        z: m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] };
}
/** Compute a triangle’s signed tetrahedral volume relative to the origin. */
function signedVolume(a, b, c) {
    return (a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x)) / 6;
}
module.exports = { identity, multiply, compose, transform, signedVolume };
