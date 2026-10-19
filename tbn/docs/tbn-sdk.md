# Client integration recipe (protocol v2)

Socket.IO is the supported transport. There is no bundled global `TbnSDK` implementation; older examples using `TbnSDK.connect()` were illustrative. Client agents should implement their own adapter using the events below. Read [physics-controls.md](physics-controls.md) and validate generated payloads against the shared schemas.

## Connect, register, and check compatibility

Load Socket.IO from the local client server and the prepared registration package from your root client application. Register after every upstream connection, including reconnects. If writing a local relay, forward upstream `init`, `protocol_info`, registration/session results, state, map, manifests, geometry and rejection events to the browser. `init` is the upstream player ID, not the browser-local socket ID.

```js
const socket = io('http://localhost:3000');
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
socket.on('server_status', status => {
  if (!status.connected) { registered = false; held = neutral(); }
  else socket.emit('register_actor', preparedActorPackage);
});
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

This is a recipe: implement `showError`, load `preparedActorPackage` from the build-time actor JSON, and map user input to `held` according to the selected controller. Also clear held state on hidden-page and pointer-lock loss. A generated relay must emit `server_status` on initial browser attachment and upstream reconnect. With a direct upstream connection, use `connect` to submit registration instead of `server_status`. Do not submit the package through both a relay's automatic registration and browser reconnect logic; pick one owner.

If reusing the framework relay in a context where imports are allowed, it can own registration via `options.actorRegistration`; client-generation placement rules still prohibit importing `tbn/client-node.js` from the required root entry point. Implement the documented bridge in `client.js` for generated clients.

## State and assets

```js
socket.on('map_data', world => cacheWorldAndBuildTerrain(world));
socket.on('mesh_manifest', entries => updateActorDescriptors(entries));
socket.on('mesh_manifest_entry', actor => socket.emit('request_mesh', actor.id));
socket.on('mesh_geometry', mesh => loadGlbFromBase64(mesh.glb, mesh.metadata));
socket.on('mesh_manifest_removed', id => removeActor(id));
socket.on('state', state => bufferSnapshotForInterpolation(state));
```

Request meshes from initial manifest entries as well as new entry events. Cache world/geometry separately from moving state. State includes every actor (including this player), position/root velocity, body Euler XYZ attitude, body angular rates, grounded status and `lastInputSequence`, plus projectiles and transient hit events. Apply the body-to-world transform and quaternion interpolation from [physics-controls.md](physics-controls.md). Deduplicate hit effects by event ID. Fire inputs/projectile creation are not currently implemented.

## Sessions and delivery receipts

Use `request_sessions` → `sessions_list`; send `join_session` with a session ID only after registration. Reset input sequence and interpolation caches on `init` after selection/transfer. On `session_rejected`, retain the existing session and display the reason. `request_world` refreshes static data; changing targets does not deform terrain.

Optional delivery tracking uses `data_version` envelopes after payload events. Cache the payload before acknowledging `{sessionId, resource, version}` with `data_ack`. `lastInputSequence` is a separate physics acknowledgment, not a data-cache receipt. See [multiplayer-server.md](multiplayer-server.md).

One upstream relay connection represents one player: give one active browser tab control ownership. Multiple independent tabs sending sequences for that same actor will conflict. A newly attached view should initialize from cached state acknowledgment or explicitly re-register before taking control; passive spectator views should not send actions.

Handle every `map_data` as a replacement, including admin flatten updates. Dispose the old rendered terrain and rebuild from the new grid. On `terrain_flattened`, clear pose interpolation buffers without resetting input sequences.

Listen for `collision_settings` to mirror server terrain-only mode in any local prediction; keep visuals and terrain contact. `targets_removed` is informational: the preceding replacement `map_data.targets` list is authoritative, so remove stale target meshes. See [physics-controls.md](physics-controls.md#session-diagnostic-controls).

`request_terrain_presets` returns the terrain catalog; preset IDs live in `world.schema.json`. On `terrain_changed`, reset old pose interpolation just as for `terrain_flattened`. See [terrain-presets.md](terrain-presets.md).

Aircraft input adapters and autopilots should follow [aircraft-controller.md](aircraft-controller.md). Use body angular rates and reconstructed COM velocity for flight estimation; no snapshot timestamp or server clock-sync API is currently available.
