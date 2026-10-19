const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { createGameServer } = require('../game-server');
const meshFixture = require('./mesh-fixture');
const frame = require('./control-frame');
const logger = { info() {}, error() {}, debug() {} };
function event(socket, name, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timed out waiting for ${name}`)); }, 4000);
        function listener(value) {
            if (!predicate(value)) return;
            clearTimeout(timer); socket.off(name, listener); resolve(value);
        }
        socket.on(name, listener);
    });
}
async function connect(t, url, auth = {}, options = {}) {
    const socket = io(url, { autoConnect: false, reconnection: false, transports: ['websocket'], auth, ...options });
    t.after(() => socket.close());
    const joined = event(socket, auth.role === 'admin' ? 'session_joined' : 'session_selected');
    const protocol = event(socket, 'protocol_info');
    socket.connect(); await joined; socket.protocolInfo = await protocol;
    return socket;
}

test('HTTP, UDP discovery, sessions, legacy events, and data receipts work end to end', { timeout: 20000 }, async t => {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discoveryPort: 0, logger,
        adminToken: 'test-admin', sessions: [{ id: 'default' }, { id: 'second' }] });
    t.after(() => server.close());
    await server.start();
    const url = `http://127.0.0.1:${server.http.address().port}`;
    const ping = await (await fetch(url + '/ping')).json();
    assert.equal(ping.port, server.http.address().port);
    assert.equal(ping.sessions.length, 2);
    assert.equal((await (await fetch(url + '/sessions')).json()).length, 2);
    for (const asset of ['/admin', '/admin.js', '/vendor/three/build/three.module.js']) { const response = await fetch(url + asset); assert.equal(response.status, 200); await response.arrayBuffer(); }
    assert.equal((await fetch(url + '/package.json')).status, 404, 'only public assets are exposed');
    const udp = dgram.createSocket('udp4'); t.after(() => udp.close());
    const beacon = once(udp, 'message');
    udp.send('TBN_DISCOVER_PING', server.discovery.socket.address().port, '127.0.0.1');
    const [packet] = await beacon;
    assert.equal(JSON.parse(packet).type, 'TBN_SERVER_BEACON');
    assert.equal(JSON.parse(packet).sessions.length, 2);
    assert.equal(JSON.parse(packet).port, server.http.address().port);

    const player = await connect(t, url, { sync: true });
    const other = await connect(t, url, { sessionId: 'second' });
    const admin = await connect(t, url, { role: 'admin', adminToken: 'test-admin' });
    const defaultSession = server.sessions.get();
    assert.equal(defaultSession.data.actors.size, 0);
    assert.equal(server.sessions.get('second').data.actors.size, 0);
    const prematureJoin = event(player, 'session_rejected'); player.emit('join_session', 'second');
    assert.match((await prematureJoin).reason, /Register actor/);
    const state = await event(admin, 'state');
    require('../modules/contracts').validate('state', state);
    assert.equal(state.actors.length, 0, 'unregistered connections do not enter simulation');
    const metrics = await event(admin, 'server_metrics');
    assert.equal(metrics.clients.length, 1); assert.equal(metrics.clients[0].registered, false);
    const denied = event(player, 'request_rejected'); player.emit('admin_kick_actor', other.id);
    assert.match((await denied).reason, /Admin/);
    const crossMesh = event(admin, 'request_rejected'); admin.emit('request_mesh', other.id);
    assert.match((await crossMesh).reason, /unavailable/);

    const rejected = event(player, 'registration_rejected'); player.emit('register_actor', { mesh: { glb: 'bad' } });
    assert.ok((await rejected).reason);
    const accepted = event(player, 'registration_accepted');
    player.emit('register_actor', meshFixture.registration({ name: 'Player' }));
    assert.equal((await accepted).triangles, 12);
    assert.equal(player.protocolInfo.protocolVersion, 2);
    const oldAction = event(player, 'request_rejected'); player.emit('action', { linear: { x: 1 } });
    assert.match((await oldAction).reason, /actions:/);
    const rotated = event(player, 'state', snapshot => snapshot.actors.some(a => a.id === player.id && a.lastInputSequence === 0 && a.rotationalRates.z > 0));
    player.emit('action', frame({ jump: true, rotate: { z: 1 } }));
    assert.equal((await rotated).actors.find(a => a.id === player.id).lastInputSequence, 0);
    const stale = event(player, 'request_rejected'); player.emit('action', frame());
    assert.match((await stale).reason, /sequence/);
    const meshReceived = event(admin, 'mesh_geometry');
    admin.emit('request_mesh', player.id);
    assert.equal((await meshReceived).glb, meshFixture().glb);
    const meshResource = `mesh:${player.id}`;
    const firstManifest = event(admin, 'data_manifest'); admin.emit('request_data_manifest');
    assert.equal((await firstManifest).resources.find(r => r.resource === meshResource).needsUpdate, true);
    admin.emit('data_ack', { sessionId: 'default', resource: meshResource, version: 1 });
    const acknowledged = event(admin, 'data_manifest'); admin.emit('request_data_manifest');
    assert.equal((await acknowledged).resources.find(r => r.resource === meshResource).needsUpdate, false);
    const updatedMesh = event(admin, 'data_version', v => v.resource === meshResource && v.version === 2);
    player.emit('register_actor', meshFixture.registration({ name: 'Updated' })); await updatedMesh;
    assert.equal(defaultSession.data.manifest(admin.id).resources.find(r => r.resource === meshResource).needsUpdate, true);
    const terrainVersion = server.sessions.get('second').data.resources.get('terrain').version;
    const updatedMap = event(admin, 'data_version', v => v.resource === 'terrain' && v.version === 2);
    admin.emit('admin_reset_targets'); await updatedMap;
    assert.equal(server.sessions.get('second').data.resources.get('terrain').version, terrainVersion);
    const allReceipts = event(admin, 'sync_manifest'); admin.emit('request_sync_manifest');
    assert.equal((await allReceipts).clients.length, 2);

    const removedGeometry = event(admin, 'data_removed', value => value.resource === meshResource);
    const movedSession = event(player, 'session_joined'); player.emit('join_session', 'second'); await movedSession; await removedGeometry;
    const consumed = event(player, 'state', s => s.actors.some(a => a.id === player.id && a.lastInputSequence === 0));
    player.emit('action', frame()); await consumed;
    assert.equal(defaultSession.data.actors.size, 0);
    assert.equal(defaultSession.data.meshes.size, 0);
    assert.equal(defaultSession.data.clients.has(player.id), false);
    assert.equal(server.sessions.get('second').data.actors.size, 1);
    assert.equal(defaultSession.physics.getState().actors.length, 0);
    const badJoin = event(player, 'session_rejected'); player.emit('join_session', 'missing'); await badJoin;
    assert.equal(server.sessions.get('second').data.actors.size, 1, 'failed joins keep the old session');
    const created = server.sessions.createSession({ id: 'dynamic' });
    assert.equal(created.timers.length, 3);
    const switched = event(player, 'session_joined'); player.emit('join_session', 'dynamic'); await switched;
    const closed = event(player, 'session_closed'); server.sessions.removeSession('dynamic'); await closed;
    assert.equal(created.timers.length, 0);
});

test('kick and address bans are session scoped and survive reconnects until unbanned', { timeout: 15000 }, async t => {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, logger, sessions: [{ id: 'default' }, { id: 'second' }] });
    t.after(() => server.close()); await server.start();
    const url = `http://127.0.0.1:${server.http.address().port}`;
    const admin = await connect(t, url, { role: 'admin' });
    const player = await connect(t, url);
    let accepted = event(player, 'registration_accepted'); player.emit('register_actor', meshFixture.registration()); await accepted;
    const id = player.id;
    const kicked = once(player, 'disconnect'); admin.emit('admin_kick_actor', id); await kicked;
    assert.equal(server.sessions.get().physics.getState().actors.length, 0);
    const returning = await connect(t, url);
    accepted = event(returning, 'registration_accepted'); returning.emit('register_actor', meshFixture.registration()); await accepted;
    const banned = event(admin, 'actor_banned'); admin.emit('admin_ban_actor', returning.id);
    const ban = await banned;
    const rejected = io(url, { autoConnect: false, reconnection: false, transports: ['websocket'] }); t.after(() => rejected.close());
    const rejection = event(rejected, 'session_rejected'); rejected.connect();
    assert.match((await rejection).reason, /banned/);
    const other = await connect(t, url, { sessionId: 'second' }); assert.ok(other.connected);
    admin.emit('admin_unban_actor', ban.address);
    const ordered = event(admin, 'data_manifest'); admin.emit('request_data_manifest'); await ordered;
    const allowed = await connect(t, url); assert.ok(allowed.connected);
});

test('polling clients register using only the shared contract events', { timeout: 10000 }, async t => {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, logger });
    t.after(() => server.close()); await server.start();
    const player = await connect(t, `http://127.0.0.1:${server.http.address().port}`, {}, { transports: ['polling'] });
    const accepted = event(player, 'registration_accepted'); player.emit('register_actor', meshFixture.registration()); await accepted;
    const snapshot = await event(player, 'state', s => s.actors.length === 1);
    require('../modules/contracts').validate('state', snapshot);
    const map = event(player, 'map_data'); player.emit('request_world');
    require('../modules/contracts').validate('world', await map);
});

test('CLI debug excludes simulation ticks and socket sends and shuts down cleanly', { timeout: 10000 }, async t => {
    const child = spawn(process.execPath, ['game-server.js', '--debug'], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, PORT: '0', DISCOVERY_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const port = await new Promise((resolve, reject) => {
        const check = chunk => { const match = output.match(/Running on port (\d+)/); if (match) { child.stdout.off('data', check); resolve(Number(match[1])); } };
        child.stdout.on('data', check); child.once('exit', () => reject(new Error(output)));
    });
    await fetch(`http://127.0.0.1:${port}/ping`);
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    assert.equal((await exited)[0], 0);
    assert.match(output, /\[DEBUG/); assert.match(output, /http.request/);
    assert.ok(!output.includes('simulation.tick')); assert.ok(!output.includes('socket.send'));
});


test('framework relay forwards v2 announcements, registration, controls and rejection feedback', { timeout: 10000 }, async t => {
    const { ClientNode } = require('../tbn/client-node');
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, logger });
    t.after(() => server.close()); await server.start();
    const relay = new ClientNode({ localPort: 0, debug: false, serverUrl: `http://127.0.0.1:${server.http.address().port}`, actorRegistration: meshFixture.registration() });
    t.after(() => relay.stop());
    const registered = once(relay, 'game:registration_accepted'); await relay.start(); await registered;
    const browser = io(`http://127.0.0.1:${relay.localPort}`, { autoConnect: false, transports: ['websocket'] });
    t.after(() => browser.close());
    const announcement = event(browser, 'protocol_info'), registration = event(browser, 'registration_accepted');
    browser.connect(); assert.equal((await announcement).protocolVersion, 2);
    assert.equal((await registration).physicsProfile.controller, 'ground');
    const acknowledged = event(browser, 'state', s => s.actors.some(a => a.lastInputSequence === 17));
    browser.emit('action', frame({ sequence: 17 })); await acknowledged;
    const rejection = event(browser, 'request_rejected'); browser.emit('action', frame({ sequence: 16 }));
    assert.match((await rejection).reason, /sequence/);
});

test('admin flatten publishes the replacement map/state and rejects player requests', { timeout: 10000 }, async t => {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, logger, sessions: [{ id: 'default' }, { id: 'second' }] });
    t.after(() => server.close()); await server.start();
    const url = `http://127.0.0.1:${server.http.address().port}`;
    assert.match(await (await fetch(url + '/admin')).text(), /id="flatten-terrain"/);
    const player = await connect(t, url), admin = await connect(t, url, { role: 'admin' });
    const denied = event(player, 'request_rejected'); player.emit('admin_flatten_terrain'); assert.match((await denied).reason, /Admin/);
    const other = server.sessions.get('second'), otherTerrain = other.terrain;
    const update = event(player, 'map_data', m => m.terrain.depthMap.every(v => v === 0));
    const receipt = event(player, 'data_version', v => v.resource === 'terrain' && v.version === 2);
    const done = event(admin, 'terrain_flattened'); admin.emit('admin_flatten_terrain');
    assert.equal((await done).sessionId, 'default'); await update; await receipt;
    assert.equal(other.terrain, otherTerrain); assert.equal(other.data.resources.get('terrain').version, 1);
});

test('admin diagnostic buttons clear targets and disable object collisions only within the selected session', { timeout: 10000 }, async t => {
    const server = createGameServer({ port: 0, host: '127.0.0.1', discovery: false, logger, sessions: [{ id: 'default' }, { id: 'second' }] });
    t.after(() => server.close()); await server.start();
    const url = `http://127.0.0.1:${server.http.address().port}`;
    const html = await (await fetch(url + '/admin')).text();
    assert.match(html, /id="remove-targets"/); assert.match(html, /id="disable-object-collisions"/);
    const player = await connect(t, url), admin = await connect(t, url, { role: 'admin' });
    for (const action of ['admin_remove_targets', 'admin_disable_object_collisions']) {
        const rejected = event(player, 'request_rejected'); player.emit(action); assert.match((await rejected).reason, /Admin/);
    }
    const map = event(player, 'map_data', m => m.targets.length === 0), removed = event(admin, 'targets_removed');
    admin.emit('admin_remove_targets'); assert.equal((await removed).removed, 15); await map;
    assert.equal(server.sessions.get('second').data.map.targets.length, 15);
    const disabled = event(player, 'collision_settings', s => s.terrainOnlyCollisions);
    admin.emit('admin_disable_object_collisions'); assert.equal((await disabled).sessionId, 'default');
    assert.equal(server.sessions.get().physics.terrainOnlyCollisions, true);
    assert.equal(server.sessions.get('second').physics.terrainOnlyCollisions, false);
    const accepted = event(player, 'registration_accepted'); player.emit('register_actor', meshFixture.registration()); await accepted;
    const grounded = await event(player, 'state', s => s.actors.some(a => a.id === player.id && a.grounded));
    assert.ok(grounded.actors[0].grounded, 'new actor retains terrain support');
    const settings = event(admin, 'collision_settings'); admin.emit('join_session', 'second'); assert.equal((await settings).terrainOnlyCollisions, false);
    const back = event(admin, 'collision_settings'); admin.emit('join_session', 'default'); assert.equal((await back).terrainOnlyCollisions, true);
});

test('admins choose a session terrain preset and clients receive the matching map and reset notice', {timeout:10000}, async t => {
    const server=createGameServer({port:0,host:'127.0.0.1',discovery:false,logger,sessions:[{id:'default',terrainPreset:'flat'},{id:'second',terrainPreset:'valley'}]});
    t.after(()=>server.close()); await server.start();
    const url=`http://127.0.0.1:${server.http.address().port}`;
    const html=await(await fetch(url+'/admin')).text(); assert.match(html,/id="terrain-preset"/); assert.match(html,/id="apply-terrain"/);
    const player=await connect(t,url), admin=await connect(t,url,{role:'admin'});
    const catalog=event(admin,'terrain_presets'); admin.emit('request_terrain_presets'); const options=await catalog;
    assert.equal(options.presets.length,6); assert.equal(options.selected,'flat');
    const denied=event(player,'request_rejected'); player.emit('admin_set_terrain_preset','mountain-range'); assert.match((await denied).reason,/Admin/);
    const before=server.sessions.get().data.resources.get('terrain').version;
    const invalid=event(admin,'request_rejected'); admin.emit('admin_set_terrain_preset','made-up'); await invalid;
    assert.equal(server.sessions.get().data.resources.get('terrain').version,before);
    const updated=event(player,'map_data',map=>map.terrain.preset==='city-blocks'); const changed=event(player,'terrain_changed');
    admin.emit('admin_set_terrain_preset','city-blocks'); const map=await updated; assert.ok(map.terrain.depthMap.some(h=>h>0));
    assert.equal((await changed).version,before+1); assert.equal(server.sessions.get('second').data.map.terrain.preset,'valley');
    const summaries=await(await fetch(url+'/sessions')).json(); assert.equal(summaries.find(s=>s.id==='default').terrainPreset,'city-blocks');
});

test('terrain preview is admin-only, correlated to its request and does not apply a terrain change', {timeout:10000}, async t => {
    const server=createGameServer({port:0,host:'127.0.0.1',discovery:false,logger,sessions:[{id:'default',terrainPreset:'flat'}]});
    t.after(()=>server.close()); await server.start();
    const url=`http://127.0.0.1:${server.http.address().port}`;
    assert.match(await(await fetch(url+'/admin')).text(), /id="preset-preview"/);
    const player=await connect(t,url),admin=await connect(t,url,{role:'admin'}),session=server.sessions.get();
    const denied=event(player,'request_rejected');player.emit('admin_preview_terrain',{preset:'valley',requestId:1});assert.match((await denied).reason,/Admin/);
    const bad=event(admin,'request_rejected');admin.emit('admin_preview_terrain',{preset:'valley',requestId:-1});assert.match((await bad).reason,/request ID/);
    const version=session.data.resources.get('terrain').version,grid=session.terrain;
    const preview=event(admin,'terrain_preview');admin.emit('admin_preview_terrain',{preset:'plateau',requestId:17});const candidate=await preview;
    assert.equal(candidate.requestId,17);assert.equal(candidate.preset,'plateau');assert.equal(candidate.baseVersion,version);
    assert.ok(candidate.terrain.depthMap.some(h=>h>0));assert.equal(session.terrain,grid);assert.equal(session.data.resources.get('terrain').version,version);
    assert.equal(session.data.map.terrain.preset,'flat');
});
