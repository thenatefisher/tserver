/**
 * Build immutable solid actor shapes from validated, transformed GLB geometry.
 * Inputs: vertex/index geometry, visual bounds, enclosed volume and uniform density.
 * Outputs: collision mesh, approximate center of mass, mass and box inertia.
 * Side effects: freezes newly constructed shape data; does not modify source geometry.
 * Coupling: receives GLB validation results; consumed by contacts and integration.
 */
const { add, scale, cross, normalize } = require('./vector');
const { deepFreeze } = require('../shared/immutable');

/** Cache parallel surface probes once; runtime rotates only downward-facing groups. */
function contactSurfaces(vertices, indices) {
    const groups = new Map();
    for (let i = 0; i < indices.length; i += 3) {
        const ids = indices.slice(i, i + 3), [a, b, c] = ids.map(id => vertices[id]);
        const normal = normalize(cross(add(b, scale(a, -1)), add(c, scale(a, -1))));
        if (Math.hypot(normal.x, normal.y, normal.z) < 1e-8) continue;
        const key = [normal.x, normal.y, normal.z].map(value => value.toFixed(7)).join(',');
        if (!groups.has(key)) groups.set(key, { normal, samples: new Map(), triangles: [] });
        const group = groups.get(key);
        group.triangles.push(ids);
        const samples = [a, b, c, scale(add(a, b), 0.5), scale(add(b, c), 0.5), scale(add(c, a), 0.5), scale(add(add(a, b), c), 1 / 3)];
        for (const point of samples) group.samples.set([point.x, point.y, point.z].map(value => value.toFixed(7)).join(','), point);
    }
    return [...groups.values()].map(group => ({ normal: group.normal, samples: [...group.samples.values()], triangles: group.triangles }));
}

/** Approximate mass center by the visual-box centroid; mass uses actual mesh volume. */
function createSolidBody(info, density = 1) {
    if (!Number.isFinite(density) || density <= 0) throw new Error('Density must be positive');
    const geometry = info.geometry || info;
    const vertices = structuredClone(geometry.vertices), indices = [...geometry.indices];
    const bounds = structuredClone(info.bounds);
    const centerOfMass = {}, size = {};
    for (const axis of ['x', 'y', 'z']) {
        centerOfMass[axis] = (bounds.min[axis] + bounds.max[axis]) / 2;
        size[axis] = bounds.max[axis] - bounds.min[axis];
    }
    const mass = info.volume * density;
    return deepFreeze({
        solid: true, density, volume: info.volume, mass, bounds, centerOfMass,
        // A box tensor is an approximation, consistent with the requested box COM.
        inertia: {
            x: mass * (size.y ** 2 + size.z ** 2) / 12,
            y: mass * (size.x ** 2 + size.z ** 2) / 12,
            z: mass * (size.x ** 2 + size.y ** 2) / 12
        },
        vertices, indices,
        surfaces: contactSurfaces(vertices, indices)
    });
}
module.exports = { createSolidBody };
