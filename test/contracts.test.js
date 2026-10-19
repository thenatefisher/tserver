const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, schemas, invariants, worldSize, orientationOrder } = require('../modules/contracts');
const { SessionManager } = require('../modules/sessions/manager');
const { createMap, validateMap, sampleTerrainHeight } = require('../modules/terrain');
const { rotateBodyToWorld, integrateActor } = require('../modules/physics');
const { decodeGlb, validateGlb } = require('../modules/actors/glb');
const fixture = require('./mesh-fixture');

test('schemas define allowed registration fields and exact action payloads', () => {
    validate('actor', fixture.registration());
    assert.throws(() => validate('actor', fixture.registration({ physicsProfile: { maxSpeed: 25, angularAcceleration: 4 } })), /additional properties/);
    assert.throws(() => validate('actor', fixture.registration({ name: 'x'.repeat(schemas.actor.properties.name.maxLength + 1) })), /characters/);
    for (const bad of [{ accel: { x: 1 } }, { angularAccel: { y: 1 } }, { moment: {} }, { fire: true }, { linear: { x: 1.01 } }, { angular: { x: NaN } }]) assert.throws(() => validate('actions', bad));
    validate('actions', { linear: { x: 1, y: 1, z: 1 }, angular: { z: -1 } });
    assert.throws(() => validate('mesh', { ...fixture(), metadata: { visualSize: { x: 1, y: 1, z: 1 }, projectileOrigins: [{ id: 'too-long-id', position: { x: 0, y: 0, z: 0 } }] } }));
});

test('partial action components persist and physical units follow the schema', () => {
    const manager = new SessionManager(), session = manager.createSession({ environment: { gravity: 0, groundFriction: 0, angularFriction: 0 } });
    const actor = session.actors.create('actor', 'address'); session.actors.register('actor', fixture.registration());
    session.actors.action('actor', { linear: { x: 1, y: 0.5 }, angular: { z: 1 } });
    session.actors.action('actor', { linear: { x: 0 } });
    assert.deepEqual(actor.action, { linear: { x: 0, y: 0.5, z: 0 }, angular: { x: 0, y: 0, z: 1 } });
    session.actors.action('actor', { linear: { x: 1, y: 0 } });
    session.tick(); const state = session.snapshot();
    assert.ok(Math.abs(state.actors[0].velocity.x - invariants.input.standardGravityMetersPerSecondSquared / session.tickRate) < 1e-8);
    assert.ok(Math.abs(state.actors[0].rotationalRates.z - 1 / session.tickRate) < 1e-8);
    assert.equal(state.actors[0].orientation.order, orientationOrder);
    validate('state', state);
    manager.close();
});

test('body axes and intrinsic Euler XYZ map to world coordinates', () => {
    assert.deepEqual(rotateBodyToWorld({ x: 1 }), { x: 1, y: 0, z: -0 });
    assert.deepEqual(rotateBodyToWorld({ y: 1 }), { x: 0, y: 0, z: -1 });
    assert.deepEqual(rotateBodyToWorld({ z: 1 }), { x: 0, y: 1, z: -0 });
    const forwardAfterYaw = rotateBodyToWorld({ x: 1 }, { z: Math.PI / 2, order: orientationOrder });
    assert.ok(Math.abs(forwardAfterYaw.x) < 1e-10); assert.ok(Math.abs(forwardAfterYaw.z + 1) < 1e-10);
    const actor = integrateActor({ position: { y: 10 } }, { angular: { z: 1 } }, 0.1, { gravity: 0 });
    assert.equal(actor.rotationalRates.z, 0.1);
});

test('world uses schema dimensions, half-open integer terrain, and no-data interpolation', () => {
    const map = createMap({ spacing: { x: 250, z: 250 } });
    validate('world', map); assert.deepEqual(map.size, worldSize);
    assert.equal(map.terrain.columns, 4); assert.equal(map.terrain.rows, 4);
    assert.ok(map.terrain.depthMap.every(Number.isInteger));
    const bad = structuredClone(map); bad.terrain.depthMap.pop();
    assert.throws(() => validateMap(bad), /grid dimensions/);
    const t = { columns: 2, rows: 2, origin: { x: 0, z: 0 }, spacing: { x: 1, z: 1 }, elevationScale: 0.1, noDataValue: -32767, depthMap: [10, -32767, 30, 40] };
    assert.ok(Math.abs(sampleTerrainHeight(t, 0.5, 0.5) - 8 / 3) < 1e-10);
    t.depthMap.fill(t.noDataValue); assert.ok(Number.isNaN(sampleTerrainHeight(t, 0, 0)));
});

test('actual transformed GLB geometry controls bounds and minimum volume', () => {
    const result = validateGlb(decodeGlb(fixture().glb));
    assert.equal(result.volume, invariants.geometryLimits.minMeshVolumeCubicMeters);
    assert.equal(result.triangles, 12);
    assert.throws(() => validateGlb(decodeGlb(fixture({ scale: 0.5 }).glb)), /volume/);
    assert.throws(() => validateGlb(decodeGlb(fixture({ translation: [10, 0, 0] }).glb)), /cube/);
    const truncated = decodeGlb(fixture().glb).subarray(0, 30);
    assert.throws(() => validateGlb(truncated), /length/);
});

test('hit events are transient across schema-valid state broadcasts', () => {
    const manager = new SessionManager(), session = manager.createSession();
    const hit = { id: 'hit', targetId: 't', sourceId: 's', damage: 1, remainingHealth: 99, hitLocation: { x: 0, y: 0, z: 0 } };
    session.queueHit(hit); assert.deepEqual(session.snapshot().hitEvents, [hit]);
    assert.deepEqual(session.snapshot().hitEvents, []);
    manager.close();
});
