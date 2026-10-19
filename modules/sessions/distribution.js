// Preserve existing payload events; add version envelopes for explicit receipt tracking.
class DataDistribution {
    constructor(session) { this.session = session; }
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
    flush(socket, retry = false) {
        for (const resource of this.session.data.pending(socket.id, retry)) this.send(socket, resource);
    }
    request(socket, resource) {
        if (!this.session.data.subscribe(socket.id, resource)) return false;
        return this.send(socket, resource);
    }
    manifest(socket) { socket.emit('data_manifest', this.session.data.manifest(socket.id)); }
}
module.exports = { DataDistribution };
