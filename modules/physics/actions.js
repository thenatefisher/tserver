/**
 * Construct complete neutral control frames and copy accepted client controls.
 * Inputs: Schema-validated v2 frames or an optional internal frame.
 * Outputs: Independent complete frames; no partial merge or acceleration interpretation.
 * Side effects: None. Coupling: ActorManager validates/rejects sequence order before storing frames.
 */
const { vector } = require('./vector');
const { schemas } = require('../contracts');
/** Return a neutral held-state frame; sequence -1 is internal and never accepted on the wire. */
function normalizeAction(action) {
    return { protocolVersion: schemas.actions.properties.protocolVersion.const, sequence: action?.sequence ?? -1,
        move: vector(action?.move), rotate: vector(action?.rotate), brake: action?.brake ?? 0, jump: action?.jump === true, fire: action?.fire === true };
}
module.exports = { normalizeAction };
