/**
 * Share DTED post addressing and physical triangle sampling, including periodic seams.
 * Inputs: Schema-valid grids, integer post indices and world X/Z coordinates.
 * Outputs: Post coordinates/heights and interpolated elevation; no side effects.
 * Coupling: TerrainModel and Rapier mesh construction must use identical boundary rules.
 */
/** Canonicalize a coordinate into a half-open interval, including negative/multi-lap positions. */
function wrap(value, origin, length) { if (value >= origin && value < origin + length) return value; return origin + ((value - origin) % length + length) % length; }
/** Address a boundary/halo post; wrapped tiles repeat their first post at each far edge. */
function terrainPost(g, column, row) {
    const periodic = g.boundary === 'wrap';
    const c = periodic ? ((column % g.columns) + g.columns) % g.columns : Math.max(0, Math.min(column, g.columns - 1));
    const r = periodic ? ((row % g.rows) + g.rows) % g.rows : Math.max(0, Math.min(row, g.rows - 1));
    const value = g.depthMap[r * g.columns + c];
    return { x: g.origin.x + (periodic ? Math.floor(column / g.columns) * g.width + c * g.spacing.x : Math.max(0, Math.min(column * g.spacing.x, g.width))),
        z: g.origin.z + (periodic ? Math.floor(row / g.rows) * g.depth + r * g.spacing.z : Math.max(0, Math.min(row * g.spacing.z, g.depth))),
        y: value === g.noDataValue || !Number.isFinite(value) ? NaN : value * g.elevationScale };
}
/** Sample the b-to-c triangle diagonal, including shortened final cells and periodic coordinates. */
function triangleHeight(g, x, z) {
    x = g.boundary === 'wrap' ? wrap(x, g.origin.x, g.width) : Math.max(g.origin.x, Math.min(x, g.origin.x + g.width));
    z = g.boundary === 'wrap' ? wrap(z, g.origin.z, g.depth) : Math.max(g.origin.z, Math.min(z, g.origin.z + g.depth));
    const c = Math.min(g.columns - 1, Math.floor((x - g.origin.x) / g.spacing.x));
    const r = Math.min(g.rows - 1, Math.floor((z - g.origin.z) / g.spacing.z));
    const a = terrainPost(g, c, r), b = terrainPost(g, c + 1, r), cc = terrainPost(g, c, r + 1), d = terrainPost(g, c + 1, r + 1);
    const tx = (x - a.x) / (b.x - a.x), tz = (z - a.z) / (cc.z - a.z);
    return tx + tz <= 1 ? a.y * (1 - tx - tz) + b.y * tx + cc.y * tz : b.y * (1 - tz) + cc.y * (1 - tx) + d.y * (tx + tz - 1);
}
module.exports = { wrap, terrainPost, triangleHeight };
