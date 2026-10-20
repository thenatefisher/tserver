# Assisted aircraft flight

For the default player-facing controls, camera, assets and HUD, follow [air-vehicle-experience.md](air-vehicle-experience.md). This document specifies the underlying physics and protocol.

Aircraft use **`assisted-flight-v1`**, announced in `protocol_info.physics.aircraftModel`. This replaces the former thrust/torque and aerodynamic lift model. The JSON action envelope remains protocol version 2; aircraft input semantics have changed. Clients must check the model identifier, discard old lift/drag feed-forward and torque compensation, and use these semantics. Other controller modes retain their existing behavior.

The server handles speed, body-rate stabilization, gravity compensation and coordinated banked turning. Clients can map keys/sticks directly to controls without a stability controller. Rapier still owns integration, geometry contacts and impacts; no flight command overwrites pose or velocity.

## Direct controls

Send complete held-state action frames at about 30 Hz, with strictly increasing sequences. All move/rotate XYZ components, `brake` and `jump` remain required by [actions.schema.json](../schemas/actions.schema.json).

| Input | Aircraft meaning |
| --- | --- |
| `move.x` | Signed target speed fraction of registered `maxSpeed`; 0 requests a smooth stop, +1 maximum forward speed, -1 reverse |
| `move.y`, `move.z` | Ignored |
| `rotate.x` | Target body roll-rate fraction; positive raises the left wing (roll right) |
| `rotate.y` | Target body pitch-rate fraction; negative nose up, positive nose down |
| `rotate.z` | Additional body yaw-rate fraction; positive turns left upright |
| `brake` | Scales target speed by `1-brake`; 1 requests a smooth stop even with throttle held |
| `jump` | Ignored |

Neutral pitch stops pitching, preserving the resulting nose attitude. Neutral roll automatically levels the wings by default. Neutral yaw still permits coordinated bank turning about world vertical. Lowering the left wing turns left; lowering the right wing turns right. The coordinated turn preserves nose elevation rather than yawing about the banked body-up axis. At zero target speed an airborne aircraft stops and hovers; there are no stalls. Pitching down steers velocity downward; pitching up steers it upward. Full throttle changes target speed rather than lift. Response takes time and respects acceleration limits.

Example: `move:{x:0.5,y:0,z:0}`, `rotate:{x:0,y:-0.5,z:0}`, `brake:0`, `jump:false`, plus `protocolVersion:2` and a fresh `sequence`, requests half maximum forward speed and a nose-up pitch rate.

## Effective policy and exact servos

Use `protocol_info.physics` for effective values; [invariants.json](invariants.json) owns defaults. These are server/session policy, not arbitrary registration fields.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `aircraftVelocityResponse` | 1.2 s | Velocity-error response time |
| `aircraftAcceleration` | 15 m/s² | Magnitude cap on velocity-servo acceleration, before gravity compensation |
| `aircraftAngularRate` | 0.8 rad/s | Magnitude cap on requested body rates |
| `aircraftAngularAcceleration` | 2 rad/s² | Magnitude cap on angular servo acceleration |
| `aircraftRateResponse` | 0.25 s | Angular-rate-error response time |
| `aircraftAutoLevel` | true | Enable neutral-roll leveling |
| `aircraftLevelGain` | 1.5 s⁻¹ | Bank-to-roll-rate leveling gain |
| `aircraftBankTurnRate` | 0.6 rad/s | Coordinated yaw contribution cap |
| `aircraftTakeoffSpeed` | 5 m/s | Required target and horizontal speed for pitch-up runway assistance |
| `aircraftTakeoffVerticalSpeed` | 0.5 m/s | Upward desired-velocity threshold for runway gravity compensation |

Let `R` map body vectors to world, `v` be COM velocity, `h` the physics substep, `g` gravity, and `limit(v,L)` clamp vector magnitude to L. Scalars use `clamp(x,min,max)`.

```text
forward = R*(1,0,0); left = R*(0,1,0); up = R*(0,0,1)
speed = move.x * maxSpeed * (1-brake)
v_target = forward * speed
a_servo = limit((v_target-v)/max(h,aircraftVelocityResponse), aircraftAcceleration)
launching = speed > aircraftTakeoffSpeed AND rotate.y < 0
            AND length((v.x,v.z)) > aircraftTakeoffSpeed
assisted = NOT terrainSupported OR v_target.y > aircraftTakeoffVerticalSpeed OR launching
a_actuation = a_servo + (assisted ? (0,g,0) : (0,0,0))
F = mass * a_actuation
# Rapier separately applies (0,-g,0) and contact impulses.

bank = atan2(left.y,up.y)
w_target = rotate * aircraftAngularRate
if rotate.x == 0 AND aircraftAutoLevel:
    w_target.x = -bank * aircraftLevelGain
if NOT terrainSupported:
    turn = -g*tan(clamp(bank,-1,1))/max(5,abs(speed))
    w_target += inverse(R)*(0,clamp(turn,-aircraftBankTurnRate,aircraftBankTurnRate),0)
w_target = limit(w_target,aircraftAngularRate)
w_body = inverse(R) * w_world
alpha = limit((w_target-w_body)/max(h,aircraftRateResponse), aircraftAngularAcceleration)
torque_world = R * (Ix*alpha.x, Iy*alpha.y, Iz*alpha.z)
```

Aircraft Rapier angular damping is zero: angular damping comes from the explicit rate servo, not the old 0.3 coefficient. Near zero target rate in unconstrained single-axis motion, rates decay approximately exponentially with the 0.25 s response time, until numerical/contact effects matter. Full input requests a rate, with acceleration limited to 2 rad/s² across all axes, rather than constant torque forever. There are no lift/drag equations or speed-dependent rotation authority. Combined axes share the rate/acceleration budgets. The existing global angular-speed cap of 3 rad/s and registered COM `maxSpeed` cap still apply after integration.

## Takeoff, landing and collision behavior

On supporting terrain, gravity remains active at rest and during level taxi. Above 5 m/s actual horizontal speed and positive target speed above 5 m/s, holding nose-up input enables gravity compensation so the body can pitch off the runway. An upward target velocity above 0.5 m/s also enables assistance. While airborne, assistance cancels gravity even at zero throttle. To land, pitch down and reduce speed; once supported, release controls to settle under gravity. Contact geometry, restitution and impulses still apply. The aircraft is not aligned automatically with terrain and has no landing gear or detailed crash model. Flight forces recover velocity smoothly after impacts rather than teleporting through obstacles.

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

## Timing, timestamps and latency

| Stage | Current implementation |
| --- | --- |
| Physics outer substep `h` | Fixed 1/120 s (8.333 ms); Rapier may additionally subdivide for CCD/solver processing |
| Session tick | Default 30 Hz, advances 1/30 s = four outer substeps; configurable `tickRate` appears in session discovery summaries |
| Client input | Complete held-state frames recommended at 30 Hz; vectors are not partial patches |
| Application | Network handler validates/stores newest frame; next session tick consumes the latest sequence and holds it over that tick's substeps |
| Publication | Full snapshots approximately 15 Hz (66.7 ms), on a timer independent of simulation; lifecycle/admin actions can publish extra snapshots |
| Timeout | Neutralizes controls after 250 ms of **simulation time** without a newer consumed frame; target speed becomes zero; rate stabilization, wing leveling and airborne gravity compensation continue |

A newer frame replaces held controls; this is not a FIFO replay of all input frames. Multiple frames arriving between ticks may be coalesced to the latest one. `lastInputSequence` acknowledges that latest consumed frame. Duplicate/out-of-order sequences are rejected and do not refresh timeout. Inputs remain constant until superseded or stale, but body orientation, target velocity and servo forces/torques are recalculated each physics substep.

There are currently **no snapshot timestamps, simulation tick IDs, server send timestamps, input application timestamps, clock synchronization, or published RTT/ping statistics**. `data_version` provides session-local resource versions for cache/receipt tracking, not physical timestamps. A cached/retried snapshot may be identical to one already received; its version can identify a replay. Do not invent `state.timestamp`, `state.serverTime`, `state.tick`, or per-input application-time fields. Snapshot version counts are not fixed-duration physics ticks.

The default cadence is nominal, not a real-time deadline. Node timer scheduling, server load and network/relay buffering introduce jitter. Simulation advances fixed dt per executed session tick rather than catching up all elapsed wall time, so simulated time can lag wall time under load. Do not assume `received snapshot count * 1/15` equals authoritative simulation time.

There is **no measured “typical network delay” available to promise clients**. Measure the deployed path, including browser -> local relay -> server and the return path if a relay is used. Even with zero transport delay, normal default timer phases alone can add approximately 0–33.3 ms to input consumption and another 0–66.7 ms before periodic publication: about 0–100 ms of nominal feedback waiting, excluding jitter, extra snapshots and display buffering. This is a phase budget, not a measured RTT or upper bound.

A client can timestamp sent sequences and snapshot arrivals with its local monotonic clock (`performance.now()`), then measure input-to-observed-ack delay for sequences actually acknowledged. Maintain median/p95 and sample jitter; frames skipped by coalescing will not each produce an acknowledgment. Such a measurement includes server phase waits and both transport directions, not just network RTT, and cannot determine the one-way delay or precise server application time. There is no custom ping/clock-sync event in this protocol. True time-aligned prediction would require an explicit server protocol extension.

Use the newest authoritative state for control estimation, not the deliberately delayed/interpolated render pose. A one-snapshot display buffer adds about 66.7 ms of client display delay beyond the feedback path; it should not silently become extra control-loop delay.

## Optional client autopilots

Basic clients need no feedback controller: map throttle directly to target speed and pitch/roll/yaw to requested rates. Clear held keys on blur/disconnect and send complete frames continuously while active. On timeout, zero target speed brings the aircraft to a gradual stop; it does not coast like the previous model.

For attitude hold, form the shortest body-frame quaternion error and request bounded proportional angular rates by dividing desired rates by `aircraftAngularRate`. Do not add the old torque or angular-damping compensation. Server rate stabilization already closes the inner loop. For altitude hold, request a bounded vertical rate from altitude error, derive a feasible pitch from desired vertical rate and target speed, and use attitude hold to approach that pitch. Avoid integrator windup at speed/rate/acceleration limits. Delayed snapshots and missing authoritative timestamps still limit precision.

The built-in Flight Lab is available at `/fly`, also linked from `/admin`. It joins a selected session as an ordinary player with a prebuilt validated glider GLB (3 m span, 0.45 m wing chord, 2.8 m fuselage) and 40 m/s maximum speed. It renders server DTED and actor GLBs, sends complete frames, and displays root altitude/velocity and sequence acknowledgments. Display poses interpolate positions and shortest-arc quaternions in a 100 ms receipt-time buffer; the chase camera follows those same display poses. This adds display delay, not physics/input delay. On snapshot starvation it freezes rather than extrapolating through terrain. Telemetry uses the newest authoritative state. Reconnecting creates a fresh actor; it does not grant admin powers. W/S adjusts target speed, Left/Right Arrow bank and turn left/right respectively, Down Arrow noses up, Up Arrow noses down, Q/E yaw, Space fires alternating wing rockets, B brakes, Escape clears controls. On-screen hold buttons offer the same rotation controls. The speed slider stays set until changed or controls are stopped.

## Implementation references

- `modules/physics/aircraft.js`: assisted flight forces and rate servo.
- `modules/physics/controllers.js`: controller dispatch and force reset.
- `modules/physics/body.js`: volume mass, COM and box inertia.
- `modules/physics/model.js`: substeps, timeout, COM/root projection, contacts and caps.
- `modules/server/public/fly.js`: direct player interface.

Clients consume shared contracts and their own GLBs; they do not import server modules.

## Terrain aiming preview

Flight Lab projects a 3 m radius circular outline along the displayed aircraft's body +X nose direction, starting at the nose at mid-height. Its center is the first terrain intersection. A surface shader maps the circle onto the actual DTED triangles, so slopes/curvature deform the footprint naturally and terrain depth occludes it. When boresight misses terrain (including over the horizon), a red screen-space circle marks the aim direction instead. Hits less than 5 m from the nose aim origin hide both markers; exactly 5 m is visible. Both hide on session replacement or disconnect. The aim uses the same interpolated pose as the aircraft to avoid snapshot jitter. This is a visual straight-line aiming preview, not a projectile trajectory, damage region or a promise of a projectile hit. Optional `fire` and server rocket state are described in [rockets.md](rockets.md). `modules/server/public/terrain-reticle.mjs` implements the reference projection.

World X/Z wrapping also applies to aircraft, camera interpolation, aiming and rockets. Read [world-wrapping.md](world-wrapping.md). Bank drives turn rate and the server adds coordinated yaw around world vertical, preserving nose elevation; clients need no automatic yaw mixer.
