const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { SystemMessages } = require('../modules/server/system-messages');
const { createGameServer } = require('../game-server');
const { validate } = require('../modules/contracts');

test('notice validation, snapshot isolation, persistence and failed publication', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notices-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const options = { systemMessagesFile: path.join(dir, 'messages.json') };
    const store = new SystemMessages(options);
    const list = [{ id: 'maintenance-v1', text: '<b>Literal text</b>' }];
    store.publish(list); list[0].text = 'mutated';
    assert.deepEqual(new SystemMessages(options).current(), store.current());
    assert.equal(store.current()[0].text, '<b>Literal text</b>');
    for (const invalid of [null, {}, [{ id: '', text: 'x' }], [{ id: 'x', text: '' }], [{ id: 'x', text: 'x', html: true }], [{ id: 'x', text: 'x' }, { id: 'x', text: 'y' }], Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: 'x' })), [{ id: 'x'.repeat(129), text: 'x' }], [{ id: 'x', text: 'x'.repeat(2001) }]]) {
        assert.throws(() => store.publish(invalid));
    }
    validate('system-messages', [{ id: 'x'.repeat(128), text: 'x'.repeat(2000) }]);
    store.file = path.join(dir, 'missing', 'messages.json');
    assert.throws(() => store.publish([]));
    assert.equal(store.current().length, 1);
    store.file = options.systemMessagesFile; store.publish([]);
    assert.deepEqual(new SystemMessages(options).current(), []);
});

const once = (socket, event) => new Promise(resolve => socket.once(event, resolve));
const request = (socket, event, payload) => new Promise((resolve, reject) => socket.timeout(3000).emit(event, payload, (err, value) => err ? reject(err) : resolve(value)));
test('lobby notices, replacements, reconnects, withdrawal and admin authorization', { timeout: 15000 }, async t => {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, adminToken: 'test', logger: { info() {}, debug() {} } });
    t.after(() => server.close()); await server.start();
    const connect = async auth => {
        const socket = io(`http://127.0.0.1:${server.http.address().port}`, { autoConnect: false, transports: ['websocket'], auth });
        t.after(() => socket.close());
        const initial = once(socket, 'system_messages'); socket.connect();
        return { socket, initial: await initial };
    };
    const player = await connect(); assert.deepEqual(player.initial, []);
    const admin = await connect({ role: 'admin', adminToken: 'test' });
    assert.equal((await request(player.socket, 'admin_publish_system_messages', [])).ok, false);
    const list = [{ id: 'v1', text: '<script>literal</script>' }];
    let next = once(player.socket, 'system_messages');
    assert.equal((await request(admin.socket, 'admin_publish_system_messages', list)).ok, true);
    assert.deepEqual(await next, list);
    assert.equal((await request(admin.socket, 'admin_publish_system_messages', [{ id: 'bad', text: '' }])).ok, false);
    player.socket.disconnect(); next = once(player.socket, 'system_messages'); player.socket.connect();
    assert.deepEqual(await next, list);
    for (const replacement of [list, [{ id: 'v2', text: 'Edited' }], []]) {
        next = once(player.socket, 'system_messages'); server.publishSystemMessages(replacement);
        assert.deepEqual(await next, replacement);
    }
});
