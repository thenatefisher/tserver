/**
 * Expose session physics and protocol frame/math helpers.
 * Inputs: Exported constructors/functions accept actor state, controls and environment.
 * Outputs: Rapier PhysicsModel, asynchronous WASM initialization and pure math helpers.
 * Side effects: Import loads library code; initializePhysics/PhysicsModel allocate WASM explicitly.
 * Coupling: Sessions own model lifetimes; the root server only orchestrates startup.
 */
module.exports = { ...require('./model'), ...require('./runtime'), ...require('./actions'), ...require('./rotation'), ...require('./vector') };
