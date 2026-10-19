# DTED Terrain Specification

The terrain property of `tbn/schemas/world.schema.json` defines a configurable grid of elevation posts. It also describes `map_data.terrain`. The world ground plane is X/Z and world elevation is Y, separate from the actor's Z-up body frame.

## Layout and resolution

`origin` gives the first post's world X/Z position in meters. `spacing.x` is the configurable distance between columns; `spacing.z` is the distance between rows, both in meters. Use the values sent by the server.

The flat array is row-major: store the entire first row, then the second row, and so on. `index = row * columns + column`. Columns advance in +X; rows advance in +Z.

Sampling excludes the far boundary:
- `columns = Math.ceil(width / spacing.x)`
- `rows = Math.ceil(depth / spacing.z)`
- `depthMap.length = rows * columns`

For a 1000 m extent at 0.25 m spacing, this is **4000 × 4000 posts**, or **16,000,000 samples**. With origin (-500, -500), the last post is at (499.75, 499.75). A grid including both boundaries would need 4001 posts per axis instead. Clients clamp interpolation to the last available post at the far edge.

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

Construct rows * columns vertices. Each cell between adjacent posts becomes two triangles; there are (rows - 1) * (columns - 1) cells. Rendering may use chunks or lower detail while retaining the received sampling contract.

## Bilinear height sampling

The result is in meters. This example reports missing data rather than silently inventing terrain heights.

```javascript
function sampleTerrainHeight(x, z, terrain) {
    const gx = Math.max(0, Math.min(terrain.columns - 1, (x - terrain.origin.x) / terrain.spacing.x));
    const gz = Math.max(0, Math.min(terrain.rows - 1, (z - terrain.origin.z) / terrain.spacing.z));
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const x1 = Math.min(x0 + 1, terrain.columns - 1), z1 = Math.min(z0 + 1, terrain.rows - 1);
    const tx = gx - x0, tz = gz - z0;
    const at = (c, r) => {
        const value = terrain.depthMap[r * terrain.columns + c];
        if (value === terrain.noDataValue) throw new Error('Missing terrain elevation');
        return value * terrain.elevationScale;
    };
    const s = at(x0, z0) * (1 - tx) + at(x1, z0) * tx;
    const n = at(x0, z1) * (1 - tx) + at(x1, z1) * tx;
    return s * (1 - tz) + n * tz;
}
```
