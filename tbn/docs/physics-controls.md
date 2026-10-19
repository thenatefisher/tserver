# Physics and controls: protocol v2

This is the client-agent implementation guide. JSON structure/ranges are definitive in `../schemas/actions.schema.json`, `../schemas/actor.schema.json`, and `../schemas/state.schema.json`. Non-schema conventions and server defaults are in `invariants.json`. The authoritative server uses Rapier 3D, with a separate physics world and immutable generated terrain per session. Clients own input and presentation, not authoritative movement.

## Complete held-state input

Send Socket.IO `action` at 30 Hz, including when controls are neutral:

```json
{
  "protocolVersion": 2,
  "sequence": 123,
  "move": { "x": 0.8, "y": 0, "z": 0 },
  "rotate": { "x": 0, "y": 0, "z": -0.3 },
  "brake": 0,
  "jump": false
}
```

All fields and all vector components are required. `move` and `rotate` are independent per-axis normalized control effort in [-1, 1], not acceleration, speed, world direction, target orientation, or guaranteed motion. Do not normalize the six axes together. `brake` is [0, 1]; `jump` is boolean. Unknown fields and nonfinite/out-of-range values are rejected with `request_rejected`; the previous valid frame remains in effect until timeout. No `fire` action exists.

Body axes are +X forward, +Y left, +Z up. Positive rotations obey the right-hand rule: X roll, Y pitch, Z yaw. In particular, positive pitch turns +X toward -Z (nose down); a conventional “pull up” control sends negative `rotate.y`. Positive yaw turns left for body-axis attitude control. Supported ground/mecha yaw is steering: the same input reverses yaw response while traveling backward. At zero heading, world forward is +X and left is -Z.

`sequence` is a nonnegative safe integer, strictly increasing within the current actor registration/session. Start at 0. Repeated or older frames are rejected and do not refresh input lifetime. Reset after reconnect, accepted re-registration, and session change. A newer frame completely replaces the old held state. State includes `lastInputSequence`, the latest frame consumed by simulation, initially -1. This is a consumption acknowledgment, not a guarantee of achieved movement. Full authoritative snapshots remain approximately 15 Hz while simulation ticks are 30 Hz with internal 120 Hz fixed substeps.

After 250 ms of simulation time without a newer frame, controls become neutral. Neutral input stops propulsion/control torque, not velocity: inertia, gravity, lift, buoyancy and passive stabilization remain active. Use `brake` to slow actively. A jump is a false-to-true transition while supported, producing a single takeoff impulse. Holding it does not jump again on landing. Airborne edges are consumed, not buffered. Release then press again to jump. Timeout counts as release. Disconnect removes the actor.

Clear local key/gamepad state on blur, pointer-lock loss and hidden-page transitions; immediately send a neutral frame if connected. Never queue old controls while disconnected. Offer keyboard and analog controls, dead zones, and visible help appropriate to the selected controller.

## Registration selects a controller

```json
"physicsProfile": { "maxSpeed": 25, "controller": "ground" }
```

Both fields are required. `controller` is one of `ground`, `hover`, `aircraft`, `mecha`, `boat`. Select from the player's vehicle design; let the player choose `maxSpeed` in [1, 100] m/s. `clientType` is only a label and does not select physics. Mass, acceleration, friction, lift, buoyancy and restitution are server-owned tuning, not arbitrary client profile fields. Accepted public registration descriptors include `physicsProfile`, allowing other clients to choose suitable presentation.

| Controller | `move` | `rotate` | Jump / passive behavior |
| --- | --- | --- | --- |
| `ground` (tank/wheeled) | X drive/reverse while supported; Y/Z ignored | Supported: Z steering only. Airborne: all attitude axes | Grounded jump edge; strong lateral grip; low rolling resistance; slope alignment |
| `mecha` | Supported X drive and Y strafe; Z ignored | Same as ground | Grounded jump edge; terrain balance; single rigid body, no physical legs |
| `hover` | All three thruster axes, including airborne | All axes; passive upright stabilization resists roll/pitch | Terrain-relative COM height servo; jump ignored |
| `aircraft` | X propulsion/reverse; Y/Z ignored | All axes | Bounded airspeed-squared lift with incidence response and linear drag; jump ignored |
| `boat` | X propulsion; Y/Z ignored | Z only | Planar spring/damper buoyancy and upright recovery while immersed; jump ignored |

Unsupported inputs cause no actuation; they are not malformed protocol. All six axes remain in every frame even when zero. Ground controllers have no airborne translation thrusters. Braking opposes supported travel for ground units and velocity for other modes. Passive systems can still move a neutral actor. These are game controllers, not engineering-grade track, flight, humanoid or fluid models. Aircraft have no simulated airfoils/stall; mechas have no gait simulation; boats have no waves or submerged-hull fluid solver. The water plane defaults to world Y=0 and is configured per session; land above it can ground a boat. Hovering over missing terrain provides no lift support.

Suggested mappings:

- Tank: W/S `move.x`, A/D `rotate.z` (A positive), Space jump, Shift brake.
- Mecha: W/S `move.x`, A/D `move.y`, Q/E `rotate.z`, Space jump.
- Hovercraft: W/S forward, A/D strafe, Q/E yaw, ascent/descent keys `move.z`.
- Aircraft: throttle `move.x`, roll `rotate.x`, elevator `rotate.y`, rudder `rotate.z`. Label pitch direction clearly.
- Boat: W/S propulsion and A/D yaw; show the server's water plane and shore.

## Contact, attitude and landing

Rapier handles gravity, rigid-body collisions, rotational inertia, normal impulses and bounce. Grounded drive uses terrain contact normals for grip and a damped attitude torque that aligns body up to the contact patch normal. It does not teleport orientation. Commanded pitch/roll is suppressed while supported; terrain contact still changes pitch/roll. After a tilted airborne landing, impacts and stabilization settle the actor. A landing can rebound according to restitution (default 0.25), then dissipate energy. `grounded` is true for supporting terrain contact, false while separated or rebounding; hover/water support is not terrain grounding. Contact tolerances permit tiny numerical penetration, so do not clamp authoritative actor Y in the renderer.

All actor GLBs are validated closed solids. Uniform session density times original enclosed volume gives mass; center of mass is the visual-box centroid. Convex actors use their convex hull; concave actors use bounded convex decomposition (up to 16 parts). Fine recesses may be approximated. Box inertia is an approximation. Animated/deforming visuals do not alter collision geometry. The fixed 2 m hitbox is a gameplay metadata convention, not the rigid-body collider.

Terrain collision and render topology must agree: see `dted-terrain.md`. Terrain remains unchanged during ordinary gameplay. The admin can explicitly flatten the selected session or choose a terrain preset; clients must replace terrain meshes/collision caches on each new `map_data` event.

## Render authoritative state intuitively

World +Y is up. A GLB is body Z-up; do not feed body Euler angles directly into a Y-up mesh and silently change axes. With Three.js:

```js
const basis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const bodyQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.x, o.y, o.z, 'XYZ'));
root.position.set(p.x, p.y, p.z);
root.quaternion.copy(basis).multiply(bodyQ);
```

Use a parent/world root with this quaternion and an unchanged body-local GLB child. Apply the same transform to hardpoints. Interpolate snapshot position and quaternion (slerp) for smooth presentation, typically buffering about one snapshot interval. Interpolate between quaternions even though the wire format is Euler XYZ, avoiding angle-wrap artifacts. Keep the camera's world-up stable; follow the actor with smoothing instead of forcing the camera to inherit every bounce. Use grounded/contact transitions for landing effects and last acknowledged sequence for an optional prediction/reconciliation layer. Prediction must be corrected to server snapshots; matching a Rapier version alone does not reproduce server controllers automatically.

## Upgrade and compatibility

This deliberately breaks v1 acceleration input: `linear`/`angular`, partial patches and missing controller registrations are rejected. Rebuild clients against the updated schemas/types. On session selection the server sends `protocol_info` with `protocolVersion: 2`, timeout seconds and session physics defaults/overrides (including `waterLevel`). Refuse unsupported versions visibly before enabling controls; surface registration/action rejection reasons in the HUD. The bundled relay forwards this announcement and replays it to newly opened browser tabs.

JSON Schema validation catches incompatible incoming payloads at runtime. TypeScript provides authoring checks but cannot validate numeric ranges or GLB binary geometry; run schema validation at build time as well. Server schemas load at process startup; restart after changes. A version announcement detects this protocol generation, not every possible future schema drift. Any future breaking change requires a version bump plus coordinated server, schema, types, relay/SDK, tests and documentation changes.

## Admin terrain flattening

The dashboard **Flatten terrain** button sends admin-only `admin_flatten_terrain` for the selected session. It replaces all elevations with world Y=0 (including former no-data holes), rebuilds Rapier terrain colliders, settles actor roots onto the plane, preserves X/Z and heading, clears motion and held controls, and moves practice targets to Y=2. Actor registrations, input sequence counters and connections remain intact. New input frames resume control normally. The server publishes a new version of `map_data` and authoritative state, then `terrain_flattened` with `{sessionId,elevation:0,version}`. Other sessions are unchanged. Clients must rebuild terrain from replacement map data and discard interpolation across the actor repositioning; do not reset input sequence counters. Target resets alone still leave terrain unchanged.

## Session diagnostic controls

The admin dashboard offers **Remove targets** and **Disable object collisions** for the selected session. Removing targets publishes an empty `targets` list through versioned `map_data` and a `targets_removed` notice `{sessionId,removed,version}`. Clients must replace their target rendering from the new world data. Terrain is unchanged. **Respawn targets** restores the practice targets; these targets currently have no physics colliders.

Disabling object collisions enables a persistent **terrain-only collision** mode. Rapier collision groups keep actor-to-terrain contact but disable every non-terrain object pair, including actor-to-actor and actor-to-obstacle interactions. Bodies, GLBs, mass, inertia, movement, gravity and world-bound constraints remain. This mode applies to existing and newly registered actors and survives terrain flattening. It resets with a new session/process, rather than automatically re-enabling on reconnect.

Admin request `admin_disable_object_collisions` broadcasts `collision_settings` with `{sessionId,terrainOnlyCollisions:true,affectedColliders}`. Selection/join also supplies `collision_settings` (the count is optional), so reconnecting dashboards and clients can display the current mode. Predicted client physics should apply the same terrain-only filter; do not delete actor meshes or disable terrain contact. The bundled relay forwards and caches these settings for newly opened views. Target request `admin_remove_targets` and collision-mode changes require the admin role; ordinary players receive `request_rejected`.

## Standard terrain presets

Valley, plateau, mountain range, flat, hills in four corners and city blocks can be selected independently for each session, at creation or through the admin dashboard. Preset changes use the same versioned terrain/collider replacement path as flattening; clients must handle `terrain_changed` as well as `terrain_flattened`. See [the terrain preset guide](terrain-presets.md) for IDs, geometry, configuration and client behavior.

## Grounded coasting friction

Ground/mecha controllers retain low powered rolling resistance (0.6 m/s²), but neutral throttle adds 6 m/s² of coasting resistance while supported. Default forward coasting deceleration is therefore approximately 6.6 m/s²: from 25 m/s a level vehicle stops in about 3.8 seconds instead of roughly 42 seconds. Braking adds stronger resistance. Forces are capped so resistance cannot reverse motion through zero. Mecha neutral strafe uses the same bounded resistance. Airborne travel is unchanged; this is directional controller friction, rather than isotropic Rapier material friction that would also impede powered forward motion. Values are server-owned in `invariants.json.physics` (`rollingDeceleration`, `coastDeceleration`); no input/schema change is required.

## Reverse steering

Supported ground/mecha steering reverses with actual backward longitudinal motion, including backward coasting while forward throttle slows the vehicle. Below 0.1 m/s, throttle direction selects the sign; neutral stationary steering keeps its usual sign. Clients send the same left/right effort in reverse and must not invert it again locally. Airborne attitude and hover/aircraft/boat yaw retain their body-axis meanings. The server threshold is `physics.steeringReverseThreshold`.

## Aircraft controller details

For exact aircraft torque/inertia/damping, thrust/lift/drag equations, COM state reconstruction, timing limits and client stability/altitude/airspeed hold guidance, read [aircraft-controller.md](aircraft-controller.md). The guide distinguishes existing state fields from missing timestamps/latency telemetry.
