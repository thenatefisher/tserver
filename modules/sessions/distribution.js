/**
 * Send session resources while preserving existing client payload event shapes.
 * Inputs: Session data store, recipient socket and resource keys/retry policy.
 * Outputs: Payload events followed by resource/version envelopes and manifests.
 * Side effects: Emits socket events and records versions actually sent; does not assume receipt.
 * Coupling: SessionData owns versions/subscriptions; ClientSockets invokes delivery at appropriate events.
 */
class DataDistribution {
    /** Retain a session reference; no data or sockets are changed during construction. */
    constructor(session) { this.session = session; }
    /** Emit one payload and version envelope, recording the send but not assuming receipt. */
    send(socket, resource) {
        const data = this.session.data;
        const entry = data.resources.get(resource);
        if (!entry || !data.clients.has(socket.id)) return false;
        data.sent(socket.id, resource, entry.version);
        const version = { sessionId: this.session.id, resource, version: entry.version, deleted: entry.deleted };
        if (resource === 'terrain') socket.emit('map_data', entry.value);
        else if (resource === 'registrations') socket.emit('mesh_manifest', entry.value);
        else if (resource === 'state') socket.emit('state', entry.value);
        else if (resource.startsWith('mesh:')) {
            if (entry.deleted) socket.emit('data_removed', version);
            else {
                const { buffer, ...geometry } = entry.value;
                socket.emit('mesh_geometry', { ...geometry, glb: buffer.toString('base64') });
            }
        }
        socket.emit('data_version', version);
        return true;
    }
    /** Send all currently pending subscribed resources, optionally retrying unacknowledged versions. */
    flush(socket, retry = false) {
        for (const resource of this.session.data.pending(socket.id, retry)) this.send(socket, resource);
    }
    /** Subscribe to and send an available resource to one socket. */
    request(socket, resource) {
        if (!this.session.data.subscribe(socket.id, resource)) return false;
        return this.send(socket, resource);
    }
    /** Emit this socket’s receipt manifest; does not expose resource payloads or other clients. */
    manifest(socket) { socket.emit('data_manifest', this.session.data.manifest(socket.id)); }
}
module.exports = { DataDistribution };
