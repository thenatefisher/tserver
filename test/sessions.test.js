const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { SessionManager } = require('../modules/sessions/manager');
const { SessionData } = require('../modules/sessions/data-store');
const { initializePhysics, normalizeAction } = require('../modules/physics');
const { createMap, sampleTerrainHeight } = require('../modules/terrain');
const meshFixture = require('./mesh-fixture');
const frame = require('./control-frame');
before(() => initializePhysics());

test('sessions own independent actors, meshes, terrain, bans, and physics instances', () => {
    const manager = new SessionManager();
    const a = manager.createSession({ id: 'a' }), b = manager.createSession({ id: 'b' });
    assert.notEqual(a.physics, b.physics);
    assert.notEqual(a.data.map, b.data.map);
    const actor = a.actors.create('player', 'address');
    a.actors.register(actor.id, meshFixture.registration());
    const initialX = actor.position.x;
    a.actors.action(actor.id, frame({ move: { x: 1 } }));
    for (let i = 0; i < 10; i++) a.tick(); a.snapshot();
    assert.ok(a.data.state.actors[0].position.x > initialX);
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
    assert.throws(() => data.set('terrain', createMap()), /immutable/);
    data.set('terrain', { ...data.map, targets: [] });
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

test('neutral internal frames contain every control without retaining prior acceleration', () => {
    assert.deepEqual(normalizeAction(), { ...frame(), sequence: -1 });
});

test('terrain grids and height samples are stable and finite', () => {
    const map = createMap({ seed: 0 });
    assert.equal(map.terrain.depthMap.length, Math.ceil(map.size.x / map.terrain.spacing.x) * Math.ceil(map.size.z / map.terrain.spacing.z));
    assert.equal(sampleTerrainHeight(map.terrain, 0, 0), 2.5);
    assert.ok(Number.isFinite(sampleTerrainHeight(map.terrain, 1000, -1000)));
});
