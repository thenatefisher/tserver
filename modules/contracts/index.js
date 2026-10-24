/**
 * Load the definitive TBN interface contract and compile JSON Schema validators.
 * Inputs: Framework schema JSON files and non-schema physical/network invariants.
 * Outputs: Validation functions and schema-derived interface constants.
 * Side effects: Loads/caches files and compiles Ajv validators once at module initialization.
 * Coupling: All protocol boundaries depend on this adapter; behavior still lives in implementation modules.
 */
const Ajv = require('ajv');
const path = require('node:path');
const schemaRoot = path.resolve(__dirname, '../../tbn/schemas');
const schemas = Object.fromEntries(['actor', 'mesh', 'actions', 'world', 'state', 'system-messages'].map(name => [name, require(path.join(schemaRoot, `${name}.schema.json`))]));
// Schemas own all structural/field limits. Invariants provide binary limits,
// coordinate conventions and cadence that JSON Schema cannot express.
const invariants = require('../../tbn/docs/invariants.json');
const ajv = new Ajv({ allErrors: true, strict: false, strictNumbers: true });
ajv.addSchema(schemas.mesh, 'mesh.schema.json');
const validators = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
/** Validate a named protocol payload in place; return it or throw without changing it. */
function validate(name, value) {
    const validator = validators[name];
    if (!validator) throw new Error(`Unknown contract: ${name}`);
    if (!validator(value)) throw new Error(`${name}: ${ajv.errorsText(validator.errors, { separator: '; ' })}`);
    if (name === 'system-messages' && new Set(value.map(message => message.id)).size !== value.length) throw new Error('system-messages: IDs must be unique');
    return value;
}
const worldSize = Object.fromEntries(Object.entries(schemas.world.properties.size.properties).map(([axis, schema]) => [axis, schema.const]));
const elevationScale = schemas.world.properties.terrain.properties.elevationScale.const;
const orientationOrder = schemas.state.definitions.orientation.properties.order.const;
const maxVisualSize = Object.fromEntries(Object.entries(schemas.mesh.properties.metadata.properties.visualSize.properties).map(([axis, schema]) => [axis, schema.maximum]));
const protocolVersion = schemas.actions.properties.protocolVersion.const;
const terrainPresets = schemas.world.properties.terrain.properties.preset.oneOf.map(({ const: id, title: name, description }) => ({ id, name, description }));
module.exports = { terrainPresets, protocolVersion, schemas, invariants, validate, worldSize, elevationScale, orientationOrder, maxVisualSize };
