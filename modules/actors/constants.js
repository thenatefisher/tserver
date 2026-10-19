/**
 * Expose server actor geometry limits and initial health policy.
 * Inputs: Shared schema-derived visual limits and framework binary invariants.
 * Outputs: Frozen geometry-limit objects and the initial health constant.
 * Side effects: None; all exported limits are read-only.
 * Coupling: contracts supplies the interface limits; actor registration consumes them.
 */
const { invariants, maxVisualSize } = require('../contracts');
const HITBOX_SIZE = Object.freeze({ ...invariants.geometryLimits.hitbox });
const MAX_VISUAL_SIZE = Object.freeze(maxVisualSize);
// Gameplay policy, not client-selectable attributes. Only maxSpeed is selectable.
const DEFAULT_HEALTH = 100;
module.exports = { HITBOX_SIZE, MAX_VISUAL_SIZE, DEFAULT_HEALTH };
