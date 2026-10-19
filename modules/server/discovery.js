/**
 * Advertise available sessions over the framework UDP discovery protocol.
 * Inputs: Session registry, actual HTTP port callback, bind options and logger.
 * Outputs: UDP beacon replies containing host identity and current session summaries.
 * Side effects: Binds/closes a UDP socket and sends discovery packets.
 * Coupling: contracts supplies protocol values; HTTP discovery uses the same session registry.
 */
const dgram = require('node:dgram');
const { invariants } = require('../contracts');
class SessionDiscovery {
    /** Retain discovery dependencies and bind configuration; the UDP socket is created by start. */
    constructor({ sessions, httpPort, port = invariants.network.udpDiscoveryPort, host = '0.0.0.0', logger }) {
        Object.assign(this, { sessions, httpPort, port, host, logger });
        this.socket = null;
    }
    /** Start this instance’s listener/timers if not already active; returns or resolves its runtime. */
    async start() {
        if (this.socket) return;
        const socket = this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('message', (message, remote) => {
            this.logger.debug('udp.receive', { remote, message: message.toString() });
            if (!message.toString().startsWith(invariants.network.udpProbeMessage)) return;
            const payload = JSON.stringify({ type: invariants.network.udpBeaconType, port: this.httpPort(), serverName: 'Authoritative Tank Host', sessions: this.sessions.list() });
            socket.send(payload, remote.port, remote.address, error => this.logger.debug('udp.send', { remote, error, bytes: Buffer.byteLength(payload) }));
        });
        socket.on('error', error => this.logger.error('[UDP DISCOVERY]', error.message));
        try {
            await new Promise((resolve, reject) => {
                /** Reject startup on bind failure; the listening callback removes this temporary handler. */
                    const failed = error => reject(error);
                socket.once('error', failed);
                socket.bind(this.port, this.host, () => { socket.off('error', failed); resolve(); });
            });
            this.logger.info(`[UDP DISCOVERY] Beacon listening on UDP port ${socket.address().port}`);
        } catch (error) { await this.close(); throw error; }
    }
    /** Release owned listeners, sockets, timers and session state; does not delete external files. */
    async close() {
        const socket = this.socket; this.socket = null;
        if (!socket) return;
        await new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } });
    }
}
module.exports = { SessionDiscovery };
