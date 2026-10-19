# Session physics with Rapier

The server uses pinned `@dimforge/rapier3d-compat` 0.21.0 (Apache-2.0). WASM code initializes once; every session owns a separate Rapier World, static terrain colliders and dynamic actor bodies. No custom integration or actor collision response runs alongside Rapier. The input boundary is protocol v2 in `tbn/schemas/actions.schema.json`. The client-facing behavioral contract is [physics-controls.md](../tbn/docs/physics-controls.md).

## Module responsibilities

| File | Responsibility |
| --- | --- |
| `physics/runtime.js` | Asynchronous one-time WASM initialization |
| `physics/model.js` | Session world, body lifecycle, fixed substeps, control lifetime and state projection |
| `physics/terrain.js` | Chunked static terrain meshes and contact manifold queries |
| `physics/controllers.js` | Ground, mecha, hover, aircraft and boat actuation |
| `physics/body.js` | Immutable validated GLB geometry, uniform-density mass, box COM/inertia |
| `physics/contacts.js` | Registration-time vertical spawn placement only; no collision response |
| `physics/rotation.js` | Body Euler XYZ, world quaternion and vector frame adapters |
| `physics/actions.js` | Complete neutral/control frame construction |
| `physics/vector.js` | Pure vector arithmetic |

## Lifecycle and flow

`new PhysicsModel(initialState, undefined, environment)` exposes `ready`, which resolves after WASM/world allocation. Standalone callers await `ready` before `step`. Server startup waits before binding ports or starting simulation timers; sessions created later can allocate synchronously after the shared runtime is initialized. Constructors do not start timers. Session removal calls `close`, freeing the World and all WASM resources, including when removed before initialization resolves.

Registrations validate JSON and actual closed GLB geometry before body creation. Convex actors use a convex hull of their transformed GLB vertices; concave actors use VHACD decomposition (resolution 32, at most 16 convex parts). Rapier solves the resulting solid compound contacts. Original volume times the session's uniform density determines mass, independently of collider approximation. COM is `(visualBounds.min + visualBounds.max)/2`; diagonal box inertia is `m/12` times the two perpendicular squared extents. This approximate inertia now participates in Rapier rotational dynamics and control torque.

The model buffers elapsed time and advances fixed 1/120 s steps, four per nominal 30 Hz session tick. Rapier uses eight solver iterations, CCD enabled on actors and up to four CCD substeps. Calls accept positive finite dt up to one second. Model state is copied on ingress/egress; immutable shape data is shared. An actor placeholder without validated geometry has no rigid body.

The model consumes newer complete control frames, records their sequence/time, and neutralizes effort after 250 ms of simulation time without a newer frame. The network boundary rejects duplicate/out-of-order sequence numbers; duplicates do not refresh lifetime. Sequence resets on registration/session transfer. Jump edges are consumed once; airborne presses are not buffered. Timeout counts as release.

Each substep clears previous control forces/torques (Rapier forces otherwise persist), evaluates actual terrain support manifolds, applies the selected controller, steps Rapier, then projects state. Active controls wake bodies. World bounds and maximum COM speed are enforced after each substep; bounds apply to actor root X/Z. The maximum angular speed is server policy. Finite contact tolerances permit small penetration.

## Contacts and controllers

Terrain contact normals are averaged across near-contact manifold points. Only upward terrain support qualifies; separating normal velocity above the support threshold is airborne, preserving a landing rebound. Ground/mecha controllers apply tangent drive, high lateral grip (mecha can deliberately strafe), low forward rolling resistance and braking. Supported yaw commands steer. Supported pitch/roll commands are ignored, while contact torques and a damped upright servo align body up with the contact patch normal. The servo applies torque, never a pose teleport. Passive slope compensation provides grip against sideways/downhill gravity. Airborne ground units accept attitude effort but have no translational thrusters. Jump is an impulse along the support normal, default takeoff speed 6 m/s.

Rapier handles impact impulses and restitution (default 0.25). A falling actor can bounce, rotate and settle. The attitude servo recovers tilted landed actors, including an inverted recovery direction. It does not force a flat attitude or replace the solver with ground-height clamping.

Hover mode has all-axis thrust, upright stabilization and terrain-relative COM height support. Aircraft mode has forward propulsion, body attitude effort, simplified airspeed-squared lift and drag. Boat mode has planar spring/damper buoyancy and upright recovery while immersed, forward propulsion and yaw. These controllers intentionally supply game behavior; they are not detailed suspension, aerodynamic, humanoid or fluid simulations. `invariants.json.physics` owns defaults; trusted per-session environment overrides can tune them. `protocol_info` announces effective policy, including the water plane.

## Terrain

Every new session generates a random-seeded terrain unless a map/seed is supplied. The cloned DTED grid is deeply frozen and cannot be replaced. Static triangle colliders are generated in 64-cell chunks. They use triangles (a,c,b), (b,c,d), with the last sample heights extended to the far boundary. Triangles touching missing samples are omitted, leaving holes. TerrainModel height queries use that same triangle diagonal; the standalone terrain module's historical bilinear helper is retained only for nonphysical convenience/target generation. Spawn placement uses TerrainModel, not that bilinear helper.

Practice target resets version the world wrapper but retain identical terrain samples and collider instances. Actor motion, collision geometry and resource ownership are independent across sessions.

## Coordinates and public state

GLB/body coordinates: +X forward, +Y left, +Z up. World: +X east, +Y up, +Z south. Rapier bodies retain GLB-local coordinates; their world quaternion is the fixed -90° world-X basis rotation multiplied by the intrinsic body Euler XYZ quaternion. The adapter converts back to body Euler XYZ for the wire. Public `rotationalRates` are body-local angular velocity, not Euler derivatives. Root velocity is COM velocity minus `omegaWorld × rotatedCOMOffset`. Private COM velocity and collision geometry are excluded from public snapshots.

State also publishes `grounded` and `lastInputSequence`. Hover/buoyancy support is not terrain grounding. These fields help client effects and reconciliation but never grant the client authority over motion.

## Limits and verification

Fine concavities can be approximated by bounded convex decomposition; animated GLB parts do not update physical geometry. Box COM/inertia are deliberate approximations. The controller has no individual physical wheels/tracks/legs; support is chassis terrain contact, not a full wheel suspension model. Aircraft lack airfoil/stall simulation; boats use a configured flat plane, not waves or hull-fluid interaction. CCD and finite substeps reduce tunneling but are not a universal numerical guarantee. There is no automatic weapon firing or projectile advancement in this actor-physics migration.

`npm test` exercises real WASM worlds: schema/sequence rejection, control timeout, body basis roundtrips, mass/COM, supported pitch suppression, steering and traction, hill alignment, tilted landing recovery, jump edges, bounce/settling, airborne COM, actor momentum transfer, controller modes and isolated/disposable terrain worlds. Socket tests cover protocol announcement, invalid v1 actions, accepted/acknowledged v2 input, registration, transfer, resources, moderation and clean startup/shutdown.

When distributing the server or bundling Rapier, preserve the dependency's Apache-2.0 license and applicable notices. See the package LICENSE; no Rapier source files are modified here.
