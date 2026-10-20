/**
 * Run the direct player flight interface with authoritative world rendering.
 * Inputs: Keyboard/pointer controls, session selection, Socket.IO maps/GLBs/state/policy.
 * Outputs: Complete action frames and rendered terrain, actors and flight telemetry.
 * Side effects: Owns a player socket, GPU resources, DOM and animation/input timers.
 * Coupling: fly.html supplies controls; normal TBN player contracts and local Three.js assets.
 */
import * as THREE from 'three';
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
const poses = new FlightPoses(100), reticle = new TerrainReticle(3);
const aimOffset = new THREE.Vector3();
let throttle = 0;
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
    const t = map.terrain, positions = [], indices = [];
    for (let r = 0; r <= t.rows; r++) for (let c = 0; c <= t.columns; c++) {
        const value = t.depthMap[Math.min(r, t.rows - 1) * t.columns + Math.min(c, t.columns - 1)];
        positions.push(t.origin.x + Math.min(c * t.spacing.x, t.width), value * t.elevationScale, t.origin.z + Math.min(r * t.spacing.z, t.depth));
    }
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.columns; c++) {
        const a = r * (t.columns + 1) + c, b = a + 1, cc = a + t.columns + 1, d = cc + 1;
        const valid = [a, b, cc, d].every(i => t.depthMap[Math.min(Math.floor(i / (t.columns + 1)), t.rows - 1) * t.columns + Math.min(i % (t.columns + 1), t.columns - 1)] !== t.noDataValue);
        if (valid) indices.push(a, cc, b, b, cc, d);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x63846c, roughness: 1, side: THREE.DoubleSide })); scene.add(terrain); reticle.setTerrain(terrain);
    targets = new THREE.Group();
    // Targets are visual markers from the world contract, rather than invented physical obstacles.
    for (const target of map.targets || []) { const marker = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xef8459 })); marker.position.set(target.x, target.y, target.z); targets.add(marker); }
    scene.add(targets);
}
/** Connect as a normal player; reset state and ignore late GLB loads from old connections. */
async function connect() {
    const epoch = ++generation; registered = false; stop(); socket?.disconnect(); sequence = 0; policy = null; poses.clear(); reticle.hide();
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
        latest = state; poses.push(state, performance.now());
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
    for (const event of ['terrain_changed', 'terrain_flattened']) current.on(event, () => { stop(); poses.clear(); poses.push(latest, performance.now()); });
    current.on('data_version', version => current.emit('data_ack', version));
    for (const event of ['registration_rejected', 'session_rejected', 'request_rejected']) current.on(event, result => { $('status').textContent = result.reason; $('start').disabled = false; });
    current.on('disconnect', () => { registered = false; stop(); $('status').textContent = 'Disconnected · reconnect to fly'; $('start').disabled = false; });
    current.on('connect_error', error => { $('status').textContent = error.message; $('start').disabled = false; });
}
/** Match the canvas drawing buffer and camera projection to the viewport. */
function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
/** Draw latest authoritative poses and smoothly follow the player's forward direction. */
function animate(now) {
    const dt = Math.min(0.1, (now - previous) / 1000); previous = now;
    if (keys.has('KeyW') || keys.has('KeyS')) { throttle = Math.max(0, Math.min(100, throttle + (keys.has('KeyW') ? 1 : -1) * dt * 30)); $('throttle').value = Math.round(throttle); }
    $('throttle-value').value = `${$('throttle').value}%`;
    reticle.hide();
    for (const rendered of poses.sample(now)) {
        const { position, quaternion: q } = rendered;
        const mesh = actors.get(rendered.id); if (mesh) { mesh.position.copy(position); mesh.quaternion.copy(q); }
        if (rendered.id !== socket?.id) continue;
        const actor = latest.actors.find(a => a.id === rendered.id); if (!actor) continue;
        const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        if (registered) reticle.update(aimOffset.clone().applyQuaternion(q).add(position), forward);
        camera.position.lerp(position.clone().addScaledVector(forward, -13).add(new THREE.Vector3(0, 5, 0)), 1 - Math.exp(-5 * dt));
        camera.lookAt(position.clone().addScaledVector(forward, 7));
        $('telemetry').textContent = `Speed  ${Math.hypot(actor.velocity.x, actor.velocity.y, actor.velocity.z).toFixed(1)} m/s\nAltitude  ${actor.position.y.toFixed(1)} m\nVertical rate  ${actor.velocity.y.toFixed(1)} m/s\n${actor.grounded ? 'Ground contact' : 'Airborne'} · input ack ${actor.lastInputSequence}`;
    }
    renderer.render(scene, camera); requestAnimationFrame(animate);
}
const inputKeys = new Set(['KeyW', 'KeyS', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
window.addEventListener('keydown', event => { if (event.code === 'Escape') return stop(); if (!inputKeys.has(event.code) || ['INPUT', 'SELECT'].includes(event.target.tagName)) return; event.preventDefault(); keys.add(event.code); });
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
