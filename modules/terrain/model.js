/**
 * Represent immutable triangulated terrain and query its collision-surface heights/normals.
 * Inputs: a schema-valid DTED grid. Outputs: heights and upward contact normals.
 * Side effects: clones/freezes the grid once per session; queries do not mutate it.
 * Coupling: wraps terrain sampling; physics contacts consume this model directly.
 */
const { deepFreeze } = require('../shared/immutable');
const { triangleHeight } = require('./sampling');
const { normalize } = require('../physics/vector');

class TerrainModel {
    /** Take ownership of an isolated grid so outside callers cannot deform a session. */
    constructor(grid) {
        this.grid = deepFreeze(structuredClone(grid));
        this.maxHeight = this.grid.depthMap.reduce((maximum, height) => height === this.grid.noDataValue ? maximum : Math.max(maximum, height * this.grid.elevationScale), -Infinity);
        Object.freeze(this);
    }
    /** Return world elevation, or NaN where the source grid has no usable data. */
    heightAt(x, z) {
        return triangleHeight(this.grid, x, z);
    }
    /** Estimate the surface normal with symmetric finite differences in world X/Z. */
    surfaceAt(x, z) {
        const height = this.heightAt(x, z);
        const dx = Math.min(this.grid.spacing.x / 4, 0.1), dz = Math.min(this.grid.spacing.z / 4, 0.1);
        const slopeX = (this.heightAt(x + dx, z) - this.heightAt(x - dx, z)) / (2 * dx);
        const slopeZ = (this.heightAt(x, z + dz) - this.heightAt(x, z - dz)) / (2 * dz);
        return { height, normal: normalize({ x: Number.isFinite(slopeX) ? -slopeX : 0, y: 1, z: Number.isFinite(slopeZ) ? -slopeZ : 0 }) };
    }
}
module.exports = { TerrainModel };
