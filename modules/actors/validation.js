const { validate } = require('../contracts');
function validateMeshMetadata(metadata) {
    validate('mesh', { glb: '', metadata });
    return structuredClone(metadata);
}
module.exports = { validateMeshMetadata };
