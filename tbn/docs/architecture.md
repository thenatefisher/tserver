# System Architecture

## Core Principle
**"The server owns truth. The client owns presentation."**
- Server simulates authoritative 30Hz physics, movement, collision, terrain contact, and actor state.
- Client reads server state and renders presentation (3D/2D/ASCII), HUD, sound, and user controls.
- Browser action frames follow protocol v2 in `tbn/schemas/actions.schema.json`: complete normalized `move`/`rotate` effort, brake, jump, version and sequence. The relay forwards frames without interpreting physics. Read [physics-controls.md](physics-controls.md).

## 3-Tier Topology
```text
┌────────────────────────────────┐
│ Authoritative Host (Port 4000) │  game-server.js: 30Hz sessions, Rapier, DTED terrain
└──────────────┬─────────────────┘
               │ Socket.IO / UDP (Port 4001)
┌──────────────▼─────────────────┐
│ Local Client Node (Port 3000)  │  client.js: LAN discovery, web server, WebSocket relay
└──────────────┬─────────────────┘
               │ Local WebSocket
┌──────────────▼─────────────────┐
│ Browser Client View            │  index.html: TbnSDK, rendering, HUD, audio, input
└────────────────────────────────┘
```

Each session owns a distinct Rapier world. Actor controllers translate intent into forces/torques; Rapier owns collision response. The server announces protocol v2 and physics policy through `protocol_info`. A local relay must forward that announcement, registration/action rejection reasons and input acknowledgments in state.
