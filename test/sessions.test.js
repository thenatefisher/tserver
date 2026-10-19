const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../modules/sessions/manager');
const { SessionData } = require('../modules/sessions/data-store');
const { integrateActor, normalizeAction } = require('../modules/physics');
const { createMap, sampleTerrainHeight } = require('../modules/terrain');
const meshFixture = require('./mesh-fixture');

test('sessions own independent actors, meshes, terrain, bans, and physics instances', () => {
    const manager = new SessionManager();
    const a = manager.createSession({ id: 'a' }), b = manager.createSession({ id: 'b' });
    assert.notEqual(a.physics, b.physics);
    assert.notEqual(a.data.map, b.data.map);
    const actor = a.actors.create('player', 'address');
    a.actors.register(actor.id, meshFixture.registration());
    const initialX = actor.position.x;
    a.actors.action(actor.id, { linear: { x: 1 }, angular: { z: 1 } });
    a.tick(); a.snapshot();
    assert.ok(a.data.state.actors[0].position.x > initialX);
    assert.ok(a.data.state.actors[0].rotationalRates.z > 0);
    assert.equal(b.data.actors.size, 0); assert.equal(b.data.meshes.size, 0);
    const terrainVersion = b.data.resources.get('terrain').version;
    a.resetTargets();
    assert.equal(b.data.resources.get('terrain').version, terrainVersion);
    a.actors.ban(actor.id, () => {});
    assert.throws(() => a.actors.create('returning', 'address'), /banned/);
    assert.doesNotThrow(() => b.actors.create('returning', 'address'));
    assert.equal(a.physics.getState().actors.length, 0);
    manager.close();
});

test('receipt manifest separates required, sent, acknowledged and invalidated data', () => {
    const data = new SessionData('a', createMap());
    data.addClient('one'); data.addClient('two');
    assert.equal(data.manifest('one').resources.find(e => e.resource === 'terrain').needsUpdate, true);
    assert.equal(data.acknowledge('one', 'terrain', 1), false, 'cannot acknowledge unsent data');
    data.sent('one', 'terrain', 1);
    assert.equal(data.manifest('one').resources.find(e => e.resource === 'terrain').needsUpdate, true);
    assert.ok(data.pending('one', true).includes('terrain'), 'unacknowledged delivery is retried');
    assert.equal(data.acknowledge('one', 'terrain', 1), true);
    assert.equal(data.manifest('one').resources.find(e => e.resource === 'terrain').needsUpdate, false);
    assert.equal(data.manifest('two').resources.find(e => e.resource === 'terrain').needsUpdate, true);
    data.set('terrain', createMap());
    assert.ok(data.pending('one').includes('terrain'));
    assert.equal(data.acknowledge('one', 'terrain', 2), false);
    data.register('actor', { id: 'actor' }, { buffer: Buffer.from('mesh') });
    assert.ok(!data.pending('one').includes('mesh:actor'), 'mesh is requested on demand');
    data.subscribe('one', 'mesh:actor'); data.sent('one', 'mesh:actor', 1); data.acknowledge('one', 'mesh:actor', 1);
    data.removeActor('actor');
    assert.ok(data.pending('one').includes('mesh:actor'));
    assert.equal(data.manifest('one').resources.find(e => e.resource === 'mesh:actor').deleted, true);
});

test('registration rejection is atomic and re-registration versions geometry', () => {
    const manager = new SessionManager(), session = manager.createSession();
    session.actors.create('p', 'address');
    assert.throws(() => session.actors.register('p', { name: 'bad', mesh: { glb: 'bad' } }));
    assert.notEqual(session.data.actors.get('p').name, 'bad');
    session.actors.register('p', meshFixture.registration());
    session.actors.register('p', meshFixture.registration({ name: 'new' }));
    assert.equal(session.data.resources.get('mesh:p').version, 2);
    assert.equal(session.data.registrations.get('p').name, 'new');
    manager.close();
});

test('physics clamps authoritative model positions and friction never reverses motion', () => {
    const actor = { position: { x: 96.99, y: 0, z: 0 }, velocity: { x: 25, y: 0, z: 0 } };
    const constrained = integrateActor(actor, {}, 1 / 30, { groundHeight: 0, bounds: { minX: -97, maxX: 97, minZ: -97, maxZ: 97 } });
    assert.equal(constrained.position.x, 97); assert.equal(constrained.velocity.x, 0);
    const still = integrateActor({ position: { y: 0 } }, { angular: { z: 0.1 } }, 1 / 30, { groundHeight: 0, angularFriction: 5 });
    assert.equal(still.rotationalRates.z, 0);
    const moving = integrateActor({ position: { y: 0 }, velocity: { x: 0.01 } }, {}, 1 / 30, { groundHeight: 0 });
    assert.ok(moving.velocity.x >= -1e-12);
    assert.deepEqual(normalizeAction({ angular: { y: Infinity } }).angular, { x: 0, y: 0, z: 0 });
});

test('terrain grids and height samples are stable and finite', () => {
    const map = createMap();
    assert.equal(map.terrain.depthMap.length, Math.ceil(map.size.x / map.terrain.spacing.x) * Math.ceil(map.size.z / map.terrain.spacing.z));
    assert.equal(sampleTerrainHeight(map.terrain, 0, 0), 2.5);
    assert.ok(Number.isFinite(sampleTerrainHeight(map.terrain, 1000, -1000)));
});
