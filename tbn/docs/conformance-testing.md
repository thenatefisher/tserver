# Standalone client conformance

Run `python3 tbn/test_conformance.py` from the generated project root, or pass `--root PATH`. Use `--json` for structured results. This authoring check does not require Node.js and does not start a client web server.

Static checks cover root index.html/actor.json/actor.glb presence; absence of Node application entry points; embedded script/style/media references, with an exception for the approved hosted tbn.js and Socket.IO browser script; the hosted TBN dependency or direct https://open.thisagentmd.com URL; obvious runtime imports and sibling fetches; matching embedded actor JSON and GLB bytes; GLB header/version/length and byte budget.

These are limited packaging checks, not a security review, complete JavaScript parser, full schema validator, triangle/volume validator, or browser execution test. Separately validate against the actor/mesh schemas and actual geometry rules. Then open the HTML using file:// in a browser and verify dependency initialization, visible connection failures, registration, compatibility, mesh rendering, controls, focus loss, state, terrain delivery, and reconnect. Test against the running TBN game server at https://open.thisagentmd.com, including its local-file origin policy. Do not substitute a localhost preview server for this launch check.

Framework authoring does not require generating a game. Test the checker with temporary fixtures rather than adding an unsolicited game to this repository.
