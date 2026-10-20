# DTED Terrain Specification

The terrain property of `tbn/schemas/world.schema.json` defines a configurable grid of elevation posts. It also describes `map_data.terrain`. The world ground plane is X/Z and world elevation is Y, separate from the actor's Z-up body frame.

## Layout and resolution

`origin` gives the first post's world X/Z position in meters. `spacing.x` is the configurable distance between columns; `spacing.z` is the distance between rows, both in meters. Use the values sent by the server.

The flat array is row-major: store the entire first row, then the second row, and so on. `index = row * columns + column`. Columns advance in +X; rows advance in +Z.

Sampling excludes the far boundary:
- `columns = Math.ceil(width / spacing.x)`
- `rows = Math.ceil(depth / spacing.z)`
- `depthMap.length = rows * columns`

For a 1000 m extent at 0.25 m spacing, this is **4000 × 4000 posts**, or **16,000,000 samples**. With origin (-500, -500), the last post is at (499.75, 499.75). A grid including both boundaries would need 4001 posts per axis instead. For `boundary:"wrap"`, the synthetic far edge repeats the first posts, making neighboring tiles join. Missing/`extend` retains last-post extension. See [world-wrapping.md](world-wrapping.md).

Validate these arithmetic relationships separately; draft-07 JSON Schema cannot multiply fields or derive array lengths from other properties. For terrain covering the full world, width and depth must match world size.x and size.z.

## Elevation encoding

`depthMap` entries are integers in **0.1 m units**. The required `elevationScale` is **0.1** meters per unit: 123 means 12.3 m, and -5 means -0.5 m. An optional integer `noDataValue` marks missing samples and must be handled before conversion or interpolation. Missing data must not be treated as a real height.

```javascript
const x = terrain.origin.x + column * terrain.spacing.x;
const z = terrain.origin.z + row * terrain.spacing.z;
const sample = terrain.depthMap[row * terrain.columns + column];
if (sample === terrain.noDataValue) throw new Error('Missing terrain elevation');
const y = sample * terrain.elevationScale;
```

## Mesh topology

The transmitted grid remains half-open. For collision/rendering, construct (rows+1) × (columns+1) vertices: append a boundary column at `origin.x + width` and a boundary row at `origin.z + depth`, copying the first row/column for `boundary:"wrap"`, or the last available heights otherwise. Interior vertex coordinates are `origin + index * spacing`; clamp boundary positions to the exact width/depth. Each of rows × columns cells has corners a=(col,row), b=(col+1,row), c=(col,row+1), d=(col+1,row+1). Use upward triangles **(a,c,b)** and **(b,c,d)**, splitting along the b-to-c diagonal. Omit a triangle if any of its posts is noData; this leaves a physical/rendered hole. The server allocates bounded collider chunks, but chunking must not change the diagonal or heights.

Bilinear interpolation generally does not lie on these triangles. For physical placement previews use the triangular interpolation below. Snapshot actor Y/attitude is always authoritative. You may use lower-detail distant rendering, but keep the collision-resolution mesh near actors. Terrain is generated once per new session and remains fixed unless an admin explicitly flattens it or selects another preset; target resets do not deform it.

## Triangular height sampling

The result is world Y in meters, or NaN for an unusable triangle. Wrapped boundary cells join the final posts to the first posts of the next tile. Legacy boundary cells duplicate final heights. Divide interpolation fractions by the actual final cell length when width/depth is not divisible by spacing.

```javascript
function sampleTerrainHeight(x, z, t) {
    const periodic = t.boundary === 'wrap';
    const wrap = (v,o,L) => o + ((v-o)%L+L)%L;
    x = periodic ? wrap(x,t.origin.x,t.width) : Math.max(t.origin.x,Math.min(x,t.origin.x+t.width));
    z = periodic ? wrap(z,t.origin.z,t.depth) : Math.max(t.origin.z,Math.min(z,t.origin.z+t.depth));
    const c = Math.min(t.columns-1,Math.floor((x-t.origin.x)/t.spacing.x));
    const r = Math.min(t.rows-1,Math.floor((z-t.origin.z)/t.spacing.z));
    const at = (col,row) => {
        const i = periodic ? col%t.columns : Math.min(col,t.columns-1);
        const j = periodic ? row%t.rows : Math.min(row,t.rows-1);
        const v = t.depthMap[j*t.columns+i];
        return v === t.noDataValue ? NaN : v*t.elevationScale;
    };
    const tx = (x-t.origin.x-c*t.spacing.x)/Math.min(t.spacing.x,t.width-c*t.spacing.x);
    const tz = (z-t.origin.z-r*t.spacing.z)/Math.min(t.spacing.z,t.depth-r*t.spacing.z);
    const a=at(c,r),b=at(c+1,r),cc=at(c,r+1),d=at(c+1,r+1);
    return tx+tz<=1 ? a*(1-tx-tz)+b*tx+cc*tz : b*(1-tz)+cc*(1-tx)+d*(tx+tz-1);
}
```

## Admin terrain flattening

The dashboard **Flatten terrain** button sends admin-only `admin_flatten_terrain` for the selected session. It replaces all elevations with world Y=0 (including former no-data holes), rebuilds Rapier terrain colliders, settles actor roots onto the plane, preserves X/Z and heading, clears motion and held controls, and moves practice targets to Y=2. Actor registrations, input sequence counters and connections remain intact. New input frames resume control normally. The server publishes a new version of `map_data` and authoritative state, then `terrain_flattened` with `{sessionId,elevation:0,version}`. Other sessions are unchanged. Clients must rebuild terrain from replacement map data and discard interpolation across the actor repositioning; do not reset input sequence counters. Target resets alone still leave terrain unchanged.

## Standard terrain presets

Valley, plateau, mountain range, flat, hills in four corners and city blocks can be selected independently for each session, at creation or through the admin dashboard. Preset changes use the same versioned terrain/collider replacement path as flattening; clients must handle `terrain_changed` as well as `terrain_flattened`. See [the terrain preset guide](terrain-presets.md) for IDs, geometry, configuration and client behavior.
