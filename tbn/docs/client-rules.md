# Client Implementation Rules

## Required outputs

Generate root `index.html`, `actor.glb`, and `actor.json` at build time. The HTML is the single playable artifact: opening it directly from disk must require neither Node.js nor a local web server. Actor files remain authoring/validation artifacts; the HTML must work when copied away from them.

Load the approved hosted `https://open.thisagentmd.com/tbn.js` script; inline all game JavaScript, other libraries, CSS, images, audio, shaders and the actor registration package. Do not depend on a CDN, sibling files, runtime module imports, `require`, or local-file `fetch`. Decode GLB bytes in memory and use the rendering library's in-memory parser. Embed other assets as data URLs or in-memory bytes. No service worker or local server is required.

Store the actor registration JSON in `<script id="tbn-actor" type="application/json">`; it must match `actor.json`. Serialize with literal `<` escaped as `\u003c` to prevent accidental script termination. Its base64 `mesh.glb` must decode to the exact `actor.glb` bytes. Follow `tbn/schemas/actor.schema.json` and `tbn/schemas/mesh.schema.json`, including actual binary geometry limits. Default to a simple stick man when no actor is described.

## Direct connection

Use the hosted TBN browser client with `TBN.connect()` (default `https://open.thisagentmd.com`). Preserve Socket.IO protocol framing; a raw WebSocket is not a replacement. Each browser instance connects directly and registers its embedded actor on every connection/reconnection. Check protocol compatibility and expose errors in the HUD. The existing game server must permit local-file browser connections, including null-Origin requests where applicable. Do not work around rejection by creating a relay.

No `client.js`, Express, npm install, port search, UDP discovery or port 3000 is part of generated games. Legacy Node helpers remain framework reference files only. Keep `tbn/` unchanged when building a user's game. Place no generated game inside `tbn/` or alternate application directories.

## Controls and presentation

Follow `tbn/docs/physics-controls.md`: complete protocol-v2 frames, monotonic sequence, neutral refresh at 30 Hz, blur handling, compatibility checks, registration and session lifecycle. Keep server physics authoritative. Air vehicles follow `tbn/docs/air-vehicle-experience.md`. The standalone packaging changes delivery, not protocol or gameplay semantics.

## Handoff and verification

Run `python3 tbn/test_conformance.py` during authoring for static packaging checks. Then open the actual HTML from disk and verify browser startup, direct connection, registration, mesh rendering, controls, state and reconnect behavior against the game server. Static checks alone cannot certify browser behavior. Tell the user to open `index.html`; do not give a Node.js launch command.

## Hosted TBN browser transport

The approved external dependency is `<script src="https://open.thisagentmd.com/tbn.js" crossorigin="anonymous"></script>`. It bundles Socket.IO; use `const socket = TBN.connect()` after loading it. `TBN.connect({url,auth,actor,autoConnect})` supports explicit overrides; the optional actor package is re-registered on reconnect. Do not duplicate automatic and manual registration. The game URL is HTTPS port 443 on Cloud Run, not public port 4242. Local-file pages send `Origin: null`; the actual game server accepts this for polling, upgrades, and script requests without cookies. For raw Socket.IO, `/socket.io/socket.io.js` and `/socket.io/` are available on the same HTTPS origin. Embed actor data and game code; do not fetch sibling files.
