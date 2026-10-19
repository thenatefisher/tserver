function number(value, fallback = 0) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
}
function vector(value) {
    return { x: number(value?.x), y: number(value?.y), z: number(value?.z) };
}
function add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function scale(v, n) { return { x: v.x * n, y: v.y * n, z: v.z * n }; }
function clampVector(value, limit = 1) {
    const v = vector(value), length = Math.hypot(v.x, v.y, v.z);
    return length > limit ? scale(v, limit / length) : v;
}
module.exports = { number, vector, add, scale, clampVector };
