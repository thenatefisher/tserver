/**
 * Preserve the historical GameModel import interface for the separated physics engine.
 * Inputs: No runtime input at import; constructors accept physics model state/options.
 * Outputs: Aliases for PhysicsModel and cloneState.
 * Side effects: None on import; model instance behavior is owned by physics/model.
 * Coupling: Compatibility adapter only; new sessions import the physics package directly.
 */
const { PhysicsModel, cloneState } = require('./physics/model');
module.exports = { GameModel: PhysicsModel, cloneState };
