/**
 * Generate schema-defined worlds and sample their quantized DTED heightfields.
 * Inputs: Optional terrain spacing/seed, grids, coordinates and world wrappers.
 * Outputs: New worlds/targets, validated maps and interpolated world elevations.
 * Side effects: Randomizes a seed for new worlds; resetTargets changes targets only, never terrain.
 * Coupling: contracts provides dimensions/scale; TerrainModel freezes a session-owned grid for physics.
 */
const { randomInt } = require('node:crypto');
const { worldSize, elevationScale, validate } = require('../contracts');
const { HITBOX_SIZE } = require('../actors/constants');
/** Compute the deterministic procedural height for one coordinate and generation seed. */
function elevation(x, z, seed) {
    x += seed % 997; z += Math.floor(seed / 997) % 991;
    return Math.sin(x / 12) * Math.cos(z / 12) * 2 + Math.sin(x / 30) * 3.5 + Math.cos(z / 25) * 2.5;
}
/** Generate a new half-open, integer-height grid using the configured seed and spacing. */
function createDtedTerrain({ spacing = { x: 10, z: 10 }, seed = randomInt(0x100000000) } = {}) {
    if (!Number.isFinite(spacing.x) || !Number.isFinite(spacing.z) || spacing.x <= 0 || spacing.z <= 0) throw new Error('Invalid terrain spacing');
    if (!Number.isSafeInteger(seed) || seed < 0 || seed >= 0x100000000) throw new Error('Invalid terrain seed');
    const width = worldSize.x, depth = worldSize.z;
    const columns = Math.ceil(width / spacing.x), rows = Math.ceil(depth / spacing.z);
    if (!Number.isSafeInteger(rows * columns) || rows * columns > 16_000_000) throw new Error('Terrain exceeds the server sample budget');
    const origin = { x: -width / 2, z: -depth / 2 };
    const depthMap = Array.from({ length: rows * columns }, (_, index) => Math.round(elevation(origin.x + (index % columns) * spacing.x, origin.z + Math.floor(index / columns) * spacing.z, seed) / elevationScale));
    return { type: 'dted', width, depth, columns, rows, origin, spacing: { ...spacing }, elevationScale, depthMap };
}
/** Validate the world schema and grid-length relationships; return input or throw. */
function validateMap(map) {
    validate('world', map);
    const t = map.terrain;
    if (t.width !== map.size.x || t.depth !== map.size.z || t.columns !== Math.ceil(t.width / t.spacing.x) || t.rows !== Math.ceil(t.depth / t.spacing.z) || t.depthMap.length !== t.rows * t.columns) throw new Error('Terrain grid dimensions do not match world and spacing');
    return map;
}
/** Interpolate valid posts into metres, renormalizing around no-data samples. */
function sampleTerrainHeight(terrain, x, z) {
    const gx = Math.max(0, Math.min(terrain.columns - 1, (x - terrain.origin.x) / terrain.spacing.x));
    const gz = Math.max(0, Math.min(terrain.rows - 1, (z - terrain.origin.z) / terrain.spacing.z));
    const x0 = Math.floor(gx), z0 = Math.floor(gz), x1 = Math.min(x0 + 1, terrain.columns - 1), z1 = Math.min(z0 + 1, terrain.rows - 1);
    const posts = [[x0, z0, (1 - gx + x0) * (1 - gz + z0)], [x1, z0, (gx - x0) * (1 - gz + z0)], [x0, z1, (1 - gx + x0) * (gz - z0)], [x1, z1, (gx - x0) * (gz - z0)]];
    let total = 0, weight = 0;
    for (const [column, row, w] of posts) {
        const value = terrain.depthMap[row * terrain.columns + column];
        if (value === terrain.noDataValue || !Number.isFinite(value)) continue;
        total += value * terrain.elevationScale * w; weight += w;
    }
    return weight ? total / weight : NaN;
}
/** Allocate randomized practice targets above the supplied terrain without changing its grid. */
function generateTargets(terrain) {
    return Array.from({ length: 15 }, (_, i) => {
        const x = Math.round((Math.random() * 80 - 40) * 10) / 10, z = Math.round((Math.random() * 80 + 10) * 10) / 10;
        return { id: `target_${i}`, x, z, y: sampleTerrainHeight(terrain, x, z) + 2, size: 2 };
    });
}
/** Generate a new schema-valid world with derived bounds and practice targets. */
function createMap(options) {
    const terrain = createDtedTerrain(options);
    return validateMap({ size: { ...worldSize }, terrain,
        bounds: { minX: -worldSize.x / 2 + HITBOX_SIZE.x / 2, maxX: worldSize.x / 2 - HITBOX_SIZE.x / 2, minZ: -worldSize.z / 2 + HITBOX_SIZE.y / 2, maxZ: worldSize.z / 2 - HITBOX_SIZE.y / 2 },
        walls: [], ramps: [], targets: generateTargets(terrain) });
}
/** Replace only the world’s target list in place; return the same world wrapper. */
function resetTargets(map) { map.targets = generateTargets(map.terrain); return map; }
module.exports = { createMap, createDtedTerrain, validateMap, sampleTerrainHeight, resetTargets };
