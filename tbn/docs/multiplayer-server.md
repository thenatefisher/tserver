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
| `action` (30Hz) | `{protocolVersion:2, sequence, move:{x,y,z}, rotate:{x,y,z}, brake, jump}` | Complete normalized held-state frame; see [physics-controls.md](physics-controls.md). All axes required; stale input neutralizes after 250 ms. |
| `request_mesh` | `actorId: string` | Request base64 GLB mesh for a remote actor. |

## Registration Payload (`register_actor`)
Generate attributes and prepare this package at build time, before execution or connection. Submit it after player server registration and before joining a game session. `mesh.glb` is a base64 string encoding a version 2 GLB, at most `16 * 1024 * 1024` decoded bytes and `5000` triangles. Include weapon hardpoint locations in body coordinates (+X forward, +Y left, +Z up). See `tbn/schemas/actor.schema.json`.

```json
{
  "name": "VehicleName",
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
- **Grounding**: Rapier resolves terrain contacts, impacts and bounce; a ground controller settles pitch/roll to the contact normal. Render authoritative attitude and Y without local clamping.

## Protocol v2 and session lifecycle

Every session selection/transfer sends `protocol_info` with `{protocolVersion:2, inputTimeoutSeconds:0.25, physics:{...}}`, including effective physics defaults and session overrides such as waterLevel. Reject unsupported versions visibly. `session_selected` indicates admission before registration; `registration_accepted` confirms a valid actor and the initial `session_joined` follows. `init` identifies the upstream actor and resets the input sequence on selection/transfer. `request_rejected` reports invalid actions, sequences or other requests without disconnecting the client. Legacy acceleration input is rejected, not translated.

| Request | Response / effect |
| --- | --- |
| `request_sessions` | `sessions_list`: session descriptions |
| `join_session` (string ID) | `session_joined` plus fresh resources, or `session_rejected` retaining current membership |
| `request_world` / `request_map` | Current `map_data` |
| `request_actors` | `actors_list` descriptors, including `physicsProfile` |
| `request_data` `{sessionId,resource}` | Versioned resource payload |
| `request_data_manifest` | `data_manifest` with required/sent/acknowledged versions |
| `data_ack` `{sessionId,resource,version}` | Confirms a version actually sent to this connection |

Resources are `terrain` (world wrapper), `registrations`, `state`, and `mesh:<actorId>`. Resource payload events are followed by `data_version` envelopes. Ack after caching. Opt in to unacknowledged-resource retries using upstream handshake `auth.sync:true`. Geometry is requested on demand; removal emits `data_removed` tombstones and manifest removal. A new session has independent receipt versions and terrain; discard old cache associations. Sessions isolate actors and simulation. A reconnect requires actor registration again.

State actors now include `grounded` and `lastInputSequence` along with body angular rates. The simulation acknowledgment reflects a consumed control frame; old/duplicate sequences are rejected without extending the 250 ms lifetime. Read [physics-controls.md](physics-controls.md) for controller behavior and [tbn-sdk.md](tbn-sdk.md) for an implementation recipe.

## Admin flatten event

Admin observers may send `admin_flatten_terrain` (no payload) to flatten their selected session to Y=0. Player requests are rejected. Updated `map_data` and state precede `terrain_flattened` `{sessionId,elevation:0,version}` for all session members. Actors are settled with zero velocity; heading/X/Z, registrations and sequence counters persist. Rebuild client terrain caches and reset interpolation on this notice. Other sessions are unchanged.
