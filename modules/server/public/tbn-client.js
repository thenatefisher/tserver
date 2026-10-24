/**
 * Expose the hosted browser TBN connection adapter after the bundled Socket.IO client.
 * Inputs: Server-injected public URL and optional connection overrides/registration package.
 * Outputs: window.TBN.connect() returns a normal Socket.IO player socket.
 * Side effects: Creates lobby sockets; joins explicitly and resumes unexpected transport loss.
 * Coupling: /tbn.js bundles this adapter with the pinned Socket.IO browser distribution.
 */
(function (global) {
    'use strict';
    const serverUrl = global.__TBN_SERVER_URL__;
    /** Connect without cookies; install user handlers before the deferred initial connection. */
    function connect(options = {}) {
        const { url = serverUrl, actor, sessionId, ...socketOptions } = options;
        const socket = global.io(url, { ...socketOptions, path: '/socket.io', withCredentials: false, autoConnect: false });
        let resumeToken = null;
        socket.on('session_joined', result => { resumeToken = result.resumeToken; });
        socket.on('session_left', () => { resumeToken = null; });
        socket.on('session_closed', () => { resumeToken = null; });
        socket.joinSession = (id, registration = actor, { waitForReady = false } = {}) => new Promise((resolve, reject) => {
            socket.timeout(10000).emit('join_session', { sessionId: id, actor: registration, waitForReady }, (error, result) => {
                if (error || !result?.ok) reject(error || new Error(result?.reason || 'Join failed'));
                else resolve(result);
            });
        });
        socket.ready = () => new Promise((resolve, reject) => {
            socket.timeout(10000).emit('client_ready', (error, result) => {
                if (error || !result?.ok) reject(error || new Error(result?.reason || 'Ready failed'));
                else resolve(result);
            });
        });
        socket.leaveSession = () => new Promise((resolve, reject) => {
            socket.timeout(10000).emit('leave_session', (error, result) => {
                if (error || !result?.ok) reject(error || new Error(result?.reason || 'Leave failed'));
                else resolve(result);
            });
        });
        socket.on('connect', () => {
            if (resumeToken) socket.timeout(10000).emit('resume_session', { resumeToken }, (error, result) => {
                if (error || !result?.ok) { resumeToken = null; socket.emitReserved('connect_error', error || new Error(result?.reason || 'Resume failed')); }
            });
            else if (sessionId) socket.joinSession(sessionId).catch(error => socket.emitReserved('connect_error', error));
        });
        if (socketOptions.autoConnect !== false) queueMicrotask(() => socket.connect());
        return socket;
    }
    global.TBN = Object.freeze({ serverUrl, connect });
})(window);
