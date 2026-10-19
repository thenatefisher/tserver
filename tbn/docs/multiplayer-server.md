# Multiplayer Server Specification

## Endpoints
- **Socket.IO / HTTP**: `http://<host>:4000` (or `process.env.PORT`)
- **UDP Discovery**: Port `4001` (IPv4 broadcast)
- **HTTP Ping**: `GET http://<host>:4000/ping` -> `{"gameServer":true,"port":4000}`

## Host Discovery
1. **UDP**: Send string `"TBN_DISCOVER"` to `255.255.255.255:4001`.
2. **Response**: `{"type":"TBN_SERVER_BEACON","port":4000}`. Connect to `http://<rinfo.address>:4000`.
3. **Fallback**: HTTP sweep `GET http://<subnet>:4000/ping`.

## Socket Events Reference

### Server -> Client (Incoming)
| Event | Payload | Description |
|---|---|---|
| `init` | `playerId: string` | Authoritative socket/actor ID. |
| `map_data` | `{ size, terrain }` | World snapshot following `tbn/schemas/world.schema.json`, sent once on connection and again on request. |
| `mesh_manifest` | `{ [id]: manifestEntry }` | Manifest of all currently connected actors. |
| `mesh_manifest_entry` | `manifestEntry` | Emitted when a new actor completes registration. |
| `mesh_manifest_removed`| `actorId: string` | Emitted when an actor disconnects. |
| `registration_accepted`| `manifestEntry` | Confirms actor registration success. |
| `registration_rejected`| `{ reason: string }` | Rejection details if actor registration failed. |
| `state` (~15Hz) | `{ actors: [], projectiles: [], hitEvents: [] }` | Full authoritative snapshot following `tbn/schemas/state.schema.json`: all actors including the player, in-flight projectiles, and new hit events. |
| `player_hit` | `{ targetId, sourceId, damage, remainingHealth, hitLocation }` | Authoritative hit and damage event. |
| `mesh_geometry` | `{ id, glb, metadata, triangles, hitbox }` | Base64 GLB geometry response for `request_mesh`. |

### Client -> Server (Outgoing)
| Event | Payload | Description |
|---|---|---|
| `register_actor` | `{ name, clientType, physicsProfile, mesh }` | Register player vehicle (GLB + metadata). |
| `action` (30Hz) | `{ linear?: {x?,y?,z?}, angular?: {x?,y?,z?} }` | Signals defined in `tbn/schemas/actions.schema.json`: `linear` in g, `angular` in rad/s²; linear X/Y/Z limits ±3/±1/±5 g; angular limits ±1 rad/s². Omitted parameters retain their previous value. |
| `request_mesh` | `actorId: string` | Request base64 GLB mesh for a remote actor. |

## Registration Payload (`register_actor`)
Generate attributes and prepare this package at build time, before execution or connection. Submit it after player server registration and before joining a game session. `mesh.glb` is a base64 string encoding a version 2 GLB, at most `16 * 1024 * 1024` decoded bytes and `5000` triangles. Include weapon hardpoint locations in body coordinates (+X forward, +Y left, +Z up). See `tbn/schemas/actor.schema.json`.

```json
{
  "name": "VehicleName",
  "clientType": "custom-client",
  "physicsProfile": {
    "maxSpeed": 25.0
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
            "x": 0,
            "y": -1.5,
            "z": 0
          }
        }
      ],
      "grounding": {
        "contactPlaneZ": 0,
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

## Server Authority Constraints
- **Simulation**: 30Hz tick rate (`dt = 1/30`).
- **Hitbox**: Fixed `2m x 2m x 2m`.
- **Visual Size Limit**: Max `3m x 3m x 3m`.
- **Polygon Limit**: Max `5,000` triangles.
- **World Dimensions**: `1000m x 1000m x 1000m`; placement and clamping bounds come from server map data.
- **Grounding**: Server sets authoritative `y` elevation via DTED terrain.
