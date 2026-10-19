# TBN SDK Reference

## Script Inclusions (`index.html`)
```html
<script src="/socket.io/socket.io.js"></script>
<script src="/tbn-sdk.js"></script>
```

## API Methods

### 1. Connection
```javascript
const game = await TbnSDK.connect({ localNodeUrl: 'http://localhost:3000' });
console.log('Player ID:', game.myPlayerId);
```

### 2. Map Topology
```javascript
game.onMapData((map) => {
    // map.bounds: { minX, maxX, minZ, maxZ }
    // map.terrain: { type: "dted", columns, rows, origin, spacing, depthMap }
    // map.walls, map.ramps, map.targets
});
```

### 3. Register Actor
Always send actor registration on each server connection, including reconnects, before joining a session. Follow [`tbn/schemas/actor.schema.json`](tbn/schemas/actor.schema.json) and its referenced [`tbn/schemas/mesh.schema.json`](tbn/schemas/mesh.schema.json). The reusable `ClientNode` accepts the prepared package as `options.actorRegistration`; it also retains browser `register_actor` packages received before connection and resends the latest package after reconnecting. Validate JSON against both schemas and validate binary GLB limits at build time.

Prepare the actor package with the agent at build time, before running the game or connecting. After player registration with the server, submit it before joining a game session. `base64Glb` must encode a version 2 GLB of at most 16 MiB decoded bytes and 5,000 triangles. Include weapon projectile origins in `meshMetadata.projectileOrigins` using body coordinates (+X forward, +Y left, +Z up). See `tbn/schemas/actor.schema.json`.

```javascript
game.actions.registerActor({
    name: "PlayerVehicle",
    clientType: "custom-client",
    physicsProfile: { maxSpeed: 25 },
    mesh: { glb: base64Glb, metadata: meshMetadata }
});
```

### 4. Actor Tracking & State Updates (~15Hz)
```javascript
game.actors.onSpawn(actor => spawnMesh(actor));
game.actors.onDespawn(actorId => removeMesh(actorId));

game.onStateUpdate((state) => {
    // state.actors: [{ id, name, health, position, velocity, orientation: {x,y,z,order:'XYZ'} }]
    // state.projectiles: [{ id, position, velocity }]
    // state.hitEvents: [{ id, targetId, sourceId, damage, remainingHealth, hitLocation }]
});
```

### 5. Combat Events
```javascript
game.events.onPlayerHit((evt) => {
    // evt: { targetId, sourceId, damage, remainingHealth, hitLocation }
});
```

### 6. Send Acceleration Inputs
Only the signals in `tbn/schemas/actions.schema.json` are supported. Vectors and components are optional; omitted parameters retain their previous value. Send explicit zeros to stop.
`linear` is linear acceleration in g (1 g = 9.81 m/s²); `angular` is angular acceleration in rad/s² about the body axes through the center of mass. Linear limits are X [-3, 3] g, Y [-1, 1] g, Z [-5, 5] g; angular components remain [-1, 1] rad/s².
```javascript
game.actions.send({
    linear: { x: 1.0, y: 0, z: 0 },   // +X forward; all three axes supported
    angular: { x: 0, y: 0, z: -0.5 } // Yaw steering
});
```
