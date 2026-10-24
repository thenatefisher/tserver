const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createGameServer } = require('../game-server');
const { registration } = require('./mesh-fixture');
const logger = { info() {}, error() {}, debug() {} };
function event(socket, name, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(name, receive); reject(new Error(`Missing ${name}`)); }, 4000);
        function receive(data) { if (predicate(data)) { clearTimeout(timer); socket.off(name, receive); resolve(data); } }
        socket.on(name, receive);
    });
}
const request = (socket, name, payload = {}) => new Promise((resolve, reject) => socket.timeout(4000).emit(name, payload, (error, result) => error ? reject(error) : resolve(result)));
async function setup(t, sessions = [{ id: 'default' }, { id: 'second', tickRate: 40 }]) {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, adminToken: 'management-test', logger, sessions });
    t.after(() => server.close()); await server.start();
    async function connect(auth = {}) {
        const socket = io(`http://127.0.0.1:${server.http.address().port}`, { autoConnect: false, reconnection: false, transports: ['websocket'], auth });
        t.after(() => socket.close());
        const ready = event(socket, auth.role === 'admin' ? 'admin_authenticated' : 'sessions_list'); socket.connect(); await ready; return socket;
    }
    const admin = await connect({ role: 'admin', adminToken: 'management-test' });
    const snapshot = async () => { const next = event(admin, 'admin_sessions'); assert.equal((await request(admin, 'admin_list_sessions')).ok, true); return next; };
    return { server, admin, connect, snapshot };
}

test('server telemetry and logs span sessions and lobby, including an empty registry', async t => {
    const { server, admin, connect, snapshot } = await setup(t);
    assert.equal(server.sockets.connections.get(admin.id).session, null, 'global admin does not need session membership');
    const first = await connect(), second = await connect(), lobby = await connect();
    let leaked = false; for (const name of ['admin_sessions', 'admin_server_metrics']) lobby.on(name, () => { leaked = true; });
    const crossSessionLog = event(admin, 'admin_event', entry => entry.type === 'registration.accepted' && entry.sessionId === 'second');
    assert.equal((await request(first, 'join_session', { sessionId: 'default', actor: registration() })).ok, true);
    assert.equal((await request(second, 'join_session', { sessionId: 'second', actor: registration() })).ok, true); await crossSessionLog;
    const metrics = event(admin, 'admin_server_metrics'); await snapshot(); const totals = await metrics;
    assert.deepEqual({ count: totals.connectedPlayers, lobby: totals.lobbyPlayers, meshes: totals.registeredMeshes, sessions: totals.sessionCount }, { count: 3, lobby: 1, meshes: 2, sessions: 2 });
    assert.deepEqual(totals.tickRates, [30, 40]); assert.equal(totals.scope, 'server');
    await request(admin, 'join_session', 'default');
    const otherMetrics = event(admin, 'admin_server_metrics'); await snapshot(); assert.equal((await otherMetrics).registeredMeshes, 2);
    for (const id of ['default', 'second']) assert.equal((await request(admin, 'admin_delete_session', { sessionId: id, confirmId: id })).ok, true);
    const empty = event(admin, 'admin_server_metrics', data => data.sessionCount === 0); const heartbeat = await empty;
    assert.equal(heartbeat.connectedPlayers, 3); assert.equal(heartbeat.lobbyPlayers, 3); assert.equal(heartbeat.registeredMeshes, 0);
    assert.ok(heartbeat.uptime >= totals.uptime); assert.deepEqual(heartbeat.tickRates, []);
    assert.equal((await request(admin, 'admin_create_session', { id: 'restored', parameters: { name: 'Restored', terrainPreset: 'flat' } })).ok, true);
    assert.equal(server.sessions.get('restored').timers.length, 3);
    assert.equal(leaked, false);
});

test('session management validates settings, updates live timers and admission, and protects against stale writes', async t => {
    const { server, admin, connect, snapshot } = await setup(t);
    const player = await connect();
    for (const name of ['admin_list_sessions', 'admin_create_session', 'admin_update_session', 'admin_delete_session', 'admin_session_user', 'admin_session_unban', 'admin_revoke_reservation']) {
        assert.match((await request(player, name, {})).reason, /Admin role/);
    }
    const invalid = [ { tickRate: 0 }, { tickRate: 121 }, { tickRate: 1.5 }, { maxPlayers: 0 }, { maxPlayers: 257 }, { name: ' ' }, { acceptingPlayers: 'yes' }, { gameMode: '<script>' }, { terrainPreset: 'missing' }, { environment: { gravity: 0 } } ];
    for (const parameters of invalid) assert.equal((await request(admin, 'admin_create_session', { id: 'invalid', parameters })).ok, false);
    assert.equal(server.sessions.get('invalid'), undefined);
    assert.equal((await request(admin, 'admin_create_session', { id: 'training', parameters: { name: 'Training', maxPlayers: 4, tickRate: 60, terrainPreset: 'flat', gameMode: 'training', acceptingPlayers: true } })).ok, true);
    assert.equal((await request(admin, 'admin_create_session', { id: 'training', parameters: {} })).ok, false);
    const training = server.sessions.get('training'), oldTimers = training.timers.slice();
    assert.equal((await request(admin, 'admin_update_session', { sessionId: 'training', expectedRevision: 0, parameters: { name: 'Flight', tickRate: 20, maxPlayers: 2, acceptingPlayers: false, terrainPreset: 'valley' } })).ok, true);
    assert.equal(training.tickRate, 20); assert.equal(training.name, 'Flight'); assert.equal(training.timers.length, 3);
    assert.notEqual(training.timers[0], oldTimers[0]); assert.equal(training.data.map.terrain.preset, 'valley');
    assert.equal(training.description().joinable, false); assert.equal(training.description().status, 'closed');
    assert.match((await request(player, 'join_session', { sessionId: 'training', actor: registration() })).reason, /closed/);
    assert.match((await request(admin, 'admin_update_session', { sessionId: 'training', expectedRevision: 0, parameters: { name: 'Stale' } })).reason, /changed/);
    assert.equal(training.name, 'Flight');
    assert.equal((await request(admin, 'admin_update_session', { sessionId: 'training', expectedRevision: 1, parameters: { acceptingPlayers: true } })).ok, true);
    await request(player, 'join_session', { sessionId: 'training', actor: registration() });
    const other = await connect(); await request(other, 'join_session', { sessionId: 'training', actor: registration() });
    assert.match((await request(admin, 'admin_update_session', { sessionId: 'training', expectedRevision: 2, parameters: { name: 'No commit', maxPlayers: 1 } })).reason, /occupied/);
    assert.equal(training.name, 'Flight');
    assert.equal((await request(admin, 'admin_delete_session', { sessionId: 'training', confirmId: 'wrong' })).ok, false);
    assert.ok((await snapshot()).sessions.find(session => session.id === 'training').users.length === 2);
    const closed = event(player, 'session_closed');
    assert.equal((await request(admin, 'admin_delete_session', { sessionId: 'training', confirmId: 'training' })).ok, true); await closed;
    assert.equal(training.timers.length, 0); assert.equal(training.physics.closed, true); assert.equal(server.sessions.get('training'), undefined);
    assert.equal(server.sockets.connections.get(player.id).session, null);
});

test('manage users across sessions without moving the admin, and revoke reconnect reservations', async t => {
    const { server, admin, connect, snapshot } = await setup(t);
    const player = await connect(), other = await connect();
    await request(player, 'join_session', { sessionId: 'default', actor: registration() });
    await request(other, 'join_session', { sessionId: 'second', actor: registration() });
    const manage = payload => request(admin, 'admin_session_user', payload);
    assert.equal((await manage({ sessionId: 'second', clientId: player.id, action: 'kick' })).ok, false);
    assert.equal((await manage({ sessionId: 'default', clientId: admin.id, action: 'kick' })).ok, false);
    assert.equal((await request(admin, 'admin_update_session', { sessionId: 'second', expectedRevision: 0, parameters: { maxPlayers: 1 } })).ok, true);
    assert.match((await manage({ sessionId: 'default', clientId: player.id, action: 'move', targetSessionId: 'second' })).reason, /full/);
    assert.equal(server.sockets.connections.get(player.id).session.id, 'default');
    await request(admin, 'admin_update_session', { sessionId: 'second', expectedRevision: 1, parameters: { maxPlayers: 3 } });
    assert.equal((await manage({ sessionId: 'default', clientId: player.id, action: 'move', targetSessionId: 'second' })).ok, true);
    assert.equal(server.sessions.get().data.actors.size, 0); assert.equal(server.sessions.get('second').data.actors.size, 2);
    assert.equal(server.sockets.connections.get(admin.id).session, null);
    assert.equal((await manage({ sessionId: 'second', clientId: player.id, action: 'remove' })).ok, true);
    assert.equal(server.sockets.connections.get(player.id).session, null);
    // A session address ban removes same-address members only from that session.
    await request(player, 'join_session', { sessionId: 'default', actor: registration() });
    const banned = event(other, 'disconnect');
    assert.equal((await manage({ sessionId: 'second', clientId: other.id, action: 'ban' })).ok, true); await banned;
    assert.equal(server.sessions.get().data.actors.size, 1);
    const state = await snapshot(), bans = state.sessions.find(session => session.id === 'second').bans;
    assert.equal(bans.length, 1);
    assert.equal((await request(admin, 'admin_session_unban', { sessionId: 'second', address: bans[0] })).ok, true);
    const playerId = server.sockets.connections.get(player.id).playerId, socketId = player.id;
    const gone = event(admin, 'admin_event', entry => entry.type === 'connection.closed' && entry.clientId === socketId);
    player.io.engine.close(); await gone;
    const reserved = (await snapshot()).sessions.find(session => session.id === 'default');
    assert.equal(reserved.reservations.length, 1); assert.equal(reserved.reservations[0].playerId, playerId);
    assert.ok(!JSON.stringify(reserved).includes('resumeToken'));
    assert.match((await request(admin, 'admin_update_session', { sessionId: 'default', expectedRevision: 0, parameters: { maxPlayers: 0 } })).reason, /Player limit/);
    assert.equal((await request(admin, 'admin_revoke_reservation', { sessionId: 'default', playerId })).ok, true);
    assert.equal(server.sessions.get().reservedPlayers, 0); assert.equal(server.sockets.resumptions.size, 0);
    const fresh = await connect(); await request(fresh, 'join_session', { sessionId: 'default', actor: registration() });
    const freshId = fresh.id, kicked = event(fresh, 'disconnect');
    assert.equal((await manage({ sessionId: 'default', clientId: freshId, action: 'kick' })).ok, true); await kicked;
    assert.equal(server.sessions.get().reservedPlayers, 0);
});

test('moving loading users preserves activation gating and address bans revoke reconnect slots', async t => {
    const { server, admin, connect, snapshot } = await setup(t);
    const loading = await connect();
    await request(loading, 'join_session', { sessionId: 'default', actor: registration(), waitForReady: true });
    assert.equal((await request(admin, 'admin_session_user', { sessionId: 'default', clientId: loading.id, action: 'move', targetSessionId: 'second' })).ok, true);
    assert.equal(server.sockets.connections.get(loading.id).loading, true);
    assert.equal(server.sessions.get('second').data.actors.size, 0);
    assert.equal((await snapshot()).sessions.find(session => session.id === 'second').users[0].status, 'loading');
    assert.equal((await request(loading, 'client_ready')).ok, false, 'destination resources still require acknowledgment');
    const playing = await connect();
    await request(playing, 'join_session', { sessionId: 'second', actor: registration() });
    const playingId = playing.id;
    const gone = event(admin, 'admin_event', entry => entry.type === 'connection.closed' && entry.clientId === playingId);
    playing.io.engine.close(); await gone; await snapshot();
    assert.equal(server.sessions.get('second').reservedPlayers, 1);
    const banned = event(loading, 'disconnect');
    assert.equal((await request(admin, 'admin_session_user', { sessionId: 'second', clientId: loading.id, action: 'ban' })).ok, true); await banned;
    assert.equal(server.sessions.get('second').reservedPlayers, 0); assert.equal(server.sockets.resumptions.size, 0);
    assert.equal(server.sessions.get('second').data.clients.size, 0);
});
