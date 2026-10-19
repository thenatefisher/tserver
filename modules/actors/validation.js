/**
 * Validate and isolate client mesh metadata using the shared schema.
 * Inputs: A client metadata object.
 * Outputs: A structured clone of schema-valid metadata.
 * Side effects: Throws on invalid input; does not mutate the client object.
 * Coupling: contracts owns validation and local schema reference resolution.
 */
const { validate } = require('../contracts');
/** Validate metadata through the mesh schema and return an independent copy. */
function validateMeshMetadata(metadata) {
    validate('mesh', { glb: '', metadata });
    return structuredClone(metadata);
}
module.exports = { validateMeshMetadata };
