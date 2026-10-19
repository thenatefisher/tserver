# Game server architecture

The root `game-server.js` is an executable composition entry point. It reads runtime options, creates the server, starts it, and installs shutdown handlers. It exports `createGameServer` for integration tests and embedding. Importing it does not bind ports or start timers.

## Layout and ownership

```text
game-server.js
modules/
  contracts/     Shared schema loading and Ajv validation
  server/        HTTP, Socket.IO clients, session discovery, logging and lifecycle
    public/      Admin dashboard and GLB viewer
  sessions/      Session registry, session lifecycle, data store and distribution
  actors/        Registration, binary geometry validation, kick and ban
  terrain/       World generation, sampling, validation and target reset
  physics/       One model per session with action, vector, rotation,
                 force, integration and constraint submodules
  game-model.js  Compatibility export for the model class
test/            Unit, schema and network integration tests
docs/            Architecture and protocol notes
node_modules/    Installed dependencies
tbn/             Versioned framework schemas, invariants, relay and client guidance
```

`tbn` is tracked directly in this repository so client contracts and their updates are committed with the implementation. It is not a second server implementation. The server requires its schemas and invariant file at runtime.

- `SessionManager` creates, lists, starts and removes sessions.
- `GameSession` owns a `SessionData`, `ActorManager`, and distinct `PhysicsModel`, plus simulation, broadcast and metrics timers. No actor, mesh, terrain, ban, action or receipt registry is global.
- `SessionData` owns connected-client records, actor records, registered descriptors, GLB buffers, immutable session terrain and the latest public snapshot. Physics owns the authoritative moving state; session ticks copy motion back into actor records. Public snapshots contain only public fields.
- `ClientSockets` owns connections and session membership. It validates admission, routes events, restricts moderation to observers with the admin role, and delegates game changes. Socket.IO rooms isolate event delivery. Session removal disconnects its clients and clears its timers and data.
- `DataDistribution` delivers versioned resources without putting terrain or mesh bytes in the moving-state stream.
- `SessionDiscovery` advertises currently available sessions through the HTTP endpoints and UDP replies.

## Definitive interface contracts

`modules/contracts` loads the original JSON files directly and compiles Ajv validators. It does not maintain copied schemas. Required properties, optional components, ranges, string lengths, allowed profile fields, world dimensions, elevation scale and Euler order come from `tbn/schemas`.

| Source | Server use |
| --- | --- |
| `actor.schema.json` and `mesh.schema.json` | Validate every registration before changing a registered actor or publishing geometry |
| `actions.schema.json` | Validate every action, reject unknown/out-of-range fields, preserve omitted components |
| `world.schema.json` | Derive dimensions and elevation scale; validate generated and supplied maps |
| `state.schema.json` | Validate every public snapshot before distribution |
| `tbn/docs/invariants.json` | Non-schema protocol and binary rules: ports, discovery messages, cadence, body basis, GLB bytes, triangles, hitbox and volume |

Where the schemas contain executable constraints, they take precedence over duplicated explanatory values. Runtime tuning such as terrain spacing, friction, initial health, logging detail and memory budgets remains implementation policy, not an additional client-selectable attribute.

The former server contract is intentionally superseded:

- `linear` is per-axis acceleration in g, with X/Y/Z limits ±3/±1/±5; `angular` is per-axis acceleration in rad/s² with limits ±1. `accel`, `angularAccel`, `moment` and `fire` are rejected. Diagonal commands are not normalized to unit magnitude; each axis has its own schema range.
- Missing vectors and components retain previous commands. Explicit zeros clear them. Invalid actions leave previous commands intact.
- `physicsProfile` requires `maxSpeed`; acceleration, angular acceleration, armor and cooling are not selectable fields.
- Body coordinates are +X forward, +Y left, +Z up. World coordinates remain +Y up. Orientation is body Euler radians in explicit XYZ order.
- World size and integer DTED elevation encoding come from the world schema. The old 200 metre world, metre-valued heights and fixed 61-post grid are removed.
- State includes `hitEvents` and runs at the invariant's approximately 15 Hz broadcast rate, separate from 30 Hz simulation.

## Connection and session flow

1. The connection selects `auth.sessionId`, default `default`. Unknown sessions, banned addresses and invalid configured admin tokens are rejected.
2. The server sends `init`, `map_data`, `mesh_manifest`, a current state and the initial data manifest. An unregistered player receives `session_selected` and is visible in connection metrics, but has no simulated actor.
3. A player sends a schema-valid `register_actor`. The server checks actual binary geometry, creates its session actor and publishes its registration. It replies `registration_accepted` and then `session_joined`. This automatically joins the initially selected session for existing framework clients that do not send an explicit join event.
4. An already registered client may send `join_session` with a session ID. Admission is checked before the old session is changed. The old actor, GLB ownership, subscriptions and receipts are removed. The validated registration is attached to a fresh actor in the target session. Actions, motion and data receipts start fresh there.
5. Disconnecting removes membership, actor, physics state, registration and geometry. Reconnection is a new connection and requires registration again.

Admin observers connect using `auth.role: 'admin'` and do not create actors. When `ADMIN_TOKEN` is configured, the handshake must also supply `auth.adminToken`. Without a token, the admin role is a trusted LAN convention rather than authenticated identity. The dashboard includes a token field and session selector.

## Session discovery and network events

`GET /ping` reports actual HTTP port and session summaries. `GET /sessions` returns the summaries directly. UDP listens on the invariant's discovery port and responds to its probe prefix, including the framework client's `_PING` suffix. Responses use the invariant beacon type and include current session summaries. Tests can use ephemeral ports or disable UDP.

Existing TBN events retain their names and schema-defined payloads: `init`, `map_data`, `mesh_manifest`, `mesh_manifest_entry`, `mesh_manifest_removed`, `register_actor`, `registration_accepted`, `registration_rejected`, `action`, `request_mesh`, `mesh_geometry`, `request_actors`, `actors_list`, and `state`.

The following extensions manage sessions and cached data:

| Request | Response or effect |
| --- | --- |
| `request_sessions` | `sessions_list` |
| `join_session` | `session_joined`, or `session_rejected` without losing old membership |
| `request_map` or `request_world` | Current `map_data` |
| `request_data` with `{sessionId, resource}` | Resource payload and `data_version` |
| `data_ack` with `{sessionId, resource, version}` | Advances that client's acknowledged version if the version was sent |
| `request_data_manifest` | Own `data_manifest` |
| `request_sync_manifest` from admin | `sync_manifest` containing all session clients' receipt manifests |
| `admin_kick_actor` | Disconnects a session client, including an unregistered connection |
| `admin_ban_actor` | Records the address ban and disconnects players at that address in the session |
| `admin_unban_actor` | Removes a session address ban |
| `admin_reset_targets` | Replaces targets and versions/distributes the world resource |

Bans use the server-observed address, not a client-supplied name or socket ID. They survive reconnects within the live session, affect clients sharing that address, and expire when the session is removed or the process restarts. A ban does not prevent participation in another session. Moderation is confined to the requesting admin's session.

## Data versions and update delivery

Resource keys are `terrain`, `registrations`, `state`, and `mesh:<actorId>`. Every replacement increments the resource's session-local version. Removal creates a versioned mesh tombstone so caches can invalidate geometry. Registrations contain descriptors; raw GLB buffers are kept separately.

For each connection, the data store maintains subscriptions, last sent versions, acknowledged versions and a bounded history of versions actually sent. `needsUpdate` compares current versus acknowledged versions. An emitted payload is never assumed to have been received. Stale acknowledgments cannot move progress backward; unsent, future or wrong-session acknowledgments are rejected.

All clients subscribe to world, registrations and state. Geometry is subscribed to on demand through `request_mesh` or `request_data`. Re-registration automatically updates geometry subscribers; removal emits `data_removed` and the existing manifest removal event. Unrequested geometry remains visible as available and unacknowledged in the manifest but is not pushed to every player.

Each payload retains its existing event shape. A following `data_version` envelope identifies its resource and version. Updated clients acknowledge after receiving/caching the payload. `auth.sync: true` enables one-second retries of unacknowledged subscribed data. Legacy clients can keep using existing events; their receipts remain unknown and they do not receive acknowledgment-driven retries. Moving state is coalesced into full snapshots rather than queued per tick.

```js
const socket = io(serverUrl, {
  auth: { sessionId: 'default', sync: true }
});
socket.on('data_version', version => {
  // The payload event is delivered before its version envelope.
  // A client with asynchronous cache writes should wait for those writes.
  socket.emit('data_ack', version);
});
```

## Physics instance and model

Every session creates a new immutable `TerrainModel` and a distinct `PhysicsModel`. Default worlds use a new random procedural seed; supply a seed for repeatable generation. The schema-defined DTED grid is cloned and deeply frozen, and its world-wrapper reference cannot be replaced during the session. Practice targets can be reset without changing that grid or its physics instance.

Every registered GLB supplies a closed indexed collision mesh in body coordinates. All actors use the session's uniform density (default one mass unit per cubic metre). Mass is enclosed GLB volume times density. The approximate center of mass is the centroid of the transformed visual bounds; a box inertia tensor is retained for future response extensions. GLB roots need not coincide with their COM. Physics advances the COM and derives the root pose from the newly rotated COM offset. Public position/velocity remain at the mesh root; COM velocity and collision geometry remain private.

`linear` commands are continuous accelerations: forward/back body X supports ±3 g, sideways Y ±1 g, and vertical Z ±5 g. Angular components remain ±1 rad/s². Inputs use the shared schema, and omitted components retain their previous values. A positive vertical pulse above 1 g lifts a level unit naturally; there is no special jump impulse or cooldown. Holding thrust continues accelerating, and explicitly clearing it restores gravity-driven flight.

During terrain contact, a tangent frame is built from the surface normal and rotated forward axis. Lateral motion is constrained to zero, all ground spin is resisted, and forward/backward rolling experiences a much smaller deceleration. Grounded angular commands therefore do not provide stationary turning or wheel steering. Airborne actors accept all linear/angular commands. Landing resolves penetration, removes into-surface motion and reapplies ground traction.

Terrain contact tests transformed GLB vertices, face centroids, edge midpoints and terrain posts inside projected faces, rather than clamping the origin or using the visual box as the collider. The terrain is treated as solid below the sampled heightfield. No-data samples are excluded from height interpolation. Actors also collide with other actors: bounds are a broad-phase test, followed by solid containment/surface-intersection checks. Contact response uses mass-weighted box-axis separation and inelastic normal impulses.

The engine advances synchronized, bounded substeps to reduce contact tunneling. This remains an approximate discrete contact solver: it does not compute general rigid-body angular impulses, exact continuous collision detection, or a full wheel/suspension model. Box inertia is currently descriptive; angular inputs are accelerations, not torque. See [physics.md](physics.md) for model interfaces and numerical choices.

`queueHit` validates transient hit events, includes them in the next new snapshot, and drains them. Replayed cached snapshots retain event IDs for client deduplication. Combat/projectile creation and damage calculation are separate from the solid actor contacts; there is no automatic firing input.

## Running and verification

```sh
npm install
npm start
npm start -- --debug
npm test
```

`PORT`, `DISCOVERY_PORT`, and optional `ADMIN_TOKEN` configure the executable. Import `createGameServer` to create additional sessions programmatically, inject physics/environment configuration, select ephemeral ports, and call `start()` or `close()`. `close()` disconnects clients, clears session timers and data, and closes HTTP and UDP listeners.

Debug logs cover startup, HTTP requests, received socket events, connection diagnostics and discovery. They omit simulation-tick and socket-send logs as requested.

Tests validate schema acceptance/rejection, partial inputs and units, axes, terrain encoding, transformed GLB geometry, physics and session isolation, registration atomicity, data receipts and invalidation, HTTP/UDP discovery, session switching, moderation and shutdown. The historical Word document in this directory describes the earlier checkout; this Markdown reference documents the current refactor.
