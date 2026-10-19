# Aircraft physics and client stability controllers

This documents the current server implementation, not a full aerodynamic aircraft simulator. Register `physicsProfile.controller: "aircraft"` with a schema-valid `maxSpeed`. Read [physics-controls.md](physics-controls.md) for the common protocol and [actions.schema.json](../schemas/actions.schema.json) for complete-frame requirements. The server uses Rapier 3D compatibility package 0.21.0. JSON structure remains authoritative in the shared schemas; equations below describe the server's controller behavior.

## Inputs and effective parameters

Send complete `action` frames at approximately 30 Hz:

```json
{
  "protocolVersion": 2,
  "sequence": 123,
  "move": { "x": 0.4, "y": 0, "z": 0 },
  "rotate": { "x": 0, "y": -0.2, "z": 0 },
  "brake": 0,
  "jump": false
}
```

| Input | Aircraft interpretation |
| --- | --- |
| `move.x` | Forward/reverse thrust effort, [-1,1]; zero means no thrust, not speed hold |
| `move.y`, `move.z` | Ignored; no lateral or vertical thrusters |
| `rotate.x` | Body +X roll torque effort |
| `rotate.y` | Body +Y pitch torque effort; negative pitches the nose up, positive pitches down |
| `rotate.z` | Body +Z yaw torque effort; positive turns the nose left when upright |
| `brake` | [0,1] acceleration opposing COM velocity, in air as well as on the ground |
| `jump` | Ignored |

Each axis is independent normalized effort, not an angle, desired rate or guaranteed acceleration. Unsupported move axes must still be present. Aircraft yaw is not inverted during reverse motion; the ground/mecha reverse-steering rule does not apply.

Use `protocol_info.physics` for effective session parameters, rather than hardcoding the defaults below. Session overrides can change these parameters. The actor's `maxSpeed` comes from its accepted registration profile.

| Symbol / parameter | Default | Meaning |
| --- | --- | --- |
| `g` / `gravity` | 9.81 m/s² | World-down gravity magnitude; also scales aircraft lift |
| `T` / `forwardAcceleration` | 29.43 m/s² | Full forward/reverse thrust acceleration |
| `A` / `angularAcceleration` | 1 rad/s² | Per-axis commanded angular-acceleration scale before damping/contacts |
| `vL` / `aircraftLiftSpeed` | 10 m/s | Forward speed producing 1 g of lift |
| `k` / `aircraftDrag` | 0.08 s⁻¹ | Linear drag coefficient |
| `B` / `brakeDeceleration` | 20 m/s² | Full braking deceleration |
| `maxAngularSpeed` | 3 rad/s | Limit on the angular-velocity vector magnitude |
| `density` | 1 mass unit/m³ | Uniform session density |
| Angular damping `d` | 0.3 s⁻¹ | Applied to all angular axes, even with active rotational input |

The 4 g lift cap and aircraft damping coefficient 0.3 are currently implementation constants, not independent selectable profile fields or named `protocol_info.physics` parameters. Do not invent an `angularDamping` wire field. There is no aircraft engine spool-up, throttle slew limit, automatic leveling, altitude hold, airspeed hold or trim controller. Those can be implemented by the client using ordinary input frames.

## Mass, center of mass and inertia

The server validates transformed, closed GLB geometry and computes its enclosed volume `V`. All actors in a session share uniform density `rho`:

```text
m = rho * V
c_body = (visualBounds.min + visualBounds.max) / 2
sx, sy, sz = visualBounds.max - visualBounds.min
Ix = m * (sy² + sz²) / 12
Iy = m * (sx² + sz²) / 12
Iz = m * (sx² + sy²) / 12
I_body = diag(Ix, Iy, Iz)
```

These are the actual configured Rapier mass properties: visual-box centroid COM and diagonal box inertia approximation, not an exact volume-centroid/inertia integration. Bounds include the GLB node transforms. Geometry can be off-center relative to the actor root. Convex hull/decomposition approximates the collision shape, but mass uses the original validated volume.

Mass, bounds, COM and inertia are not currently transmitted as per-actor numeric fields. A client can derive them from its exact registered GLB and the effective session density. `mesh.metadata.visualSize` supplies the declared extents, validated against the transformed geometry, but does not fully specify an offset COM. Do not read the fixed 2 m gameplay hitbox as the inertia box. Geometry validation and mass construction live in the server's `modules/actors/glb.js` and `modules/physics/body.js`.

## Rotation response and damping

Let `u = (rotate.x, rotate.y, rotate.z)` and `R` map body-local vectors into world coordinates. At every fixed physics substep, the controller resets previous actuation forces/torques and applies:

```text
tau_body = (Ix * A * u.x, Iy * A * u.y, Iz * A * u.z)
tau_world = R * tau_body
```

For isolated principal-axis motion without contact, full input therefore requests approximately **1 rad/s²** about that body axis before damping. It is a torque command scaled by inertia, not an instruction to overwrite angular velocity. Collision impulses and general rigid-body integration can change the observed response. There is no airspeed multiplier on control torque: control authority exists at zero speed, in reverse and during ground contact. The server does not suppress aircraft pitch/roll on the runway or stabilize the aircraft to the terrain.

Rapier's angular damping operation for an integration interval `delta` is:

```text
omega_after_damping = omega_before_damping / (1 + d * delta)
d = 0.3 s⁻¹
```

This scales all components, not only yaw. It is not “subtract 0.3 rad/s every frame” or “multiply by 0.7 per snapshot.” The small-step continuous approximation is `domega/dt = alpha_command - d*omega`. Neutral-input angular velocity decays approximately as `omega(t) = omega(0)*exp(-0.3*t)`; the half-life is about 2.31 seconds. Rapier's operator is documented in its [rigid-body velocity implementation](https://docs.rs/rapier3d/latest/src/rapier3d/dynamics/rigid_body_components.rs.html) (`apply_damping`); that link follows upstream, while this server pins its JS/WASM dependency.

For a small-step, contact-free, single-axis predictor, `omega_next ≈ (omega + A*u*h)/(1+d*h)` is useful. It is not a promise of bit-identical Rapier simulation: solver internals, quaternion updates, floating point, contacts and caps also matter. The server clamps angular-velocity vector length after every outer 1/120 s step; all three axes share the 3 rad/s magnitude budget. A constant full single-axis input would otherwise approach `A/d ≈ 3.33 rad/s`, so the cap limits it first.

## Coordinates and state reconstruction

The wire state supplies:

| Field | Exact meaning |
| --- | --- |
| `position` | GLB/root world position in metres; not COM position |
| `velocity` | GLB/root world velocity in m/s; not COM velocity |
| `orientation` | Body Euler radians `{x:roll,y:pitch,z:yaw,order:"XYZ"}` |
| `rotationalRates` | Body-local angular velocity `(p,q,r)` in rad/s; not Euler-angle derivatives |
| `grounded` | Supporting terrain contact, not “below a chosen altitude” or an aircraft flight-mode switch |
| `lastInputSequence` | Latest input frame consumed by physics, initially -1; not an application timestamp |

Body axes are +X forward, +Y left, +Z up. World axes are +X east, +Y up, +Z south. The **exact** rotation convention is:

```text
B = rotation about X by -pi/2
R = B * Rx(orientation.x) * Ry(orientation.y) * Rz(orientation.z)
v_world = R * v_body
```

Products act on column vectors, so the rightmost factor acts first. This is the intrinsic XYZ convention used by Three.js `Euler(..., 'XYZ')`, followed by the fixed body/world basis conversion. At zero orientation `(x,y,z)_body` maps to `(x,z,-y)_world`.

No quaternion is currently transmitted. Reconstruct a world quaternion locally:

```js
const basis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const bodyQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.x, o.y, o.z, 'XYZ'));
const qWorld = basis.multiply(bodyQ); // body-local -> world
```

Use quaternion errors for attitude control and slerp for display interpolation. Euler angles can wrap or change representation near gimbal lock; do not differentiate/subtract raw Euler components to estimate angular rates. The transmitted body rates are already available.

To reproduce the server's force calculations, reconstruct COM quantities:

```text
r_world = R * c_body
omega_world = R * rotationalRates
position_COM = position_root + r_world
velocity_COM = velocity_root + cross(omega_world, r_world)
```

Using root velocity directly as COM velocity can introduce false airspeed/vertical-speed oscillations while an off-center aircraft rotates. Define whether altitude hold targets root altitude or COM altitude; use consistent position/velocity pairs. For this flight model COM altitude is generally the simpler control variable.

## Exact thrust, lift, drag and braking equations

Define world-space unit vectors `f = R*(1,0,0)` (forward) and `n = R*(0,0,1)` (body up). Let `v` be world COM velocity and `uT = move.x`:

```text
v_forward = max(0, dot(v, f))
C = min(4, (v_forward / vL)²)
a_thrust = T * uT * f
a_lift = g * C * n
a_drag = -k * v
a_gravity = (0, -g, 0)
a_brake = 0                                      if |v| = 0
        = -normalize(v) * min(|v|/h, B*brake)     otherwise
a_total = a_thrust + a_lift + a_drag + a_gravity + a_brake
F_actuation = m * (a_thrust + a_lift + a_drag + a_brake)
```

Rapier adds gravity and resolves contacts. The brake cap limits its own contribution for the current outer substep; combined forces can still alter the resulting velocity. There is no additional configured Rapier linear damping; `aircraftDrag` is an explicitly applied force. The stronger neutral-throttle ground/mecha coasting friction does not apply to aircraft.

Important consequences for hold controllers:

- “Airspeed” here is the **positive forward COM-velocity projection**, not total speed and not a measured wind-relative velocity. There is no wind model. Backward or purely sideways motion produces no lift through this formula.
- At upright, level attitude, 10 m/s forward speed gives 1 g of lift and approximately cancels gravity. At 20 m/s and above, lift is capped at 4 g. With `gravity=0`, this implementation also produces zero lift.
- Lift always points along body up, even when banked or inverted. It has no angle-of-attack, airfoil, stall, induced-drag or ground-effect model. There are no speed-dependent rotation-control effects.
- Pitch changes the thrust/lift directions, not the lift coefficient directly. Bank reduces vertical lift and provides horizontal lift. For zero vertical speed, vertical acceleration before contacts is `T*uT*f.y + g*C*n.y - g` (drag/brake add terms when vertical velocity is nonzero).
- In an upright, level, unbanked equilibrium without braking, the approximate throttle feed-forward is `uT = k*v_forward/T`. At 10 m/s that is about 0.0272, not full throttle. Zero throttle still permits passive lift, drag and gravity.
- Level altitude hold may be infeasible below 10 m/s, at excessive bank, with a low selected `maxSpeed`, or when required actuation saturates. Account for those limits rather than winding up an integrator.
- The server caps total COM speed to the registered `maxSpeed` after each outer substep. It is a hard vector-magnitude clamp, not an aerodynamic terminal-speed model. Contact/boundary constraints can also override unconstrained flight.

## Timing, timestamps and latency

| Stage | Current implementation |
| --- | --- |
| Physics outer substep `h` | Fixed 1/120 s (8.333 ms); Rapier may additionally subdivide for CCD/solver processing |
| Session tick | Default 30 Hz, advances 1/30 s = four outer substeps; configurable `tickRate` appears in session discovery summaries |
| Client input | Complete held-state frames recommended at 30 Hz; vectors are not partial patches |
| Application | Network handler validates/stores newest frame; next session tick consumes the latest sequence and holds it over that tick's substeps |
| Publication | Full snapshots approximately 15 Hz (66.7 ms), on a timer independent of simulation; lifecycle/admin actions can publish extra snapshots |
| Timeout | Neutralizes controls after 250 ms of **simulation time** without a newer consumed frame; passive lift/drag/gravity/damping continue |

A newer frame replaces held controls; this is not a FIFO replay of all input frames. Multiple frames arriving between ticks may be coalesced to the latest one. `lastInputSequence` acknowledges that latest consumed frame. Duplicate/out-of-order sequences are rejected and do not refresh timeout. Inputs remain constant until superseded or stale, but body orientation, torque direction, thrust, lift and drag are recalculated each physics substep.

There are currently **no snapshot timestamps, simulation tick IDs, server send timestamps, input application timestamps, clock synchronization, or published RTT/ping statistics**. `data_version` provides session-local resource versions for cache/receipt tracking, not physical timestamps. A cached/retried snapshot may be identical to one already received; its version can identify a replay. Do not invent `state.timestamp`, `state.serverTime`, `state.tick`, or per-input application-time fields. Snapshot version counts are not fixed-duration physics ticks.

The default cadence is nominal, not a real-time deadline. Node timer scheduling, server load and network/relay buffering introduce jitter. Simulation advances fixed dt per executed session tick rather than catching up all elapsed wall time, so simulated time can lag wall time under load. Do not assume `received snapshot count * 1/15` equals authoritative simulation time.

There is **no measured “typical network delay” available to promise clients**. Measure the deployed path, including browser -> local relay -> server and the return path if a relay is used. Even with zero transport delay, normal default timer phases alone can add approximately 0–33.3 ms to input consumption and another 0–66.7 ms before periodic publication: about 0–100 ms of nominal feedback waiting, excluding jitter, extra snapshots and display buffering. This is a phase budget, not a measured RTT or upper bound.

A client can timestamp sent sequences and snapshot arrivals with its local monotonic clock (`performance.now()`), then measure input-to-observed-ack delay for sequences actually acknowledged. Maintain median/p95 and sample jitter; frames skipped by coalescing will not each produce an acknowledgment. Such a measurement includes server phase waits and both transport directions, not just network RTT, and cannot determine the one-way delay or precise server application time. There is no custom ping/clock-sync event in this protocol. True time-aligned prediction would require an explicit server protocol extension.

Use the newest authoritative state for control estimation, not the deliberately delayed/interpolated render pose. A one-snapshot display buffer adds about 66.7 ms of client display delay beyond the feedback path; it should not silently become extra control-loop delay.

## Building client stability, altitude and airspeed hold

A practical client can use a conservative cascaded controller, while keeping the server authoritative:

1. Read effective session parameters and the registered actor's geometry/profile. Reconstruct world quaternion, body angular rates and COM velocity from the newest state. Keep an estimate across snapshot gaps; reconcile it on authoritative updates.
2. For attitude hold, form body-frame quaternion error `q_error = inverse(qWorld_current) * qWorld_target`. Choose the equivalent quaternion with nonnegative `w` for the short rotation. Convert to an axis-angle error vector (or `2*q_error.xyz` for small errors).
3. An inner-loop starting structure is `alpha_target = Kp*attitude_error - Kd*omega_body`. Approximate damping compensation can add `d*omega_body` before dividing by `A`; clamp each resulting `rotate` effort to [-1,1]. This is a continuous/small-step design aid, not an exact inversion of multi-axis Rapier dynamics. Tune gains against measured delayed feedback; they are not server-supplied constants.
4. For airspeed hold, measure `v_forward`, use `k*v_target/T` as a level-flight thrust feed-forward, and add bounded proportional/integral speed correction. Add anti-windup at thrust/speed limits. Negative effort is reverse thrust, not an engine-idle command.
5. For altitude hold, use altitude error to request a bounded climb/descent rate, then a bounded pitch/attitude target for the inner loop, while the airspeed loop manages thrust. Include the actual vertical-force equation, bank angle, available lift and speed limits. Do not pretend ignored `move.z` is an altitude control.
6. Choose deliberate takeoff/landing behavior from `grounded` and forward speed. Ground contact does not disable aircraft torque, so hold-controller inputs can tip a stationary aircraft. Decide whether to inhibit pitch/roll until takeoff; no server landing-gear controller does this for you.
7. Refresh complete frames with increasing sequences, including neutral inputs. Clear stale local controls on blur/disconnect. Reset estimators/integrators/interpolation after session transfer, re-registration or admin terrain repositioning (`terrain_changed`/`terrain_flattened`); preserve or reset sequence counters according to the common protocol's specific lifecycle rules.

Do not directly set authoritative position/velocity or rotate the physical actor locally to fake the hold. Render prediction is optional and must reconcile to server snapshots. This model provides sufficient actuation to experiment with stabilization, but absent server timestamps/application-time telemetry limits how precisely a client can reconstruct delayed physics state.

## Implementation references

- `modules/physics/controllers.js`: exact aircraft forces, torque scale and hardcoded damping.
- `modules/physics/body.js`: volume mass, box COM and inertia construction.
- `modules/physics/rotation.js`: Euler/quaternion/basis conversion.
- `modules/physics/model.js`: fixed substeps, input hold/timeout, COM/root projection and caps.
- `modules/sessions/session.js`: snapshot contents and publication timers.
- `tbn/docs/invariants.json`: default physical/network tuning; runtime `protocol_info` supplies effective overrides where implemented.

These paths identify the server sources for maintainers; client builds should consume the shared schemas/contracts and their own GLB assets, not import the server implementation.
