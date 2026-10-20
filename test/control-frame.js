/** Build complete schema-v2 frames for network and controller tests. */
module.exports = (overrides = {}) => ({ protocolVersion: 2, sequence: 0,
    move: { x: 0, y: 0, z: 0, ...overrides.move }, rotate: { x: 0, y: 0, z: 0, ...overrides.rotate },
    brake: overrides.brake ?? 0, jump: overrides.jump ?? false, fire: overrides.fire ?? false, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['move', 'rotate'].includes(key))) });
