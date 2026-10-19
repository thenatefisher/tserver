/**
 * Bridge browser Socket.IO clients to the authoritative TBN server and cache session resources.
 * Inputs: Constructor options, browser v2 frames/registrations, upstream discovery and server events.
 * Outputs: HTTP assets, relayed authoritative events and local lifecycle events.
 * Side effects: Binds HTTP/UDP during start, maintains caches, opens upstream sockets and resends registration.
 * Coupling: actions schema drives diagnostics; server protocol owns validation/physics; no local simulation.
 */
const express = require('express');
const os = require('os');
const dgram = require('dgram');
const httpClient = require('http');
const { EventEmitter } = require('events');
const actionSchema = require('./schemas/actions.schema.json');
const { generatePlayerName } = require('./player-names');

/**
 * The reusable local backend for a game client.
 *
 * There are three connections in this class:
 *   1. The browser connects to `ioLocal` (the local Socket.IO server).
 *   2. This process connects to the central game server with `gameServerSocket`.
 *   3. Express serves the user's frontend and any custom local HTTP API.
 *
 * The class keeps the central server authoritative: it forwards browser input
 * upstream and forwards authoritative state/events back to every browser tab.
 * It does not simulate movement, collision, damage, or other game rules.
 *
 * Subclass ClientNode to override core behavior, or listen for its lifecycle
 * events to add behavior without replacing it. Public properties such as app,
 * ioLocal, gameServerSocket and the state caches are intentionally exposed.
 */
class ClientNode extends EventEmitter {
    constructor(options = {}) {
        super();

        this.options = options;
        // Change these values in client.js or pass them to the constructor.
        this.localPort = options.localPort ?? process.env.LOCAL_PORT ?? 3000;
        this.gameServerPort = options.gameServerPort || 4000;
        this.udpDiscoveryPort = options.udpDiscoveryPort || 4001;
        this.explicitServerUrl = options.serverUrl || process.argv[2] || process.env.GAME_SERVER_URL;
        this.staticPath = options.staticPath || __dirname;

        // Supplying app/httpServer/ioLocal is useful for tests or an existing
        // Express application. Most users can leave these at their defaults.
        this.app = options.app || express();
        this.http = options.httpServer || require('http').createServer(this.app);
        this.ioLocal = options.ioLocal || require('socket.io')(this.http, {
            cors: { origin: '*' }
        });
        this.ioClient = options.ioClient || require('socket.io-client');

        // These fields are deliberately public so a custom backend can inspect
        // current connection status and cached game data at any time.
        this.gameServerSocket = null;
        this.isConnectedToGameServer = false;
        this.currentServerUrl = null;
        this.cachedRegistrationAccepted = null;
        this.cachedProtocolInfo = null;
        this.cachedMapData = null;
        this.cachedActorsList = {};
        this.cachedMeshManifest = {};
        this.cachedMeshes = {};
        this.currentGameState = {};
        this.started = false;
        this.playerName = options.playerName || null;
        // A complete build-time package following schemas/actor.schema.json.
        // Its mesh follows schemas/mesh.schema.json; never register without it.
        this.actorRegistration = options.actorRegistration || null;
        this.debug = options.debug !== false;
        this.debugEvents = new Map();
    }

    /** Summarize the pipeline without printing multi-megabyte GLB strings. */
    debugEvent(direction, event, data, browserId) {
        if (!this.debug) return;
        const key = `${direction}:${browserId || ''}:${event}`;
        const previous = this.debugEvents.get(key) || { count: 0, loggedAt: 0 };
        previous.count++;
        this.debugEvents.set(key, previous);
        // Show the first packet immediately, then one summary per five seconds.
        if ((event === 'action' || event === 'state') && previous.count > 1 && Date.now() - previous.loggedAt < 5000) return;
        previous.loggedAt = Date.now();
        const details = { count: previous.count, browserId, upstreamConnected: this.isConnectedToGameServer };
        if (event === 'action') {
            const allowedSignals = Object.keys(actionSchema.properties);
            details.signals = Object.fromEntries(allowedSignals.filter(name => data?.[name] !== undefined).map(name => [name, data[name]]));
            details.unsupportedSignals = Object.keys(data || {}).filter(name => !allowedSignals.includes(name));
            details.frameSemantics = 'v2 complete normalized control effort; missing fields rejected; stale input neutralizes';
        } else if (event === 'state') {
            const actors = Array.isArray(data?.actors) ? data.actors : [];
            const ownActor = actors.find(actor => actor.id === this.gameServerSocket?.id);
            Object.assign(details, { actorCount: actors.length, ownActorPresent: !!ownActor,
                ownPosition: ownActor?.position, ownVelocity: ownActor?.velocity });
        } else if (event === 'register_actor' || event === 'mesh_geometry') {
            const mesh = event === 'register_actor' ? data?.mesh : data;
            const glb = mesh?.glb;
            const header = typeof glb === 'string' ? Buffer.from(glb.slice(0, 16), 'base64') : null;
            Object.assign(details, { id: data?.id, name: data?.name,
                physicsProfile: data?.physicsProfile, glbPresent: typeof glb === 'string' && glb.length > 0,
                base64Characters: typeof glb === 'string' ? glb.length : 0,
                glbMagic: header?.subarray(0, 4).toString(),
                glbVersion: header?.length >= 8 ? header.readUInt32LE(4) : undefined,
                declaredGlbBytes: header?.length >= 12 ? header.readUInt32LE(8) : undefined,
                visualSize: mesh?.metadata?.visualSize,
                hardpointCount: mesh?.metadata?.projectileOrigins?.length });
        } else if (event === 'registration_rejected') {
            details.reason = data?.reason || 'No rejection reason supplied';
        } else if (event === 'registration_accepted' || event === 'mesh_manifest_entry') {
            Object.assign(details, { id: data?.id, name: data?.name });
        } else if (event === 'mesh_manifest' || event === 'actors_list') {
            details.actorIds = Object.keys(data || {});
        } else if (event === 'map_data') {
            Object.assign(details, { columns: data?.terrain?.columns, rows: data?.terrain?.rows,
                heightCount: data?.terrain?.depthMap?.length });
        } else if (event === 'init' || event === 'request_mesh' || event === 'mesh_manifest_removed') {
            details.actorId = data;
        }
        const log = event === 'registration_rejected' || direction === 'dropped' ? console.warn : console.log;
        log(`[TBN DEBUG] ${direction} ${event}`, details);
    }

    /**
     * Configure Express before the server starts listening.
     * Add routes/middleware in an override, then call super.configureApp() to
     * keep serving index.html and the rest of the configured static directory.
     */
    configureApp() {
        this.app.use(express.static(this.staticPath));
    }

    /** Return IPv4 subnet prefixes used by the default LAN discovery scan. */
    getLocalSubnets() {
        const subnets = [];
        for (const interfaces of Object.values(os.networkInterfaces())) {
            for (const iface of interfaces || []) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    const parts = iface.address.split('.');
                    if (parts.length === 4) {
                        subnets.push({ ip: iface.address, prefix: `${parts[0]}.${parts[1]}.${parts[2]}.` });
                    }
                }
            }
        }
        return subnets;
    }

    /**
     * Find the central game server. The default strategy checks an explicit
     * URL, UDP beacons, and /ping on local addresses before falling back to
     * localhost. Override this when the server URL comes from a database,
     * command-line menu, cloud service, or another discovery mechanism.
     * The returned value must be a Socket.IO-compatible URL string.
     */
    async discoverGameServer() {
        if (this.explicitServerUrl) {
            console.log(`[DISCOVERY] Explicit server address provided: ${this.explicitServerUrl}`);
            return this.explicitServerUrl;
        }

        console.log('[DISCOVERY] Searching for Game Server on local subnets...');
        return new Promise((resolve) => {
            let resolved = false;
            const done = (url) => {
                if (resolved) return;
                resolved = true;
                resolve(url);
            };

            // Fast path: game servers can announce themselves over UDP.
            try {
                const udpClient = dgram.createSocket('udp4');
                udpClient.bind(() => {
                    udpClient.setBroadcast(true);
                    const message = Buffer.from('TBN_DISCOVER_PING');
                    udpClient.send(message, 0, message.length, this.udpDiscoveryPort, '255.255.255.255', (err) => {
                        if (err) console.log('[UDP DISCOVERY] Broadcast send warning:', err.message);
                    });
                });
                udpClient.on('message', (msg, rinfo) => {
                    try {
                        const data = JSON.parse(msg.toString());
                        if (data.type === 'TBN_SERVER_BEACON') {
                            const foundUrl = `http://${rinfo.address}:${data.port || this.gameServerPort}`;
                            console.log(`[DISCOVERY SUCCESS] Found server via UDP Beacon at ${foundUrl}`);
                            udpClient.close();
                            done(foundUrl);
                        }
                    } catch (error) {
                        this.emit('discovery:error', error);
                    }
                });
                setTimeout(() => {
                    try { udpClient.close(); } catch (_) {}
                }, 2000);
            } catch (error) {
                this.emit('discovery:error', error);
            }

            // Fallback path: probe localhost and each local /24 for /ping.
            const candidateIps = ['127.0.0.1'];
            for (const subnet of this.getLocalSubnets()) {
                console.log(`[DISCOVERY] Scanning local subnet range ${subnet.prefix}1-254...`);
                for (let i = 1; i <= 254; i++) candidateIps.push(`${subnet.prefix}${i}`);
            }

            for (const ip of candidateIps) {
                const req = httpClient.get({
                    hostname: ip,
                    port: this.gameServerPort,
                    path: '/ping',
                    timeout: 400
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => {
                        try {
                            if (JSON.parse(body).gameServer) {
                                const foundUrl = `http://${ip}:${this.gameServerPort}`;
                                console.log(`[DISCOVERY SUCCESS] Found server via HTTP probe at ${foundUrl}`);
                                done(foundUrl);
                            }
                        } catch (_) {}
                    });
                });
                req.on('error', () => {});
                req.on('timeout', () => req.destroy());
            }

            // Never leave startup hanging if no server answers discovery.
            setTimeout(() => {
                if (!resolved) {
                    const fallback = `http://localhost:${this.gameServerPort}`;
                    console.log(`[DISCOVERY] No active server found on LAN. Defaulting to ${fallback}`);
                    done(fallback);
                }
            }, 2500);
        });
    }

    /**
     * Create the upstream Socket.IO connection. Override this to customize
     * authentication or socket options; call super.connectToCentralServer(url)
     * unless you also plan to register all required event handlers yourself.
     */
    connectToCentralServer(targetUrl) {
        this.currentServerUrl = targetUrl;
        console.log(`[LOCAL CLIENT NODE] Connecting to Central Game Server at: ${targetUrl}`);
        if (this.gameServerSocket) this.gameServerSocket.disconnect();

        this.gameServerSocket = this.ioClient(targetUrl, {
            reconnection: true,
            reconnectionDelay: 1000,
            timeout: 5000,
            ...(this.options.gameSocketOptions || {})
        });
        this.registerGameServerHandlers(this.gameServerSocket);
        return this.gameServerSocket;
    }

    /**
     * Register events received from the authoritative game server.
     * Each standard event is cached (when needed), emitted to local browsers,
     * and exposed as a `game:<event>` EventEmitter event. Add custom server
     * events with `this.relayFromGame(socket, 'my_event')`.
     */
    registerGameServerHandlers(socket) {
        socket.on('connect', () => {
            this.isConnectedToGameServer = true;
            // Keep the same identity on reconnect; actor registration sends it upstream.
            if (!this.playerName) this.playerName = generatePlayerName();
            console.log('[LOCAL CLIENT NODE] Player name:', this.playerName);
            if (this.actorRegistration) {
                this.sendActorRegistration(this.actorRegistration);
            } else {
                console.warn('[TBN] Actor registration required: waiting for a package conforming to tbn/schemas/actor.schema.json (including mesh.schema.json). Supply options.actorRegistration or send register_actor from the browser.');
            }
            console.log(`[LOCAL CLIENT NODE] Connected to Game Server at ${this.currentServerUrl}! (ID: ${socket.id})`);
            this.ioLocal.emit('server_status', { connected: true, serverUrl: this.currentServerUrl, nodeSocketId: socket.id, playerName: this.playerName });
            this.emit('game:connect', socket);
        });
        socket.on('disconnect', (reason) => {
            this.cachedRegistrationAccepted = null; this.cachedProtocolInfo = null;
            this.isConnectedToGameServer = false;
            console.log(`[LOCAL CLIENT NODE] Disconnected from Game Server (${this.currentServerUrl}). Retrying...`);
            this.ioLocal.emit('server_status', { connected: false, serverUrl: this.currentServerUrl });
            this.emit('game:disconnect', reason);
        });
        socket.on('connect_error', (error) => {
            this.isConnectedToGameServer = false;
            console.error('[TBN DEBUG] Upstream connect_error:', error.message);
            this.ioLocal.emit('server_status', { connected: false, serverUrl: this.currentServerUrl, error: error.message });
            this.emit('game:connect_error', error);
        });

        // These are the standard game protocol events. Keep them when
        // overriding this method unless the custom client intentionally uses a
        // different protocol.
        this.relayFromGame(socket, 'protocol_info', data => { this.cachedProtocolInfo = data; });
        this.relayFromGame(socket, 'init', () => {
            this.cachedMapData = null; this.cachedActorsList = {}; this.cachedMeshManifest = {}; this.cachedMeshes = {}; this.currentGameState = {};
        });
        for (const event of ['session_selected', 'session_joined', 'session_rejected', 'session_closed', 'sessions_list', 'request_rejected', 'data_version', 'data_manifest', 'data_removed', 'terrain_flattened']) this.relayFromGame(socket, event);
        this.relayFromGame(socket, 'map_data', data => { this.cachedMapData = data; });
        this.relayFromGame(socket, 'mesh_manifest', data => {
            this.cachedMeshManifest = data;
            this.cachedActorsList = data;
        });
        this.relayFromGame(socket, 'actors_list', data => {
            this.cachedMeshManifest = data;
            this.cachedActorsList = data;
        });
        this.relayFromGame(socket, 'mesh_manifest_entry', data => {
            this.cachedMeshManifest[data.id] = data;
            this.cachedActorsList[data.id] = data;
        });
        this.relayFromGame(socket, 'mesh_manifest_removed', id => {
            delete this.cachedMeshManifest[id];
            delete this.cachedActorsList[id];
            delete this.cachedMeshes[id];
            if (this.currentGameState && Array.isArray(this.currentGameState.actors)) {
                this.currentGameState.actors = this.currentGameState.actors.filter(actor => actor.id !== id);
            }
        });
        this.relayFromGame(socket, 'mesh_geometry', data => { this.cachedMeshes[data.id] = data; });
        this.relayFromGame(socket, 'registration_rejected');
        this.relayFromGame(socket, 'registration_accepted', data => { this.cachedRegistrationAccepted = data; });
        this.relayFromGame(socket, 'state', data => { this.currentGameState = data; });
        this.relayFromGame(socket, 'player_hit');
    }

    /**
     * Forward one game-server event to all connected browser tabs.
     * `updateCache` is optional and runs before the browser notification, which
     * lets custom events update backend state consistently.
     */
    relayFromGame(socket, eventName, updateCache) {
        socket.on(eventName, (data) => {
            this.debugEvent('server -> browser', eventName, data);
            if (updateCache) updateCache(data);
            this.ioLocal.emit(eventName, data);
            this.emit(`game:${eventName}`, data);
        });
    }

    /** Attach the local Socket.IO connection handler once during startup. */
    registerLocalHandlers() {
        this.ioLocal.on('connection', browserSocket => this.handleBrowserConnection(browserSocket));
    }

    /**
     * Initialize a browser tab and wire its standard commands upstream.
     * Cached map/actor/state data is replayed immediately so a newly opened tab
     * does not need to wait for the next game-server broadcast. Override this
     * to add per-browser permissions or custom events, and call super first.
     */
    handleBrowserConnection(browserSocket) {
        console.log('[LOCAL CLIENT NODE] Local browser tab connected to Local Node.');
        if (this.debug) console.log('[TBN DEBUG] Browser connected; replaying cache', {
            browserId: browserSocket.id, upstreamId: this.gameServerSocket?.id,
            upstreamConnected: this.isConnectedToGameServer,
            staticPath: this.staticPath, mapCached: !!this.cachedMapData,
            manifestActorIds: Object.keys(this.cachedMeshManifest),
            cachedMeshIds: Object.keys(this.cachedMeshes),
            stateActorCount: this.currentGameState?.actors?.length || 0
        });
        const diagnosticTimer = this.debug ? setTimeout(() => {
            const received = event => this.debugEvents.has(`browser -> server:${browserSocket.id}:${event}`);
            if (!received('register_actor')) console.warn('[TBN DEBUG] No register_actor received from this browser after 5 seconds. Check browser startup/registration code.', { browserId: browserSocket.id });
            if (!received('action')) console.warn('[TBN DEBUG] No action received from this browser after 5 seconds. Check browser input handlers and action loop.', { browserId: browserSocket.id });
            if (!Object.keys(this.cachedMeshes).length) console.warn('[TBN DEBUG] No mesh geometry cached. Check registration results, manifest events, and request_mesh. Rendering/GLB loader errors must be checked in the browser console.');
        }, 5000) : null;
        diagnosticTimer?.unref();
        browserSocket.on('disconnect', reason => {
            clearTimeout(diagnosticTimer);
            if (this.debug) console.log('[TBN DEBUG] Browser disconnected', { browserId: browserSocket.id, reason });
            for (const key of this.debugEvents.keys()) {
                if (key.startsWith(`browser -> server:${browserSocket.id}:`) || key.startsWith(`dropped:${browserSocket.id}:`)) this.debugEvents.delete(key);
            }
        });
        browserSocket.emit('server_status', { connected: this.isConnectedToGameServer, serverUrl: this.currentServerUrl, playerName: this.playerName });
        if (this.cachedProtocolInfo) browserSocket.emit('protocol_info', this.cachedProtocolInfo);
        if (this.gameServerSocket && this.gameServerSocket.id) browserSocket.emit('init', this.gameServerSocket.id);
        if (this.cachedRegistrationAccepted) browserSocket.emit('registration_accepted', this.cachedRegistrationAccepted);
        if (this.cachedMapData) browserSocket.emit('map_data', this.cachedMapData);
        if (Object.keys(this.cachedMeshManifest).length) browserSocket.emit('mesh_manifest', this.cachedMeshManifest);
        for (const mesh of Object.values(this.cachedMeshes)) browserSocket.emit('mesh_geometry', mesh);
        if (Object.keys(this.currentGameState).length) browserSocket.emit('state', this.currentGameState);

        // These are the standard browser commands understood by the game
        // server. Add more commands with relayToGame(browserSocket, 'name').
        this.relayToGame(browserSocket, 'register_actor');
        this.relayToGame(browserSocket, 'action');
        this.relayToGame(browserSocket, 'request_mesh');
        this.relayToGame(browserSocket, 'request_actors');
        for (const event of ['join_session', 'request_sessions', 'request_map', 'request_world', 'request_data', 'request_data_manifest', 'data_ack']) this.relayToGame(browserSocket, event);
        this.emit('browser:connect', browserSocket);
    }

    /**
     * Forward a browser event to the central game server when connected.
     * This also emits `browser:<event>` locally, even if the game server is
     * offline, so custom backend code can log or handle the command itself.
     */
    relayToGame(browserSocket, eventName) {
        browserSocket.on(eventName, (data) => {
            if (eventName === 'register_actor') {
                this.sendActorRegistration(data, browserSocket.id);
                this.emit('browser:register_actor', data, browserSocket);
                return;
            }
            this.debugEvent('browser -> server', eventName, data, browserSocket.id);
            if (this.gameServerSocket && this.isConnectedToGameServer) {
                data === undefined
                    ? this.gameServerSocket.emit(eventName)
                    : this.gameServerSocket.emit(eventName, data);
            } else {
                this.debugEvent('dropped', eventName, data, browserSocket.id);
            }
            this.emit(`browser:${eventName}`, data, browserSocket);
        });
    }

    /** Retain the prepared actor package and submit it on every upstream connection. */
    sendActorRegistration(data, browserId) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            console.error('[TBN] register_actor requires a package following tbn/schemas/actor.schema.json.');
            return;
        }
        if (!this.playerName) this.playerName = generatePlayerName();
        this.actorRegistration = { ...data, name: data.name || this.playerName };
        this.debugEvent('browser -> server', 'register_actor', this.actorRegistration, browserId);
        if (this.gameServerSocket && this.isConnectedToGameServer) {
            this.gameServerSocket.emit('register_actor', this.actorRegistration);
        } else {
            console.log('[TBN] Actor registration retained; will send when the server connects.');
        }
    }

    /**
     * Start the complete pipeline: configure Express, register local sockets,
     * discover the game server, connect upstream, and begin listening locally.
     * `start()` resolves once the local HTTP server is ready.
     */
    async start() {
        if (this.started) return this;
        this.started = true;
        this.configureApp();
        this.registerLocalHandlers();

        console.log('====================================================');
        console.log(`[LOCAL CLIENT NODE] Starting on http://localhost:${this.localPort}`);
        console.log(`[LOCAL CLIENT NODE] Serving static files from: ${this.staticPath}`);
        console.log('====================================================');

        const serverUrl = await this.discoverGameServer();
        this.connectToCentralServer(serverUrl);
        await new Promise((resolve, reject) => {
            const onError = error => {
                if (error.code === 'EADDRINUSE') {
                    this.http.off('error', onError);
                    this.localPort = 0;
                    this.http.listen(0, '0.0.0.0', () => {
                        this.localPort = this.http.address().port;
                        console.log(`[LOCAL CLIENT NODE] Port 3000 is busy; using http://localhost:${this.localPort}`);
                        this.emit('listening', this.localPort);
                        resolve();
                    });
                    return;
                }
                reject(error);
            };
            this.http.once('error', onError);
            this.http.listen(this.localPort, '0.0.0.0', () => {
                this.http.off('error', onError);
                this.localPort = this.http.address().port;
                console.log(`[LOCAL CLIENT NODE] Local Web Server listening on http://localhost:${this.localPort}`);
                this.emit('listening', this.localPort);
                resolve();
            });
        });
        return this;
    }

    /** Disconnect upstream and close local Socket.IO resources cleanly. */
    async stop() {
        if (this.gameServerSocket) this.gameServerSocket.disconnect();
        await new Promise(resolve => this.ioLocal.close(resolve));
        this.started = false;
        this.emit('stopped');
    }
}

function startClientNode(options = {}) {
    const client = new ClientNode(options);
    // Preserve the original fire-and-forget API. Use `client.ready` when an
    // application needs to await startup, and listen for `start:error` to
    // handle a failed port bind or discovery/connect setup.
    client.ready = client.start();
    client.ready.catch(error => client.emit('start:error', error));
    return client;
}

if (require.main === module) {
    const client = startClientNode();
    client.on('start:error', error => {
        console.error('[LOCAL CLIENT NODE] Failed to start:', error);
        process.exitCode = 1;
    });
}

module.exports = { ClientNode, startClientNode };
