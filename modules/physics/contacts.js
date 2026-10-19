/**
 * Find nonpenetrating vertical placement of a solid GLB against the terrain solid.
 * Inputs: actor root pose, immutable mesh, and a TerrainModel or height callback.
 * Outputs: required root elevation and contact normal; inputs remain unchanged.
 * Side effects: none. Coupling: body rotation, vector math and terrain query interfaces.
 */
const { vector } = require('./vector');
const { rotateBodyToWorld } = require('./rotation');

/** Adapt the immutable terrain model, or the injectable scalar test height, to a surface query. */
function surfaceAt(limits, x, z) {
    if (limits.terrain) return limits.terrain.surfaceAt(x, z);
    const height = typeof limits.groundHeight === 'function' ? limits.groundHeight({ x, y: 0, z }) : limits.groundHeight;
    return { height: typeof height === 'number' ? height : NaN, normal: { x: 0, y: 1, z: 0 } };
}

/** Find the vertical support requirement using actual GLB vertices and triangle surfaces. */
function terrainContact(actor, limits) {
    const position = vector(actor.position);
    const offsets = actor.body?.vertices.map(vertex => rotateBodyToWorld(vertex, actor.orientation)) || [{ x: 0, y: 0, z: 0 }];
    let rootHeight = -Infinity, normal = { x: 0, y: 1, z: 0 }, support;
    if (limits.terrain && position.y + Math.min(...offsets.map(offset => offset.y)) > limits.terrain.maxHeight + 1e-4) return { height: -Infinity, normal, grounded: false };
    // Taking the maximum support requirement keeps every sampled mesh surface
    // outside the terrain solid, including rotated or off-center geometry.
    /** Accumulate the highest root support requirement from one rotated mesh-surface sample. */
    function sample(offset) {
        const x = position.x + offset.x, z = position.z + offset.z;
        const height = limits.terrain ? limits.terrain.heightAt(x, z) : surfaceAt(limits, x, z).height;
        const required = height - offset.y;
        if (Number.isFinite(required) && required > rootHeight) { rootHeight = required; support = { x, z }; }
    }
    // A closed solid's downward-facing surfaces contain its terrain-facing
    // envelope. Parallel probe sets are cached at registration rather than
    // allocating duplicate edge midpoints for every triangle on every substep.
    const surfaces = actor.body?.surfaces.filter(surface => rotateBodyToWorld(surface.normal, actor.orientation).y < -1e-8);
    if (surfaces) {
        for (const surface of surfaces) for (const point of surface.samples) sample(rotateBodyToWorld(point, actor.orientation));
    } else offsets.forEach(sample);
    const grid = limits.terrain?.grid;
    const hasPost = grid &&
        Math.ceil((position.x + Math.min(...offsets.map(v => v.x)) - grid.origin.x) / grid.spacing.x) <= Math.floor((position.x + Math.max(...offsets.map(v => v.x)) - grid.origin.x) / grid.spacing.x) &&
        Math.ceil((position.z + Math.min(...offsets.map(v => v.z)) - grid.origin.z) / grid.spacing.z) <= Math.floor((position.z + Math.max(...offsets.map(v => v.z)) - grid.origin.z) / grid.spacing.z);
    const triangles = hasPost ? (surfaces?.flatMap(surface => surface.triangles) || []) : [];
    for (const ids of triangles) {
        const [a, b, c] = ids.map(index => offsets[index]);
        const grid = limits.terrain?.grid;
        if (!grid) continue;
        // A terrain post can strike the interior of a broad face while all its
        // vertices are clear. Test posts under each projected triangle as well.
        const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(denominator) < 1e-10) continue;
        const minX = Math.max(0, Math.ceil((position.x + Math.min(a.x, b.x, c.x) - grid.origin.x) / grid.spacing.x));
        const maxX = Math.min(grid.columns - 1, Math.floor((position.x + Math.max(a.x, b.x, c.x) - grid.origin.x) / grid.spacing.x));
        const minZ = Math.max(0, Math.ceil((position.z + Math.min(a.z, b.z, c.z) - grid.origin.z) / grid.spacing.z));
        const maxZ = Math.min(grid.rows - 1, Math.floor((position.z + Math.max(a.z, b.z, c.z) - grid.origin.z) / grid.spacing.z));
        for (let row = minZ; row <= maxZ; row++) for (let column = minX; column <= maxX; column++) {
            const x = grid.origin.x + column * grid.spacing.x - position.x, z = grid.origin.z + row * grid.spacing.z - position.z;
            const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
            const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
            if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8) sample({ x, y: u * a.y + v * b.y + (1 - u - v) * c.y, z });
        }
    }
    if (support) normal = surfaceAt(limits, support.x, support.z).normal;
    return { height: rootHeight, normal, grounded: Number.isFinite(rootHeight) && position.y <= rootHeight + 1e-4 };
}
module.exports = { terrainContact };
