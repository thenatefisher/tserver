/** Bind the actual server directly, avoiding a port-probe/bind race. */
async function listenWithFallback(server, { port = 3000, host = '0.0.0.0' } = {}) {
    const preferredPort = Number(port);
    if (!Number.isInteger(preferredPort) || preferredPort < 0 || preferredPort > 65535) {
        throw new RangeError('port must be an integer from 0 to 65535');
    }
    const bind = requestedPort => new Promise((resolve, reject) => {
        const cleanup = () => {
            server.off('error', onError);
            server.off('listening', onListening);
        };
        const onError = error => { cleanup(); reject(error); };
        const onListening = () => { cleanup(); resolve(server.address().port); };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
            server.listen(requestedPort, host);
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
    try {
        return await bind(preferredPort);
    } catch (error) {
        if (error.code !== 'EADDRINUSE' || preferredPort === 0) throw error;
        // Let the OS allocate and bind an available port in one operation.
        return bind(0);
    }
}

module.exports = { listenWithFallback };
