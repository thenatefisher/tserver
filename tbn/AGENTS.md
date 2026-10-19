# TBN Game-Building Agent Instructions

You are helping a user build a game using the **Tactical Battle Network (TBN)** framework. Provide a client that launches successfully and connects to the central TBN server. This is the single downstream agent instruction file; technical contracts are linked below.

When the user enters **`start tbn`**, you must execute the standardized 5-phase creation protocol detailed below.

---

## ⚡ Command Trigger: `start tbn`

When the user enters `start tbn` (or asks to create/build a new TBN client):

### Phase 1: The Creative Vibe-Coding Interview
**DO NOT WRITE ANY CODE YET.** Immediately ask the user the 4 creative design questions from [`tbn/docs/user-interview.md`](tbn/docs/user-interview.md):

```text
Awesome! Let's vibe-code your custom TBN client. Tell me:
1. Visual Style (3D Three.js, 2D Canvas, Retro ASCII Terminal, Cyberpunk Wireframe)?
2. Vehicle Vibe & Shape (Hovercraft, Mech Walker, Heavy Tank, Agile Drone)?
3. Controls (WASD tank steering, Mouse-aim directional drive, Touch / Dual-stick)?
4. Juice & Polish (Particle exhausts, Procedural Web Audio SFX, Screen shake, CRT scanlines)?
```
*Wait for the user's response before proceeding.*

Also ask for their build-time actor property choice: maximum speed (`maxSpeed`) in m/s, inclusive range [1, 100]. Obtain this choice before generating the final `actor.json`. Also select `physicsProfile.controller` from ground, hover, aircraft, mecha, boat according to the chosen vehicle design. Both fields are required; no tradeoff or points budget exists. Read `tbn/docs/physics-controls.md` before implementing controls or rendering. Store the selected value in `actor.json` as `physicsProfile.maxSpeed`.

---

### Phase 2: Invariant Ingestion & Architecture Plan
Once the user replies with their aesthetic and vehicle preferences, review and strictly adhere to the system invariants:
- **Invariants Sheet**: [`tbn/docs/invariants.md`](tbn/docs/invariants.md)
- **Machine-Readable Invariants**: [`tbn/docs/invariants.json`](tbn/docs/invariants.json)
- **TypeScript Contracts**: [`tbn/docs/tbn.d.ts`](tbn/docs/tbn.d.ts)
- **Server Data**: [`tbn/schemas/world.schema.json`](tbn/schemas/world.schema.json) is delivered on connection, on request, and after an explicit admin flatten or preset change. Rebuild terrain on replacement `map_data`; clear interpolation on `terrain_flattened` or `terrain_changed` without resetting input sequences. Replace target visuals on map updates; mirror `collision_settings.terrainOnlyCollisions` in any prediction while keeping terrain contact and actor visuals. [`tbn/schemas/state.schema.json`](tbn/schemas/state.schema.json) defines full game-state snapshots at approximately 15 Hz: all actors including the player, projectile position/velocity, and hit events. Actor orientation is Euler radians in XYZ order. Cache world data separately from moving state and deduplicate hit effects by event ID.
- **Mandatory Actor Registration**: [`tbn/schemas/actor.schema.json`](tbn/schemas/actor.schema.json), referencing [`tbn/schemas/mesh.schema.json`](tbn/schemas/mesh.schema.json). Prepare and validate the actor package at build time. Send `register_actor` on every server connection, including reconnects, before joining a session. Socket connection success alone is insufficient. Required actor fields are `name` (at most 30 characters), `clientType`, `physicsProfile` with `maxSpeed` in [1, 100], and `mesh`; `physicsProfile.controller` is also required.
- **Client Signals**: [`tbn/schemas/actions.schema.json`](tbn/schemas/actions.schema.json) is protocol v2: complete `protocolVersion`, increasing `sequence`, normalized `move` and `rotate` XYZ vectors, `brake`, and `jump`. All fields/components are required. Inputs are control effort, not acceleration. Read [`tbn/docs/physics-controls.md`](tbn/docs/physics-controls.md) for controller capabilities, grounded pitch suppression, jump edges, 250 ms timeout, sequencing, compatibility, input mappings and rendering. Reject old `linear`/`angular` examples. Surface `protocol_info` mismatches and rejection reasons in the HUD.

Key Non-Negotiables:
The server enforces mesh volume of at least 1 m³ and a fixed 2 m cube hitbox centered at the actor origin (X/Y/Z [-1, 1]). Do not expose either as a user-selectable property or add client-supplied hitbox/volume fields. Build the GLB to satisfy these server rules.

1. **Network Ports**: Central Host is `http://<host>:4000` (UDP beacon `4001`). Local relay binds `http://localhost:3000`.
2. **Coordinate Conventions**: Body frame is **`+X` = forward**, **`+Y` = left**, **`+Z` = up** (NOT Three.js `-Z`!). Author geometry with `contactPlaneZ = 0.0`; the server subsequently determines world terrain contact and attitude.
3. **Geometry Budgets**: Hitbox `2m x 2m x 2m`. Visual size at most `3m x 3m x 3m` in a `1km x 1km x 1km` world. Only GLB version 2 is supported. Maximum decoded GLB size is `16 * 1024 * 1024` bytes (16 MiB), with at most 5,000 triangles.
4. **DTED Terrain**: Configurable world-X/Z row-major grid defined in `tbn/schemas/world.schema.json`. Integer heights use 0.1 m units; multiply by `elevationScale = 0.1`. At 0.25 m spacing, a 1 km extent has 4000 posts per axis (far boundary excluded). Use transmitted dimensions and spacing, never hardcode resolution.
5. **Client Rotations**: Always use Euler angles in radians with explicit `XYZ` order. Enforce this in generated client logic and rendering calls. Convert other incoming representations at the boundary while preserving the server wire format. x = roll, y = pitch, z = yaw.

Body axes follow the right-hand rule (+X cross +Y = +Z). World/DTED coordinates retain +Y up; convert Z-up body geometry and hardpoints at the world/render boundary. At zero heading the mapping is `(x, y, z) -> (x, z, -y)`.

---

### Phase 3: Build & Scaffold Client
Generate the four mandatory client artifacts in the **repository root** before executing the game or connecting to the server:
1. `./client.js`: Express web server and Socket.IO bridge binding to port `3000` that connects upstream to port `4000` (or discovers via UDP `4001` / HTTP ping).
2. `./index.html`: Client presentation (visuals, input loop emitting `action` at 30Hz, actor GLB/mesh registration, sound, and HUD).
3. `./actor.glb`: A version 2 GLB representing the user's described actor. If the user provides no actor description, generate a simple stick man. Obey the geometry, grounding, body-frame, byte, and triangle invariants.
4. `./actor.json`: The complete registration package following `tbn/schemas/actor.schema.json` and its referenced `tbn/schemas/mesh.schema.json`. Include base64 of the exact bytes of `actor.glb` in `mesh.glb`, along with name, client type, attributes, and mesh metadata. Include every weapon hardpoint in `mesh.metadata.projectileOrigins` using the body coordinate frame; use an empty array for an unarmed actor. Keep the files synchronized and validate both at build time. The client loads this prepared package and sends it on each server connection; do not defer asset generation until runtime.

**Strict Placement Rules**:
- Client code MUST reside in root (`./client.js` and `./index.html`).
- Never place client code in `tbn/` or create alternate entry points (`app.js`, `server.js`, `frontend/index.html`).
- Never import or modify `tbn/client-node.js`.

---

### Phase 4: Automated Conformance Verification
Run the automated conformance suite:
```bash
python3 tbn/test_conformance.py
```
If any violations are reported, parse the semantic feedback and automatically remediate until **0 violations** remain.

---

### Phase 5: User Handoff
Present the user with clear instructions to launch:
```bash
node client.js
```
And direct them to open `http://localhost:3000` in their browser.

---

## 📚 Topic Documentation Index

| Topic | Document Path | Description |
|---|---|---|
| **Physics & Controls v2** | [`tbn/docs/physics-controls.md`](tbn/docs/physics-controls.md) | **Mandatory.** Rapier controllers, input lifecycle, slope attitude, jumps, bounce and rendering. |
| **0. System Invariants** | [`tbn/docs/invariants.md`](tbn/docs/invariants.md) | **Mandatory.** Ports, body frame coordinates (+X forward), limits, DTED math, and schemas. |
| **1. Game Construction Rules** | [`tbn/docs/client-rules.md`](tbn/docs/client-rules.md) | Root placement only, strict immutability of `tbn/`, forbidden entry points, `node client.js`. |
| **2. Multiplayer Server & Protocol** | [`tbn/docs/multiplayer-server.md`](tbn/docs/multiplayer-server.md) | Socket.IO server, 30Hz loop, event lifecycles, and combat. |
| **3. System Architecture** | [`tbn/docs/architecture.md`](tbn/docs/architecture.md) | 3-tier architecture: Authoritative Host, Local Node Relay, Browser Presentation. |
| **4. TBN SDK Integration** | [`tbn/docs/tbn-sdk.md`](tbn/docs/tbn-sdk.md) | `TbnSDK.connect()`, map receipt, actor registration, state updates, hit events. |
| **5. Actor Geometry & GLB** | [`tbn/docs/actor-geometry-glb.md`](tbn/docs/actor-geometry-glb.md) | GLB limits (<=5k triangles), hitbox, contactPlaneZ=0 grounding, projectile hardpoints. |
| **6. DTED Terrain Specs** | [`tbn/docs/dted-terrain.md`](tbn/docs/dted-terrain.md) | Row-major elevation grid, triangle height sampling, mesh generation. |
| **7. User Vibe-Coding Interview** | [`tbn/docs/user-interview.md`](tbn/docs/user-interview.md) | 4 creative interview questions to ask upon `start tbn`. |
| **8. Conformance Testing** | [`tbn/docs/conformance-testing.md`](tbn/docs/conformance-testing.md) | Automated testing with `python3 tbn/test_conformance.py`. |

Terrain presets and session selection: read [`tbn/docs/terrain-presets.md`](tbn/docs/terrain-presets.md). Render all presets from received DTED samples; city blocks are raised heightfield terrain, not missing GLB buildings. Neutral ground throttle now applies stronger server coasting friction; avoid local velocity overrides that fight this authoritative response.

Supported ground/mecha reverse steering is handled by the server from longitudinal travel direction. Do not invert client steering again when reversing; keep ordinary left/right control mappings. Airborne yaw remains body-axis attitude effort.
