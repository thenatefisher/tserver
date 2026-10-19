/**
 * Resolve contacts between closed solid actor meshes within one physics session.
 * Inputs: actor states containing immutable triangle meshes and environment limits.
 * Outputs: the same working actor array with separated poses/COM velocities.
 * Side effects: mutates only working physics states, never registered geometry.
 * Coupling: mesh narrow-phase, body transforms, mass weighting and terrain projection.
 * Response uses an inelastic box-axis separation approximation after an actual mesh
 * intersection test; it is not a general rigid-body angular impulse solver.
 */
const { add, scale, dot, cross, vector } = require('./vector');
const { rotateBodyToWorld } = require('./rotation');
const { terrainContact } = require('./contacts');
const { wheelMotion } = require('./friction');
const { constrain } = require('./constraints');

/** Transform one immutable mesh and compute its broad-phase world bounds. */
function worldMesh(actor) {
    const vertices = actor.body.vertices.map(vertex => add(actor.position, rotateBodyToWorld(vertex, actor.orientation)));
    const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    for (const vertex of vertices) for (const axis of ['x', 'y', 'z']) {
        bounds.min[axis] = Math.min(bounds.min[axis], vertex[axis]); bounds.max[axis] = Math.max(bounds.max[axis], vertex[axis]);
    }
    const triangles = [];
    for (let i = 0; i < actor.body.indices.length; i += 3) triangles.push(actor.body.indices.slice(i, i + 3).map(index => vertices[index]));
    return { vertices, triangles, bounds };
}

/** Ray/triangle intersection distance, or null; direction need not be unit length. */
function rayTriangle(origin, direction, triangle) {
    const [a, b, c] = triangle, edge1 = add(b, scale(a, -1)), edge2 = add(c, scale(a, -1));
    const h = cross(direction, edge2), determinant = dot(edge1, h);
    if (Math.abs(determinant) < 1e-10) return null;
    const s = add(origin, scale(a, -1)), u = dot(s, h) / determinant;
    if (u < -1e-8 || u > 1 + 1e-8) return null;
    const q = cross(s, edge1), v = dot(direction, q) / determinant;
    if (v < -1e-8 || u + v > 1 + 1e-8) return null;
    const t = dot(edge2, q) / determinant;
    return t > 1e-8 ? t : null;
}

/** Test the interior of a closed solid with a skew ray and deduplicated face hits. */
function inside(point, mesh) {
    const hits = new Set();
    for (const triangle of mesh.triangles) {
        const t = rayTriangle(point, { x: 1, y: 0.371, z: 0.529 }, triangle);
        if (t !== null) hits.add(Math.round(t * 1e7));
    }
    return hits.size % 2 === 1;
}

/** Detect containment or crossing surfaces; AABB overlap alone is insufficient. */
function intersects(a, b) {
    if (a.vertices.some(vertex => inside(vertex, b)) || b.vertices.some(vertex => inside(vertex, a))) return true;
    for (const triangle of a.triangles) for (let edge = 0; edge < 3; edge++) {
        const start = triangle[edge], direction = add(triangle[(edge + 1) % 3], scale(start, -1));
        for (const target of b.triangles) {
            const t = rayTriangle(start, direction, target);
            if (t !== null && t < 1 - 1e-8) return true;
        }
    }
    return false;
}

/** Choose the shortest separating box axis, including one solid containing another. */
function separation(a, b) {
    let depth = Infinity, normal;
    for (const axis of ['x', 'y', 'z']) {
        if (a.max[axis] <= b.min[axis] + 1e-7 || b.max[axis] <= a.min[axis] + 1e-7) return null;
        const negative = a.max[axis] - b.min[axis], positive = b.max[axis] - a.min[axis];
        if (Math.min(negative, positive) < depth) {
            depth = Math.min(negative, positive); normal = { x: 0, y: 0, z: 0 }; normal[axis] = negative <= positive ? 1 : -1;
        }
    }
    return { depth, normal };
}

/** Apply mass-weighted separation and a zero-restitution normal impulse in place. */
function resolvePair(a, b, contact) {
    const inverseA = 1 / a.body.mass, inverseB = 1 / b.body.mass, total = inverseA + inverseB;
    const { normal, depth } = contact;
    a.position = add(a.position, scale(normal, -(depth + 1e-7) * inverseA / total));
    b.position = add(b.position, scale(normal, (depth + 1e-7) * inverseB / total));
    const velocityA = vector(a.centerVelocity || a.velocity), velocityB = vector(b.centerVelocity || b.velocity);
    const relative = dot(add(velocityB, scale(velocityA, -1)), normal);
    const impulse = Math.max(0, -relative / total);
    a.centerVelocity = add(velocityA, scale(normal, -impulse * inverseA));
    b.centerVelocity = add(velocityB, scale(normal, impulse * inverseB));
    for (const actor of [a, b]) { actor.rotationalRates = { x: 0, y: 0, z: 0 }; actor.velocity = { ...actor.centerVelocity }; }
}

/** Iterate nearby solid pairs and re-project terrain after positional corrections. */
function resolveActorContacts(actors, limits) {
    const solids = actors.filter(actor => actor.body?.solid);
    for (let iteration = 0; iteration < 4; iteration++) {
        let changed = false;
        const cache = new Map();
        /** Cache transformed meshes for this solver iteration; invalidate moved actors below. */
        const meshFor = actor => { if (!cache.has(actor)) cache.set(actor, worldMesh(actor)); return cache.get(actor); };
        for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
            const a = solids[i], b = solids[j], meshA = meshFor(a), meshB = meshFor(b);
            const contact = separation(meshA.bounds, meshB.bounds);
            if (!contact || !intersects(meshA, meshB)) continue;
            resolvePair(a, b, contact); cache.delete(a); cache.delete(b); changed = true;
            for (const actor of [a, b]) {
                const terrain = terrainContact(actor, limits);
                if (Number.isFinite(terrain.height) && actor.position.y <= terrain.height + 1e-7) {
                    actor.position.y = Math.max(actor.position.y, terrain.height);
                    actor.centerVelocity = wheelMotion(actor.centerVelocity, { x: 0, y: 0, z: 0 }, actor.orientation, terrain.normal, 0, limits).velocity;
                    actor.grounded = true;
                }
                // Pair separation must obey the same world and speed constraints
                // as ordinary movement, including clearing blocked COM velocity.
                actor.velocity = actor.centerVelocity;
                constrain(actor, { ...(actor.physicsProfile || {}), ...limits });
                actor.centerVelocity = { ...actor.velocity };
            }
        }
        if (!changed) break;
    }
    return actors;
}
module.exports = { resolveActorContacts };
