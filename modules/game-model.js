// Compatibility entry point; sessions instantiate their own PhysicsModel.
const { PhysicsModel, cloneState } = require('./physics/model');
module.exports = { GameModel: PhysicsModel, cloneState };
