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
    const { validate } = require('../modules/contracts');
    validate('actions', controls('ArrowLeft'));
});
