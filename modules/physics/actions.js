const { vector } = require('./vector');
function normalizeAction(action) { return { linear: vector(action?.linear), angular: vector(action?.angular) }; }
function mergeAction(previous, patch) {
    const current = normalizeAction(previous);
    return { linear: { ...current.linear, ...patch.linear }, angular: { ...current.angular, ...patch.angular } };
}
module.exports = { normalizeAction, mergeAction };
