# System Architecture

## Core Principle
**"The server owns truth. The client owns presentation."**
- Server simulates authoritative 30Hz physics, movement, collision, terrain clamping, health, and combat.
- Client reads server state and renders presentation (3D/2D/ASCII), HUD, sound, and user controls.
- Browser action frames follow [`tbn/schemas/actions.schema.json`](tbn/schemas/actions.schema.json): `linear` in g and `angular` in rad/s², with optional components; linear X/Y/Z limits are respectively ±3/±1/±5 g, while angular components are ±1 rad/s². Omitted parameters retain their previous value. The relay forwards these signals to the authoritative server.

## 3-Tier Topology
```text
┌────────────────────────────────┐
│ Authoritative Host (Port 4000) │  game-server.js: 30Hz physics, DTED terrain, combat
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
