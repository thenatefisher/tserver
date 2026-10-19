/**
 * Provide finite three-dimensional vector arithmetic.
 * Inputs: Numeric scalars, vector-like values and magnitude limits.
 * Outputs: New vectors, projections, magnitudes and scalar products.
 * Side effects: None; input vectors remain unchanged.
 * Coupling: Shared by forces, integration, contact frames, collision response and terrain normals.
 */
function number(value, fallback = 0) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}
/** Copy a vector-like input into a finite XYZ vector without changing the input. */
function vector(value) {
    return { x: number(value?.x), y: number(value?.y), z: number(value?.z) };
}
/** Return component-wise vector addition without modifying either operand. */
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
/** Return a scaled copy of a vector. */
function scale(v, n) { return { x: v.x * n, y: v.y * n, z: v.z * n }; }
/** Copy and clamp vector magnitude to a nonnegative limit. */
function clampVector(value, limit = 1) {
    const v = vector(value), length = Math.hypot(v.x, v.y, v.z);
    return length > limit ? scale(v, limit / length) : v;
}

/** Dot product for projections; neither input is changed. */
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
/** Right-handed cross product for contact frames and rotational velocities. */
function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
/** Unit direction; a zero vector stays zero. */
function normalize(v) { const length = Math.hypot(v.x, v.y, v.z); return length > 1e-12 ? scale(v, 1 / length) : { x: 0, y: 0, z: 0 }; }
/** Remove the component along a unit normal; returns a new vector. */
function tangent(v, normal) { return add(v, scale(normal, -dot(v, normal))); }
module.exports = { number, vector, add, scale, clampVector, dot, cross, normalize, tangent };
