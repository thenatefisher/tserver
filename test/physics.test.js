const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, worldSize } = require('../modules/contracts');
const { validateGlb, decodeGlb } = require('../modules/actors/glb');
const { createSolidBody } = require('../modules/physics/body');
const { TerrainModel } = require('../modules/terrain/model');
const { terrainContact } = require('../modules/physics/contacts');
const { integrateActor, PhysicsModel, rotateBodyToWorld } = require('../modules/physics');
const { createMap } = require('../modules/terrain');
const { SessionManager } = require('../modules/sessions/manager');
const { add } = require('../modules/physics/vector');
const fixture = require('./mesh-fixture');

/** Create a one-post flat solid terrain; its sampled height is constant everywhere. */
function flatTerrain(height = 0) {
    return new TerrainModel({ type: 'dted', width: worldSize.x, depth: worldSize.z, columns: 1, rows: 1, origin: { x: -worldSize.x / 2, z: -worldSize.z / 2 }, spacing: { x: worldSize.x, z: worldSize.z }, elevationScale: 0.1, depthMap: [Math.round(height / 0.1)] });
}
/** Build a registered-style solid cube state without a socket or session. */
function actor(options = {}, mesh = fixture()) {
    return { id: 'a', name: 'Cube', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, order: 'XYZ' }, rotationalRates: { x: 0, y: 0, z: 0 }, body: createSolidBody(validateGlb(decodeGlb(mesh.glb))), ...options };
}
/** Advance an actor repeatedly, retaining all private COM and contact state. */
function simulate(state, action, seconds, environment) {
    for (let i = 0; i < Math.round(seconds * 60); i++) state = integrateActor(state, action, 1 / 60, environment);
    return state;
}

test('per-axis schema limits allow continuous vertical thrust while rejecting overflow', () => {
    validate('actions', { linear: { x: 3, y: 1, z: 5 }, angular: { x: 1, y: -1, z: 1 } });
    validate('actions', { linear: { x: -3, y: -1, z: -5 } });
    for (const linear of [{ x: 3.01 }, { x: -3.01 }, { y: 1.01 }, { z: 5.01 }]) assert.throws(() => validate('actions', { linear }));
});

test('uniform density uses enclosed volume for mass and box centroid for COM', () => {
    const small = actor({}, fixture({ translation: [0.5, 0, 0] })).body;
    const large = actor({}, fixture({ scale: 2 })).body;
    assert.deepEqual(small.centerOfMass, { x: 0.5, y: 0, z: 0.5 });
    assert.ok(Math.abs(large.mass / small.mass - 8) < 1e-8);
    assert.equal(small.density, large.density);
    assert.equal(small.indices.length, 36);
    assert.ok(Object.isFrozen(small.vertices[0]));
    const source = validateGlb(decodeGlb(fixture().glb));
    createSolidBody(source);
    assert.ok(!Object.isFrozen(source.geometry.vertices[0]), 'shape construction does not freeze source geometry');
});

test('ground contact blocks lateral slide and spin but permits wheel-like forward motion', () => {
    const environment = { terrain: flatTerrain(), rollingFriction: 0.6 };
    const sideways = simulate(actor(), { linear: { y: 1 }, angular: { x: 1, y: 1, z: 1 } }, 1, environment);
    assert.ok(Math.abs(sideways.position.z) < 1e-10);
    assert.deepEqual(sideways.rotationalRates, { x: 0, y: 0, z: 0 });
    assert.deepEqual(sideways.orientation, { x: 0, y: 0, z: 0, order: 'XYZ' });
    const forward = simulate(actor(), { linear: { x: 3 } }, 1, environment);
    assert.ok(forward.position.x > 10); assert.ok(forward.velocity.x > 20);
    const facingLeft = actor({ orientation: { x: 0, y: 0, z: Math.PI / 2, order: 'XYZ' } });
    const moved = simulate(facingLeft, { linear: { x: 1, y: 1 } }, 0.5, environment);
    assert.ok(moved.position.z < -0.5); assert.ok(Math.abs(moved.position.x) < 1e-8);
});

test('5g vertical input launches naturally; release falls and lands without penetration', () => {
    const environment = { terrain: flatTerrain() };
    const launched = simulate(actor(), { linear: { z: 5 } }, 0.2, environment);
    assert.ok(launched.position.y > 0.5); assert.ok(launched.velocity.y > 7);
    assert.equal(launched.grounded, false);
    const airborne = simulate(launched, { angular: { z: 1 } }, 0.1, environment);
    assert.ok(airborne.rotationalRates.z > 0);
    const landed = simulate(airborne, {}, 3, environment);
    assert.equal(landed.grounded, true); assert.ok(Math.abs(landed.velocity.y) < 1e-8);
    const contact = terrainContact(landed, environment);
    assert.ok(landed.position.y >= contact.height - 1e-8);
    assert.deepEqual(landed.rotationalRates, { x: 0, y: 0, z: 0 });
});

test('airborne rotation preserves an off-center solid visual-box COM', () => {
    const initial = actor({ position: { x: 0, y: 10, z: 0 }, centerVelocity: { x: 0, y: 0, z: 0 } }, fixture({ translation: [0.5, 0, 0] }));
    const before = add(initial.position, rotateBodyToWorld(initial.body.centerOfMass, initial.orientation));
    const next = simulate(initial, { angular: { z: 1 } }, 0.5, { gravity: 0 });
    const after = add(next.position, rotateBodyToWorld(next.body.centerOfMass, next.orientation));
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(after[axis] - before[axis]) < 1e-8);
    assert.ok(Math.abs(next.position.z) > 0.01);
});

test('terrain solid catches rotated geometry and a ridge under a face interior', () => {
    const terrain = new TerrainModel({ columns: 3, rows: 3, origin: { x: -0.25, z: -0.25 }, spacing: { x: 0.5, z: 0.5 }, elevationScale: 0.1, depthMap: [0,0,0,0,10,0,0,0,0] });
    const inward = simulate(actor({}, fixture({ reverseWinding: true })), {}, 0.1, { terrain: flatTerrain() });
    assert.ok(Math.abs(inward.position.y) < 1e-8, 'inward GLB winding is corrected for contact surfaces');
    const ridgeContact = terrainContact(actor(), { terrain });
    assert.ok(Math.abs(ridgeContact.height - 1) < 1e-8);
    const tilted = simulate(actor({ orientation: { x: Math.PI / 4, y: 0, z: 0, order: 'XYZ' } }), {}, 0.1, { terrain: flatTerrain() });
    for (const vertex of tilted.body.vertices) assert.ok(add(tilted.position, rotateBodyToWorld(vertex, tilted.orientation)).y >= -1e-8);
});

test('solid actors cannot pass through each other and response respects mass', () => {
    const a = actor({ id: 'a', position: { x: -0.6, y: 5, z: 0 }, velocity: { x: 3, y: 0, z: 0 } });
    const b = actor({ id: 'b', position: { x: 1, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }, fixture({ scale: 2 }));
    const model = new PhysicsModel({ actors: [a, b], projectiles: [] }, undefined, { gravity: 0 });
    for (let i = 0; i < 20; i++) model.step({}, 1 / 60);
    const [left, right] = model.getState().actors;
    assert.ok(left.position.x + 0.5 <= right.position.x - 1 + 1e-6);
    assert.ok(right.centerVelocity.x > 0 && right.centerVelocity.x < 1);
    assert.ok(Math.abs(left.centerVelocity.x - right.centerVelocity.x) < 1e-8);
});

test('each session generates an isolated immutable terrain model and target reset preserves it', () => {
    const sessions = new SessionManager(), a = sessions.createSession({ id: 'a', map: createMap({ seed: 11 }) }), b = sessions.createSession({ id: 'b', map: createMap({ seed: 22 }) });
    assert.notEqual(a.terrain, b.terrain);
    assert.notDeepEqual(a.terrain.grid.depthMap, b.terrain.grid.depthMap);
    const before = [...a.terrain.grid.depthMap], grid = a.data.map.terrain;
    Reflect.set(grid.depthMap, 0, 999); Reflect.set(a.data.map, 'terrain', b.terrain.grid);
    assert.deepEqual(a.terrain.grid.depthMap, before);
    assert.equal(a.data.map.terrain, grid);
    a.resetTargets(); assert.equal(a.data.map.terrain, grid);
    assert.deepEqual(a.terrain.grid.depthMap, before);
    a.actors.create('player', 'address'); a.actors.register('player', fixture.registration());
    const body = a.data.actors.get('player').body;
    assert.ok(body.solid); assert.equal(a.physics.getState().actors[0].body, body);
    assert.ok(!('body' in a.snapshot().actors[0]), 'collision geometry remains private');
    sessions.close();
});
