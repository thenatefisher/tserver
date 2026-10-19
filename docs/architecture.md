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
tbn/             Existing external framework contract checkout
```

`tbn` is an existing Git framework reference, retained at its required location and left unchanged. It is not a second server implementation. The server requires its schemas and invariant file at runtime.

- `SessionManager` creates, lists, starts and removes sessions.
- `GameSession` owns a `SessionData`, `ActorManager`, and distinct `PhysicsModel`, plus simulation, broadcast and metrics timers. No actor, mesh, terrain, ban, action or receipt registry is global.
- `SessionData` owns connected-client records, actor records, registered descriptors, GLB buffers, terrain and the latest public snapshot. Physics owns the authoritative moving state; session ticks copy motion back into actor records. Public snapshots contain only public fields.
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

- `linear` is per-axis acceleration in g and `angular` is per-axis acceleration in rad/s². `accel`, `angularAccel`, `moment` and `fire` are rejected. Diagonal commands are not normalized to unit magnitude; each axis has its own schema range.
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

Every session constructs a new physics model through `physicsFactory(environment)`. The model owns its actor and projectile arrays and can be replaced for tests or another engine. Submodules separate action merging, vectors, body rotation, forces, integration and constraints.

For linear input, apply intrinsic body Euler XYZ, then the zero-heading basis conversion `(x,y,z) -> (x,z,-y)`. Multiply linear components by standard gravity from the invariants before rotating to world coordinates; add world gravity. Angular components already have physical units and are integrated about the body Euler axes. This is a simple Euler kinematic model rather than a rigid-body torque/inertia solver.

```text
world acceleration = bodyToWorld(linear * standardGravity) + gravity
velocity1 = velocity0 + acceleration * dt
position1 = position0 + velocity0 * dt + acceleration * dt² / 2
rotationalRates1 = rotationalRates0 + angularAcceleration * dt
orientation1 = orientation0 + constrainedRotationalRates1 * dt
```

Ground friction opposes predicted horizontal velocity; angular friction opposes predicted rotational motion. Friction is capped so it cannot reverse a stationary actor or overshoot through zero. Ground height is bilinearly sampled at the new position, ignores no-data sentinels and applies the schema elevation scale. Contact clears downward velocity. Speed limits and world bounds are applied to authoritative model state; hitting a horizontal boundary clears its corresponding velocity. Position integration uses pre-limit velocity, so this remains an approximate fixed-step integrator.

Terrain spacing is configurable and is not hardcoded as a client contract. The default runtime policy uses 10 metre posts. Columns and rows use half-open `ceil(extent / spacing)` semantics. The sampler clamps at outer posts, and returns NaN when no valid sample contributes.

GLB validation reads embedded binary accessors and node transforms; it checks actual transformed bounds, declared visual-size agreement, the invariant byte/triangle budgets and ground-aligned cube. Minimum volume uses signed tetrahedral volume on closed, consistently wound mesh surfaces. Malformed, open, inconsistently wound, compressed or unsupported position accessor formats are rejected explicitly. This is not a general-purpose glTF conformance validator or a solver for overlapping solid unions.

`queueHit` validates transient hit events, includes them in the next new snapshot, and drains them. Replayed cached snapshots retain event IDs for client deduplication. Combat/projectile creation and collision response are not implemented by this refactor; there is no automatic firing input or damage calculation.

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
