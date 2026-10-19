# Actor Geometry & GLB Specifications

## Build-time preparation and submission
The build must write `./actor.glb` and `./actor.json` in the recipient's project root before execution or connection. If the user has not described an actor, generate a simple stick man; otherwise follow their description. `actor.json` contains the complete registration package, with `mesh.glb` equal to base64 of the exact `actor.glb` bytes. Validate both artifacts and keep them synchronized. Runtime code loads and submits the prepared package rather than generating it after connection.

Every client must submit its actor package on each server connection, including reconnects. Use [`tbn/schemas/actor.schema.json`](tbn/schemas/actor.schema.json); its `mesh` reference resolves to [`tbn/schemas/mesh.schema.json`](tbn/schemas/mesh.schema.json). The actor name is limited to 30 characters, `physicsProfile.maxSpeed` is required in [1, 100] and `physicsProfile.controller` must select ground, hover, aircraft, mecha, or boat, and weapon hardpoint IDs are limited to 8 characters. Mesh metadata requires `visualSize` and `projectileOrigins`; grounding metadata is optional in the mesh schema, while supplied geometry must still obey the grounding invariants.

Before executing the game or connecting to the server, the user's agent generates the actor attributes and prepares the actor JSON registration package: `name`, attributes in `physicsProfile`, and the 3D representation in `mesh.glb`, with weapon hardpoints in `mesh.metadata.projectileOrigins`.

At runtime, register the player with the server, then submit the prepared actor characteristics using `register_actor`, before joining a game session. The payload schema is `tbn/schemas/actor.schema.json`; matching invariants and types are in `invariants.json` and `tbn.d.ts`.

## Limits
- **Minimum mesh volume**: 1 m³, enforced by the server from the submitted GLB. This is not a client-selectable field or a declared metadata value. The server defines the geometry volume calculation; do not substitute a bounding-box calculation for that rule.
- **Hitbox authority**: The server always uses a fixed 2 m cube centered at the actor origin, X/Y/Z in [-1, 1]. Clients do not choose or submit hitbox dimensions.
- **Decoded GLB size**: `MAX_GLB_BYTES = 16 * 1024 * 1024` = `16,777,216` bytes (16 MiB). This limit applies to the binary before base64 encoding.
- **GLB version**: Only version **2** is supported.
- **Hitbox**: Fixed `2m (X) x 2m (Y) x 2m (Z)`.
- **Visual Size**: Max `{ x: 3, y: 3, z: 3 }` in a 1 km cube world.
- **Triangle Budget**: `<= 5,000` triangles.
- **Encoding**: Uncompressed binary glTF (`.glb`) base64 string.

Send the base64 string directly in `mesh.glb` inside the actor JSON registration package. Validate the decoded byte count, GLB header version, and actual triangle count; a JSON schema alone cannot verify binary geometry.

## Coordinate Frame
- Right-handed body frame: `+X` = forward, `+Y` = left, `+Z` = up.
- Rotations: `yaw` = Z-axis, `pitch` = Y-axis, `roll` = X-axis.
- Client rotation code always uses Euler angles in radians, explicitly in `XYZ` order. Convert other representations at server/library boundaries.

## Grounding (`metadata.grounding`)
- Lowest vertices of the GLB must align to `Z = 0` (±0.01m).
- `contactPlaneZ`: Strictly `0`.
- `clearance`: `0.0` to `0.1` metres.
- `supportPoints`: Array of at least 3 points inside hitbox (`|x| <= 1.0`, `|y| <= 1.0`).

## Projectile Origins (`metadata.projectileOrigins`)
- Array of hardpoint objects: `{ id: string, position: {x, y, z}, direction?: {x, y, z} }`.
- Include every weapon's projectile origin in body-frame coordinates: **+X forward, +Y left, +Z up**. Use an empty array for an unarmed actor.
- `position` is in meters relative to the GLB root, anywhere in the allowed 3 m cube: X/Y in [-1.5, 1.5], Z in [0, 3], inclusive. It need not be inside the actual mesh bounds.
- All GLB vertices after internal node transforms must fit this same actor-local cube. Validate actual geometry at build time; schema checks on metadata alone cannot inspect binary GLB vertices.

## Rapier collision representation

The server validates a closed solid GLB and derives a convex hull (convex actors) or bounded convex decomposition (concave actors). Fine cavities can be approximated. All actors share uniform density; mass uses enclosed GLB volume, COM uses the visual-box centroid, inertia uses a box approximation. Author wheels, tracks and legs visually; these do not automatically create joints, suspension or physical locomotion. The selected server controller supplies movement. The fixed hitbox remains metadata, distinct from the solid physics collider. See [physics-controls.md](physics-controls.md).
