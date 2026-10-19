# Server game state

[`tbn/schemas/state.schema.json`](tbn/schemas/state.schema.json) defines the full authoritative snapshot delivered to every client approximately 15 Hz. This broadcast rate is separate from the 30 Hz simulation and action cadence.

- `actors`: all actors, including the receiving player, with `id`, public `name`, `health`, `position`, `orientation`, and `velocity`. Additional public information may be included; private information must not be included.
- `projectiles`: all projectiles currently in flight, with `id`, `position`, and `velocity`.
- `hitEvents`: hits accumulated since the previous broadcast, with a stable `id`, `targetId`, `sourceId`, `damage`, `remainingHealth`, and `hitLocation`. Send an empty array when no hits occurred. Deduplicate by event ID when replaying cached snapshots. This array is transient event delivery, not a durable event history or a guarantee that a disconnected client receives missed hits.

Positions and hit locations are world-space meters; velocities are world-space meters per second. Orientation uses body-axis Euler angles in radians with explicit `order: "XYZ"`: X roll, Y pitch, Z yaw. Apply the body-to-world basis conversion `(x,y,z) -> (x,z,-y)` after the body rotation. The body is +X forward, +Y left, +Z up; the world remains +X east, +Y up, +Z south.

Snapshots contain full current actor and projectile lists. Entries absent from the next snapshot are no longer present. IDs must be unique within their respective lists; JSON Schema cannot enforce uniqueness by ID alone.

World data follows [`tbn/schemas/world.schema.json`](tbn/schemas/world.schema.json). Send it once on connection and again when requested; do not include its large terrain array in each state snapshot. GLB assets likewise use the separate mesh delivery path. Clients cache world data and use state snapshots to update moving objects.
