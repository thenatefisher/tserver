/**
 * Build static Rapier terrain colliders from immutable row-major DTED samples.
 * Inputs: Rapier world and TerrainModel. Outputs: Set of owned terrain collider handles.
 * Side effects: Allocates chunked triangle meshes in that world; source grid remains unchanged.
 * Coupling: TerrainModel and client terrain guidance share the same triangle diagonal/boundary extension.
 */
const { RAPIER } = require('./runtime');
const { invariants } = require('../contracts');
/** Allocate bounded-size collider chunks, omitting triangles touching no-data posts. */
function createTerrainColliders(world, terrain, policy = {}) {
    const handles = new Set();
    if (!terrain) return handles;
    const g = terrain.grid, chunk = 64;
    // Add a duplicate final post at the far boundary: wire grids remain half-open.
    for (let r0 = 0; r0 < g.rows; r0 += chunk) for (let c0 = 0; c0 < g.columns; c0 += chunk) {
        const nr = Math.min(chunk, g.rows - r0), nc = Math.min(chunk, g.columns - c0);
        const vertices = [], indices = [], valid = [];
        for (let r = 0; r <= nr; r++) for (let c = 0; c <= nc; c++) {
            const row = r0 + r, col = c0 + c;
            const sample = g.depthMap[Math.min(row, g.rows - 1) * g.columns + Math.min(col, g.columns - 1)];
            valid.push(sample !== g.noDataValue && Number.isFinite(sample));
            vertices.push(g.origin.x + Math.min(col * g.spacing.x, g.width), valid.at(-1) ? sample * g.elevationScale : 0,
                g.origin.z + Math.min(row * g.spacing.z, g.depth));
        }
        for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
            const a = r * (nc + 1) + c, b = a + 1, d = (r + 1) * (nc + 1) + c + 1, below = d - 1;
            for (const tri of [[a, below, b], [b, below, d]]) if (tri.every(i => valid[i])) indices.push(...tri);
        }
        if (indices.length) {
            // Shared triangle edges are not physical ridges. Without this correction,
            // Rapier can generate sideways/upward edge impulses even on a flat grid.
            const collider = world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(vertices), new Uint32Array(indices), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
                .setFriction(0).setRestitution(policy.restitution ?? invariants.physics.restitution));
            handles.add(collider.handle);
        }
    }
    return handles;
}
/** Read actual terrain support manifolds; upward normal excludes walls and separating bounce contacts. */
function terrainSupport(world, collider, handles, velocity) {
    const normals = [];
    world.contactPairsWith(collider, other => {
        if (!handles.has(other.handle)) return;
        world.contactPair(collider, other, manifold => {
            let n = manifold.normal();
            if (n.y < 0) n = { x: -n.x, y: -n.y, z: -n.z };
            if (n.y < 0.3 || velocity.x * n.x + velocity.y * n.y + velocity.z * n.z > 0.5) return;
            for (let i = 0; i < manifold.numContacts(); i++) if (manifold.contactDist(i) < 0.025) normals.push(n);
        });
    });
    if (!normals.length) return null;
    const sum = normals.reduce((a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }), { x: 0, y: 0, z: 0 });
    const len = Math.hypot(sum.x, sum.y, sum.z);
    return { x: sum.x / len, y: sum.y / len, z: sum.z / len };
}
module.exports = { createTerrainColliders, terrainSupport };
