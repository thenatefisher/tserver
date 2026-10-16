const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const dgram = require('dgram');
const { GameModel } = require('./tbn/game-model');
const { decodeGlb, validateGlb } = require('./tbn/glb');

const PORT = process.env.PORT || 4000;
const UDP_DISCOVERY_PORT = 4001;
const TICK_RATE = 30;
const TICK_DT = 1 / TICK_RATE;
const DEFAULT_ARMOR = 100;
const HITBOX_SIZE = Object.freeze({ x: 2, y: 1, z: 3 });
const MAX_VISUAL_SIZE = Object.freeze({ x: HITBOX_SIZE.x * 1.25, y: HITBOX_SIZE.y * 1.25, z: HITBOX_SIZE.z * 1.25 });

// Server Metrics Tracking
let serverMetrics = {
    startTime: Date.now(),
    totalFires: 0,
    totalJumps: 0
};

// Express Static Routes
app.use(express.static(__dirname));

// Serve Admin Dashboard on root or /admin
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// HTTP Health Ping endpoint for HTTP subnet probes
app.get('/ping', (req, res) => {
    res.json({ gameServer: true, port: PORT, serverName: "Tank-Battle-Host" });
});

// --- UDP Discovery Server Beacon ---
const udpBeacon = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udpBeacon.on('error', (err) => {
    console.log(`[UDP DISCOVERY] Beacon error:\n${err.stack}`);
    try { udpBeacon.close(); } catch(e) {}
});

udpBeacon.on('message', (msg, rinfo) => {
    const str = msg.toString();
    if (str.includes('TANK_DISCOVER')) {
        const response = JSON.stringify({
            type: 'TANK_SERVER_BEACON',
            port: PORT,
            serverName: 'Authoritative Tank Host'
        });
        udpBeacon.send(response, rinfo.port, rinfo.address, (err) => {
            if (!err) {
                console.log(`[UDP DISCOVERY] Responded to probe from ${rinfo.address}:${rinfo.port}`);
            }
        });
    }
});

udpBeacon.bind(UDP_DISCOVERY_PORT, () => {
    udpBeacon.setBroadcast(true);
    console.log(`[UDP DISCOVERY] Beacon listening on UDP port ${UDP_DISCOVERY_PORT}`);
});

// --- Central Authoritative Map Data ---
const TERRAIN_WIDTH = 200;
const TERRAIN_DEPTH = 200;
const DTED_COLUMNS = 61;
const DTED_ROWS = 61;

function terrainElevationFormula(x, z) {
    return Math.sin(x / 12) * Math.cos(z / 12) * 2.0
        + Math.sin(x / 30) * 3.5
        + Math.cos(z / 25) * 2.5;
}

function createDtedTerrain() {
    const origin = { x: -TERRAIN_WIDTH / 2, z: -TERRAIN_DEPTH / 2 };
    const spacing = {
        x: TERRAIN_WIDTH / (DTED_COLUMNS - 1),
        z: TERRAIN_DEPTH / (DTED_ROWS - 1)
    };
    const depthMap = new Array(DTED_ROWS * DTED_COLUMNS);

    // DTED posts are serialized row-major: west-to-east columns, then
    // south-to-north rows. Values are terrain elevations in metres.
    for (let row = 0; row < DTED_ROWS; row++) {
        const z = origin.z + row * spacing.z;
        for (let column = 0; column < DTED_COLUMNS; column++) {
            const x = origin.x + column * spacing.x;
            depthMap[row * DTED_COLUMNS + column] =
                Math.round(terrainElevationFormula(x, z) * 100) / 100;
        }
    }

    return {
        type: "dted",
        width: TERRAIN_WIDTH,
        depth: TERRAIN_DEPTH,
        columns: DTED_COLUMNS,
        rows: DTED_ROWS,
        origin,
        spacing,
        verticalUnits: "meters",
        noDataValue: -32767,
        depthMap
    };
}

const DTED_TERRAIN = createDtedTerrain();

function sampleTerrainHeight(x, z) {
    const terrain = DTED_TERRAIN;
    const gridX = Math.max(0, Math.min(terrain.columns - 1, (x - terrain.origin.x) / terrain.spacing.x));
    const gridZ = Math.max(0, Math.min(terrain.rows - 1, (z - terrain.origin.z) / terrain.spacing.z));
    const x0 = Math.floor(gridX);
    const z0 = Math.floor(gridZ);
    const x1 = Math.min(x0 + 1, terrain.columns - 1);
    const z1 = Math.min(z0 + 1, terrain.rows - 1);
    const tx = gridX - x0;
    const tz = gridZ - z0;
    const at = (column, row) => terrain.depthMap[row * terrain.columns + column];
    const south = at(x0, z0) * (1 - tx) + at(x1, z0) * tx;
    const north = at(x0, z1) * (1 - tx) + at(x1, z1) * tx;
    return south * (1 - tz) + north * tz;
}

function generateTargets() {
    return Array.from({ length: 15 }, (_, i) => ({
        id: "target_" + i,
        x: Math.round((Math.random() * 80 - 40) * 10) / 10,
        z: Math.round((Math.random() * 80 + 10) * 10) / 10,
        size: 2
    })).map(target => ({ ...target, y: Math.round((sampleTerrainHeight(target.x, target.z) + 2) * 100) / 100 }));
}

function respawnTarget(target) {
    target.x = Math.round((Math.random() * 80 - 40) * 10) / 10;
    target.z = Math.round((Math.random() * 80 + 10) * 10) / 10;
    target.y = Math.round((sampleTerrainHeight(target.x, target.z) + 2) * 100) / 100;
}

const MAP_DATA = {
    bounds: { minX: -97, maxX: 97, minZ: -97, maxZ: 97 },
    terrain: DTED_TERRAIN,
    walls: [
        { name: "wallN", w: 200, h: 1.5, d: 2, x: 0, y: 0.75, z: 100 },
        { name: "wallS", w: 200, h: 1.5, d: 2, x: 0, y: 0.75, z: -100 },
        { name: "wallE", w: 2, h: 1.5, d: 200, x: 100, y: 0.75, z: 0 },
        { name: "wallW", w: 2, h: 1.5, d: 200, x: -100, y: 0.75, z: 0 }
    ],
    ramps: [
        { name: "ramp1", w: 20, h: 1, d: 30, x: 0, y: 5, z: 30, rotX: -Math.PI / 8, rotZ: 0, color: "#808066" },
        { name: "ramp2", w: 20, h: 1, d: 30, x: 25, y: 4, z: 0, rotX: 0, rotZ: Math.PI / 8, color: "#808066" },
        { name: "ramp3", w: 15, h: 6, d: 15, x: -30, y: 8, z: 30, rotX: 0, rotZ: 0, color: "#808066" }
    ],
    targets: generateTargets()
};

const DEFAULT_PHYSICS = {
    acceleration: 20,
    angularAcceleration: 4,
    maxSpeed: 25,
    maxAngularRate: 5,
    gravity: 9.81,
    groundFriction: 6,
    angularFriction: 1.5,
    armor: DEFAULT_ARMOR,
    coolingRate: 15
};

let players = {};
let userManifest = {};
const gameModel = new GameModel(undefined, undefined, {
    groundHeight: position => sampleTerrainHeight(position.x, position.z),
    gravity: 9.81,
    groundFriction: 16,
    angularFriction: 5
});

function finiteVector(value) {
    return value && ['x', 'y', 'z'].every(axis => Number.isFinite(Number(value[axis])))
        ? { x: Number(value.x), y: Number(value.y), z: Number(value.z) }
        : null;
}

function validateMeshMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') throw new Error(`mesh.metadata is required; received=${JSON.stringify(metadata)}`);
    const visualSize = finiteVector(metadata.visualSize);
    if (!visualSize || Object.keys(visualSize).some(axis => visualSize[axis] <= 0 || visualSize[axis] > MAX_VISUAL_SIZE[axis])) {
        throw new Error(`visualSize must be positive and no larger than ${JSON.stringify(MAX_VISUAL_SIZE)} metres; received=${JSON.stringify(metadata.visualSize)}`);
    }
    const grounding = metadata.grounding;
    if (!grounding || Number(grounding.contactPlaneY) !== 0 || !Number.isFinite(Number(grounding.clearance)) || Number(grounding.clearance) < 0 || Number(grounding.clearance) > 0.1) {
        throw new Error(`metadata.grounding must define contactPlaneY=0 and clearance between 0 and 0.1 metres; received=${JSON.stringify(grounding)}`);
    }
    if (!Array.isArray(grounding.supportPoints) || grounding.supportPoints.length < 3) {
        throw new Error(`metadata.grounding.supportPoints must contain at least three points; received=${JSON.stringify(grounding.supportPoints)}`);
    }
    const supportPoints = grounding.supportPoints.map(point => {
        const x = Number(point && point.x);
        const z = Number(point && point.z);
        if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > HITBOX_SIZE.x / 2 || Math.abs(z) > HITBOX_SIZE.z / 2) {
            throw new Error(`grounding support point must be inside fixed actor hitbox ${JSON.stringify(HITBOX_SIZE)}; received=${JSON.stringify(point)}`);
        }
        return { x, z };
    });
    if (!Array.isArray(metadata.projectileOrigins)) throw new Error(`metadata.projectileOrigins must be an array; received=${JSON.stringify(metadata.projectileOrigins)}`);
    const originIds = new Set();
    const projectileOrigins = metadata.projectileOrigins.map(origin => {
        if (!origin || typeof origin.id !== 'string' || !origin.id || origin.id.length > 32 || originIds.has(origin.id)) {
            throw new Error(`projectile origin ids must be unique non-empty strings; received=${JSON.stringify(origin && origin.id)}, existingIds=${JSON.stringify([...originIds])}`);
        }
        originIds.add(origin.id);
        const position = finiteVector(origin.position);
        if (!position || Object.keys(position).some(axis => Math.abs(position[axis]) > MAX_VISUAL_SIZE[axis] / 2)) {
            throw new Error(`projectile origin position must be inside allowed visual bounds ${JSON.stringify(MAX_VISUAL_SIZE)}; received=${JSON.stringify(origin && origin.position)}, allowedHalfExtents=${JSON.stringify({ x: MAX_VISUAL_SIZE.x / 2, y: MAX_VISUAL_SIZE.y / 2, z: MAX_VISUAL_SIZE.z / 2 })}`);
        }
        const direction = origin.direction === undefined ? undefined : finiteVector(origin.direction);
        if (origin.direction !== undefined && !direction) throw new Error(`projectile origin direction must be a finite vector; received=${JSON.stringify(origin.direction)}`);
        return { id: origin.id, position, ...(direction ? { direction } : {}) };
    });
    return { visualSize, projectileOrigins, grounding: { contactPlaneY: 0, clearance: Number(grounding.clearance), supportPoints } };
}

function manifestEntry(player) {
    if (!player.meshGlb) return null;
    return {
        id: player.id,
        name: player.name,
        clientType: player.clientType,
        triangles: player.meshTriangles,
        hitbox: { ...HITBOX_SIZE },
        metadata: player.meshMetadata
    };
}

function currentManifest() {
    return Object.fromEntries(Object.entries(userManifest).map(([id, entry]) => [id, entry]));
}

io.on('connection', (nodeSocket) => {
    console.log('[GAME SERVER] Connection established:', nodeSocket.id);

    nodeSocket.emit('init', nodeSocket.id);
    nodeSocket.emit('map_data', MAP_DATA);

    nodeSocket.emit('mesh_manifest', currentManifest());

    const player = players[nodeSocket.id] = {
        id: nodeSocket.id,
        name: "NodeActor_" + nodeSocket.id.substr(0, 4),
        clientType: "standard-node",
        position: { x: (Math.random() - 0.5) * 40, y: 0, z: (Math.random() - 0.5) * 40 },
        velocity: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0 },
        rotationalRates: { x: 0, y: 0, z: 0 },
        health: DEFAULT_ARMOR,
        maxHealth: DEFAULT_ARMOR,
        meshGlb: null,
        meshMetadata: null,
        meshTriangles: 0,
        physicsProfile: { ...DEFAULT_PHYSICS },
        action: {}
    };
    player.position.y = sampleTerrainHeight(player.position.x, player.position.z);
    gameModel.addActor(player);

    nodeSocket.on('register_actor', (data) => {
        console.log(`[GAME SERVER] Registration request received from client ${nodeSocket.id}`);
        if (!players[nodeSocket.id] || !data) {
            console.log(`[GAME SERVER] Registration failed for client ${nodeSocket.id}: missing client state or registration data`);
            return;
        }

        let p = players[nodeSocket.id];
        if (data.name) p.name = String(data.name).substr(0, 20);
        if (data.clientType) p.clientType = String(data.clientType);
        if (!data.mesh || data.mesh.glb === undefined) {
            console.log(`[GAME SERVER] Registration failed for client ${nodeSocket.id}: mesh.glb and mesh.metadata are required`);
            nodeSocket.emit('registration_rejected', { reason: 'mesh.glb and mesh.metadata are required' });
            return;
        }

        let meshBuffer;
        let meshMetadata;
        let meshInfo;
        try {
            meshBuffer = decodeGlb(data.mesh.glb);
            meshInfo = validateGlb(meshBuffer);
            meshMetadata = validateMeshMetadata(data.mesh.metadata);
            if (meshInfo.bounds) {
                const actualSize = ['x', 'y', 'z'].map(axis => meshInfo.bounds.max[axis] - meshInfo.bounds.min[axis]);
                const axes = ['x', 'y', 'z'];
                if (Math.abs(meshInfo.bounds.min.y - meshMetadata.grounding.contactPlaneY) > 0.01 || actualSize.some((size, index) => size <= 0 || size > MAX_VISUAL_SIZE[axes[index]] || size > meshMetadata.visualSize[axes[index]] * 1.01)) {
                    throw new Error(`GLB POSITION bounds exceed limits: bounds=${JSON.stringify(meshInfo.bounds)}, actualSize=${JSON.stringify({ x: actualSize[0], y: actualSize[1], z: actualSize[2] })}, declaredVisualSize=${JSON.stringify(meshMetadata.visualSize)}, fixedVisualLimit=${JSON.stringify(MAX_VISUAL_SIZE)}, groundingContactPlaneY=${meshMetadata.grounding.contactPlaneY}`);
                }
            }
        } catch (error) {
            console.log(`[GAME SERVER] Registration failed for client ${nodeSocket.id}: ${error.message}`);
            nodeSocket.emit('registration_rejected', { reason: error.message });
            return;
        }
        p.meshGlb = meshBuffer;
        p.meshMetadata = meshMetadata;
        p.meshTriangles = meshInfo.triangles;

        if (data.physicsProfile && typeof data.physicsProfile === 'object') {
            p.physicsProfile = {
                acceleration: Math.min(100.0, Math.max(1.0, Number(data.physicsProfile.acceleration) || DEFAULT_PHYSICS.acceleration)),
                angularAcceleration: Math.min(20.0, Math.max(0.1, Number(data.physicsProfile.angularAcceleration) || DEFAULT_PHYSICS.angularAcceleration)),
                maxSpeed: Math.min(100.0, Math.max(1.0, Number(data.physicsProfile.maxSpeed) || DEFAULT_PHYSICS.maxSpeed)),
                maxAngularRate: Math.min(20.0, Math.max(0.1, Number(data.physicsProfile.maxAngularRate) || DEFAULT_PHYSICS.maxAngularRate)),
                armor: Math.min(100, Math.max(1, Number(data.physicsProfile.armor) || DEFAULT_PHYSICS.armor)),
                coolingRate: Math.min(50, Math.max(1, Number(data.physicsProfile.coolingRate) || DEFAULT_PHYSICS.coolingRate))
            };
            p.maxHealth = p.physicsProfile.armor;
            p.health = Math.min(p.health, p.maxHealth);
        }
        gameModel.addActor(p);

        console.log(`[GAME SERVER] Registration successful for client ${nodeSocket.id}: actor [${p.name}] (${p.clientType}), mesh ${p.meshGlb.length} bytes`);

        userManifest[nodeSocket.id] = manifestEntry(p);
        nodeSocket.emit('registration_accepted', userManifest[nodeSocket.id]);
        io.emit('mesh_manifest_entry', userManifest[nodeSocket.id]);
    });

    nodeSocket.on('action', (data) => {
        if (players[nodeSocket.id] && data) {
            const clamp = value => Math.max(-1, Math.min(1, Number(value) || 0));
            const action = {};
            for (const field of ['accel', 'moment']) {
                if (data[field] && typeof data[field] === 'object') {
                    action[field] = {};
                    for (const axis of ['x', 'y', 'z']) {
                        if (typeof data[field][axis] === 'number') action[field][axis] = clamp(data[field][axis]);
                    }
                }
            }
            players[nodeSocket.id].action = action;
        }
    });

    nodeSocket.on('request_mesh', (actorId) => {
        const player = players[String(actorId)];
        console.log(`[GAME SERVER] Mesh request from client ${nodeSocket.id} for actor ${String(actorId)}`);
        if (!player || !player.meshGlb) {
            console.log(`[GAME SERVER] Mesh request unavailable for actor ${String(actorId)} from client ${nodeSocket.id}`);
            return;
        }
        const meshBytes = player.meshGlb.length;
        const encodedMeshBytes = Buffer.byteLength(player.meshGlb.toString('base64'), 'utf8');
        nodeSocket.emit('mesh_geometry', {
            id: player.id,
            glb: player.meshGlb.toString('base64'),
            metadata: player.meshMetadata,
            triangles: player.meshTriangles,
            hitbox: { ...HITBOX_SIZE }
        });
        console.log(`[GAME SERVER] Mesh reply to client ${nodeSocket.id} for actor ${player.id}: ${encodedMeshBytes} bytes sent (base64; ${meshBytes} raw bytes)`);
    });

    nodeSocket.on('request_actors', () => {
        nodeSocket.emit('actors_list', currentManifest());
    });

    // --- Admin Commands ---
    nodeSocket.on('admin_kick_actor', (targetId) => {
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            console.log(`[ADMIN] Kicking node socket: ${targetId}`);
            targetSocket.disconnect(true);
        }
    });

    nodeSocket.on('admin_reset_targets', () => {
        MAP_DATA.targets = generateTargets();
        io.emit('map_data', MAP_DATA);
        console.log(`[ADMIN] Respawned practice targets.`);
    });

    nodeSocket.on('disconnect', () => {
        console.log('[GAME SERVER] Disconnected:', nodeSocket.id);
        delete players[nodeSocket.id];
        delete userManifest[nodeSocket.id];
        gameModel.removeActor(nodeSocket.id);
        io.emit('mesh_manifest_removed', nodeSocket.id);
    });
});

// Periodic Metrics Broadcast (1Hz)
setInterval(() => {
    io.emit('server_metrics', {
        uptime: (Date.now() - serverMetrics.startTime) / 1000,
        actorCount: Object.keys(players).length,
        totalFires: serverMetrics.totalFires,
        totalJumps: serverMetrics.totalJumps
    });
}, 1000);

// Authoritative Tick Loop (30 Ticks/Sec, comfortably above the 5Hz contract)
setInterval(() => {
    const actions = Object.fromEntries(Object.entries(players).map(([id, player]) => [id, player.action]));
    const nextState = gameModel.step(actions, TICK_DT);
    for (const actor of nextState.actors) {
        actor.position.x = Math.max(MAP_DATA.bounds.minX, Math.min(MAP_DATA.bounds.maxX, actor.position.x));
        actor.position.z = Math.max(MAP_DATA.bounds.minZ, Math.min(MAP_DATA.bounds.maxZ, actor.position.z));
        const player = players[actor.id];
        if (player) {
            player.position = actor.position;
            player.velocity = actor.velocity;
            player.orientation = actor.orientation;
            player.rotationalRates = actor.rotationalRates;
        }
    }
    io.emit('state', {
        actors: nextState.actors.map(actor => ({
            name: actor.name,
            id: actor.id,
            health: actor.health,
            position: actor.position,
            velocity: actor.velocity,
            orientation: actor.orientation,
            rotationalRates: actor.rotationalRates
        })),
        projectiles: nextState.projectiles
    });
}, 1000 / TICK_RATE);

http.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`[CENTRAL GAME SERVER] Running on port ${PORT}`);
    console.log(`Host Admin Web UI: http://localhost:${PORT}`);
    console.log(`====================================================`);
});
