/**
 * Expose the hosted browser TBN connection adapter after the bundled Socket.IO client.
 * Inputs: Server-injected public URL and optional connection overrides/registration package.
 * Outputs: window.TBN.connect() returns a normal Socket.IO player socket.
 * Side effects: Creates sockets; optionally resubmits a prepared actor on every reconnect.
 * Coupling: /tbn.js bundles this adapter with the pinned Socket.IO browser distribution.
 */
(function (global) {
    'use strict';
    const serverUrl = global.__TBN_SERVER_URL__;
    /** Connect without cookies; install user handlers before the deferred initial connection. */
    function connect(options = {}) {
        const { url = serverUrl, actor, ...socketOptions } = options;
        const socket = global.io(url, { ...socketOptions, path: '/socket.io', withCredentials: false, autoConnect: false });
        if (actor) socket.on('connect', () => socket.emit('register_actor', actor));
        if (socketOptions.autoConnect !== false) queueMicrotask(() => socket.connect());
        return socket;
    }
    global.TBN = Object.freeze({ serverUrl, connect });
})(window);
