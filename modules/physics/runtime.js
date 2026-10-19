/**
 * Load the shared Rapier WASM code once, without sharing simulation worlds.
 * Inputs: initializePhysics() calls. Outputs: initialized Rapier API and readiness flag.
 * Side effects: Allocates the WASM runtime asynchronously; no timers/listeners.
 * Coupling: PhysicsModel waits for this before allocating its session-local world.
 */
const RAPIER = require('@dimforge/rapier3d-compat');
let pending, initialized = false;
/** Initialize WASM once; concurrent callers share the promise, never a physics world. */
function initializePhysics() {
    return pending ||= RAPIER.init().then(() => { initialized = true; return RAPIER; });
}
/** Report whether synchronous world construction is now safe; does not initialize anything. */
function isInitialized() { return initialized; }
module.exports = { RAPIER, initializePhysics, isInitialized };
