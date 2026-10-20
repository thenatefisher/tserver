/**
 * Manage client admission, session membership and routing of socket commands.
 * Inputs: Socket.IO connections, session registry, logger and optional admin token.
 * Outputs: Session-scoped payloads, rejection events, manifests and moderation effects.
 * Side effects: Installs/removes handlers, changes room membership and mutates session state through managers.
 * Coupling: ActorManager handles actors; DataDistribution handles versioned delivery; sessions own physics.
 */
const { invariants, protocolVersion, terrainPresets } = require('../contracts');
const { DataDistribution } = require('../sessions/distribution');

class ClientSockets {
    /** Own connection maps and install session/Socket.IO lifecycle listeners without creating actors. */
    constructor({ io, sessions, logger, adminToken }) {
        Object.assign(this, { io, sessions, logger, adminToken });
        this.connections = new Map(); this.bindings = new Map();
        this.onCreated = session => this.bindSession(session);
        this.onRemoving = session => this.unbindSession(session);
        this.onConnection = socket => this.connect(socket);
        sessions.on('created', this.onCreated); sessions.on('removing', this.onRemoving);
        for (const session of sessions.sessions.values()) this.bindSession(session);
        io.on('connection', this.onConnection);
    }
    /** Install session publication handlers and a per-session distribution adapter. */
    bindSession(session) {
        const distribution = new DataDistribution(session);
        /** Select live connection records belonging to this session without copying payloads. */
        const clients = () => [...this.connections.values()].filter(client => client.session === session);
        /** Push updated subscribed resources to session members; records sends, not receipts. */
        const changed = () => { for (const client of clients()) distribution.flush(client.socket); };
        /** Publish telemetry/manifests and retry opted-in unacknowledged data once per second. */
        const metrics = () => {
            const payload = session.metrics(id => this.io.sockets.sockets.get(id)?.conn.transport.name);
            for (const client of clients()) {
                client.socket.emit('server_metrics', payload);
                // Opt-in receipt tracking retries unacknowledged versions every second.
                distribution.flush(client.socket, client.socket.handshake.auth?.sync === true);
                distribution.manifest(client.socket);
            }
        };
        session.on('state', changed); session.on('data_changed', changed); session.on('metrics', metrics);
        this.bindings.set(session.id, { distribution, changed, metrics });
    }
    /** Disconnect session members and remove publication handlers before disposal. */
    unbindSession(session) {
        for (const client of [...this.connections.values()]) if (client.session === session) {
            client.socket.emit('session_closed', { sessionId: session.id });
            client.socket.disconnect(true);
        }
        const binding = this.bindings.get(session.id);
        if (binding) {
            session.off('state', binding.changed); session.off('data_changed', binding.changed); session.off('metrics', binding.metrics);
            this.bindings.delete(session.id);
        }
    }
    /** Remove a connection’s receipts, actor and room membership from its previous session. */
    detach(client) {
        const { session, socket } = client;
        if (!session) return;
        session.data.clients.delete(socket.id);
        if (session.actors.remove(socket.id)) {
            session.snapshot();
            this.broadcast(session, 'mesh_manifest_removed', socket.id);
            session.emit('data_changed');
        }
        socket.leave(`session:${session.id}`);
        client.session = null;
    }
    /** Check admission first, then attach/switch session and deliver its initial versioned resources. */
    join(client, sessionId, selectOnly = false) {
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error('Unknown game session');
        if (!client.admin && session.actors.isBanned(client.address)) throw new Error('Client is banned from this session');
        if (!client.admin && !client.registration && !selectOnly) throw new Error('Register actor before joining a session');
        this.detach(client);
        client.session = session;
        const socket = client.socket;
        socket.join(`session:${session.id}`);
        session.data.addClient(socket.id, { admin: client.admin, connectedAt: client.connectedAt, address: client.address });
        if (!client.admin && client.registration) session.actors.attach(socket.id, client.address, client.registration);
        session.snapshot();
        socket.emit(client.admin || client.registration ? 'session_joined' : 'session_selected', { sessionId: session.id, name: session.name });
        socket.emit('protocol_info', { protocolVersion, inputTimeoutSeconds: invariants.input.inputTimeoutSeconds, weapons: invariants.weapons, physics: { ...invariants.physics, ...session.physics.environment, terrain: undefined, groundHeight: undefined, bounds: undefined } });
        socket.emit('terrain_presets', { sessionId: session.id, presets: terrainPresets, selected: session.data.map.terrain.preset || null });
        socket.emit('collision_settings', { sessionId: session.id, terrainOnlyCollisions: session.physics.terrainOnlyCollisions });
        socket.emit('init', socket.id);
        const distribution = this.bindings.get(session.id).distribution;
        distribution.flush(socket); distribution.manifest(socket);
        session.emit('data_changed');
    }
    /** Emit a payload only to the specified session room. */
    broadcast(session, event, payload) { this.io.to(`session:${session.id}`).emit(event, payload); }
    /** Install guarded protocol handlers and select the initial session for a newly admitted socket. */
    connect(socket) {
        const auth = socket.handshake.auth || {};
        if (auth.role === 'admin' && this.adminToken && auth.adminToken !== this.adminToken) {
            socket.emit('session_rejected', { reason: 'Invalid admin token' }); socket.disconnect(true); return;
        }
        const client = { socket, session: null, address: socket.handshake.address, connectedAt: Date.now(), registration: null, admin: auth.role === 'admin' };
        this.connections.set(socket.id, client);
        this.logger.info('[GAME SERVER] Connection established:', socket.id);
        this.logger.debug('socket.connect', { id: socket.id, address: client.address, transport: socket.conn.transport.name });
        socket.onAny((event, ...args) => this.logger.debug('socket.receive', { id: socket.id, event, args }));
        socket.on('error', error => this.logger.debug('socket.error', { id: socket.id, error }));
        socket.conn.on('upgrade', transport => this.logger.debug('socket.upgrade', { id: socket.id, transport: transport.name }));
        /** Register a synchronous command handler and translate thrown errors into rejection events. */
        const guard = (event, handler, errorEvent = 'request_rejected') => socket.on(event, (...args) => {
            try { handler(...args); }
            catch (error) {
                this.logger.info(`[GAME SERVER] ${event} rejected for ${socket.id}: ${error.message}`);
                socket.emit(errorEvent, { event, reason: error.message });
            }
        });
        /** Resolve the current session distributor after any membership switch. */
        const distribution = () => this.bindings.get(client.session.id).distribution;
        /** Reject privileged commands unless this connection passed admin admission. */
        const requireAdmin = () => { if (!client.admin) throw new Error('Admin role required'); };
        guard('join_session', id => this.join(client, typeof id === 'string' ? id : id?.sessionId), 'session_rejected');
        guard('request_sessions', () => socket.emit('sessions_list', this.sessions.list()));
        guard('request_terrain_presets', () => socket.emit('terrain_presets', { sessionId: client.session.id, presets: terrainPresets, selected: client.session.data.map.terrain.preset || null }));
        guard('register_actor', input => {
            if (client.admin) throw new Error('Observers cannot register actors');
            const existed = client.session.data.actors.has(socket.id);
            if (!existed) client.session.actors.create(socket.id, client.address);
            let descriptor;
            try { descriptor = client.session.actors.register(socket.id, input); }
            catch (error) { if (!existed) client.session.actors.remove(socket.id); throw error; }
            client.registration = { descriptor, geometry: client.session.data.meshes.get(socket.id), physicsProfile: { ...client.session.data.actors.get(socket.id).physicsProfile }, body: client.session.data.actors.get(socket.id).body };
            client.session.snapshot();
            socket.emit('registration_accepted', descriptor);
            if (!existed) socket.emit('session_joined', { sessionId: client.session.id, name: client.session.name });
            this.broadcast(client.session, 'mesh_manifest_entry', descriptor);
            client.session.emit('data_changed');
        }, 'registration_rejected');
        guard('action', input => {
            if (!client.session.data.actors.has(socket.id)) throw new Error('Register actor before sending actions');
            client.session.actors.action(socket.id, input);
        });
        guard('request_map', () => distribution().request(socket, 'terrain'));
        guard('request_world', () => distribution().request(socket, 'terrain'));
        guard('request_actors', () => socket.emit('actors_list', Object.fromEntries(client.session.data.registrations)));
        guard('request_mesh', id => {
            if (!distribution().request(socket, `mesh:${String(id)}`)) throw new Error('Actor mesh unavailable');
        });
        guard('request_data', request => {
            if (request?.sessionId && request.sessionId !== client.session.id) throw new Error('Wrong session');
            if (typeof request?.resource !== 'string' || !distribution().request(socket, request.resource)) throw new Error('Resource unavailable');
        });
        guard('data_ack', acknowledgment => {
            if (acknowledgment?.sessionId !== client.session.id || !client.session.data.acknowledge(socket.id, acknowledgment.resource, acknowledgment.version)) throw new Error('Invalid data acknowledgment');
        });
        guard('request_data_manifest', () => distribution().manifest(socket));
        guard('request_sync_manifest', () => {
            requireAdmin();
            socket.emit('sync_manifest', { sessionId: client.session.id, clients: [...client.session.data.clients.keys()].map(id => ({ id, ...client.session.data.manifest(id) })) });
        });
        /** Close a targeted socket; normal disconnect handlers remove its session membership. */
        const disconnect = id => this.io.sockets.sockets.get(id)?.disconnect(true);
        guard('admin_kick_actor', id => {
            requireAdmin();
            if (client.session.actors.kick(id, disconnect)) {
                this.broadcast(client.session, 'mesh_manifest_removed', id);
                client.session.snapshot(); client.session.emit('data_changed');
            }
        });
        guard('admin_ban_actor', id => {
            requireAdmin();
            const ids = [...client.session.data.actors.keys()];
            const address = client.session.actors.ban(id, disconnect);
            if (address) {
                for (const actorId of ids) if (!client.session.data.actors.has(actorId)) this.broadcast(client.session, 'mesh_manifest_removed', actorId);
                socket.emit('actor_banned', { id, address });
                client.session.snapshot(); client.session.emit('data_changed');
            }
        });
        guard('admin_unban_actor', address => { requireAdmin(); client.session.actors.unban(address); });
        guard('admin_reset_targets', () => { requireAdmin(); client.session.resetTargets(); });
        guard('admin_remove_targets', () => {
            requireAdmin();
            this.broadcast(client.session, 'targets_removed', client.session.removeTargets());
        });
        guard('admin_disable_object_collisions', () => {
            requireAdmin();
            this.broadcast(client.session, 'collision_settings', client.session.disableObjectCollisions());
        });
        guard('admin_preview_terrain', request => {
            requireAdmin();
            if (!Number.isSafeInteger(request?.requestId) || request.requestId < 0) throw new Error('Invalid terrain preview request ID');
            socket.emit('terrain_preview', { ...client.session.previewTerrainPreset(request.preset), requestId: request.requestId });
        });
        guard('admin_set_terrain_preset', preset => {
            requireAdmin();
            this.broadcast(client.session, 'terrain_changed', client.session.setTerrainPreset(preset));
        });
        guard('admin_flatten_terrain', () => {
            requireAdmin();
            const result = client.session.flattenTerrain();
            this.broadcast(client.session, 'terrain_flattened', result);
        });
        socket.on('disconnect', reason => {
            this.logger.info('[GAME SERVER] Disconnected:', socket.id);
            this.logger.debug('socket.disconnect', { id: socket.id, reason });
            this.connections.delete(socket.id); this.detach(client);
        });
        try { this.join(client, auth.sessionId || 'default', true); }
        catch (error) { socket.emit('session_rejected', { reason: error.message }); socket.disconnect(true); }
    }
    /** Release owned listeners, sockets, timers and session state; does not delete external files. */
    close() {
        this.io.off('connection', this.onConnection);
        this.sessions.off('created', this.onCreated); this.sessions.off('removing', this.onRemoving);
        for (const session of this.sessions.sessions.values()) this.unbindSession(session);
    }
}
module.exports = { ClientSockets };
