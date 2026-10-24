const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createGameServer } = require('../game-server');
const { registration } = require('./mesh-fixture');
const { ClientSockets } = require('../modules/server/sockets');
const logger = { info() {}, error() {}, debug() {} };
function next(socket, name, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(name, receive); reject(new Error(`Missing ${name}`)); }, 3000);
        function receive(data) { if (predicate(data)) { clearTimeout(timer); socket.off(name, receive); resolve(data); } }
        socket.on(name, receive);
    });
}
test('admin audit is private and records failed/successful registration packages and client context', async t => {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, adminToken: 'audit-token', logger });
    t.after(() => server.close()); await server.start();
    const url = `http://127.0.0.1:${server.http.address().port}`;
    const open = (auth, extraHeaders) => {
        const socket = io(url, { auth, extraHeaders, autoConnect: false, reconnection: false, transports: ['websocket'] });
        t.after(() => socket.close()); return socket;
    };
    const player = open({ sessionId: 'default', contractVersion: 'client-build-7' }, { 'User-Agent': 'Mozilla/5.0 Firefox/130.0' });
    const selected = next(player, 'session_selected'); player.connect(); await selected;
    let leaked = false;
    player.on('admin_event', () => { leaked = true; }); player.on('admin_events', () => { leaked = true; });
    const denied = open({ role: 'admin', adminToken: 'wrong' });
    let exposed = false; for (const event of ['admin_authenticated', 'sessions_list', 'server_metrics', 'admin_events']) denied.on(event, () => { exposed = true; });
    const rejected = next(denied, 'session_rejected'); denied.connect(); await rejected;
    assert.equal(exposed, false);
    const admin = open({ role: 'admin', adminToken: 'audit-token', sessionId: 'default' });
    const history = next(admin, 'admin_events'); admin.connect(); const initial = await history;
    const connected = initial.events.find(e => e.clientId === player.id && e.type === 'connection.opened');
    assert.equal(connected.client.browser, 'Firefox'); assert.equal(connected.client.reportedContractVersion, 'client-build-7');
    assert.equal(connected.client.reportedSchemaVersion, null);
    assert.match(connected.client.serverContractFingerprint, /^[a-f0-9]{64}$/);
    assert.ok(initial.events.some(e => e.type === 'authentication.failed'));
    const attempt = next(admin, 'admin_event', e => e.type === 'registration.attempt');
    const failed = next(admin, 'admin_event', e => e.type === 'registration.failed');
    player.emit('register_actor', { name: 'Invalid', token: 'do-not-store', mesh: { glb: 'raw-mesh' } });
    const packageEvent = await attempt;
    assert.equal(packageEvent.details.package.token, '[redacted]');
    assert.equal(packageEvent.details.package.mesh.glb.characters, 8);
    assert.match((await failed).details.reason, /actor:/);
    const accepted = next(admin, 'admin_event', e => e.type === 'registration.accepted');
    player.emit('register_actor', registration()); assert.equal((await accepted).details.descriptor.name, 'Test cube');
    const left = next(player, 'session_left'); player.emit('leave_session'); await left;
    const combined = next(admin, 'admin_event', e => e.type === 'registration.accepted' && e.details.event === 'join_session');
    player.emit('join_session', { sessionId: 'default', actor: registration() }); await combined;
    const playerId = player.id;
    const closed = next(admin, 'admin_event', e => e.type === 'connection.closed' && e.clientId === playerId);
    player.disconnect(); await closed;
    assert.equal(leaked, false);
});
test('admin access fails closed when no server token is configured', async t => {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, logger });
    t.after(() => server.close()); await server.start();
    const socket = io(`http://127.0.0.1:${server.http.address().port}`, { autoConnect: false, reconnection: false, transports: ['websocket'], auth: { role: 'admin', adminToken: 'anything' } });
    t.after(() => socket.close()); const denied = next(socket, 'session_rejected'); socket.connect();
    assert.equal((await denied).reason, 'Invalid admin token');
});
test('audit retention and package summaries are bounded and redact secrets', () => {
    const audit = Object.create(ClientSockets.prototype); audit.events = []; audit.eventSequence = 0; audit.connections = new Map();
    for (let i = 0; i < 1010; i++) audit.audit('test', null, { i });
    assert.equal(audit.events.length, 1000); assert.equal(audit.events[0].id, 11);
    const summary = audit.summarize({ password: 'private', mesh: { glb: 'binary' }, many: Array.from({length:100}, () => 'x'.repeat(10000)) });
    assert.equal(summary.password, '[redacted]'); assert.equal(summary.mesh.glb.characters, 6);
    assert.ok(JSON.stringify(summary).length < 20000);
});
