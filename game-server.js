const { invariants } = require('./modules/contracts');
const { createGameServer } = require('./modules/server');

async function main() {
    const server = createGameServer({
        port: Number(process.env.PORT ?? invariants.network.serverPort),
        discoveryPort: Number(process.env.DISCOVERY_PORT ?? invariants.network.udpDiscoveryPort),
        debug: process.argv.includes('--debug'),
        adminToken: process.env.ADMIN_TOKEN
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        server.close().catch(error => { console.error(error); process.exitCode = 1; });
    });
    await server.start();
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { createGameServer };
