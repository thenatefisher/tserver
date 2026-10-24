/**
 * Run the direct player flight interface with authoritative world rendering.
 * Inputs: Keyboard/pointer controls, session selection, Socket.IO maps/GLBs/state/policy.
 * Outputs: Complete action frames and rendered terrain, actors and flight telemetry.
 * Side effects: Owns a player socket, GPU resources, DOM and animation/input timers.
 * Coupling: fly.html supplies controls; normal TBN player contracts and local Three.js assets.
 */
import * as THREE from 'three';
import { FlightEffects } from './flight-effects.mjs';
import { nearestImage, tileOffsets, boundarySample } from './world-wrap.mjs';
import { TerrainReticle } from './terrain-reticle.mjs';
import { flightInput } from './flight-input.mjs';
import { FlightPoses } from './flight-poses.mjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const $ = id => document.getElementById(id);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#88acc7'); scene.fog = new THREE.Fog('#88acc7', 300, 1000);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); $('view').append(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xd8edff, 0x36452f, 2.8)); const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(100, 200, 80); scene.add(sun);
const loader = new GLTFLoader(), actors = new Map(), requested = new Set(), keys = new Set();
const poses = new FlightPoses(100), reticle = new TerrainReticle(3), effects = new FlightEffects(scene);
const aimOffset = new THREE.Vector3();
let throttle = 0, grid, terrainTiles = [], cameraSnap = true;
let socket, generation = 0, sequence = 0, registered = false, terrain, targets, latest = { actors: [] }, policy, previous = performance.now();
/** Dispose one owned object tree, including material textures, without touching shared assets. */
function dispose(object) {
    object.traverse(child => { child.geometry?.dispose(); for (const m of [child.material].flat().filter(Boolean)) {
        for (const value of Object.values(m)) if (value?.isTexture) value.dispose(); m.dispose();
    } }); scene.remove(object);
}
/** Neutralize local held controls and send a complete frame when connected. */
function stop() { keys.clear(); throttle = 0; $('throttle').value = 0; $('throttle-value').value = '0%'; send(true); }
/** Send normalized complete controls; the server owns all stabilization and integration. */
function send(forceNeutral = false) {
    if (!registered || !socket?.connected || (document.hidden && !forceNeutral)) return;
    socket.emit('action', flightInput(keys, Number($('throttle').value), policy.protocolVersion, sequence++));
}
/** Replace the exact server triangle grid, repeating its far-edge samples and omitting no-data holes. */
function showMap(map) {
    reticle.setTerrain(null);
    if (terrain) dispose(terrain); if (targets) dispose(targets);
    const t = map.terrain, positions = [], indices = []; grid = t; poses.setWorld(t); effects.setWorld(t);
    for (let r = 0; r <= t.rows; r++) for (let c = 0; c <= t.columns; c++) {
        const value = boundarySample(t, c, r);
        positions.push(t.origin.x + Math.min(c * t.spacing.x, t.width), value * t.elevationScale, t.origin.z + Math.min(r * t.spacing.z, t.depth));
    }
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.columns; c++) {
        const a = r * (t.columns + 1) + c, b = a + 1, cc = a + t.columns + 1, d = cc + 1;
        for (const triangle of [[a, cc, b], [b, cc, d]]) {
            const valid = triangle.every(i => {
                const value = boundarySample(t, i % (t.columns + 1), Math.floor(i / (t.columns + 1)));
                return value !== t.noDataValue && Number.isFinite(value);
            });
            if (valid) indices.push(...triangle);
        }
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    terrain = new THREE.Group(); terrainTiles = [];
    const material = new THREE.MeshStandardMaterial({ color: 0x63846c, roughness: 1, side: THREE.DoubleSide });
    for (const offset of tileOffsets(new THREE.Vector3(t.origin.x, 0, t.origin.z), t)) {
        const tile = new THREE.Mesh(geometry, material); tile.position.set(offset.x, 0, offset.z);
        terrain.add(tile); terrainTiles.push(tile);
    }
    scene.add(terrain); reticle.setTerrain(terrainTiles);
    targets = new THREE.Group();
    // Targets are visual markers from the world contract, rather than invented physical obstacles.
    for (const target of map.targets || []) { const marker = new THREE.Mesh(new THREE.BoxGeometry(target.size || 1, target.size || 1, target.size || 1), new THREE.MeshStandardMaterial({ color: 0xef8459 })); marker.position.set(target.x, target.y, target.z); marker.userData.canonical = marker.position.clone(); targets.add(marker); }
    scene.add(targets);
}
/** Connect as a normal player; reset state and ignore late GLB loads from old connections. */
async function connect() {
    const epoch = ++generation; registered = false; stop(); socket?.disconnect(); sequence = 0; policy = null; poses.clear(); effects.clear(); reticle.hide(); cameraSnap = true;
    for (const mesh of actors.values()) dispose(mesh); actors.clear(); requested.clear(); latest = { actors: [] };
    $('start').disabled = true; $('status').textContent = 'Connecting…';
    socket = io({ auth: { sessionId: $('session').value, sync: true } }); const current = socket;
    current.on('protocol_info', info => { policy = info; });
    current.on('session_selected', async () => {
        try { const response = await fetch('/flight-actor.json'); if (!response.ok) throw new Error('Aircraft asset unavailable'); const registration = await response.json();
            if (epoch === generation) current.emit('register_actor', registration);
        } catch (error) { $('status').textContent = error.message; }
    });
    current.on('registration_accepted', descriptor => {
        aimOffset.set(descriptor.metadata.visualSize.x / 2, 0, descriptor.metadata.visualSize.z / 2);
        registered = policy?.physics.aircraftModel === 'assisted-flight-v1'; sequence = 0; $('start').disabled = false;
        $('status').textContent = policy?.physics.aircraftModel === 'assisted-flight-v1' ? 'Connected · assisted flight ready' : 'Server aircraft model differs; restart the server';
    });
    current.on('map_data', showMap);
    current.on('state', state => {
        latest = state; poses.push(state, performance.now()); effects.push(state, performance.now());
        for (const actor of state.actors) if (!requested.has(actor.id)) { requested.add(actor.id); current.emit('request_mesh', actor.id); }
        const live = new Set(state.actors.map(a => a.id)); for (const [id, mesh] of actors) if (!live.has(id)) { dispose(mesh); actors.delete(id); requested.delete(id); }
    });
    current.on('mesh_geometry', async data => {
        const bytes = Uint8Array.from(atob(data.glb), c => c.charCodeAt(0));
        try { const gltf = await loader.parseAsync(bytes.buffer, '');
            if (epoch !== generation || !latest.actors.some(a => a.id === data.id)) { dispose(gltf.scene); return; }
            if (actors.has(data.id)) dispose(actors.get(data.id)); actors.set(data.id, gltf.scene); scene.add(gltf.scene);
        } catch (error) { $('status').textContent = `Mesh error: ${error.message}`; requested.delete(data.id); }
    });
    for (const event of ['terrain_changed', 'terrain_flattened']) current.on(event, () => { stop(); poses.clear(); effects.clear(); cameraSnap = true; poses.push(latest, performance.now()); });
    current.on('data_version', version => current.emit('data_ack', version));
    for (const event of ['registration_rejected', 'session_rejected', 'request_rejected']) current.on(event, result => { $('status').textContent = result.reason; $('start').disabled = false; });
    current.on('session_closed', () => { registered = false; stop(); poses.clear(); effects.clear(); for (const mesh of actors.values()) dispose(mesh); actors.clear(); latest = { actors: [] }; $('status').textContent = 'Session closed · choose another session'; $('start').disabled = false; });
    current.on('disconnect', () => { registered = false; stop(); effects.clear(); $('status').textContent = 'Disconnected · reconnect to fly'; $('start').disabled = false; });
    current.on('connect_error', error => { $('status').textContent = error.message; $('start').disabled = false; });
}
/** Match the canvas drawing buffer and camera projection to the viewport. */
function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
/** Draw latest authoritative poses and smoothly follow the player's forward direction. */
function animate(now) {
    const dt = Math.min(0.1, (now - previous) / 1000); previous = now;
    if (keys.has('KeyW') || keys.has('KeyS')) { throttle = Math.max(0, Math.min(100, throttle + (keys.has('KeyW') ? 1 : -1) * dt * 30)); $('throttle').value = Math.round(throttle); }
    $('throttle-value').value = `${$('throttle').value}%`;
    reticle.hide(); $('sky-reticle').style.display = 'none';
    const displayed = poses.sample(now), playerPose = displayed.find(a => a.id === socket?.id);
    const reference = playerPose?.position || new THREE.Vector3();
    const offsets = grid ? tileOffsets(reference, grid) : [];
    terrainTiles.forEach((tile, i) => { tile.position.set(offsets[i].x, 0, offsets[i].z); });
    for (const marker of targets?.children || []) marker.position.copy(nearestImage(marker.userData.canonical, reference, grid));
    for (const rendered of displayed) {
        const position = nearestImage(rendered.position, reference, grid), q = rendered.quaternion;
        const mesh = actors.get(rendered.id); if (mesh) { mesh.position.copy(position); mesh.quaternion.copy(q); }
        if (rendered.id !== socket?.id) continue;
        const actor = latest.actors.find(a => a.id === rendered.id); if (!actor) continue;
        const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        if (registered) reticle.update(aimOffset.clone().applyQuaternion(q).add(position), forward);
        const desiredCamera = position.clone().addScaledVector(forward, -13).add(new THREE.Vector3(0, 5, 0));
        if (cameraSnap) { camera.position.copy(desiredCamera); cameraSnap = false; }
        else camera.position.lerp(desiredCamera, 1 - Math.exp(-5 * dt));
        camera.lookAt(position.clone().addScaledVector(forward, 7));
        if (reticle.mode === 'sky') {
            // A sky marker is a screen-space circle at the boresight vanishing point,
            // not a fake terrain hit or a depth-tested object floating in the world.
            camera.updateMatrixWorld();
            const point = camera.position.clone().addScaledVector(forward, 10000);
            const inFront = point.clone().applyMatrix4(camera.matrixWorldInverse).z < 0;
            point.project(camera);
            if (inFront && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1) {
                $('sky-reticle').style.left = `${(point.x + 1) * innerWidth / 2}px`;
                $('sky-reticle').style.top = `${(1 - point.y) * innerHeight / 2}px`;
                $('sky-reticle').style.display = 'block';
            }
        }
        $('telemetry').textContent = `Speed  ${Math.hypot(actor.velocity.x, actor.velocity.y, actor.velocity.z).toFixed(1)} m/s\nAltitude  ${actor.position.y.toFixed(1)} m\nVertical rate  ${actor.velocity.y.toFixed(1)} m/s\n${actor.grounded ? 'Ground contact' : 'Airborne'} · input ack ${actor.lastInputSequence}`;
    }
    effects.update(now, reference);
    renderer.render(scene, camera); requestAnimationFrame(animate);
}
const inputKeys = new Set(['KeyW', 'KeyS', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyB']);
window.addEventListener('keydown', event => { if (event.code === 'Escape') return stop(); if (!inputKeys.has(event.code) || (event.target.tagName === 'SELECT' || (event.target.tagName === 'INPUT' && event.target.type !== 'range'))) return; event.preventDefault(); keys.add(event.code); });
window.addEventListener('keyup', event => keys.delete(event.code)); window.addEventListener('blur', stop);
document.addEventListener('visibilitychange', stop); window.addEventListener('resize', resize);
for (const button of document.querySelectorAll('[data-key]')) {
    button.addEventListener('pointerdown', event => { button.setPointerCapture(event.pointerId); keys.add(button.dataset.key); });
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(event, () => keys.delete(button.dataset.key));
}
$('throttle').addEventListener('input', () => { throttle = Number($('throttle').value); });
$('start').onclick = connect; $('stop').onclick = stop;
fetch('/sessions').then(r => r.json()).then(sessions => { for (const session of sessions) $('session').add(new Option(session.name, session.id)); $('start').disabled = false; $('status').textContent = 'Choose a session to begin'; }).catch(error => { $('status').textContent = error.message; });
setInterval(send, 1000 / 30); resize(); camera.position.set(0, 30, 45); camera.lookAt(0, 0, 0); requestAnimationFrame(animate);
