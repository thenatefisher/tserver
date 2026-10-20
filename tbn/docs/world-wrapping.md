# Edge-to-edge world wrapping

New generated worlds use `map_data.terrain.boundary: "wrap"`. This is a flat periodic X/Z world (a torus topology), not a curved planet. Gravity is still world -Y; altitude and attitude do not rotate at an edge. Read the boundary field from the [world schema](../schemas/world.schema.json). Missing/`extend` means the legacy bounded world, not wrapping. Terrain changes preserve the session's boundary policy.

## Authoritative coordinates

For width W, depth D and terrain origin (ox,oz), actor roots and rockets are canonicalized to `[ox,ox+W)` and `[oz,oz+D)`. Crossing +X emerges at -X and +Z at -Z, including corner crossings. Preserve overshoot, velocity, rotational rates, orientation, altitude, input sequence and weapon cadence. Never bounce or zero horizontal speed at a wrapped edge.

```js
const mod = (n, L) => ((n % L) + L) % L;
const canonical = (n, o, L) => o + mod(n-o, L);
const delta = (n, L) => mod(n + L/2, L) - L/2;
// Nearest periodic image of wire position p relative to view reference r:
const nearbyX = r.x + delta(p.x-r.x, terrain.width);
const nearbyZ = r.z + delta(p.z-r.z, terrain.depth);
```

Do not use inset hitbox bounds as the wrap period. Terrain dimensions and origin define it. Y is unchanged. A wire position jump from 499 to -499 in a 1000 m world means +2 m travel, not -998 m. Resource versions and input acknowledgments are unchanged and are not lap counters. No lap counter is transmitted.

## Terrain seams

The half-open grid still contains exactly `rows*columns` posts. Construct the synthetic far-edge column using **column zero**, the far-edge row using **row zero**, and the far corner using post (0,0). Use the usual upward triangles `(a,c,b)` and `(b,c,d)`; do not duplicate the final posts for a wrapped map. Preserve holes/no-data. Repeat identical tiles separated by W/D. Do not regenerate from preset or seed.

Coordinates within each tile remain `origin + index*spacing`. The last cell can be shorter than spacing if the extent is not evenly divisible: its endpoint is exactly `origin+extent`. Sample/interpolate using that cell's actual length. Server height queries repeat modulo W/D, and terrain colliders include a periodic border halo so complete actor shapes remain supported while crossing. Terrain generation blends the final border band into the next tile's continuation; received samples remain definitive.

## Continuous client rendering

1. Unwrap each arriving actor/projectile relative to its previous displayed track using shortest periodic deltas, **before** position interpolation. Quaternion interpolation is unchanged. The assumption is that motion between received samples is less than half an extent; after long data starvation reset/rebase instead of guessing multiple laps.
2. Track the player's unwrapped pose with the chase camera. Do not interpolate canonical positions across the whole map or reset the camera at each crossing. After a real lifecycle/terrain reset, discard interpolation and snap the camera to the new pose.
3. Render the current terrain tile plus its eight neighbors, sharing geometry/materials. Translate the tile neighborhood as the player crosses. Choose fog/far range so the outer edge of this neighborhood is not visible, or add more tiles for longer view ranges. Choose each other actor/target's nearest image relative to the player; avoid drawing duplicated logical targets as independent game entities.
4. Raycast aiming against the repeated terrain meshes. A ground reticle, rocket trail, explosion, shadow and target indicator must use the same local periodic images as the aircraft and camera. Keep old smoke continuous across a crossing rather than drawing a kilometre-long segment.
5. Preserve canonical authoritative state separately for HUD/networking. No client should send rewritten world positions or perform authoritative physics wrapping itself. Any optional prediction must reconcile with wrapped authoritative snapshots.

Flight Lab implements this in `world-wrap.mjs`, `flight-poses.mjs` and `fly.js`. These server source paths are reference locations, not runtime dependencies for generated clients. Implement the recipe in the required root client artifacts.

## Collision and compatibility notes

Rapier actor images allow actors near opposite edges to contact one another. Images have matching mass/geometry/actuation and never appear as extra public actors. The paired image constraints are a game approximation: exact global momentum conservation across simultaneous periodic contact islands is not guaranteed. Terrain-only collision mode removes the images and keeps terrain support. Rockets ignore all actor geometry, including these images.

Legacy custom maps without `boundary: "wrap"` keep last-post terrain extension and existing bounds. Updated clients must honor the explicit field rather than infer topology from world size. Verify both X/Z directions, diagonal crossings, continuous camera/interpolation, terrain contact, far-edge sampling, aiming and rocket impacts at a seam.
