# Rockets and visual explosions

The optional `action.fire` boolean is a held rocket trigger in protocol v2. Omission means false, preserving existing clients. Refresh it with normal complete frames; stale input, neutralization and blur stop firing. Do not invent a separate fire event. Shared [actions](../schemas/actions.schema.json), [state](../schemas/state.schema.json) and [mesh](../schemas/mesh.schema.json) schemas define payloads. `protocol_info.weapons` announces tuning; defaults live in [invariants.json](invariants.json).

## Launch and controls

Register valid `mesh.metadata.projectileOrigins` at build time. Empty hardpoints mean unarmed; no invisible default muzzle is added. Rockets launch from these body-space positions in array order, alternating/cycling with successive shots. A missing direction means body +X. Direction vectors must be nonzero and are normalized by the server. Flight Lab supplies left/right wing hardpoints, with Space/on-screen Fire holding `fire:true`; **B is now brake**, replacing Space braking. Pitch and bank-turn mappings are unchanged.

Default cadence is one rocket every 0.25 seconds, speed 120 m/s plus inherited actor COM velocity, lifetime 8 seconds, and at most 512 active rockets per session. Flight is straight and powered with no gravity or guidance. Rockets wrap X/Z with the world and retain velocity. The server sweeps each physics substep and splits paths at map seams rather than relying on snapshot-to-snapshot collision checks.

## Collision and explosion semantics

Rockets pass through **all actor geometry**, including the shooter, other players and periodic collision images. They detonate on terrain, other Rapier non-actor colliders and visible practice-target cubes. Target cube dimensions come from world `targets[].size`; this rocket collision test does not enable vehicle/target collisions. Terrain-only actor collision diagnostics do not disable rocket impacts.

Impact removes the projectile and publishes an explosion with **radius 5 m** (10 m diameter). These explosions are visual: there is currently no blast damage, actor impulse or terrain deformation. Expired rockets disappear without an impact explosion. Terrain replacement clears live rockets/explosions; actor disconnect does not retroactively remove already fired rockets.

## State and presentation

`state.projectiles` is the full in-flight set. Each rocket has `id`, `position`, `velocity`, and optional `ownerId`, `hardpointId`, `age` (simulation seconds). Canonical coordinates follow world wrapping. Remove absent rockets. Interpolate for rendering, unwrap paths before interpolation, and infer visual direction from velocity. Do not extrapolate indefinite flight or calculate authoritative hits locally.

`state.explosions` is an optional full short-lived set with `{id,position,radius,age}`; treat absence as empty. Explosions remain visible in snapshots for 1.2 simulation seconds, not only a single event packet. Deduplicate by ID to avoid restarting a burst each snapshot or cached replay. Age is effect age, not a server clock or input timestamp. The blast radius is supplied by the server; do not mistake it for a damage guarantee.

For the Flight Lab feel, leave a trail of soft expanding spherical puffs behind interpolated rockets, let the puffs drift upward and disperse, and show a fast expanding fireball plus irregular smoke lobes at impact. Keep geometry/particle pools bounded, share GPU resources, and age particles independently of snapshot arrival. Place trails and bursts in the same nearby periodic image as the player. The reference implementation batches clouds into an instanced mesh and limits the retained puff count. Keep current state separate from this presentation-only particle simulation.
