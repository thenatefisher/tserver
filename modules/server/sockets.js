/**
 * Manage client admission, session membership and routing of socket commands.
 * Inputs: Socket.IO connections, session registry, logger and optional admin token.
 * Outputs: Session-scoped payloads, rejection events, manifests and moderation effects.
 * Side effects: Installs/removes handlers, changes room membership and mutates session state through managers.
 * Coupling: ActorManager handles actors; DataDistribution handles versioned delivery; sessions own physics.
 */
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { invariants, protocolVersion, terrainPresets, schemas } = require('../contracts');
const { HITBOX_SIZE } = require('../actors/constants');
const { AdminManagement } = require('./admin-management');
const { DataDistribution } = require('../sessions/distribution');

class ClientSockets {
    /** Own connection maps and install session/Socket.IO lifecycle listeners without creating actors. */
    constructor({ io, sessions, logger, adminToken, systemMessages }) {
        Object.assign(this, { io, sessions, logger, adminToken, systemMessages });
        this.systemMessages = systemMessages;
        this.events = []; this.eventSequence = 0;
        this.contractFingerprint = createHash('sha256').update(JSON.stringify(schemas)).digest('hex');
        this.connections = new Map(); this.bindings = new Map(); this.resumptions = new Map();
        this.management = new AdminManagement(this);
        this.onCreated = session => { this.bindSession(session); this.publishSessions(); };
        this.onRemoving = session => this.unbindSession(session);
        this.onConnection = socket => this.connect(socket);
        this.onRemoved = () => this.publishSessions();
        sessions.on('removed', this.onRemoved);
        sessions.on('created', this.onCreated); sessions.on('removing', this.onRemoving);
        for (const session of sessions.sessions.values()) this.bindSession(session);
        io.on('connection', this.onConnection);
    }
    /** Bounded, redacted audit history; never retain credentials or raw mesh bytes. */
    audit(type, client, details = {}, level = 'info', sessionId = client?.session?.id || null) {
        const entry = { id: ++this.eventSequence, timestamp: new Date().toISOString(), type, level,
            sessionId, clientId: client?.socket?.id || null, client: client?.diagnostics ? structuredClone(client.diagnostics) : null, details: this.summarize(details) };
        this.events.push(entry);
        if (this.events.length > 1000) this.events.shift();
        for (const observer of this.connections.values()) if (observer.admin) observer.socket.emit('admin_event', entry);
    }
    /** Limit depth, item count and string lengths before retaining untrusted packages. */
    summarize(value, depth = 0, budget = { remaining: 16000 }) {
        if ((budget.remaining -= 32) < 0) return '[size limit]';
        if (depth > 6) return '[depth limit]';
        if (typeof value === 'string') { const limit = Math.max(0, Math.min(2048, budget.remaining)); budget.remaining -= Math.min(value.length, limit); return value.length > limit ? value.slice(0, limit) + '… [truncated]' : value; }
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.slice(0, 40).map(item => this.summarize(item, depth + 1, budget));
        return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key,
            /token|secret|password|cookie|authorization/i.test(key) ? '[redacted]' :
            key === 'glb' ? { encoding: 'base64', characters: typeof item === 'string' ? item.length : Number.isSafeInteger(item?.characters) ? item.characters : null } : this.summarize(item, depth + 1, budget)]));
    }
    expireResume(token) {
        const saved = this.resumptions.get(token);
        if (!saved) return;
        clearTimeout(saved.timer); saved.session.reservedPlayers--; this.resumptions.delete(token);
        this.publishSessions();
    }
    saveResume(client) {
        if (!client.session || !client.registration || client.admin || client.loading) return;
        const session = client.session;
        const actor = session.data.actors.get(client.socket.id);
        if (!actor) return;
        const saved = { session, address: client.address, expiresAt: Date.now() + 30000, registration: client.registration, playerId: client.playerId,
            pose: structuredClone({ position: actor.position, orientation: actor.orientation, health: actor.health }) };
        session.reservedPlayers++;
        saved.timer = setTimeout(() => this.expireResume(client.resumeToken), 30000);
        saved.timer.unref(); this.resumptions.set(client.resumeToken, saved);
    }
    publishSessions() { this.io.emit('sessions_list', this.sessions.list()); }
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
    /** Return session members to the lobby and remove publication handlers before disposal. */
    unbindSession(session) {
        for (const [token, saved] of this.resumptions) if (saved.session === session) this.expireResume(token);
        for (const client of [...this.connections.values()]) if (client.session === session) {
            client.socket.emit('session_closed', { sessionId: session.id });
            this.detach(client);
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
        clearTimeout(client.loadingTimer); client.loadingTimer = null; client.loading = false;
        if (!session) return;
        session.data.clients.delete(socket.id);
        if (session.actors.remove(socket.id)) {
            session.snapshot();
            this.broadcast(session, 'mesh_manifest_removed', socket.id);
            session.emit('data_changed');
        }
        socket.leave(`session:${session.id}`);
        client.session = null;
        this.publishSessions();
    }
    /** Check admission first, then attach/switch session and deliver its initial versioned resources. */
    join(client, sessionId, selectOnly = false, waitForReady = false) {
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('Session ID required');
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error('Unknown game session');
        if (!client.admin && !session.acceptingPlayers) throw new Error('Session is closed to new players');
        if (!client.admin && session.actors.isBanned(client.address)) throw new Error('Client is banned from this session');
        if (!client.admin && !client.registration && !selectOnly) throw new Error('Register actor before joining a session');
        if (client.session === session) return { sessionId: session.id, name: session.name };
        if (!client.admin && session.description().playerCount >= session.maxPlayers) throw new Error('Session is full');
        // Prepare the target actor before releasing the old membership.
        if (!client.admin && client.registration && !waitForReady) {
            try { session.actors.attach(client.socket.id, client.address, client.registration); }
            catch (error) { session.actors.remove(client.socket.id); throw error; }
        }
        this.detach(client);
        client.session = session;
        client.loading = waitForReady && !client.admin;
        const socket = client.socket;
        socket.join(`session:${session.id}`);
        session.data.addClient(socket.id, { admin: client.admin, connectedAt: client.connectedAt, address: client.address });

        if (client.loading) {
            client.loadingTimer = setTimeout(() => {
                this.detach(client); client.registration = null;
                socket.emit('session_left', { reason: 'Loading timed out' });
            }, 30000);
            client.loadingTimer.unref();
        }
        session.snapshot();
        this.audit('session.joined', client, { loading: client.loading });
        socket.emit(client.loading ? 'session_loading' : client.admin || client.registration ? 'session_joined' : 'session_selected', { sessionId: session.id, name: session.name, playerId: client.playerId, resumeToken: client.resumeToken });
        socket.emit('protocol_info', { protocolVersion, inputTimeoutSeconds: invariants.input.inputTimeoutSeconds, weapons: invariants.weapons, physics: { ...invariants.physics, ...session.physics.environment, terrain: undefined, groundHeight: undefined, bounds: undefined } });
        socket.emit('terrain_presets', { sessionId: session.id, presets: terrainPresets, selected: session.data.map.terrain.preset || null });
        socket.emit('collision_settings', { sessionId: session.id, terrainOnlyCollisions: session.physics.terrainOnlyCollisions });
        socket.emit('init', socket.id);
        const distribution = this.bindings.get(session.id).distribution;
        distribution.flush(socket); distribution.manifest(socket);
        session.emit('data_changed');
        if (!client.admin && client.registration) socket.emit('registration_accepted', client.registration.descriptor);
        this.publishSessions();
        return { sessionId: session.id, name: session.name, status: client.loading ? 'loading' : 'playing' };
    }
    /** Emit a payload only to the specified session room. */
    broadcast(session, event, payload) { this.io.to(`session:${session.id}`).emit(event, payload); }
    /** Install guarded protocol handlers and select the initial session for a newly admitted socket. */
    connect(socket) {
        const auth = socket.handshake.auth || {};
        const client = { playerId: randomUUID(), resumeToken: randomBytes(32).toString('hex'), socket, session: null, address: socket.handshake.address, connectedAt: Date.now(), registration: null, admin: auth.role === 'admin' };
        const headers = socket.handshake.headers;
        const ua = headers['user-agent'] || '';
        const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome/Chromium' : /Safari\//.test(ua) ? 'Safari' : 'Unknown / non-browser';
        client.diagnostics = this.summarize({ address: client.address, forwardedFor: headers['x-forwarded-for'] || null,
            addressNote: 'Peer address is observed; forwarded headers and client versions are unverified claims.',
            userAgent: headers['user-agent'] || null, browser, browserHints: headers['sec-ch-ua'] || null,
            platform: headers['sec-ch-ua-platform'] || null, mobile: headers['sec-ch-ua-mobile'] || null,
            origin: headers.origin || null, language: headers['accept-language'] || null,
            transport: socket.conn.transport.name, role: client.admin ? 'admin' : 'player',
            reportedProtocolVersion: auth.protocolVersion ?? null, reportedSchemaVersion: auth.schemaVersion ?? null,
            reportedContractVersion: auth.contractVersion ?? null, serverProtocolVersion: protocolVersion, serverSchemaDraft: schemas.actor.$schema, serverContractFingerprint: this.contractFingerprint });
        if (auth.role === 'admin' && (!this.adminToken || typeof auth.adminToken !== 'string' || !timingSafeEqual(createHash('sha256').update(auth.adminToken).digest(), createHash('sha256').update(this.adminToken).digest()))) {
            this.audit('authentication.failed', client, { reason: 'Invalid admin token or admin access is not configured' }, 'error');
            socket.emit('session_rejected', { reason: 'Invalid admin token' }); socket.disconnect(true); return;
        }
        socket.emit('system_messages', this.systemMessages.current());
        this.connections.set(socket.id, client);
        this.management.bind(socket, client);
        this.audit('connection.opened', client);
        if (client.admin) { socket.emit('admin_authenticated'); socket.emit('admin_events', { events: this.events, limit: 1000 }); this.management.publish(socket); }
        this.logger.info('[GAME SERVER] Connection established:', socket.id);
        this.logger.debug('socket.connect', { id: socket.id, address: client.address, transport: socket.conn.transport.name });
        socket.onAny((event, ...args) => this.logger.debug('socket.receive', { id: socket.id, event, args: event === 'resume_session' ? ['[redacted]'] : this.summarize(args) }));
        socket.on('error', error => { this.logger.debug('socket.error', { id: socket.id, error }); this.audit('connection.error', client, { reason: error.message }, 'error'); });
        socket.conn.on('upgrade', transport => { client.diagnostics.transport = transport.name; this.audit('connection.upgraded', client, { transport: transport.name }); });
        /** Register a synchronous command handler and translate thrown errors into rejection events. */
        const guard = (event, handler, errorEvent = 'request_rejected') => socket.on(event, (...args) => {
            const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
            const registration = event === 'register_actor' ? args[0] : event === 'join_session' ? args[0]?.actor : null;
            const registrationAttempt = event === 'register_actor' || registration != null;
            const requestedSession = event === 'join_session' ? (typeof args[0] === 'string' ? args[0] : args[0]?.sessionId) : client.session?.id;
            if (registrationAttempt) this.audit('registration.attempt', client, { event, package: this.summarize(registration),
                reportedProtocolVersion: registration?.protocolVersion ?? null, reportedSchemaVersion: registration?.schemaVersion ?? null,
                reportedContractVersion: registration?.contractVersion ?? null }, 'info', typeof requestedSession === 'string' ? requestedSession.slice(0, 100) : null);
            try {
                if (!['join_session', 'leave_session', 'request_sessions', 'resume_session'].includes(event) && !client.session) throw new Error('Join a session first');
                const result = handler(...args);
                if (event.startsWith('admin_')) this.audit('admin.command', client, { event, arguments: this.summarize(args) });
                if (registrationAttempt) this.audit('registration.accepted', client, { event, descriptor: this.summarize(client.registration?.descriptor) });
                ack?.({ ok: true, ...result });
            }
            catch (error) {
                this.logger.info(`[GAME SERVER] ${event} rejected for ${socket.id}: ${error.message}`);
                const failure = { ok: false, event, reason: error.message };
                this.audit(registrationAttempt ? 'registration.failed' : 'request.rejected', client, failure, 'error', typeof requestedSession === 'string' ? requestedSession.slice(0, 100) : null);
                socket.emit(errorEvent, failure); ack?.(failure);
            }
        });
        /** Resolve the current session distributor after any membership switch. */
        const distribution = () => this.bindings.get(client.session.id).distribution;
        /** Reject privileged commands unless this connection passed admin admission. */
        const requireAdmin = () => { if (!client.admin) throw new Error('Admin role required'); };
        guard('join_session', request => {
            const id = typeof request === 'string' ? request : request?.sessionId;
            const previous = client.registration;
            if (request?.actor) {
                if (client.admin) throw new Error('Observers cannot register actors');
                const target = this.sessions.get(id);
                if (!target) throw new Error('Unknown game session');
                if (client.session === target) throw new Error('Leave before replacing registration through join');
                const { buffer, info, metadata, body } = target.actors.prepare(request.actor);
                client.registration = {
                    descriptor: { id: socket.id, name: request.actor.name, clientType: request.actor.clientType,
                        physicsProfile: { ...request.actor.physicsProfile }, triangles: info.triangles, hitbox: { ...HITBOX_SIZE }, metadata },
                    geometry: { id: socket.id, buffer, metadata, triangles: info.triangles, hitbox: { ...HITBOX_SIZE } },
                    physicsProfile: { ...request.actor.physicsProfile }, body
                };
            }
            try { return this.join(client, id, false, request?.waitForReady === true); }
            catch (error) { client.registration = previous; throw error; }
        }, 'session_rejected');
        guard('resume_session', request => {
            if (client.session) throw new Error('Leave before resuming a session');
            const token = request?.resumeToken;
            const saved = this.resumptions.get(token);
            if (!saved) throw new Error('Resume token expired or invalid');
            if (saved.session.actors.isBanned(client.address)) throw new Error('Client is banned from this session');
            this.expireResume(token);
            client.registration = { ...saved.registration, descriptor: { ...saved.registration.descriptor, id: socket.id }, geometry: { ...saved.registration.geometry, id: socket.id } }; client.playerId = saved.playerId;
            try {
                const result = this.join(client, saved.session.id);
                const actor = saved.session.data.actors.get(socket.id);
                Object.assign(actor, saved.pose); saved.session.actors.place(actor);
                saved.session.physics.addActor(actor); saved.session.snapshot();
                return result;
            } catch (error) { client.registration = null; throw error; }
        }, 'session_rejected');
        guard('client_ready', () => {
            if (!client.loading) throw new Error('Session is not loading');
            const session = client.session;
            const receipt = session.data.clients.get(socket.id);
            for (const key of ['terrain', 'registrations']) {
                if (receipt.acknowledged.get(key) !== session.data.resources.get(key).version) throw new Error('Required resources are not acknowledged');
            }
            session.actors.attach(socket.id, client.address, client.registration);
            clearTimeout(client.loadingTimer); client.loadingTimer = null; client.loading = false;
            session.snapshot(); session.emit('data_changed');
            socket.emit('session_joined', { sessionId: session.id, name: session.name, playerId: client.playerId, resumeToken: client.resumeToken });
            return { sessionId: session.id, status: 'playing' };
        });
        guard('leave_session', () => { this.audit('session.left', client); this.detach(client); client.registration = null; socket.emit('session_left'); return {}; });
        guard('request_sessions', () => socket.emit('sessions_list', this.sessions.list()));
        guard('request_terrain_presets', () => socket.emit('terrain_presets', { sessionId: client.session.id, presets: terrainPresets, selected: client.session.data.map.terrain.preset || null }));
        guard('register_actor', input => {
            if (client.admin) throw new Error('Observers cannot register actors');
            if (client.loading) throw new Error('Finish loading before replacing registration');
            const existed = client.session.data.actors.has(socket.id);
            if (!existed) client.session.actors.create(socket.id, client.address);
            let descriptor;
            try { descriptor = client.session.actors.register(socket.id, input); }
            catch (error) { if (!existed) client.session.actors.remove(socket.id); throw error; }
            client.registration = { descriptor, geometry: client.session.data.meshes.get(socket.id), physicsProfile: { ...client.session.data.actors.get(socket.id).physicsProfile }, body: client.session.data.actors.get(socket.id).body };
            client.session.snapshot();
            socket.emit('registration_accepted', descriptor);
            if (!existed) socket.emit('session_joined', { sessionId: client.session.id, name: client.session.name, playerId: client.playerId, resumeToken: client.resumeToken });
            this.broadcast(client.session, 'mesh_manifest_entry', descriptor);
            client.session.emit('data_changed');
        }, 'registration_rejected');
        guard('action', input => {
            if (!client.reportedActionVersion) { client.reportedActionVersion = true; this.audit('contract.reported', client, { source: 'action', protocolVersion: input?.protocolVersion ?? null }); }
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
            this.audit('connection.closed', client, { reason });
            if (reason === 'transport close' || reason === 'transport error' || reason === 'ping timeout') this.saveResume(client);
            this.connections.delete(socket.id); this.detach(client);
        });
        socket.emit('sessions_list', this.sessions.list());
        // An explicit handshake selection remains supported for existing clients.
        if (auth.sessionId) {
            try { this.join(client, auth.sessionId, true); }
            catch (error) { socket.emit('session_rejected', { reason: error.message }); }
        }
    }
    /** Release owned listeners, sockets, timers and session state; does not delete external files. */
    close() {
        this.management.close();
        for (const token of this.resumptions.keys()) this.expireResume(token);
        this.io.off('connection', this.onConnection);
        this.sessions.off('removed', this.onRemoved);
        this.sessions.off('created', this.onCreated); this.sessions.off('removing', this.onRemoving);
        for (const session of this.sessions.sessions.values()) this.unbindSession(session);
    }
}
module.exports = { ClientSockets };
