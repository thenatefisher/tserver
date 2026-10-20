const { test } = require('node:test');
const assert = require('node:assert/strict');
/** Create an independent wire pose to exercise receipt-time interpolation without a browser. */
function state(x, yaw = 0) { return { actors: [{ id: 'a', position: { x, y: 10, z: 0 }, orientation: { x: 0, y: 0, z: yaw, order: 'XYZ' } }] }; }
test('flight display interpolates positions and quaternion wrap while freezing on snapshot starvation', async () => {
    const { FlightPoses } = await import('../modules/server/public/flight-poses.mjs');
    const buffer = new FlightPoses(100), first = state(0, Math.PI - 0.1);
    buffer.push(first, 0); buffer.push(state(10, -Math.PI + 0.1), 100);
    const midpoint = buffer.sample(150)[0]; assert.equal(midpoint.position.x, 5);
    const start = buffer.sample(100)[0]; assert.ok(start.quaternion.angleTo(midpoint.quaternion) < 0.11);
    assert.equal(buffer.sample(500)[0].position.x, 10);
    assert.equal(first.actors[0].position.x, 0);
    buffer.clear(); assert.deepEqual(buffer.sample(500), []);
    for (let i = 0; i < 100; i++) buffer.push(state(i), i * 50);
    assert.equal(buffer.frames.length, 12);
});


test('Flight Lab arrow keys bank toward their turn and retain original pitch mapping', async () => {
    const { flightInput } = await import('../modules/server/public/flight-input.mjs');
    const controls = key => flightInput(new Set([key]), 50, 2, 1);
    assert.equal(controls('ArrowLeft').rotate.x, -1);
    assert.equal(controls('ArrowRight').rotate.x, 1);
    assert.equal(controls('ArrowDown').rotate.y, -1);
    assert.equal(controls('ArrowUp').rotate.y, 1);
    assert.equal(controls('Space').fire, true); assert.equal(controls('Space').brake, 0);
    assert.equal(controls('KeyB').brake, 1); assert.equal(controls('KeyB').fire, false);
    const { validate } = require('../modules/contracts');
    validate('actions', controls('ArrowLeft'));
});

test('wrapped snapshots interpolate over the nearest seam image rather than across the map', async () => {
    const { FlightPoses } = await import('../modules/server/public/flight-poses.mjs');
    const { tileOffsets, nearestImage, boundarySample } = await import('../modules/server/public/world-wrap.mjs');
    const { Vector3 } = await import('three');
    const grid = {boundary:'wrap',width:1000,depth:1000,origin:{x:-500,z:-500},columns:2,rows:2,depthMap:[1,2,3,4]};
    const poses = new FlightPoses(100); poses.setWorld(grid);
    poses.push(state(499),0); poses.push(state(-499),100);
    assert.equal(poses.sample(150)[0].position.x,500);
    assert.equal(nearestImage(new Vector3(-490,20,0),new Vector3(490,0,0),grid).x,510);
    assert.equal(tileOffsets(new Vector3(501,0,0),grid).length,9);
    assert.equal(boundarySample(grid,2,2),1);
});
