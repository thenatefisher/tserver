/**
 * Executable orchestration entry point.
 * Inputs: environment port/token options and --debug.
 * Outputs: a running server, or exported createGameServer for embedding.
 * Side effects: only direct execution binds listeners and installs shutdown signals.
 * Coupling: modules/server owns lifecycle; modules/contracts owns protocol defaults.
 */
const { invariants } = require('./modules/contracts');
const { createGameServer } = require('./modules/server');

/** Compose and start one server runtime; shutdown signals close its owned resources. */
async function main() {
    const server = createGameServer({
        port: Number(process.env.PORT ?? invariants.network.serverPort),
        discoveryPort: Number(process.env.DISCOVERY_PORT ?? invariants.network.udpDiscoveryPort),
        discovery: process.env.K_SERVICE ? false : undefined,
        debug: process.argv.includes('--debug'),
        adminToken: process.env.ADMIN_TOKEN,
        systemMessagesFile: process.env.SYSTEM_MESSAGES_FILE,
        publicGameUrl: process.env.PUBLIC_GAME_URL ?? invariants.network.browserServerUrl,
        allowedOrigins: (process.env.ALLOWED_BROWSER_ORIGINS || '').split(',').filter(Boolean)
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        server.close().catch(error => { console.error(error); process.exitCode = 1; });
    });
    await server.start();
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { createGameServer };
