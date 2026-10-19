// Column-major glTF transforms; no renderer or asset loaders are needed server-side.
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
    return Array.from({ length: 16 }, (_, n) => {
        const row = n % 4, column = Math.floor(n / 4);
        return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
    });
}
function compose(t, q, s) {
    const [x, y, z, w] = q, xx = x * x, yy = y * y, zz = z * z;
    return [(1 - 2 * (yy + zz)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
        2 * (x * y - z * w) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (y * z + x * w) * s[1], 0,
        2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
        ...t, 1];
}
function transform(v, m) {
    return { x: m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
        y: m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
        z: m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] };
}
function signedVolume(a, b, c) {
    return (a.x * (b.y * c.z - b.z * c.y) + a.y * (b.z * c.x - b.x * c.z) + a.z * (b.x * c.y - b.y * c.x)) / 6;
}
module.exports = { identity, multiply, compose, transform, signedVolume };
