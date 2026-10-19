# Standard session terrain presets

Every session can select its own terrain independently. The schema defines preset IDs/labels in `schemas/world.schema.json` under `terrain.preset`; the server exposes this catalog as `terrain_presets`. The dashboard's **Live map → Terrain → Apply terrain** controls the selected session and previews elevations on its radar.

| ID | Name | Layout |
| --- | --- | --- |
| `valley` | Valley | Low, wide east-west corridor with elevated north/south sides |
| `plateau` | Plateau | Central level summit at 70 m with smooth surrounding slopes |
| `mountain-range` | Mountain range | Three parallel ridges, peaks and lower passes |
| `flat` | Flat | All elevation posts at Y=0 |
| `corner-hills` | Hills in four corners | Four rounded corner hills and an open central plain |
| `city-blocks` | City blocks | Regular 100 m blocks: level streets around raised 24–56 m roofs |

City blocks are heightfield terrain, not separately streamed buildings. Streets are 40 m wide between 60 m roof footprints. At the default 10 m spacing, transitions occupy a sample interval and appear sloped; the representation does not support overhangs or vertical facades. Existing terrain-only collision mode still collides with these blocks because they are terrain. There are no extra hidden building colliders. Clients render all presets through the same DTED mesh path.

Named presets default to seed 0 and are repeatable for the same seed and resolution. Mountain peak variation and city roof heights depend on the seed. Existing custom/procedural maps remain supported. Changing the preset preserves the current grid spacing; coarse grids approximate the shape less accurately. Clients must use the transmitted size, spacing, samples and topology instead of independently regenerating from a preset ID.

## Server session configuration

```js
const server = createGameServer({
  sessions: [
    { id: 'training', name: 'Training', terrainPreset: 'flat' },
    { id: 'mountains', name: 'Mountains', terrainPreset: 'mountain-range', terrainSeed: 42 },
    { id: 'city', name: 'City', terrainPreset: 'city-blocks' }
  ]
});
```

The same options work with `sessions.createSession(...)`. To select resolution explicitly, supply a generated map: `createMap({preset:'valley', seed:0, spacing:{x:5,z:5}})`. Supply either `map` or `terrainPreset`, not both. The default session retains its existing procedural terrain until a preset is selected. Session discovery summaries include `terrainPreset` (null for custom/procedural maps).

## Network and replacement lifecycle

- On selection/join, or after `request_terrain_presets`, the server sends `terrain_presets`: `{sessionId,presets:[{id,name,description}],selected}`.
- Admin sends `admin_set_terrain_preset` with a preset ID string. Invalid IDs and non-admin requests produce `request_rejected` without changing the world.
- The server builds new frozen terrain, replaces Rapier colliders with internal-edge correction, safely places actors above the new surface, preserves X/Z and heading, clears motion/held controls, and adjusts existing target elevations. Removed targets stay removed. Actor registrations, input sequence counters and terrain-only collision policy remain intact.
- Updated `map_data` and authoritative state are followed by `terrain_changed`: `{sessionId,preset,version}`. Clients rebuild terrain, dispose old meshes, update target rendering and discard old pose interpolation history. Do not reset input sequence numbers.
- The **Flatten terrain** button selects the `flat` preset while retaining its existing `terrain_flattened` notice. Handle both terrain-change notices. Other sessions remain unchanged.

`map_data.terrain.preset` and optional `seed` are metadata; `depthMap` is authoritative. Maps remain fixed during ordinary gameplay. Admin operations explicitly replace them and increment the existing world resource version, requiring fresh delivery receipts. The bundled relay forwards/cache-updates the catalog and forwards replacement notices.
