const { EventEmitter } = require('node:events');
const { GameSession } = require('./session');
class SessionManager extends EventEmitter {
    constructor() { super(); this.sessions = new Map(); this.running = false; }
    createSession(options = {}) {
        const id = options.id || 'default';
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid session ID');
        if (this.sessions.has(id)) throw new Error(`Session already exists: ${id}`);
        const session = new GameSession({ ...options, id });
        this.sessions.set(id, session);
        this.emit('created', session);
        if (this.running) session.start();
        return session;
    }
    get(id = 'default') { return this.sessions.get(id); }
    list() { return [...this.sessions.values()].map(session => session.description()); }
    removeSession(id) {
        const session = this.get(id);
        if (!session) return false;
        this.emit('removing', session);
        session.close(); this.sessions.delete(id);
        return true;
    }
    start() { this.running = true; for (const session of this.sessions.values()) session.start(); }
    close() { this.running = false; for (const id of [...this.sessions.keys()]) this.removeSession(id); this.removeAllListeners(); }
}
module.exports = { SessionManager };
