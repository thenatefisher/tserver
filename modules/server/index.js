const { invariants } = require('../contracts');
const { SessionManager } = require('../sessions/manager');
const { createHttpServer } = require('./http');
const { SessionDiscovery } = require('./discovery');
const { ClientSockets } = require('./sockets');
const { createLogger } = require('./logger');

function createGameServer(options = {}) {
    const logger = options.logger || createLogger(options.debug);
    const sessions = new SessionManager();
    for (const config of options.sessions || [{ id: 'default', name: 'Tank Battle' }]) sessions.createSession(config);
    const { app, http, io } = createHttpServer({ sessions, logger, port: options.port ?? invariants.network.serverPort });
    const sockets = new ClientSockets({ io, sessions, logger, adminToken: options.adminToken });
    const discovery = options.discovery === false ? null : new SessionDiscovery({
        sessions, logger, httpPort: () => http.address()?.port,
        port: options.discoveryPort ?? invariants.network.udpDiscoveryPort, host: options.host || '0.0.0.0'
    });
    let started = false, closing;
    const runtime = {
        app, http, io, sessions, sockets, discovery,
        async start() {
            if (started) return runtime;
            try {
                await new Promise((resolve, reject) => {
                    const failed = error => reject(error);
                    http.once('error', failed);
                    http.listen(options.port ?? invariants.network.serverPort, options.host || '0.0.0.0', () => { http.off('error', failed); resolve(); });
                });
                await discovery?.start();
                sessions.start(); started = true;
                logger.info(`[CENTRAL GAME SERVER] Running on port ${http.address().port}`);
                logger.debug('startup', { pid: process.pid, port: http.address().port, sessions: sessions.list() });
                return runtime;
            } catch (error) { await runtime.close(); throw error; }
        },
        close() {
            if (closing) return closing;
            closing = (async () => {
                sockets.close(); sessions.close();
                await discovery?.close();
                await new Promise(resolve => { io.close(resolve); http.closeAllConnections(); });
                started = false;
            })();
            return closing;
        }
    };
    return runtime;
}
module.exports = { createGameServer };
