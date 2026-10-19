/**
 * Construct HTTP routes and the shared Socket.IO transport without starting them.
 * Inputs: Session registry, logger, port policy and repository asset root.
 * Outputs: Express app, HTTP server and Socket.IO server.
 * Side effects: Installs middleware/routes; request handling reads public assets and sends responses.
 * Coupling: contracts supplies network defaults; socket lifecycle is wired by server/index.
 */
const { invariants } = require('../contracts');
const express = require('express');
const { createServer } = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');

/** Build the app/transports and routes; returns unbound servers without starting timers. */
function createHttpServer({ sessions, logger, port = invariants.network.serverPort, root = path.resolve(__dirname, '../..') }) {
    const app = express();
    const http = createServer(app);
    // Allow the largest validated GLB, including base64 expansion and metadata.
    const io = new Server(http, { maxHttpBufferSize: Math.ceil(invariants.geometryLimits.maxGlbBytes / 3) * 4 + 1024 * 1024 });
    app.use((req, res, next) => {
        const started = process.hrtime.bigint();
        logger.debug('http.request', { method: req.method, path: req.path, address: req.socket.remoteAddress });
        res.on('finish', () => logger.debug('http.response', { method: req.method, path: req.path, status: res.statusCode, durationMs: Number(process.hrtime.bigint() - started) / 1e6 }));
        next();
    });
    /** Build current public host/session status; uses the actual bound ephemeral port. */
    const status = () => ({ gameServer: true, port: http.address()?.port || port, serverName: 'Tank-Battle-Host', sessions: sessions.list() });
    app.get(invariants.network.httpPingEndpoint, (req, res) => res.json(status()));
    app.get('/sessions', (req, res) => res.json(sessions.list()));
    app.use('/vendor/three', express.static(path.join(root, 'node_modules/three')));
    app.use(express.static(path.join(__dirname, 'public')));
    app.get(['/', '/admin'], (req, res, next) => {
        res.sendFile(path.join(__dirname, 'public/admin.html'), error => {
            if (!error) return;
            if (error.code === 'ENOENT') return res.json(status());
            next(error);
        });
    });
    io.engine.on('connection_error', error => logger.debug('socket.connection_error', { code: error.code, message: error.message }));
    return { app, http, io };
}
module.exports = { createHttpServer };
