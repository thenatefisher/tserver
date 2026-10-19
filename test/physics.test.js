const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { validate, invariants } = require('../modules/contracts');
const { validateGlb, decodeGlb } = require('../modules/actors/glb');
const { createSolidBody } = require('../modules/physics/body');
const { TerrainModel } = require('../modules/terrain/model');
const { PhysicsModel, initializePhysics, rotateBodyToWorld, worldQuaternion, bodyOrientation, RAPIER } = require('../modules/physics');
const { createMap } = require('../modules/terrain');
const { SessionManager } = require('../modules/sessions/manager');
const { add, dot } = require('../modules/physics/vector');
const fixture = require('./mesh-fixture'), frame = require('./control-frame');
before(() => initializePhysics());

/** Build a physical plane with an optional X gradient, including half-open edge posts. */
function terrain(slope = 0) {
    return new TerrainModel({ type: 'dted', width: 1000, depth: 1000, columns: 2, rows: 2,
        origin: { x: -500, z: -500 }, spacing: { x: 500, z: 500 }, elevationScale: 0.1,
        depthMap: [-5000 * slope, 0, -5000 * slope, 0] });
}
/** Build a registered cube, with physical root at the origin and COM above it. */
function actor(overrides = {}, mesh = fixture()) {
    return { id: 'a', name: 'Cube', health: 100, position: { x: -10, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, order: 'XYZ' }, rotationalRates: { x: 0, y: 0, z: 0 },
        physicsProfile: { maxSpeed: 100, controller: 'ground' }, body: createSolidBody(validateGlb(decodeGlb(mesh.glb))), ...overrides };
}
/** Allocate an owned model and register cleanup even when an assertion fails. */
function model(t, actors = [actor()], environment = { terrain: terrain() }) {
    const m = new PhysicsModel({ actors }, undefined, environment); t.after(() => m.close()); return m;
}
/** Refresh complete held-state frames each tick so this helper does not accidentally test timeout. */
function run(m, seconds, controls = {}) {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
        const actions = Object.fromEntries(m.state.actors.map(a => [a.id, frame({ ...controls, sequence: Math.round(m.time * 120) + 1 })]));
        m.step(actions, 1 / 60);
    }
    return m.getState().actors[0];
}

test('v2 controls reject partial, legacy, nonfinite and out-of-range frames', () => {
    validate('actions', frame({ move: { x: 1, y: -1, z: 1 }, brake: 1 }));
    for (const bad of [{}, { linear: { x: 1 } }, frame({ move: { x: 1.01 } }), frame({ rotate: { y: NaN } }), frame({ sequence: -1 }), frame({ protocolVersion: 1 })]) assert.throws(() => validate('actions', bad));
    const partial = frame(); delete partial.move.y; assert.throws(() => validate('actions', partial));
});

test('uniform-density solids retain actual volume mass, visual-box COM and nonmutating construction', () => {
    const small = actor({}, fixture({ translation: [0.5, 0, 0] })).body, large = actor({}, fixture({ scale: 2 })).body;
    assert.deepEqual(small.centerOfMass, { x: 0.5, y: 0, z: 0.5 });
    assert.ok(Math.abs(large.mass / small.mass - 8) < 1e-8); assert.ok(Object.isFrozen(small.vertices[0]));
    const source = validateGlb(decodeGlb(fixture().glb)); createSolidBody(source);
    assert.ok(!Object.isFrozen(source.geometry.vertices[0]));
});

test('Rapier quaternion boundary preserves the body basis and Euler XYZ orientation', () => {
    const o = { x: 0.3, y: -0.4, z: 1, order: 'XYZ' }, restored = bodyOrientation(worldQuaternion(o));
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(restored[axis] - o[axis]) < 1e-10);
});

test('ground controller grips laterally, drives forward, permits yaw and suppresses commanded pitch/roll', t => {
    const m = model(t); run(m, 0.5);
    const before = m.getState().actors[0].position;
    const moved = run(m, 1, { move: { x: 1, y: 1, z: 1 }, rotate: { x: 1, y: 1 } });
    assert.ok(moved.position.x > before.x + 5);
    assert.ok(Math.abs(moved.position.z - before.z) < 0.05);
    assert.ok(Math.abs(moved.orientation.x) < 0.02 && Math.abs(moved.orientation.y) < 0.02);
    const turned = run(m, 1, { rotate: { z: 1 } }); assert.ok(turned.orientation.z > 0.05);
});

test('hill contact changes attitude and settles a tilted landing to the terrain normal', t => {
    const ground = terrain(0.2), m = model(t, [actor({ position: { x: -100, y: -17, z: -10 }, orientation: { x: 0.25, y: -0.35, z: 0.1, order: 'XYZ' } })], { terrain: ground });
    const settled = run(m, 6, { rotate: { x: 1, y: 1 } });
    assert.equal(settled.grounded, true);
    const up = rotateBodyToWorld({ z: 1 }, settled.orientation), normal = ground.surfaceAt(settled.position.x, settled.position.z).normal;
    assert.ok(dot(up, normal) > 0.995, JSON.stringify({ up, normal }));
    assert.ok(Math.abs(settled.orientation.y) > 0.1, 'attitude represents hill pitch');
});

test('jump is one grounded rising edge; held jump does not relaunch, release/repress can jump', t => {
    const m = model(t); run(m, 0.5);
    const launched = run(m, 0.1, { jump: true }); assert.ok(launched.centerVelocity.y > 3); assert.equal(launched.grounded, false);
    const landed = run(m, 4, { jump: true }); assert.equal(landed.grounded, true); assert.ok(Math.abs(landed.centerVelocity.y) < 0.05);
    run(m, 0.1); const again = run(m, 0.1, { jump: true }); assert.ok(again.centerVelocity.y > 3);
});

test('falling impacts bounce and then dissipate energy and settle', t => {
    const m = model(t, [actor({ position: { x: 0, y: 3, z: 0 } })]);
    let hit = false, rebound = false;
    for (let i = 0; i < 180; i++) {
        const a = m.step({}, 1 / 60).actors[0];
        if (a.position.y < 0.05 && a.centerVelocity.y < -2) hit = true;
        if (hit && a.centerVelocity.y > 0.5) { rebound = true; assert.equal(a.grounded, false); }
    }
    assert.ok(rebound, 'nonzero restitution must produce a separating rebound');
    const settled = run(m, 3); assert.equal(settled.grounded, true); assert.ok(Math.abs(settled.centerVelocity.y) < 0.05);
});

test('airborne off-center rotation preserves COM when gravity is disabled', t => {
    const initial = actor({ position: { x: 0, y: 10, z: 0 } }, fixture({ translation: [0.5, 0, 0] }));
    const m = model(t, [initial], { gravity: 0 });
    const before = add(initial.position, rotateBodyToWorld(initial.body.centerOfMass, initial.orientation));
    const moved = run(m, 0.5, { rotate: { z: 1 } });
    const after = add(moved.position, rotateBodyToWorld(moved.body.centerOfMass, moved.orientation));
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(after[axis] - before[axis]) < 1e-5);
});

test('Rapier actor collisions transfer momentum according to volume mass', t => {
    const a = actor({ position: { x: -2, y: 10, z: 0 }, velocity: { x: 3, y: 0, z: 0 } });
    const b = actor({ id: 'b', position: { x: 1, y: 10, z: 0 } }, fixture({ scale: 2 }));
    const m = model(t, [a, b], { gravity: 0, restitution: 0 }); run(m, 1);
    const [left, right] = m.getState().actors;
    assert.ok(left.position.x < right.position.x - 1.4);
    assert.ok(right.centerVelocity.x > 0 && right.centerVelocity.x < 1);
});

test('stale controls neutralize and duplicate sequences cannot refresh their lifetime', t => {
    const m = model(t, [actor({ position: { x: 0, y: 10, z: 0 }, physicsProfile: { maxSpeed: 100, controller: 'hover' } })], { gravity: 0 });
    const input = frame({ sequence: 7, move: { x: 1 } });
    for (let i = 0; i < 60; i++) m.step({ a: input }, 1 / 60);
    const a = m.getState().actors[0];
    assert.ok(a.centerVelocity.x > 6 && a.centerVelocity.x < 9, a.centerVelocity.x);
    assert.equal(a.lastInputSequence, 7);
    const speed = a.centerVelocity.x; m.step({ a: frame({ sequence: 8 }) }, 1 / 30);
    assert.ok(Math.abs(m.getState().actors[0].centerVelocity.x - speed) < 1e-5);
});

test('controller modes implement mecha strafe, hover support, flight lift and planar boat buoyancy', t => {
    const mecha = model(t, [actor({ physicsProfile: { maxSpeed: 100, controller: 'mecha' } })]);
    run(mecha, 0.5); assert.ok(run(mecha, 1, { move: { y: 1 } }).position.z < -0.1);
    const hover = model(t, [actor({ position: { x: -10, y: 0, z: 0 }, physicsProfile: { maxSpeed: 100, controller: 'hover' } })]);
    const hovering = run(hover, 4); assert.ok(hovering.position.y > 0.8 && hovering.position.y < 1.5);
    const plane = model(t, [actor({ position: { x: 0, y: 10, z: 0 }, velocity: { x: 10, y: 0, z: 0 }, physicsProfile: { maxSpeed: 100, controller: 'aircraft' } })], {});
    assert.ok(run(plane, 0.2, { move: { x: 0.1 } }).position.y > 9.8);
    const boat = model(t, [actor({ position: { x: 0, y: -1, z: 0 }, physicsProfile: { maxSpeed: 100, controller: 'boat' } })], { waterLevel: 0 });
    assert.ok(Math.abs(run(boat, 4).position.y + 0.5) < 0.05);
});

test('each session owns immutable terrain and a separately disposable Rapier world', () => {
    const sessions = new SessionManager(), a = sessions.createSession({ id: 'a', map: createMap({ seed: 11 }) }), b = sessions.createSession({ id: 'b', map: createMap({ seed: 22 }) });
    assert.notEqual(a.physics.world, b.physics.world); assert.notDeepEqual(a.terrain.grid.depthMap, b.terrain.grid.depthMap);
    const grid = a.data.map.terrain, before = [...grid.depthMap];
    Reflect.set(grid.depthMap, 0, 999); Reflect.set(a.data.map, 'terrain', b.terrain.grid);
    a.resetTargets(); assert.equal(a.data.map.terrain, grid); assert.deepEqual(grid.depthMap, before);
    a.actors.create('p', 'address'); a.actors.register('p', fixture.registration()); a.tick();
    assert.ok(!('body' in a.snapshot().actors[0]));
    sessions.removeSession('a'); assert.equal(a.physics.world, null); assert.ok(b.physics.world);
    sessions.close();
});


test('physical terrain rays match triangular queries, asymmetric axes and extended boundary heights', t => {
    const ground = new TerrainModel({ type: 'dted', width: 1000, depth: 1000, columns: 2, rows: 2,
        origin: { x: -500, z: -500 }, spacing: { x: 500, z: 500 }, elevationScale: 0.1, depthMap: [0, 100, 200, 400] });
    const m = model(t, [], { terrain: ground }); m.step({}, 1 / 120);
    for (const [x, z] of [[-400,-400],[-100,-200],[-250,-100],[400,100],[490,490]]) {
        const hit = m.world.castRay(new RAPIER.Ray({ x, y: 100, z }, { x: 0, y: -1, z: 0 }), 200, true);
        assert.ok(hit); assert.ok(Math.abs(100 - hit.timeOfImpact - ground.heightAt(x,z)) < 1e-4);
    }
});

test('world bounds and speed caps remain authoritative after Rapier integration', t => {
    const m = model(t, [actor({ position: { x: 9.99, y: 10, z: 0 }, velocity: { x: 50, y: 0, z: 0 }, physicsProfile: { maxSpeed: 10, controller: 'ground' } })],
        { gravity: 0, bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 } });
    const moved = run(m, 0.1); assert.equal(moved.position.x, 10); assert.equal(moved.centerVelocity.x, 0);
    const free = model(t, [actor({ position: { x: 0, y: 10, z: 0 }, velocity: { x: 50, y: 0, z: 0 }, physicsProfile: { maxSpeed: 10, controller: 'ground' } })], { gravity: 0 });
    assert.ok(run(free, 0.1).centerVelocity.x <= 10);
});


test('concave/disconnected solids retain their central gap through bounded convex decomposition', t => {
    const info = validateGlb(decodeGlb(fixture().glb));
    const vertices = [-1, 1].flatMap(y => info.geometry.vertices.map(v => ({ ...v, y: v.y + y })));
    const indices = [...info.geometry.indices, ...info.geometry.indices.map(i => i + info.geometry.vertices.length)];
    const body = createSolidBody({ geometry: { vertices, indices }, volume: 2,
        bounds: { min: { x: -0.5, y: -1.5, z: 0 }, max: { x: 0.5, y: 1.5, z: 1 } } });
    const m = model(t, [actor({ position: { x: 0, y: 10, z: 0 }, body })], { gravity: 0 }); m.step({}, 1/120);
    assert.ok(Math.abs(m.records.get('a').rb.mass() - 2) < 1e-5);
    const gap = m.world.castRay(new RAPIER.Ray({ x: 0, y: 20, z: 0 }, { x: 0, y: -1, z: 0 }), 30, true);
    assert.equal(gap, null, 'a convex hull must not fill this gap');
    const solid = m.world.castRay(new RAPIER.Ray({ x: 0, y: 20, z: 1 }, { x: 0, y: -1, z: 0 }), 30, true);
    assert.ok(solid);
});

test('terrain-only mode passes through actors and late-added obstacles while keeping ground support and mass', t => {
    const a = actor({ position: { x: -2, y: 10, z: 0 }, velocity: { x: 3, y: 0, z: 0 } });
    const b = actor({ id: 'b', position: { x: 2, y: 10, z: 0 }, velocity: { x: -3, y: 0, z: 0 } });
    const m = model(t, [a, b]);
    const mass = m.records.get('a').rb.mass(), terrainHandles = [...m.terrainHandles];
    assert.equal(m.disableObjectCollisions(), 2);
    m.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 50, 0.5));
    run(m, 1);
    const [left, right] = m.getState().actors;
    assert.ok(left.position.x > right.position.x, 'actors must cross each other and the static obstacle');
    run(m, 4);
    assert.ok(m.getState().actors.every(a => a.grounded && Math.abs(a.position.y) < 0.01));
    assert.equal(m.records.get('a').rb.mass(), mass); assert.deepEqual([...m.terrainHandles], terrainHandles);
    m.addActor(actor({ id: 'new', position: { x: 10, y: 2, z: 0 } })); run(m, 3);
    assert.ok(m.getState().actors.find(a => a.id === 'new').grounded);
    assert.equal(m.disableObjectCollisions(), 4, 'repeat calls include later actors and obstacles');
    m.flattenTerrain(terrain()); assert.equal(m.terrainOnlyCollisions, true);
    run(m, 0.2); assert.ok(m.getState().actors.every(a => a.grounded));
});


test('sustained forward-only driving remains grounded across flat triangle edges and chunk seams', t => {
    for (const spacing of [10, 500]) for (const terrainOnly of [false, true]) {
        const count = 1000 / spacing;
        const flat = new TerrainModel({ type: 'dted', width: 1000, depth: 1000, columns: count, rows: count,
            origin: { x: -500, z: -500 }, spacing: { x: spacing, z: spacing }, elevationScale: 0.1,
            depthMap: Array(count * count).fill(0) });
        const m = model(t, [actor({ position: { x: -20, y: 0, z: 2 }, physicsProfile: { maxSpeed: 25, controller: 'ground' } })], { terrain: flat });
        if (terrainOnly) m.disableObjectCollisions();
        let maxVerticalSpeed = 0, minimumUp = 1, maxHeight = 0;
        for (let i = 0; i < 600; i++) {
            const moved = m.step({ a: frame({ sequence: i, move: { x: 1 } }) }, 1/60).actors[0];
            maxVerticalSpeed = Math.max(maxVerticalSpeed, Math.abs(moved.centerVelocity.y));
            minimumUp = Math.min(minimumUp, rotateBodyToWorld({ z: 1 }, moved.orientation).y);
            maxHeight = Math.max(maxHeight, Math.abs(moved.position.y));
        }
        const detail = JSON.stringify({ spacing, terrainOnly, maxVerticalSpeed, minimumUp, maxHeight });
        assert.ok(maxVerticalSpeed < 0.01, detail);
        assert.ok(minimumUp > 0.999, detail);
        assert.ok(maxHeight < 0.005, detail);
        assert.ok(m.getState().actors[0].position.x > 200, 'must cross the default grid chunk boundary at X=140');
    }
});

test('grounded vehicles stop promptly after throttle release without reversing or damping airborne travel', t => {
    for (const controller of ['ground','mecha']) {
        const m=model(t,[actor({velocity:{x:25,y:0,z:0},physicsProfile:{controller,maxSpeed:100}})]);
        let maxReverse=0;
        for (let i=0;i<300;i++) {
            const moved=m.step({a:frame({sequence:i})},1/60).actors[0]; maxReverse=Math.min(maxReverse,moved.centerVelocity.x);
        }
        assert.ok(Math.abs(m.getState().actors[0].centerVelocity.x)<0.02); assert.ok(maxReverse>-0.005);
    }
    const airborne=model(t,[actor({position:{x:0,y:20,z:0},velocity:{x:10,y:0,z:0}})],{gravity:0,terrain:terrain()});
    assert.ok(Math.abs(run(airborne,2).centerVelocity.x-10)<0.001);
});

test('supported steering reverses with backward travel and reverse takeoff, but airborne attitude does not', t => {
    for (const controller of ['ground', 'mecha']) {
        const forward = model(t, [actor({ physicsProfile: { controller, maxSpeed: 100 } })]); run(forward, 0.2);
        const positive = run(forward, 0.4, { move: { x: 1 }, rotate: { z: 1 } }); assert.ok(positive.rotationalRates.z > 0.05);
        const reverse = model(t, [actor({ physicsProfile: { controller, maxSpeed: 100 } })]); run(reverse, 0.2);
        const negative = run(reverse, 0.4, { move: { x: -1 }, rotate: { z: 1 } }); assert.ok(negative.rotationalRates.z < -0.05);
        const coasting = model(t, [actor({ velocity: { x: -5, y: 0, z: 0 }, physicsProfile: { controller, maxSpeed: 100 } })]); run(coasting, 0.1);
        const rollingBack = coasting.step({ a: frame({ sequence: 999, move: { x: 1 }, rotate: { z: 1 } }) }, 1/30).actors[0];
        assert.ok(rollingBack.centerVelocity.x < -1, 'forward throttle has not yet reversed actual backward travel');
        assert.ok(rollingBack.rotationalRates.z < -0.005, 'steering follows actual travel rather than throttle sign');
    }
    const airborne = model(t, [actor({ position: { x: 0, y: 20, z: 0 }, velocity: { x: -5, y: 0, z: 0 } })], { gravity: 0 });
    assert.ok(run(airborne, 0.3, { move: { x: -1 }, rotate: { z: 1 } }).rotationalRates.z > 0.1);
});
