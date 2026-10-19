# TBN Invariants & System Specifications

This document defines the immutable technical invariants of the TBN game environment. Agents and developers must treat all values and conventions here as non-negotiable system contracts.

## Framework philosophy

TBN gives users and their agents the scaffolding to create their own games. Every generated game must launch successfully and be able to connect to the central TBN game server. Creative presentation and controls share a standard actor input contract so they remain compatible with that server.

---

## 1. Network Topology & Ports

| Component | Protocol / Transport | Port / Endpoint | Invariant Value | Description |
|---|---|---|---|---|
| **Authoritative Game Host** | HTTP / Socket.IO | `4000` | `http://<host>:4000` | Central authoritative physics & combat simulation. |
| **UDP Beacon Discovery** | UDP Broadcast | `4001` | `255.255.255.255:4001` | Probe string: `"TBN_DISCOVER"`. Response: `{"type":"TBN_SERVER_BEACON","port":4000}`. |
| **Local Client Relay** | HTTP / Express + Socket.IO | `3000` | `http://localhost:3000` | Local relay launched via `node client.js`. Serves `./index.html`. |
| **Host Ping Probe** | HTTP GET | `4000` | `GET http://<host>:4000/ping` | Subnet fallback probe. Returns `{"gameServer":true,"port":4000}`. |

---

## 2. Coordinate System Conventions

> [!WARNING]
> **CRITICAL AGENT NOTICE: DO NOT USE THREE.JS DEFAULTS!**
> Standard Three.js conventions (where `-Z` is forward) **DO NOT APPLY** to the vehicle body or network packets.

### Body Frame (Vehicle Local)
This is a right-handed frame: +X cross +Y = +Z. Positive roll, pitch, and yaw follow the right-hand rule about +X, +Y, and +Z respectively.
- **`+X` = Forward (Nose)**: Positive control effort `move.x > 0` drives forward. Heading angle $0^\circ$ points along $+X$.
- **`+Y` = Left (Port)**: Lateral axis.
- **`+Z` = Up (Roof)**: Elevation/normal axis.
- **Rotations**:
  - `yaw` = Rotation about **$+Z$** (steering). Positive yaw control `rotate.z > 0` turns counter-clockwise when viewed from above.
  - `pitch` = Rotation about $+Y$.
  - `roll` = Rotation about $+X$.

### Client rotation representation
Client rotation code must always use **Euler angles**, in **radians**, with explicit **`XYZ` order**. Components map to x = roll, y = pitch, z = yaw. Agents must enforce this in generated code and code review; do not assume a rendering library's default order or use degrees.

Convert any other server/library representation at the client boundary before using it in client logic. The server state schema supplies `orientation` as Euler radians with explicit `XYZ` order. Use an explicit body-to-world basis conversion when applying those Euler angles to a renderer.

### World Frame
The actor body frame is separate from the world/DTED frame below. At zero heading, convert a body-local vector to this world/render frame as `(x, y, z) -> (x, z, -y)`. Apply the actor's world rotation and translation when placing local points. Use this conversion consistently for GLB geometry, hardpoints, and orientation; do not reinterpret Z-up body coordinates as Y-up world coordinates. Euler client rotations remain radians with explicit XYZ order in the applicable frame.
- **`+X` = East**
- **`+Y` = Up (Terrain elevation in metres)**
- **`+Z` = South**
- **World Dimensions**: 1,000 m on each axis (a 1 km cube), defined in `tbn/schemas/world.schema.json`. Server map data supplies world placement and clamping bounds.

### Grounding Plane
- **`contactPlaneZ`**: Strictly **`0.0`** (±0.01m). The lowest vertices of your actor GLB/mesh must rest at $Z = 0.0$.
- **Clearance**: Between `0.0` and `0.1` metres above terrain.

---

## 3. Absolute Physical Dimensions & Limits

The server enforces a minimum actor mesh volume of **1 m³** from the submitted GLB and a fixed **2 m cube hitbox centered at the actor origin**, with X/Y/Z bounds [-1, 1]. Neither rule is client-selectable. The mesh schema documents these binary geometry constraints; JSON Schema cannot calculate mesh volume from the base64 GLB. The server's volume calculation is authoritative; no client bounding-box approximation replaces it.

| Constraint | Limit | Strictness | Notes |
|---|---|---|---|
| **Hitbox Dimensions** | `2m (X) x 2m (Y) x 2m (Z)` | **Authoritative** | Fixed by server for all actors. |
| **Max Visual Extents** | `3m (X) x 3m (Y) x 3m (Z)` | **Hard limit** | GLB bounding box must not exceed this or registration is rejected. |
| **Polygon Budget** | $\le 5,000$ triangles | **Hard limit** | Uncompressed binary `.glb` base64 string. |
| **Simulation Rate** | $30\text{ Hz}$ | **Authoritative** | Fixed timestep $\Delta t = 1/30 \approx 0.0333\text{ s}$. |
| **Input Clamping** | Per-axis schema limits | **Authoritative** | Movement/rotation effort is [-1, 1] per axis; brake [0, 1]. Complete v2 frames required; invalid values rejected. |

---

## 4. DTED Terrain Specification & Canonical Math

The terrain is a configurable Digital Terrain Elevation Data (DTED) post grid described by `tbn/schemas/world.schema.json`:
- World ground plane: X/Z; elevation is Y. Columns advance +X and rows advance +Z.
- `spacing.x` and `spacing.z` are configurable sample distances in meters; use transmitted values.
- Sampling is half-open: the far boundary is excluded. `columns = ceil(width / spacing.x)`, `rows = ceil(depth / spacing.z)`.
- Example: a 1000 m square sampled every 0.25 m has 4000 columns and 4000 rows, totaling 16,000,000 samples. Including both endpoints would instead require 4001 posts per axis; that is not this contract.
- `depthMap` contains integer elevations in 0.1 m units; `elevationScale` is always 0.1. A stored value of 123 means world Y = 12.3 m.
- Row-major indexing: `index = row * columns + column`. The array length must equal `rows * columns`.
- Verify dimension/spacing/count relationships at runtime; JSON Schema cannot compare or multiply property values.

### Canonical physical height sampling

Use the Rapier collision mesh diagonal and boundary extension in [dted-terrain.md](dted-terrain.md). Bilinear interpolation is not the authoritative collision surface. This helper matches triangular heights; a NaN denotes missing terrain:

```javascript
function sampleTerrainHeight(x, z, t) {
    const gx = Math.max(0, Math.min(t.columns, (x - t.origin.x) / t.spacing.x));
    const gz = Math.max(0, Math.min(t.rows, (z - t.origin.z) / t.spacing.z));
    const col = Math.min(t.columns - 1, Math.floor(gx));
    const row = Math.min(t.rows - 1, Math.floor(gz));
    const tx = Math.min(1, gx - col), tz = Math.min(1, gz - row);
    const at = (c, r) => {
        const v = t.depthMap[Math.min(r, t.rows - 1) * t.columns + Math.min(c, t.columns - 1)];
        return v === t.noDataValue ? NaN : v * t.elevationScale;
    };
    const a = at(col, row), b = at(col + 1, row), c = at(col, row + 1), d = at(col + 1, row + 1);
    return tx + tz <= 1 ? a * (1 - tx - tz) + b * tx + c * tz :
        b * (1 - tz) + c * (1 - tx) + d * (tx + tz - 1);
}
```

---

## 5. Socket.IO Protocol Schemas

### Registration Payload (`register_actor`)
At build time, let the user select `physicsProfile.maxSpeed` in m/s, inclusive range [1, 100]. Also choose `controller` from ground, hover, aircraft, mecha, boat to match the vehicle. These are the only selectable fields; there are no tradeoffs or allocation costs. Future selectable parameters and tradeoffs will be introduced through explicit updates to the actor schema and matching contracts. Example values below illustrate the payload shape; use the user's selected speed in the generated package.

Required build outputs in the recipient's project root are `./actor.glb` and `./actor.json`. Default to a simple stick man if the user supplies no actor description. The JSON is the complete registration package and its `mesh.glb` must decode to the exact bytes of `actor.glb`. Generate and validate both before execution or connection, and keep them synchronized when either changes.

The agent generates actor attributes at build time, before executing the game or connecting to the server. Prepare the actor name, attributes (`physicsProfile`), base64 GLB (`mesh.glb`), and weapon hardpoint positions (`mesh.metadata.projectileOrigins`) as one JSON registration package.

After registering the player with the server and before joining a game session, send this prepared package through `register_actor`. See [`tbn/schemas/actor.schema.json`](tbn/schemas/actor.schema.json), with matching values in `invariants.json` and contracts in `tbn.d.ts`.

Only **GLB version 2** is supported. `MAX_GLB_BYTES = 16 * 1024 * 1024` (**16,777,216 decoded binary bytes**); `MAX_TRIANGLES = 5000`. Send the binary as a **base64 string** in the JSON, and verify decoded size, GLB version, and triangle count separately from JSON schema validation. Hardpoint positions use the body frame: **+X forward, +Y left, +Z up**.

Example package:
```json
{
  "name": "PlayerVehicle",
  "clientType": "custom-client",
  "physicsProfile": {
    "maxSpeed": 25.0,
    "controller": "ground"
  },
  "mesh": {
    "glb": "<base64_uncompressed_glb>",
    "metadata": {
      "visualSize": {
        "x": 2.0,
        "y": 3.0,
        "z": 1.0
      },
      "projectileOrigins": [
        {
          "id": "main",
          "position": {
            "x": 1.0,
            "y": -0.0,
            "z": 0.5
          }
        }
      ],
      "grounding": {
        "contactPlaneZ": 0.0,
        "clearance": 0.02,
        "supportPoints": [
          {
            "x": -0.8,
            "y": 0.8
          },
          {
            "x": 0.8,
            "y": 0.8
          },
          {
            "x": -0.8,
            "y": -0.8
          },
          {
            "x": 0.8,
            "y": -0.8
          }
        ]
      }
    }
  }
}
```

### 30Hz Action Payload (`action`)
The invariant validation schema is [`actions.schema.json`](tbn/schemas/actions.schema.json), with matching constants in [`invariants.json`](tbn/docs/invariants.json) and types in [`tbn.d.ts`](tbn/docs/tbn.d.ts).

Every player sends complete normalized control frames defined by `tbn/schemas/actions.schema.json`. See [Physics and controls v2](physics-controls.md) for all fields, controller capabilities, sequence reset rules, stale-input timeout, jump edges, contact behavior and migration. `move` and `rotate` components are effort [-1, 1], not physical accelerations. Partial/v1 inputs are rejected. The server supplies gravity and actor-specific actuation; clients render authoritative poses.
