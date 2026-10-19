const { identity, multiply, compose, transform, signedVolume: triangleVolume } = require('./geometry');
const { invariants } = require('../contracts');
const MAX_GLB_BYTES = invariants.geometryLimits.maxGlbBytes;
const MAX_TRIANGLES = invariants.geometryLimits.maxPolygonTriangles;
const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const TYPES = { 5121: ['readUInt8', 1], 5123: ['readUInt16LE', 2], 5125: ['readUInt32LE', 4], 5126: ['readFloatLE', 4] };
function decodeGlb(value) {
    if (typeof value !== 'string') throw new Error('mesh.glb must be a base64 string');
    const base64 = value.replace(/^data:.*?;base64,/, '');
    if (base64.length > Math.ceil(MAX_GLB_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid or oversized base64 GLB');
    return Buffer.from(base64, 'base64');
}
function parseContainer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 20 || buffer.length > MAX_GLB_BYTES) throw new Error('Invalid GLB byte length');
    if (buffer.readUInt32LE(0) !== GLB_MAGIC || !invariants.geometryLimits.supportedGlbVersions.includes(buffer.readUInt32LE(4))) throw new Error('Unsupported GLB version');
    if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('GLB length mismatch');
    let json, binary;
    for (let offset = 12; offset < buffer.length;) {
        if (offset + 8 > buffer.length) throw new Error('Truncated GLB chunk');
        const length = buffer.readUInt32LE(offset), type = buffer.readUInt32LE(offset + 4);
        if (length % 4 || offset + 8 + length > buffer.length) throw new Error('Invalid GLB chunk size');
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (offset === 12 && type !== JSON_CHUNK) throw new Error('GLB must begin with JSON');
        if (type === JSON_CHUNK) {
            if (json) throw new Error('Duplicate GLB JSON');
            try { json = JSON.parse(data.toString('utf8').trim()); } catch { throw new Error('Invalid GLB JSON'); }
        }
        if (type === BIN_CHUNK) { if (binary) throw new Error('Duplicate GLB binary'); binary = data; }
        offset += 8 + length;
    }
    if (!json || json.asset?.version !== '2.0' || !binary) throw new Error('GLB requires version 2 asset and embedded binary');
    if ((json.buffers || []).some(b => b.uri || b.byteLength > binary.length)) throw new Error('GLB buffers must be embedded and within binary bounds');
    const extensions = [...(json.extensionsUsed || []), ...(json.extensionsRequired || [])];
    if (extensions.includes('KHR_draco_mesh_compression') || extensions.includes('EXT_meshopt_compression')) throw new Error('Compressed geometry is unsupported');
    return { json, binary };
}
function accessorValues(json, binary, index, expectedType) {
    const accessor = json.accessors?.[index];
    if (!accessor || accessor.type !== expectedType || !Number.isSafeInteger(accessor.count) || accessor.count < 1) throw new Error('Invalid geometry accessor');
    const components = COMPONENTS[accessor.type], type = TYPES[accessor.componentType];
    if (!type || accessor.normalized || (expectedType === 'VEC3' && accessor.componentType !== 5126) || (expectedType === 'SCALAR' && accessor.componentType === 5126)) throw new Error('Unsupported geometry component type');
    const [read, bytes] = type;
    if (accessor.count * components * bytes > MAX_GLB_BYTES) throw new Error('Decoded accessor exceeds geometry memory budget');
    const values = new Array(accessor.count * components).fill(0);
    function readView(viewIndex, localOffset, count, width, method, elementBytes, strideOverride) {
        const view = json.bufferViews?.[viewIndex];
        if (!view || (view.buffer || 0) !== 0) throw new Error('Invalid GLB buffer view');
        const base = view.byteOffset || 0, offset = localOffset || 0, stride = strideOverride || view.byteStride || width * elementBytes;
        if (![base, offset, view.byteLength, stride].every(Number.isSafeInteger) || base < 0 || offset < 0 || stride < width * elementBytes || base + view.byteLength > binary.length || offset + (count - 1) * stride + width * elementBytes > view.byteLength) throw new Error('Geometry accessor exceeds buffer view');
        return Array.from({ length: count * width }, (_, n) => {
            const value = binary[method](base + offset + Math.floor(n / width) * stride + (n % width) * elementBytes);
            if (!Number.isFinite(value)) throw new Error('Nonfinite geometry vertex');
            return value;
        });
    }
    if (accessor.bufferView !== undefined) {
        const source = readView(accessor.bufferView, accessor.byteOffset, accessor.count, components, read, bytes);
        source.forEach((value, i) => { values[i] = value; });
    } else if (!accessor.sparse) throw new Error('Accessor has no geometry data');
    if (accessor.sparse) {
        const sparse = accessor.sparse, sparseType = TYPES[sparse.indices?.componentType];
        if (!sparseType || sparse.indices.componentType === 5126 || !Number.isSafeInteger(sparse.count) || sparse.count < 1 || sparse.count > accessor.count) throw new Error('Invalid sparse accessor');
        const indices = readView(sparse.indices.bufferView, sparse.indices.byteOffset, sparse.count, 1, sparseType[0], sparseType[1]);
        const replacements = readView(sparse.values.bufferView, sparse.values.byteOffset, sparse.count, components, read, bytes);
        for (let i = 0; i < indices.length; i++) {
            if (indices[i] >= accessor.count || (i && indices[i] <= indices[i - 1])) throw new Error('Invalid sparse index');
            for (let axis = 0; axis < components; axis++) values[indices[i] * components + axis] = replacements[i * components + axis];
        }
    }
    return values;
}
function validateGlb(input) {
    const { json, binary } = parseContainer(input);
    const scene = json.scenes?.[json.scene ?? 0];
    if (!scene || !Array.isArray(scene.nodes)) throw new Error('GLB has no default scene');
    const bounds = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    let triangles = 0, volume = 0, visits = 0;
    function visit(index, parent, ancestors) {
        if (ancestors.has(index) || ++visits > 10000) throw new Error('Invalid or excessive GLB node hierarchy');
        const node = json.nodes?.[index];
        if (!node) throw new Error('Missing GLB node');
        let local = identity();
        if (node.matrix) {
            if (node.matrix.length !== 16 || !node.matrix.every(Number.isFinite)) throw new Error('Invalid node matrix');
            if (node.matrix[3] !== 0 || node.matrix[7] !== 0 || node.matrix[11] !== 0 || node.matrix[15] !== 1) throw new Error('Node matrix must be affine');
            local = [...node.matrix];
        } else {
            const translation = node.translation || [0, 0, 0], rotation = node.rotation || [0, 0, 0, 1], scale = node.scale || [1, 1, 1];
            if (translation.length !== 3 || rotation.length !== 4 || scale.length !== 3 || ![...translation, ...rotation, ...scale].every(Number.isFinite)) throw new Error('Invalid node transform');
            if (Math.abs(Math.hypot(...rotation) - 1) > 1e-3) throw new Error('Invalid node quaternion');
            local = compose(translation, rotation, scale);
        }
        const world = multiply(parent, local);
        let signedVolume = 0;
        const edges = new Map();
        if (node.mesh !== undefined) {
            const mesh = json.meshes?.[node.mesh];
            if (!mesh) throw new Error('Missing GLB mesh');
            for (const primitive of mesh.primitives || []) {
                const mode = primitive.mode ?? 4;
                if (![4, 5, 6].includes(mode)) continue;
                if (primitive.extensions?.KHR_draco_mesh_compression) throw new Error('Compressed geometry is unsupported');
                const positions = accessorValues(json, binary, primitive.attributes?.POSITION, 'VEC3');
                const vertices = Array.from({ length: positions.length / 3 }, (_, i) => transform(positions.slice(i * 3, i * 3 + 3), world));
                const indices = primitive.indices === undefined ? vertices.map((_, i) => i) : accessorValues(json, binary, primitive.indices, 'SCALAR');
                if (indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= vertices.length)) throw new Error('Invalid triangle vertex index');
                const count = mode === 4 ? indices.length / 3 : indices.length - 2;
                if (!Number.isSafeInteger(count) || count < 1 || (triangles += count) > MAX_TRIANGLES) throw new Error('Invalid triangle count or triangle budget exceeded');
                for (let i = 0; i < count; i++) {
                    const ids = mode === 4 ? indices.slice(i * 3, i * 3 + 3) : mode === 6 ? [indices[0], indices[i + 1], indices[i + 2]] : i % 2 ? [indices[i + 1], indices[i], indices[i + 2]] : indices.slice(i, i + 3);
                    const [a, b, c] = ids.map(id => vertices[id]);
                    signedVolume += triangleVolume(a, b, c);
                    const keys = [a, b, c].map(v => [v.x, v.y, v.z].map(n => n.toFixed(6)).join(','));
                    for (let edge = 0; edge < 3; edge++) {
                        const start = keys[edge], end = keys[(edge + 1) % 3];
                        if (start === end) continue;
                        const key = start < end ? `${start}|${end}` : `${end}|${start}`;
                        const entry = edges.get(key) || { count: 0, balance: 0 };
                        entry.count++; entry.balance += start < end ? 1 : -1; edges.set(key, entry);
                    }
                    for (const vertex of [a, b, c]) for (const axis of ['x', 'y', 'z']) {
                        if (!Number.isFinite(vertex[axis])) throw new Error('Nonfinite transformed vertex');
                        bounds.min[axis] = Math.min(bounds.min[axis], vertex[axis]); bounds.max[axis] = Math.max(bounds.max[axis], vertex[axis]);
                    }
                }
            }
        }
        if ([...edges.values()].some(edge => edge.count !== 2 || edge.balance !== 0)) throw new Error('GLB volume requires a closed consistently wound mesh');
        volume += Math.abs(signedVolume);
        const next = new Set(ancestors).add(index);
        for (const child of node.children || []) visit(child, world, next);
    }
    for (const node of scene.nodes) visit(node, identity(), new Set());
    if (!triangles) throw new Error('GLB contains no renderable triangles');
    const limits = invariants.geometryLimits.actorLocalBounds;
    for (const axis of ['x', 'y', 'z']) if (bounds.min[axis] < limits.min[axis] - 1e-6 || bounds.max[axis] > limits.max[axis] + 1e-6) throw new Error('Transformed GLB exceeds actor local cube');
    if (Math.abs(bounds.min.z - invariants.coordinates.grounding.contactPlaneZ) > invariants.coordinates.grounding.maxPlaneDeviation) throw new Error('GLB must be grounded at body Z zero');
    if (volume + 1e-6 < invariants.geometryLimits.minMeshVolumeCubicMeters) throw new Error('GLB mesh volume is below the server minimum');
    return { triangles, json, bounds, volume };
}
module.exports = { MAX_GLB_BYTES, MAX_TRIANGLES, decodeGlb, validateGlb };
