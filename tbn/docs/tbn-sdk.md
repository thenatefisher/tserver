# Client integration recipe (protocol v2)

Socket.IO is the supported transport. The hosted `/tbn.js` exposes `window.TBN.connect(options)` and bundles Socket.IO. Older `TbnSDK.connect()` examples are not this API. The returned object is a standard Socket.IO socket; use the events below. Read [physics-controls.md](physics-controls.md) and validate generated payloads against the shared schemas.

## Connect, register, and check compatibility

Load `<script src="https://open.thisagentmd.com/tbn.js" crossorigin="anonymous"></script>` before game code. It bundles the pinned Socket.IO browser client and exposes `TBN.connect()`; embed other dependencies at build time. Read the prepared actor from the embedded `tbn-actor` JSON script, not a neighboring file. Connect directly to `https://open.thisagentmd.com`; register after every connection, including reconnects. The server must permit local-file browser origins. `init` is the player ID from this direct connection.

```js
const preparedActorPackage = JSON.parse(document.getElementById('tbn-actor').textContent);
const socket = TBN.connect(); // defaults to https://open.thisagentmd.com; no cookies
let playerId, sequence = 0, protocolReady = false, registered = false;
const neutral = () => ({ move: { x: 0, y: 0, z: 0 }, rotate: { x: 0, y: 0, z: 0 }, brake: 0, jump: false });
let held = neutral();
socket.on('protocol_info', info => {
  protocolReady = info.protocolVersion === 2;
  if (!protocolReady) showError('Client/server protocol mismatch; rebuild this client.');
  // Render boat water at info.physics.waterLevel; retain session policy for UI.
});
socket.on('init', id => { playerId = id; sequence = 0; held = neutral(); });
socket.on('registration_accepted', () => { registered = true; sequence = 0; held = neutral(); });
socket.on('registration_rejected', error => { registered = false; showError(error.reason); });
socket.on('request_rejected', error => showError(error.reason));
socket.on('state', state => {
  const own = state.actors.find(actor => actor.id === playerId);
  if (own) sequence = Math.max(sequence, own.lastInputSequence + 1);
});
socket.on('connect', () => { registered = false; held = neutral(); socket.emit('register_actor', preparedActorPackage); });
socket.on('connect_error', error => showError(error.message));
socket.on('disconnect', () => { protocolReady = false; registered = false; held = neutral(); });
setInterval(() => {
  if (socket.connected && protocolReady && registered) {
    socket.emit('action', { protocolVersion: 2, sequence: sequence++, ...held });
  }
}, 1000 / 30);
window.addEventListener('blur', () => {
  held = neutral();
  if (socket.connected && protocolReady && registered) socket.emit('action', { protocolVersion: 2, sequence: sequence++, ...held });
});
```

The hosted adapter handles the connection; implement the game event handlers above in index.html. `TBN.connect({actor: preparedActorPackage})` can alternatively own reconnect registration; omit your manual connect registration handler when using that option. Implement showError and map controls to held state. Clear controls on hidden-page and pointer-lock loss. Do not create a local relay or load actor.json at runtime.

## State and assets

```js
socket.on('map_data', world => cacheWorldAndBuildTerrain(world));
socket.on('mesh_manifest', entries => updateActorDescriptors(entries));
socket.on('mesh_manifest_entry', actor => socket.emit('request_mesh', actor.id));
socket.on('mesh_geometry', mesh => loadGlbFromBase64(mesh.glb, mesh.metadata));
socket.on('mesh_manifest_removed', id => removeActor(id));
socket.on('state', state => bufferSnapshotForInterpolation(state));
```

Request meshes from initial manifest entries as well as new entry events. Cache world/geometry separately from moving state. State includes every actor (including this player), position/root velocity, body Euler XYZ attitude, body angular rates, grounded status and `lastInputSequence`, plus projectiles and transient hit events. Apply the body-to-world transform and quaternion interpolation from [physics-controls.md](physics-controls.md). Deduplicate hit effects by event ID. Optional fire inputs and authoritative rockets/explosions follow [rockets.md](rockets.md).

## Sessions and delivery receipts

Use `request_sessions` → `sessions_list`; send `join_session` with a session ID only after registration. Reset input sequence and interpolation caches on `init` after selection/transfer. On `session_rejected`, retain the existing session and display the reason. `request_world` refreshes static data; changing targets does not deform terrain.

Optional delivery tracking uses `data_version` envelopes after payload events. Cache the payload before acknowledging `{sessionId, resource, version}` with `data_ack`. `lastInputSequence` is a separate physics acknowledgment, not a data-cache receipt. See [multiplayer-server.md](multiplayer-server.md).

Each open HTML instance has its own direct server connection and input sequence. Register on that connection and use its init ID to identify the player.

Handle every `map_data` as a replacement, including admin flatten updates. Dispose the old rendered terrain and rebuild from the new grid. On `terrain_flattened`, clear pose interpolation buffers without resetting input sequences.

Listen for `collision_settings` to mirror server terrain-only mode in any local prediction; keep visuals and terrain contact. `targets_removed` is informational: the preceding replacement `map_data.targets` list is authoritative, so remove stale target meshes. See [physics-controls.md](physics-controls.md#session-diagnostic-controls).

`request_terrain_presets` returns the terrain catalog; preset IDs live in `world.schema.json`. On `terrain_changed`, reset old pose interpolation just as for `terrain_flattened`. See [terrain-presets.md](terrain-presets.md).

Aircraft input adapters and autopilots should follow [aircraft-controller.md](aircraft-controller.md). Use body angular rates and reconstructed COM velocity for flight estimation; no snapshot timestamp or server clock-sync API is currently available.
