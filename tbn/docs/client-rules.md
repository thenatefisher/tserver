# Client Implementation Rules

## Mandatory Constraints
1. **Root Placement**:
   - Client relay/server: `./client.js` (root).
   - Browser client UI: `./index.html` (root).
   - Build-time actor mesh: `./actor.glb` (root).
   - Build-time actor registration package: `./actor.json` (root).
   - No client files inside subfolders or `tbn/`.
2. **Read-Only `tbn/`**:
   - `tbn/` is strictly read-only framework documentation, contracts, and SDKs.
   - Never create, edit, or copy client code inside `tbn/`.
   - Never modify, use, or wrap `tbn/client-node.js`.
3. **No Alternate Entry Points**:
   - Forbidden: `app.js`, `server.js`, `frontend/index.html`, `tbn/index.html`, `src/client.js`.
4. **Execution Command**:
   - Start the game strictly with:
     ```bash
     node client.js
     ```
   - Never instruct users to run `node tbn/client-node.js`.

## Web Server Requirements (`client.js`)
- Bind to port `3000` (or next ephemeral port if occupied).
- Route `GET /` must serve `./index.html`:
  ```javascript
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.use(express.static(__dirname));
  ```
- Access via `http://localhost:3000`. Never open `index.html` via `file://`.

## Build-time actor artifacts
Before executing the client or connecting to the server, generate both `actor.glb` and `actor.json`. Use a simple stick man when the user has not described an actor; otherwise implement their description. `actor.json` must conform to `tbn/schemas/actor.schema.json` and its referenced `tbn/schemas/mesh.schema.json`, with `mesh.glb` equal to base64 of the exact `actor.glb` bytes. Validate GLB version 2, decoded size at most 16 MiB, at most 5,000 triangles, and the geometry invariants. Regenerate the JSON whenever the GLB changes. Load the prepared package at runtime and submit it on each server connection.
