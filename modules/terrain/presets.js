/**
 * Evaluate the standard terrain preset height functions without allocating world state.
 * Inputs: Schema-defined preset ID, world X/Z coordinates, dimensions and integer seed.
 * Outputs: Elevation in metres and the schema-derived preset catalog.
 * Side effects: None; named shapes are deterministic for the same coordinates/seed.
 * Coupling: contracts owns IDs/labels; terrain generation quantizes these heights into shared DTED samples.
 */
const { terrainPresets } = require('../contracts');
/** Smooth a bounded transition so natural terrain joins have no sudden height steps. */
function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
/** Evaluate a normalized rounded peak with a specified radius. */
function gaussian(value, radius) { return Math.exp(-((value / radius) ** 2)); }
/** Hash a city block's integer coordinates into a stable unsigned height variation. */
function blockHash(x, z, seed) { return (Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ seed) >>> 0; }
/** Return height for one validated preset; city geometry is part of the visible heightfield, not hidden boxes. */
function presetElevation(preset, x, z, size, seed) {
    const u = x / (size.x / 2), v = z / (size.z / 2);
    switch (preset) {
        case 'flat': return 0;
        case 'valley': return 90 * smooth((Math.abs(v) - 0.1) / 0.75);
        case 'plateau': return 70 * (1 - smooth((Math.hypot(u, v) - 0.35) / 0.35));
        case 'mountain-range': {
            const phase = (seed % 6283) / 1000;
            return [-0.55, 0, 0.55].reduce((height, ridge, i) => height +
                [80, 120, 90][i] * gaussian(u - ridge, 0.14) * (0.65 + 0.35 * Math.cos(v * 8 + phase + i) ** 2), 0);
        }
        case 'corner-hills': return [-0.72, 0.72].reduce((sum, cx) => sum + [-0.72, 0.72].reduce((h, cz) =>
            h + 80 * gaussian(u - cx, 0.22) * gaussian(v - cz, 0.22), 0), 0);
        case 'city-blocks': {
            const bx = Math.floor(x / 100), bz = Math.floor(z / 100);
            const localX = x - bx * 100, localZ = z - bz * 100;
            return localX >= 20 && localX <= 80 && localZ >= 20 && localZ <= 80 ? 24 + (blockHash(bx, bz, seed) % 5) * 8 : 0;
        }
        default: throw new Error('Unknown terrain preset');
    }
}
module.exports = { terrainPresets, presetElevation };
