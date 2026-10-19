# Solid actor physics

Each game session owns a fixed heightfield solid and a physics model. Registered actors are closed GLB solids, rather than point masses clamped to a ground-height value. Network fields remain defined by `tbn/schemas`; no client-selectable mass, density, inertia or friction fields are added.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `physics/body.js` | Immutable collision mesh, visual-box COM, mass and approximate box inertia |
| `terrain/model.js` | Immutable session grid, height queries and contact normals |
| `physics/contacts.js` | Solid mesh versus heightfield support elevation |
| `physics/friction.js` | Wheel-like forward traction and lateral no-slip |
| `physics/forces.js` | Input units, gravity and body/world conversion |
| `physics/integration.js` | COM motion, airborne rotation, support and landing |
| `physics/collisions.js` | Actual mesh intersection checks and approximate pair response |
| `physics/model.js` | Session-owned state and synchronized actor substeps |

Every implementation module includes its input/output, side-effect and dependency contract at the top. Helpers describe their interfaces, and complex contact/transformation operations have local explanatory comments.

## Shape and mass

GLB validation reads transformed triangle vertices, checks the ground-aligned body cube, and verifies closed, consistently wound surfaces. Those same transformed vertices and indices form the immutable physics shape. Collision geometry is kept out of public actor snapshots and geometry-reply metadata.

Actors have equal uniform density within a session. Default density is one normalized mass unit per cubic metre; enclosed volume determines relative mass in actor-to-actor response. Center of mass is approximated by `(visualBounds.min + visualBounds.max) / 2`, as requested, rather than an expensive volume-weighted centroid. The retained diagonal inertia approximation is `mass / 12` times the sum of squared box dimensions perpendicular to each body axis. The current contact solver does not yet use that tensor for angular impulses.

## Coordinates and acceleration

Body axes are X forward, Y left, Z up. The Euler body rotation is intrinsic XYZ, followed by the world basis conversion `(x, y, z) -> (x, z, -y)`. World Y is altitude.

| Command | Units | Inclusive limits |
| --- | --- | --- |
| `linear.x` | g forward/back | −3 to 3 |
| `linear.y` | g lateral | −1 to 1 |
| `linear.z` | g vertical | −5 to 5 |
| `angular.x`, `.y`, `.z` | rad/s² about body axes | −1 to 1 |

Limits are implemented in the shared action schema and compiled by Ajv. Physics converts linear g to m/s² using standard gravity from the invariant contract. Components are independent; diagonal acceleration is not normalized. Partial messages retain omitted components, so a client must send explicit zero to clear jump thrust.

There is no jump event or impulse. On level ground, 5 g upward input produces approximately 4 g net upward acceleration after gravity. Ground contact releases when the actor has outward normal velocity or outward normal acceleration. Holding positive Z can produce sustained flight; a jump-capable client should pulse the command and clear it according to its controls. Airborne thrust still follows body orientation.

## Ground traction

A contact normal and projected body-forward axis define the ground tangent frame. The solver:

1. Removes lateral velocity and lateral commanded acceleration while supported.
2. Allows forward/reverse acceleration along the projected body X axis.
3. Applies a lower rolling deceleration, default 0.6 m/s², capped so friction cannot reverse the predicted forward velocity.
4. Holds all rotational rates at zero during support. Ground angular commands do not rotate the actor; this is not a steerable wheel model.
5. Releases those contact constraints in flight, and reapplies them on landing.

Gravity still contributes down a slope along the wheel-forward direction. The lateral constraint resists sideways downhill motion. Terrain support changes the actor's vertical placement; it does not automatically orient the actor to the slope or simulate suspension.

## Integration and contact

The COM advances using the average of previous and next constrained velocities over each small step. Angular rates integrate body angular acceleration, then Euler orientation advances from those rates. The new root is the new COM minus the rotated COM offset, preserving the chosen rotation pivot. Public root velocity includes its rotational component; private COM velocity is stored separately.

The heightfield is solid below its sampled surface. Terrain support considers mesh vertices, edge midpoints, triangle centroids and grid posts projected into triangle interiors. It chooses the highest required root elevation that clears those samples. The contact normal comes from the support location. Penetration is projected out vertically, inward motion is removed, and wheel traction is restored when landing.

Actor pairs first undergo a world-bounds broad phase, then closed-solid ray containment or triangle-edge intersection tests. Intersecting pairs receive mass-weighted separation along the shortest bounding-box axis and a zero-restitution normal impulse. Corrected actors are rechecked against terrain and world/speed limits. The pair solver uses a bounded number of iterations.

Both model and direct integration use bounded substeps based on elapsed time, actor size and speed. Model substeps keep all actors at the same simulation time before pair resolution. These measures reduce tunneling but are not an exact swept collision algorithm. Very dense piles, very thin features or large time steps can still exceed this approximate solver's accuracy.

## Terrain lifetime and ownership

New sessions generate new seeded terrain instances. Default seeds are randomized; an explicit seed produces repeatable generation. The grid is cloned and deeply frozen, and the world wrapper cannot swap its terrain reference. The physics model retains that exact immutable grid through its `TerrainModel`.

Target resets update only practice-target data. They may advance the world-wrapper resource version and resend `map_data`, but they never change terrain heights, the frozen grid identity or the physics terrain instance. Removing a session releases its model, actor shapes and grid references.

## Verification

`npm test` covers per-axis schema limits, uniform density and COM, forward traction, lateral/spin resistance, jump/flight/landing, off-center rotation, rotated-mesh support, terrain ridges under faces, solid pair contacts and immutable isolated session terrain, alongside socket and data-distribution integration checks.

## Contact sampling cost

Parallel face probe sets are deduplicated at registration and stored with the immutable body. Only terrain-facing groups are sampled at runtime. Transformed meshes are cached within each actor-pair solver iteration, and actors entirely above the terrain's global maximum skip terrain probes. Those caches reduce repeated allocation and height queries without replacing the GLB mesh with its visual box.
