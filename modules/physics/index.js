/**
 * Expose the public physics model and math entry points.
 * Inputs: No runtime inputs at import; exported functions accept actor/model data.
 * Outputs: PhysicsModel, integration, action, rotation and vector helpers.
 * Side effects: No timers or global simulation state are created on import.
 * Coupling: Re-exports the physics submodules; each session owns its own model instance.
 */
module.exports = {
    ...require('./model'), ...require('./integration'), ...require('./actions'),
    ...require('./rotation'), ...require('./vector')
};
