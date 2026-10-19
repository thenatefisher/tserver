module.exports = function meshFixture({ scale = 1, translation = [0, 0, 0] } = {}) {
    const vertices = [-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0, -0.5,-0.5,1, 0.5,-0.5,1, 0.5,0.5,1, -0.5,0.5,1];
    const indices = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
    const binary = Buffer.alloc(vertices.length * 4 + indices.length * 2);
    vertices.forEach((v, i) => binary.writeFloatLE(v, i * 4));
    indices.forEach((v, i) => binary.writeUInt16LE(v, vertices.length * 4 + i * 2));
    const json = JSON.stringify({
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, scale: [scale, scale, scale], translation }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteLength: vertices.length * 4 }, { buffer: 0, byteOffset: vertices.length * 4, byteLength: indices.length * 2 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', min: [-0.5,-0.5,0], max: [0.5,0.5,1] }, { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' }]
    });
    const encoded = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
    const glb = Buffer.alloc(28 + encoded.length + binary.length);
    glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(encoded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); encoded.copy(glb, 20);
    const offset = 20 + encoded.length;
    glb.writeUInt32LE(binary.length, offset); glb.writeUInt32LE(0x004e4942, offset + 4); binary.copy(glb, offset + 8);
    return { glb: glb.toString('base64'), metadata: { visualSize: { x: scale, y: scale, z: scale }, projectileOrigins: [] } };
};
module.exports.registration = (overrides = {}) => ({ name: 'Test cube', clientType: 'test-client', physicsProfile: { maxSpeed: 25 }, mesh: module.exports(), ...overrides });
