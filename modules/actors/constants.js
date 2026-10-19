const { invariants, maxVisualSize } = require('../contracts');
const HITBOX_SIZE = Object.freeze({ ...invariants.geometryLimits.hitbox });
const MAX_VISUAL_SIZE = Object.freeze(maxVisualSize);
// Gameplay policy, not client-selectable attributes. Only maxSpeed is selectable.
const DEFAULT_HEALTH = 100;
module.exports = { HITBOX_SIZE, MAX_VISUAL_SIZE, DEFAULT_HEALTH };
