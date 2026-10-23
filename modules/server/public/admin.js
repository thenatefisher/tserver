/**
 * Run the browser admin dashboard, session selector, radar and GLB viewer.
 * Inputs: DOM elements, Socket.IO metrics/state/assets, local token storage and user controls.
 * Outputs: Rendered client statistics, cached meshes, scene previews and admin requests.
 * Side effects: Updates DOM/sessionStorage, maintains a socket and WebGL animation, emits control/receipt events.
 * Coupling: Served public HTML provides IDs; Socket.IO and local Three.js modules provide transport/rendering.
 */
/** Resolve a required dashboard element by ID; returns the live DOM node. */
const $ = id => document.getElementById(id);
const socket = io({ auth: { role: 'admin', sync: true, adminToken: sessionStorage.getItem('tbnAdminToken') || '' } });
let clients = [], manifest = {}, selectedId = null, map = null, state = { actors: [] };
let viewerPromise, model, scene, camera, renderer, controls, initialCamera;
let meshVersion = 0, terrainOnlyCollisions = false, terrainPresets = [];
let previewRequestId = 0, previewReady = false, activeSessionId = null;
const terrainPreview = document.createElement('canvas'); terrainPreview.width = terrainPreview.height = 256;
/** Format elapsed seconds for display without changing the metric value. */
const duration = seconds => {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
/** Prepend a timestamped activity message and bound the retained browser DOM log. */
function log(message) {
    const entry = document.createElement('div');
    entry.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
    $('activity').prepend(entry);
    while ($('activity').children.length > 80) $('activity').lastChild.remove();
}
/** Dispose displayed GPU resources, invalidate pending loads and reset viewer DOM. */
function clearMesh(message) {
    meshVersion++;
    if (model) {
        scene.remove(model);
        model.traverse(object => {
            object.geometry?.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) {
                if (!material) continue;
                for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
                material.dispose();
            }
        });
        model = null;
    }
    $('viewer-message').textContent = message;
    $('details').textContent = '';
    $('reset-view').disabled = true;
}
/** Select an actor, clear its previous preview and request its geometry over the socket. */
function showMesh(id) {
    selectedId = id;
    clearMesh('Loading actor mesh…');
    $('selected').textContent = clients.find(client => client.id === id)?.name || id;
    socket.emit('request_mesh', id);
}
/** Replace the client table DOM from current connection metrics and attach action handlers. */
function renderClients() {
    const body = $('clients');
    body.replaceChildren();
    if (!clients.length) {
        const cell = body.insertRow().insertCell();
        cell.colSpan = 7;
        cell.textContent = 'No player clients connected.';
        return;
    }
    for (const client of clients) {
        const row = body.insertRow();
        const speed = Math.hypot(client.velocity.x, client.velocity.y, client.velocity.z);
        const values = [
            `${client.name}\n${client.id}`, `${client.clientType}\n${client.transport}`,
            duration((Date.now() - client.connectedAt) / 1000), `${client.health} / ${client.maxHealth}`,
            `${speed.toFixed(1)} m/s`, client.registered ? `${client.triangles.toLocaleString()} triangles\n${(client.meshBytes / 1024).toFixed(1)} KiB` : 'Not registered'
        ];
        for (const value of values) {
            const cell = row.insertCell();
            cell.textContent = value;
            cell.style.whiteSpace = 'pre-line';
        }
        const actions = row.insertCell();
        const view = document.createElement('button');
        view.textContent = 'View';
        view.disabled = !client.registered;
        view.addEventListener('click', () => showMesh(client.id));
        const kick = document.createElement('button');
        kick.textContent = 'Kick';
        kick.className = 'danger';
        kick.addEventListener('click', () => socket.emit('admin_kick_actor', client.id));
        actions.append(view, ' ', kick);
    }
}
$('admin-auth').addEventListener('submit', event => {
    event.preventDefault();
    const token = $('admin-token').value.trim();
    sessionStorage.setItem('tbnAdminToken', token);
    socket.auth.adminToken = token;
    socket.disconnect().connect();
});
$('session-select').addEventListener('change', () => {
    socket.auth.sessionId = $('session-select').value;
    socket.emit('join_session', $('session-select').value);
});
socket.on('sessions_list', sessions => {
    $('session-select').replaceChildren(...sessions.map(session => {
        const option = document.createElement('option');
        option.value = session.id; option.textContent = session.name;
        option.selected = session.id === (socket.auth.sessionId || 'default');
        return option;
    }));
});
socket.on('session_joined', session => {
    activeSessionId = session.sessionId; clearTerrainCandidate();
    $('flatten-terrain').disabled = false; $('flatten-terrain').textContent = 'Flatten terrain';
    $('remove-targets').disabled = false; $('remove-targets').textContent = 'Remove targets';
    terrainOnlyCollisions = false; $('disable-object-collisions').disabled = false; $('disable-object-collisions').textContent = 'Disable object collisions';
    map = null; $('terrain-preset').disabled = true; $('apply-terrain').disabled = true;
    clients = []; manifest = {}; selectedId = null; state = { actors: [] };
    renderClients(); clearMesh('Choose View beside a registered mesh.');
    $('selected').textContent = `Session: ${session.name}`;
});
socket.on('session_rejected', error => { $('status').textContent = error.reason; log(error.reason); });
socket.on('data_version', version => socket.emit('data_ack', version));
socket.on('connect', () => {
    $('status').textContent = 'Connected'; $('status').style.color = '#4ade80';
    log('Dashboard connected'); socket.emit('request_sessions');
});
socket.on('disconnect', reason => {
    activeSessionId = null; clearTerrainCandidate();
    $('apply-terrain').disabled = true; $('terrain-preset').disabled = true;
    $('flatten-terrain').disabled = true; $('remove-targets').disabled = true; $('disable-object-collisions').disabled = true;
    $('status').textContent = 'Disconnected · reconnecting'; $('status').style.color = '#fbbf24';
    log(`Disconnected: ${reason}`);
    clients = []; manifest = {}; selectedId = null; state = { actors: [] };
    renderClients(); clearMesh('Disconnected from server.');
    for (const id of ['count', 'registered', 'uptime', 'rate']) $(id).textContent = '—';
});
socket.on('connect_error', error => { $('status').textContent = 'Connection failed · retrying'; log(error.message); });
socket.on('mesh_manifest', data => { manifest = data; });
socket.on('mesh_manifest_entry', entry => {
    manifest[entry.id] = entry;
    log(`Mesh registered: ${entry.name}`);
    if (selectedId === entry.id) showMesh(entry.id);
});
socket.on('mesh_manifest_removed', id => {
    delete manifest[id];
    clients = clients.filter(client => client.id !== id); renderClients();
    if (selectedId === id) { selectedId = null; clearMesh('Selected player disconnected.'); }
    log(`Player disconnected: ${id}`);
});
socket.on('server_metrics', metrics => {
    const oldIds = new Set(clients.map(client => client.id));
    clients = metrics.clients;
    for (const client of clients) if (!oldIds.has(client.id)) log(`Player connected: ${client.name}`);
    $('count').textContent = metrics.actorCount;
    $('registered').textContent = clients.filter(client => client.registered).length;
    $('uptime').textContent = duration(metrics.uptime);
    $('rate').textContent = `${metrics.tickRate} Hz`;
    renderClients();
});
socket.on('map_data', data => {
    map = data; drawTerrainRaster(map.terrain, terrainPreview);
    $('terrain-preset').value = data.terrain.preset || ''; updateTerrainDescription(); requestTerrainPreview();
});
socket.on('state', data => { state = data; });
$('reset-targets').addEventListener('click', () => { socket.emit('admin_reset_targets'); log('Practice targets reset'); });

/** Invalidate outstanding previews and clear the candidate canvas; never changes live map data. */
function clearTerrainCandidate() {
    previewRequestId++; previewReady = false;
    $('preset-preview').getContext('2d').clearRect(0, 0, 256, 256);
    $('terrain-preview-status').textContent = 'Select terrain to preview it before applying.';
    $('apply-terrain').disabled = true;
}
/** Request a read-only preview with a monotonic ID so stale replies cannot overwrite a newer selection/session. */
function requestTerrainPreview() {
    clearTerrainCandidate();
    if (!socket.connected || !activeSessionId || !$('terrain-preset').value) return;
    $('terrain-preview-status').textContent = 'Loading preview…';
    socket.emit('admin_preview_terrain', { preset: $('terrain-preset').value, requestId: previewRequestId });
}
socket.on('terrain_preview', result => {
    if (result.requestId !== previewRequestId || result.sessionId !== activeSessionId || result.preset !== $('terrain-preset').value) return;
    drawTerrainRaster(result.terrain, $('preset-preview')); previewReady = true;
    $('terrain-preview-status').textContent = `${terrainPresets.find(p => p.id === result.preset)?.name || result.preset} preview — ${result.preset === map?.terrain.preset ? 'currently active' : 'not applied'}`;
    $('apply-terrain').disabled = false;
});

/** Update the explanation for the selected server-defined terrain option; no map changes occur here. */
function updateTerrainDescription() {
    $('terrain-description').textContent = terrainPresets.find(p => p.id === $('terrain-preset').value)?.description || 'Current custom/procedural terrain';
}
socket.on('terrain_presets', catalog => {
    terrainPresets = catalog.presets;
    const custom = document.createElement('option'); custom.value = ''; custom.textContent = 'Custom / procedural'; custom.disabled = true;
    $('terrain-preset').replaceChildren(custom, ...terrainPresets.map(preset => {
        const option = document.createElement('option'); option.value = preset.id; option.textContent = preset.name; return option;
    }));
    $('terrain-preset').value = catalog.selected || ''; $('terrain-preset').disabled = false;
    $('apply-terrain').disabled = true; updateTerrainDescription();
    if (map) requestTerrainPreview();
});
$('terrain-preset').addEventListener('change', () => { updateTerrainDescription(); requestTerrainPreview(); });
$('terrain-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('terrain-preset').value || !previewReady) return;
    $('apply-terrain').disabled = true; $('terrain-preset').disabled = true;
    socket.emit('admin_set_terrain_preset', $('terrain-preset').value);
});
socket.on('terrain_changed', result => {
    state = { actors: [] }; // Avoid displaying interpolated positions across the terrain replacement.
    $('apply-terrain').disabled = !previewReady; $('terrain-preset').disabled = false;
    log(`Applied ${terrainPresets.find(p => p.id === result.preset)?.name || result.preset} terrain (world version ${result.version})`);
});

$('remove-targets').addEventListener('click', () => {
    $('remove-targets').disabled = true; $('remove-targets').textContent = 'Removing…';
    socket.emit('admin_remove_targets');
});
socket.on('targets_removed', result => {
    $('remove-targets').disabled = false; $('remove-targets').textContent = 'Remove targets';
    log(`Removed ${result.removed} targets (world version ${result.version})`);
});
$('disable-object-collisions').addEventListener('click', () => {
    $('disable-object-collisions').disabled = true; $('disable-object-collisions').textContent = 'Disabling…';
    socket.emit('admin_disable_object_collisions');
});
socket.on('collision_settings', settings => {
    terrainOnlyCollisions = settings.terrainOnlyCollisions;
    $('disable-object-collisions').disabled = terrainOnlyCollisions || !socket.connected;
    $('disable-object-collisions').textContent = terrainOnlyCollisions ? 'Object collisions disabled' : 'Disable object collisions';
    if (terrainOnlyCollisions) log('Object collisions disabled; terrain contact preserved');
});
$('flatten-terrain').addEventListener('click', () => {
    $('flatten-terrain').disabled = true; $('flatten-terrain').textContent = 'Flattening…';
    socket.emit('admin_flatten_terrain');
});
socket.on('terrain_flattened', result => {
    $('flatten-terrain').disabled = false; $('flatten-terrain').textContent = 'Flatten terrain';
    $('apply-terrain').disabled = !previewReady;
    log(`Terrain flattened to Y=${result.elevation} m; actors settled (world version ${result.version})`);
});
socket.on('request_rejected', error => {
    log(error.reason);
    if (error.event === 'admin_preview_terrain') {
        $('terrain-preview-status').textContent = `Preview failed: ${error.reason}`; previewReady = false; $('apply-terrain').disabled = true;
    }
    if (error.event === 'admin_set_terrain_preset') {
        $('terrain-preset').disabled = !socket.connected; $('apply-terrain').disabled = !socket.connected || !previewReady;
    }
    if (error.event === 'admin_disable_object_collisions') {
        $('disable-object-collisions').disabled = terrainOnlyCollisions || !socket.connected;
        $('disable-object-collisions').textContent = terrainOnlyCollisions ? 'Object collisions disabled' : 'Disable object collisions';
    }
    if (error.event === 'admin_remove_targets') {
        $('remove-targets').disabled = !socket.connected; $('remove-targets').textContent = 'Remove targets';
    }
    if (error.event === 'admin_flatten_terrain') {
        $('flatten-terrain').disabled = !socket.connected; $('flatten-terrain').textContent = 'Flatten terrain';
    }
});

/** Load local Three.js modules, create GPU/resize/animation resources and return the GLB loader. */
async function setupViewer() {
    const THREE = await import('three');
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x09101c);
    $('viewer').prepend(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x526080, 3));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(4, 6, 3); scene.add(light);
    scene.add(new THREE.GridHelper(10, 20, 0x405475, 0x25344b));
    new ResizeObserver(() => {
        const { clientWidth: w, clientHeight: h } = $('viewer');
        renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    }).observe($('viewer'));
    renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    return { THREE, loader: new GLTFLoader() };
}
socket.on('mesh_geometry', async data => {
    if (data.id !== selectedId) return;
    const version = meshVersion;
    try {
        viewerPromise ||= setupViewer().catch(error => { viewerPromise = null; throw error; });
        const { THREE, loader } = await viewerPromise;
        const bytes = Uint8Array.from(atob(data.glb), char => char.charCodeAt(0));
        const gltf = await loader.parseAsync(bytes.buffer, '');
        if (version !== meshVersion || data.id !== selectedId) {
            gltf.scene.traverse(object => {
                object.geometry?.dispose();
                for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
                    if (!material) continue;
                    for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
                    material.dispose();
                }
            });
            return;
        }
        model = gltf.scene; model.rotation.x = -Math.PI / 2; scene.add(model);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const distance = Math.max(size.x, size.y, size.z, 0.1) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.6 / Math.min(camera.aspect, 1);
        initialCamera = { center, position: center.clone().add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(distance)) };
        resetCamera();
        $('viewer-message').textContent = '';
        $('reset-view').disabled = false;
        $('details').textContent = `${data.triangles.toLocaleString()} triangles · ${(bytes.length / 1024).toFixed(1)} KiB\nSize: ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m\nHitbox: ${data.hitbox.x} × ${data.hitbox.y} × ${data.hitbox.z} m\nProjectile origins: ${data.metadata.projectileOrigins.length}`;
    } catch (error) {
        if (version === meshVersion) { clearMesh(`Unable to display mesh: ${error.message}`); log(`Mesh viewer error: ${error.message}`); }
    }
});
/** Restore saved viewer camera/target positions; changes rendering state only. */
function resetCamera() {
    if (!initialCamera) return;
    camera.position.copy(initialCamera.position); controls.target.copy(initialCamera.center); controls.update();
}
$('reset-view').addEventListener('click', resetCamera);
const ctx = $('radar').getContext('2d');
/** Cache a small elevation raster from received samples so terrain shape is visible without per-frame grid traversal. */
function drawTerrainRaster(t, canvas) {
    if (!t) return;
    const preview = canvas.getContext('2d'), image = preview.createImageData(256, 256);
    let min = Infinity, max = -Infinity;
    for (const value of t.depthMap) if (value !== t.noDataValue) { min = Math.min(min, value); max = Math.max(max, value); }
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const row = Math.min(t.rows - 1, Math.floor((255 - y) / 256 * t.rows));
        const col = Math.min(t.columns - 1, Math.floor(x / 256 * t.columns));
        const value = t.depthMap[row * t.columns + col], valid = value !== t.noDataValue;
        const h = valid ? (value - min) / Math.max(1, max - min) : 0, i = (y * 256 + x) * 4;
        image.data[i] = valid ? 20 + h * 110 : 5; image.data[i + 1] = valid ? 45 + h * 105 : 10;
        image.data[i + 2] = valid ? 42 + h * 70 : 18; image.data[i + 3] = 255;
    }
    preview.putImageData(image, 0, 0);
}
/** Draw current world actors/targets and schedule the next browser animation frame. */
function drawRadar() {
    ctx.clearRect(0, 0, 500, 500);
    if (map) ctx.drawImage(terrainPreview, 0, 0, 500, 500);
    ctx.strokeStyle = '#25344b';
    for (let i = 0; i <= 500; i += 50) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 500); ctx.moveTo(0, i); ctx.lineTo(500, i); ctx.stroke(); }
    for (const target of map?.targets || []) { ctx.fillStyle = '#fb7185'; ctx.fillRect((target.x - map.terrain.origin.x) / map.terrain.width * 500 - 3, 500 - (target.z - map.terrain.origin.z) / map.terrain.depth * 500 - 3, 6, 6); }
    for (const actor of state.actors) {
        const x = (actor.position.x - map.terrain.origin.x) / map.terrain.width * 500, y = 500 - (actor.position.z - map.terrain.origin.z) / map.terrain.depth * 500;
        ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
        ctx.font = '11px system-ui'; ctx.fillText(actor.name, x + 8, y + 4);
    }
    requestAnimationFrame(drawRadar);
}
drawRadar();
