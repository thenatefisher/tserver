/**
 * Generate schema-defined worlds and sample their quantized DTED heightfields.
 * Inputs: Optional schema-defined preset, spacing/seed, grids, coordinates and world wrappers.
 * Outputs: New worlds/targets, validated maps and interpolated world elevations.
 * Side effects: Randomizes a seed for new worlds; resetTargets changes targets only, never terrain.
 * Coupling: contracts provides dimensions/scale; TerrainModel freezes a session-owned grid for physics.
 */
const { randomInt } = require('node:crypto');
const { worldSize, elevationScale, validate } = require('../contracts');
const { terrainPresets, presetElevation } = require('./presets');
const { TerrainModel } = require('./model');
const { schemas } = require('../contracts');
const { HITBOX_SIZE } = require('../actors/constants');
const { triangleHeight } = require('./sampling');
/** Compute the deterministic procedural height for one coordinate and generation seed. */
function elevation(x, z, seed) {
    x += seed % 997; z += Math.floor(seed / 997) % 991;
    return Math.sin(x / 12) * Math.cos(z / 12) * 2 + Math.sin(x / 30) * 3.5 + Math.cos(z / 25) * 2.5;
}
/** Generate a new half-open, integer-height grid using the configured seed and spacing. */
function createDtedTerrain({ spacing = { x: 10, z: 10 }, seed, preset, boundary = 'wrap' } = {}) {
    if (preset !== undefined && !terrainPresets.some(choice => choice.id === preset)) throw new Error('Unknown terrain preset');
    if (!schemas.world.properties.terrain.properties.boundary.enum.includes(boundary)) throw new Error('Unknown terrain boundary policy');
    seed ??= preset ? 0 : randomInt(0x100000000);
    if (!Number.isFinite(spacing.x) || !Number.isFinite(spacing.z) || spacing.x <= 0 || spacing.z <= 0) throw new Error('Invalid terrain spacing');
    if (!Number.isSafeInteger(seed) || seed < 0 || seed >= 0x100000000) throw new Error('Invalid terrain seed');
    const width = worldSize.x, depth = worldSize.z;
    const columns = Math.ceil(width / spacing.x), rows = Math.ceil(depth / spacing.z);
    if (!Number.isSafeInteger(rows * columns) || rows * columns > 16_000_000) throw new Error('Terrain exceeds the server sample budget');
    const origin = { x: -width / 2, z: -depth / 2 };
    const depthMap = Array.from({ length: rows * columns }, (_, index) => {
        const x = origin.x + (index % columns) * spacing.x, z = origin.z + Math.floor(index / columns) * spacing.z;
        /** Evaluate the chosen height function, including the neighboring tile continuation. */
        const at = (px, pz) => preset ? presetElevation(preset, px, pz, worldSize, seed) : elevation(px, pz, seed);
        // Blend the final border band toward the neighboring tile's continuation.
        // This keeps recognizable preset interiors while removing a height step at the seam.
        /** Smoothly join the border band without changing the preset interior. */
        const blend = value => { value = Math.max(0, Math.min(1, value)); return value * value * (3 - 2 * value); };
        const wx = boundary === 'wrap' ? blend((x - (origin.x + width - 50)) / 50) : 0;
        const wz = boundary === 'wrap' ? blend((z - (origin.z + depth - 50)) / 50) : 0;
        const height = (1-wx)*(1-wz)*at(x,z) + wx*(1-wz)*at(x-width,z) + (1-wx)*wz*at(x,z-depth) + wx*wz*at(x-width,z-depth);
        return Math.round(height / elevationScale);
    });
    return { ...(preset ? { preset, seed } : {}), type: 'dted', boundary, width, depth, columns, rows, origin, spacing: { ...spacing }, elevationScale, depthMap };
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
    if (terrain.boundary === 'wrap') return triangleHeight(terrain, x, z);
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
    const model = new TerrainModel(terrain);
    return Array.from({ length: 15 }, (_, i) => {
        const x = Math.round((Math.random() * 80 - 40) * 10) / 10, z = Math.round((Math.random() * 80 + 10) * 10) / 10;
        return { id: `target_${i}`, x, z, y: model.heightAt(x, z) + 2, size: 2 };
    });
}
/** Generate a new schema-valid world with derived bounds and practice targets. */
function createMap(options) {
    const terrain = createDtedTerrain(options);
    const insetX = terrain.boundary === 'wrap' ? 0 : HITBOX_SIZE.x / 2;
    const insetZ = terrain.boundary === 'wrap' ? 0 : HITBOX_SIZE.y / 2;
    return validateMap({ size: { ...worldSize }, terrain,
        bounds: { minX: terrain.origin.x + insetX, maxX: terrain.origin.x + terrain.width - insetX, minZ: terrain.origin.z + insetZ, maxZ: terrain.origin.z + terrain.depth - insetZ },
        walls: [], ramps: [], targets: generateTargets(terrain) });
}
/** Replace only the world’s target list in place; return the same world wrapper. */
function resetTargets(map) { map.targets = generateTargets(map.terrain); return map; }
module.exports = { terrainPresets, createMap, createDtedTerrain, validateMap, sampleTerrainHeight, resetTargets };
