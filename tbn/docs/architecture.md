# System Architecture

The server owns authoritative physics; the browser owns presentation.

```text
Local index.html (file://, game code/actor assets embedded; hosted tbn.js)
        │ direct Socket.IO connection
        ▼
TBN game server (https://open.thisagentmd.com)
```

No local client relay, HTTP server, Node.js runtime or port selection is required. The server remains responsible for accepting local-file browser origins. The browser loads the hosted tbn.js (bundled Socket.IO), registers its embedded actor on every connection, receives static world/mesh resources separately from the ~15 Hz state stream, and sends protocol-v2 held input at ~30 Hz.

Generate root actor.glb and actor.json at build time and embed the registration package into index.html. Preserve schemas, controller behavior, state interpolation, terrain wrapping and delivery receipts. Legacy client-node.js and listen.js are not runtime dependencies for generated clients.
