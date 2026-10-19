/**
 * Recursively freeze session geometry and configuration.
 * Inputs: an object graph.
 * Outputs: the same graph, frozen in place.
 * Side effects: prevents subsequent writes to every reachable plain object/array.
 * Coupling: used by solid bodies, terrain and session data; no network dependencies.
 */

/** Freeze all reachable children, including cycles and children of shallow-frozen objects; returns the input. */
function deepFreeze(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    return Object.freeze(value);
}
module.exports = { deepFreeze };
