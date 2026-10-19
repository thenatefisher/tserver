/**
 * Create, discover and dispose independent game-session instances.
 * Inputs: Session options and session IDs.
 * Outputs: GameSession instances and public session summaries.
 * Side effects: Mutates the registry, emits lifecycle events and starts/stops owned sessions.
 * Coupling: GameSession owns simulation/data; ClientSockets observes creation/removal for transport wiring.
 */
const { EventEmitter } = require('node:events');
const { GameSession } = require('./session');
class SessionManager extends EventEmitter {
    /** Create an empty registry; sessions begin running only when start is called. */
    constructor() { super(); this.sessions = new Map(); this.running = false; }
    /** Construct/register an independent session and notify lifecycle observers; starts it if running. */
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
    /** Return a session by ID without changing membership or state. */
    get(id = 'default') { return this.sessions.get(id); }
    /** Return public summaries of current sessions without exposing private state. */
    list() { return [...this.sessions.values()].map(session => session.description()); }
    /** Notify removal observers, dispose the session and remove its registry entry. */
    removeSession(id) {
        const session = this.get(id);
        if (!session) return false;
        this.emit('removing', session);
        session.close(); this.sessions.delete(id);
        return true;
    }
    /** Start this instance’s listener/timers if not already active; returns or resolves its runtime. */
    start() { this.running = true; for (const session of this.sessions.values()) session.start(); }
    /** Release owned listeners, sockets, timers and session state; does not delete external files. */
    close() { this.running = false; for (const id of [...this.sessions.keys()]) this.removeSession(id); this.removeAllListeners(); }
}
module.exports = { SessionManager };
