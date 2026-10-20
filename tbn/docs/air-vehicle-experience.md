# Default air-vehicle client experience

When a user asks for a plane, glider, jet or other freely flying air vehicle, default to an approachable **assisted-flight** experience like the server's Flight Lab (`/fly`). Preserve the user's requested visual style, vehicle design and control preferences. Use this as a starting experience, not a requirement to reproduce its dashboard or its exact aircraft.

Read [aircraft-controller.md](aircraft-controller.md) for definitive aircraft behavior, [physics-controls.md](physics-controls.md) for the protocol, and [client-rules.md](client-rules.md) for required root artifacts. The action/actor/world/state schemas remain the interface contract. The built-in page illustrates the experience; generated clients must run independently through their own `client.js` and `index.html`, not import server files or depend on `/fly` or its assets being hosted by the relay.

## Choose the matching server controller

Use `physicsProfile.controller: "aircraft"` for free flight and check `protocol_info.physics.aircraftModel === "assisted-flight-v1"`. Surface a clear compatibility message if it differs; do not silently apply the old thrust/torque semantics. Let the user choose `maxSpeed` under the existing build-time property rules. Carry forward preferences already given rather than repeating questions.

A drone or helicopter presentation may also use assisted aircraft when the user wants freely controlled flight: at zero requested speed the airborne actor can stop and hover. Explain that this is an arcade flight controller, not a helicopter rotor simulation. If the user specifically wants terrain-following hovercraft behavior, select `hover` instead and follow that controller's capabilities. Aircraft `move.z` is ignored: do not present it as a working vertical-thrust control. A requested unsupported flight mechanic needs a contract/server change rather than a client-only illusion.

## Default controls and feel

Prefer direct mappings to the server's built-in assistance. Clients do not need their own lift, stall, gravity-compensation, rate-damping or bank-to-turn controller. Avoid layering another stabilizer onto those controls unless the user explicitly requests an autopilot or advanced flight mode.

| UI control | Complete-frame value / behavior |
| --- | --- |
| W / S or throttle slider | Increase/decrease a persistent target-speed fraction, usually 0..1; send as `move.x` |
| Left Arrow | `rotate.x = -1`: lower left wing, bank and turn left |
| Right Arrow | `rotate.x = +1`: lower right wing, bank and turn right |
| Down Arrow | `rotate.y = -1`: nose up (pull back) |
| Up Arrow | `rotate.y = +1`: nose down (push forward) |
| Q / E | Optional yaw trim: `rotate.z = +1 / -1` respectively |
| Space | `brake = 1` while held; release restores the throttle's target speed |
| Escape / Stop controls | Clear held inputs and set target-speed fraction to zero |

These mappings deliberately preserve conventional pitch controls and intuitive left/right turns. Positive roll raises the left wing; do not accidentally map Left Arrow to positive roll. Server bank coordination already turns toward the lowered wing without adding nose elevation changes. Do not invert steering because the actor is an aircraft or apply the ground reverse-steering convention to it.

When a rotation key/stick is released, send zero on that axis: pitch rate settles, neutral roll levels wings, and an existing bank can continue turning while it levels. Keep throttle set until changed or stopped. Explain that throttle selects speed, not lift: zero asks for a smooth airborne stop/hover, not an engine-off glide. Turning and changes in climb/descent are smooth rather than instantaneous. Let users override these defaults deliberately, with visible bindings.

Offer on-screen hold buttons or touch sticks for pitch/turn, a labeled throttle slider, and a visible stop control. Handle pointer-up, cancellation and lost capture. Clear local inputs and send a neutral frame on blur/hidden-page transitions; never queue controls while disconnected. Keep complete frames flowing at about 30 Hz while active, including neutral ones. All XYZ components, sequence, protocol version, brake and jump remain required; unsupported aircraft axes are zero and jump is false. Disable actuation until registration and model compatibility succeed.

## Camera, world and smooth display

For a 3D experience, default to a chase camera behind the aircraft's **body +X nose**, raised along world +Y. Keep world-up/horizon stable rather than blindly rolling the camera with the vehicle. Smooth camera position and follow the same displayed pose used for the actor. Use the exact body-to-world quaternion conversion in the aircraft guide; Three.js's usual -Z camera direction is not the actor's nose convention.

Server snapshots arrive around 15 Hz. Render at browser animation-frame rate and interpolate authoritative root positions and shortest-arc quaternion rotations using a small receipt-time buffer (100 ms is a reasonable default). Do not snap the mesh to every snapshot or smooth only the camera. Freeze the displayed pose if samples run out rather than extrapolating into terrain indefinitely. This adds display latency; keep newest authoritative state separate for telemetry/control estimation. Receipt times are local display timing, not invented server simulation timestamps.

Render terrain from the received DTED data, including the server triangle topology, scale, edges and no-data holes, and render every actor from its registered GLB. Rebuild on terrain replacement and clear display history after terrain repositioning or connection/session lifecycle resets. Preserve input sequences after admin terrain changes as specified in the common protocol. A grid/horizon, restrained terrain contrast and clear aircraft silhouette make motion and attitude easier to read; adapt presentation for 2D/ASCII requests while keeping these control semantics.

For an aiming experience, a useful optional cue is a circular reticle projected along body +X onto the first terrain intersection, as in Flight Lab. Map the outline onto the actual terrain surface rather than floating a flat ring above it; hide it when aim misses and use the displayed aircraft pose for smooth motion. Keep this visual preview distinct from ballistic trajectories or hit guarantees. It does not introduce a `fire` action.

## Vehicle assets and useful feedback

Generate the user's aircraft geometry at build time. For a generic plane/glider request with no further shape specification, favor a recognizable long fuselage, broad thin wings and a smaller tailplane, with a visibly distinct nose and contrasting surfaces. A glider can use high-aspect-ratio wings within the existing size envelope. A request for an air vehicle counts as a vehicle description; do not fall back to an unrelated stick figure.

Use closed solid GLB geometry that meets the existing minimum volume, size, grounding and triangle limits. Thin visual wings alone may not meet the volume requirement: give the fuselage sufficient real enclosed volume and validate the complete mesh. Visual styling does not create new aerodynamic parameters. Produce root `actor.glb` and matching `actor.json` under the existing build rules; do not assume the Flight Lab glider is available to client builds.

Keep a compact HUD with target speed/throttle, actual speed, altitude, vertical rate, ground/airborne status and connection/registration errors. Label root versus COM measurements consistently. A short takeoff hint should explain: raise target speed, accelerate along the ground, then hold nose up. Landing uses nose-down approach and reduced speed, followed by neutral controls on contact; there is no landing-gear simulation. Keep controls/help visible without obscuring the aircraft.

## Acceptance checks before handoff

- Left banks/turns left, right banks/turns right; Down noses up and Up noses down unless the user chose another mapping.
- Raising speed during level airborne flight does not create runaway lift. Pitch changes the flight path; roll alone does not introduce unintended nose elevation changes.
- Releasing rotation stabilizes rates/levels wings; stop/brake slows smoothly. Takeoff and terrain contact work with the actual generated GLB.
- Mesh and chase camera move smoothly between snapshots. Terrain replacement, reconnect, input timeout and focus loss do not leave stuck controls or stale interpolation.
- Registration, complete frames, GLB and JSON pass the shared validation and existing conformance workflow. The client starts through `node client.js` and remains independent of server implementation files.

Use the Flight Lab's control feel as the default. Reserve aircraft tuning panels and client autopilot construction for users who request them; a basic flying experience should be immediately usable.
