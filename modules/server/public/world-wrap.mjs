/**
 * Provide periodic display coordinates and DTED boundary addressing.
 * Inputs: Received terrain contract, world coordinates and view reference positions.
 * Outputs: Wrapped deltas, nearest repeated images and tile offsets; no side effects.
 * Coupling: FlightPoses, terrain rendering, actors, effects and aiming share this convention.
 */
/** Shortest signed displacement; exact half-width ties choose the negative direction. */
export function wrapDelta(delta, length) { return ((delta + length / 2) % length + length) % length - length / 2; }
/** Copy a point into the periodic image nearest the reference; altitude remains unchanged. */
export function nearestImage(point, reference, grid) {
    const result = point.clone();
    if (grid?.boundary === 'wrap') { result.x = reference.x + wrapDelta(point.x - reference.x, grid.width); result.z = reference.z + wrapDelta(point.z - reference.z, grid.depth); }
    return result;
}
/** Return the nine visible neighboring tile translations, or one legacy bounded tile. */
export function tileOffsets(reference, grid) {
    if (grid?.boundary !== 'wrap') return [{ x: 0, z: 0 }];
    const x = Math.floor((reference.x - grid.origin.x) / grid.width), z = Math.floor((reference.z - grid.origin.z) / grid.depth);
    return [-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dz => ({ x: (x + dx) * grid.width, z: (z + dz) * grid.depth })));
}
/** Address the synthetic boundary row/column using first posts for wrap, last posts otherwise. */
export function boundarySample(g, column, row) {
    const c = g.boundary === 'wrap' ? column % g.columns : Math.min(column, g.columns - 1);
    const r = g.boundary === 'wrap' ? row % g.rows : Math.min(row, g.rows - 1);
    return g.depthMap[r * g.columns + c];
}
