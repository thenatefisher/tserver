/**
 * Define browser-origin access for local-file clients and hosted game views.
 * Inputs: Origin headers, public game URL and optional additional exact origins.
 * Outputs: CORS options, WebSocket admission decisions and asset response headers.
 * Side effects: Asset middleware writes response headers/rejections; no authentication changes.
 * Coupling: HTTP scripts and Socket.IO share one policy; admin tokens remain socket-layer authorization.
 */
/** Allow opaque local-file origins, native clients, hosted game pages and local development origins. */
function browserAccess(publicUrl, additional = []) {
    const publicOrigin = new URL(publicUrl).origin;
    const allowed = new Set([publicOrigin, 'https://game.thisagentmd.com', 'https://open.thisagentmd.com', 'http://open.thisagentmd.com', ...additional]);
    /** Test an origin without treating an allowed browser origin as an authenticated admin. */
    const permits = origin => {
        if (!origin || origin === 'null') return true;
        if (allowed.has(origin)) return true;
        try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
        catch { return false; }
    };
    return {
        permits,
        cors: { origin: (origin, callback) => callback(null, permits(origin)), methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'], credentials: false },
        /** Gate upgrades too: browser WebSockets do not enforce CORS response headers. */
        allowRequest: (request, callback) => callback(null, permits(request.headers.origin)),
        /** Supply CORS for script/HTTP resources, including preflight from a file:// page. */
        assets: (req, res, next) => {
            res.vary('Origin');
            if (!permits(req.headers.origin)) return res.sendStatus(403);
            if (req.headers.origin) res.set('Access-Control-Allow-Origin', req.headers.origin);
            res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.set('Access-Control-Allow-Headers', 'Content-Type');
            res.set('Cross-Origin-Resource-Policy', 'cross-origin');
            if (req.method === 'OPTIONS') return res.sendStatus(204);
            next();
        }
    };
}
module.exports = { browserAccess };
