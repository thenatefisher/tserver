/**
 * Server-wide admin telemetry and session/user management, independent of observer membership.
 * Inputs: authenticated socket records and explicit session command targets.
 * Outputs: private aggregate metrics, session rosters, acknowledgments and audit events.
 * Side effects: creates/updates/removes sessions, moderates members and owns one telemetry timer.
 */
const { terrainPresets, invariants } = require('../contracts');

class AdminManagement {
    constructor(owner) {
        this.owner = owner;
        this.startedAt = Date.now();
        this.timer = setInterval(() => this.publish(), 1000);
        this.timer.unref();
    }
    metrics() {
        const { connections, sessions } = this.owner;
        const players = [...connections.values()].filter(client => !client.admin);
        const worlds = [...sessions.sessions.values()];
        return { scope: 'server', uptime: (Date.now() - this.startedAt) / 1000,
            connectedPlayers: players.length, lobbyPlayers: players.filter(client => !client.session).length,
            registeredMeshes: worlds.reduce((count, session) => count + session.data.meshes.size, 0),
            sessionCount: worlds.length, tickRates: [...new Set(worlds.map(session => session.tickRate))].sort((a, b) => a - b) };
    }
    snapshot() {
        const { sessions, connections, resumptions } = this.owner;
        return { presets: terrainPresets, defaults: { tickRate: invariants.network.simulationFrequencyHz, maxPlayers: 16 },
            sessions: [...sessions.sessions.values()].map(session => ({ ...session.description(),
                acceptingPlayers: session.acceptingPlayers, revision: session.adminRevision || 0, startedAt: session.startedAt,
                bans: [...session.actors.bans],
                users: [...connections.values()].filter(client => !client.admin && client.session === session).map(client => ({
                    id: client.socket.id, playerId: client.playerId, name: client.registration?.descriptor.name || 'Unregistered',
                    address: client.address, browser: client.diagnostics.browser, connectedAt: client.connectedAt,
                    status: client.loading ? 'loading' : client.registration ? 'playing' : 'selected',
                    registered: Boolean(client.registration)
                })),
                reservations: [...resumptions.values()].filter(saved => saved.session === session).map(saved => ({
                    playerId: saved.playerId, name: saved.registration.descriptor.name, address: saved.address, expiresAt: saved.expiresAt
                }))
            })) };
    }
    publish(socket) {
        const observers = socket ? [socket] : [...this.owner.connections.values()].filter(client => client.admin).map(client => client.socket);
        if (!observers.length) return;
        const metrics = this.metrics(), sessions = this.snapshot();
        for (const observer of observers) {
            observer.emit('admin_server_metrics', metrics);
            observer.emit('admin_sessions', sessions);
        }
    }
    session(id) {
        if (typeof id !== 'string') throw new Error('Session ID required');
        const session = this.owner.sessions.get(id);
        if (!session) throw new Error('Unknown game session');
        return session;
    }
    /** Whitelist editable settings and validate every field before mutating a live session. */
    parameters(input, current) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Session parameters required');
        const allowed = ['name', 'maxPlayers', 'gameMode', 'tickRate', 'acceptingPlayers', 'terrainPreset'];
        for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unsupported session parameter: ${key}`);
        const next = { ...input };
        if ('name' in next && (typeof next.name !== 'string' || !next.name.trim() || next.name.length > 80)) throw new Error('Name must be 1–80 characters');
        if ('name' in next) next.name = next.name.trim();
        if ('gameMode' in next && (typeof next.gameMode !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(next.gameMode))) throw new Error('Game mode must be a 1–40 character label');
        if ('maxPlayers' in next && (!Number.isInteger(next.maxPlayers) || next.maxPlayers < 1 || next.maxPlayers > 256)) throw new Error('Player limit must be an integer from 1 to 256');
        if (current && next.maxPlayers < current.description().playerCount) throw new Error('Player limit cannot be below occupied and reserved slots');
        if ('tickRate' in next && (!Number.isInteger(next.tickRate) || next.tickRate < 1 || next.tickRate > 120)) throw new Error('Tick rate must be an integer from 1 to 120 Hz');
        if ('acceptingPlayers' in next && typeof next.acceptingPlayers !== 'boolean') throw new Error('Admission must be a boolean');
        if ('terrainPreset' in next && !terrainPresets.some(preset => preset.id === next.terrainPreset)) throw new Error('Unknown terrain preset');
        return next;
    }
    bind(socket, client) {
        const command = (event, handler) => socket.on(event, (request, ack) => {
            try {
                if (!client.admin) throw new Error('Admin role required');
                const result = handler(request);
                this.owner.audit('admin.command', client, { event, arguments: this.owner.summarize(request) }, 'info', typeof (request?.sessionId ?? request?.id) === 'string' ? (request.sessionId ?? request.id).slice(0, 64) : null);
                if (typeof ack === 'function') ack({ ok: true, ...result });
                this.publish();
            } catch (error) {
                const failure = { ok: false, event, reason: error.message };
                this.owner.audit('request.rejected', client, failure, 'error');
                socket.emit('request_rejected', failure);
                if (typeof ack === 'function') ack(failure);
            }
        });
        command('admin_publish_system_messages', request => { this.owner.publishSystemMessages(request); return {}; });
        command('admin_list_sessions', () => { this.publish(socket); return {}; });
        command('admin_create_session', request => {
            if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(request.id)) throw new Error('Session ID must be 1–64 letters, numbers, underscores or hyphens');
            if (this.owner.sessions.sessions.size >= 64) throw new Error('Server session limit reached (64)');
            const parameters = this.parameters(request.parameters);
            const session = this.owner.sessions.createSession({ id: request.id, ...parameters });
            return { sessionId: session.id };
        });
        command('admin_update_session', request => {
            const session = this.session(request?.sessionId);
            if (request.expectedRevision !== (session.adminRevision || 0)) throw new Error('Session changed; reload its parameters before saving');
            const parameters = this.parameters(request.parameters, session);
            const { terrainPreset, ...settings } = parameters;
            if (terrainPreset !== undefined && terrainPreset !== session.data.map.terrain.preset) {
                this.owner.broadcast(session, 'terrain_changed', session.setTerrainPreset(terrainPreset));
            }
            const restart = session.timers.length > 0 && settings.tickRate !== undefined && settings.tickRate !== session.tickRate;
            if (restart) session.stop();
            Object.assign(session, settings); session.adminRevision = (session.adminRevision || 0) + 1;
            if (restart) session.start();
            this.owner.publishSessions();
            this.owner.broadcast(session, 'session_updated', session.description());
            return { sessionId: session.id, revision: session.adminRevision };
        });
        command('admin_delete_session', request => {
            const session = this.session(request?.sessionId);
            if (request.confirmId !== session.id) throw new Error('Confirm the session ID before deleting');
            this.owner.sessions.removeSession(session.id);
            return { sessionId: session.id };
        });
        command('admin_session_user', request => {
            const session = this.session(request?.sessionId);
            if (!['kick', 'ban', 'move', 'remove'].includes(request.action)) throw new Error('Unknown user action');
            const user = this.owner.connections.get(request.clientId);
            if (!user || user.admin || user.session !== session) throw new Error('Player is no longer in this session');
            if (request.action === 'move') {
                if (request.targetSessionId === session.id) throw new Error('Choose a different destination session');
                this.owner.join(user, request.targetSessionId, true, user.loading);
            } else if (request.action === 'remove') {
                this.owner.detach(user); user.registration = null;
                user.socket.emit('session_left', { reason: 'Removed by administrator' });
            } else if (request.action === 'ban') {
                session.actors.ban(user.socket.id, id => this.owner.connections.get(id)?.socket.disconnect(true));
                for (const [token, saved] of this.owner.resumptions) if (saved.session === session && saved.address === user.address) this.owner.expireResume(token);
            } else user.socket.disconnect(true);
            return { sessionId: session.id };
        });
        command('admin_session_unban', request => {
            const session = this.session(request?.sessionId);
            if (typeof request.address !== 'string' || !session.actors.bans.has(request.address)) throw new Error('Address ban no longer exists');
            session.actors.unban(request.address); return {};
        });
        command('admin_revoke_reservation', request => {
            const session = this.session(request?.sessionId);
            const saved = [...this.owner.resumptions].find(([, entry]) => entry.session === session && entry.playerId === request.playerId);
            if (!saved) throw new Error('Reconnect reservation expired or no longer exists');
            this.owner.expireResume(saved[0]); return {};
        });
    }
    close() { clearInterval(this.timer); }
}
module.exports = { AdminManagement };
