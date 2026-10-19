/**
 * Represent complete acceleration commands and merge partial action patches.
 * Inputs: Schema-validated linear/angular vectors and the previous complete command.
 * Outputs: New complete command objects; omitted components retain their values.
 * Side effects: None; validation/rejection occurs before these helpers are called.
 * Coupling: vector converts internal values; ActorManager performs the schema boundary check.
 */
const { vector } = require('./vector');
/** Create complete internal linear/angular vectors from an already validated action. */
function normalizeAction(action) { return { linear: vector(action?.linear), angular: vector(action?.angular) }; }
/** Merge a partial command into previous vectors; omitted axes retain their values. */
function mergeAction(previous, patch) {
    const current = normalizeAction(previous);
    return { linear: { ...current.linear, ...patch.linear }, angular: { ...current.angular, ...patch.angular } };
}
module.exports = { normalizeAction, mergeAction };
