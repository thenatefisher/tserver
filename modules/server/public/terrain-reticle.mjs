/**
 * Project a circular aiming outline onto the rendered terrain triangles.
 * Inputs: Terrain mesh, world aim origin/direction and circle radius in metres.
 * Outputs: Terrain overlay and hidden/terrain/sky mode for a separate boresight HUD circle.
 * Side effects: Owns a shader material and overlay child; borrows terrain geometry.
 * Coupling: Three.js raycasting/shaders; fly.js supplies the displayed aircraft pose.
 */
import { Mesh, Raycaster, ShaderMaterial, Vector3, DoubleSide } from 'three';
export class TerrainReticle {
    /** Allocate projector uniforms and surface shader; no terrain geometry is copied or owned. */
    constructor(radius = 3) {
        this.ray = new Raycaster(); this.ray.near = 0; this.mode = 'hidden';
        this.material = new ShaderMaterial({
            uniforms: { center: { value: new Vector3() }, direction: { value: new Vector3(1, 0, 0) }, radius: { value: radius }, depth: { value: radius } },
            // Evaluate the projector at each surface fragment, not only at ring vertices:
            // even a coarse triangle or a sharp ridge receives the exact mapped outline.
            vertexShader: `varying vec3 surface;
                void main() { vec4 world = modelMatrix * vec4(position, 1.0); surface = world.xyz;
                    gl_Position = projectionMatrix * viewMatrix * world; }`,
            fragmentShader: `uniform vec3 center; uniform vec3 direction; uniform float radius; uniform float depth;
                varying vec3 surface;
                void main() {
                    vec3 delta = surface - center;
                    float along = dot(delta, direction);
                    if (abs(along) > depth) discard;
                    float radial = length(delta - direction * along);
                    float edge = abs(radial - radius);
                    float aa = max(fwidth(radial), 0.015);
                    float alpha = 1.0 - smoothstep(0.07, 0.07 + aa, edge);
                    if (alpha < 0.01) discard;
                    gl_FragColor = vec4(0.55, 1.0, 0.72, alpha);
                }`,
            transparent: true, depthTest: true, depthWrite: false, side: DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        });
    }
    /** Detach the previous overlay and borrow a replacement surface; leave its geometry untouched. */
    setTerrain(terrain) {
        this.hide(); this.overlay?.removeFromParent(); this.terrain = terrain; this.overlay = null;
        if (!terrain) return;
        this.overlay = new Mesh(terrain.geometry, this.material); this.overlay.visible = false;
        this.overlay.renderOrder = 1; terrain.add(this.overlay);
    }
    /** Hide stale aim when disconnected, changing sessions or lacking a displayed aircraft. */
    hide() { this.mode = 'hidden'; if (this.overlay) this.overlay.visible = false; }
    /** Raycast only terrain; project a circle perpendicular to aim, stretched naturally over slopes. */
    update(origin, direction) {
        this.hide(); if (!this.terrain) return null;
        this.terrain.updateWorldMatrix(true, false);
        this.ray.set(origin, direction.clone().normalize());
        const hit = this.ray.intersectObject(this.terrain, false)[0];
        if (!hit) { this.mode = 'sky'; return null; }
        // Inspect the nearest hit before applying the minimum range: skipping near
        // intersections in Raycaster could incorrectly reveal a farther ground marker.
        if (hit.distance < 5) return null;
        this.mode = 'terrain';
        this.material.uniforms.center.value.copy(hit.point);
        this.material.uniforms.direction.value.copy(this.ray.ray.direction);
        // Bound the local projector volume, extending it at oblique incidence so the
        // complete circle can stretch along the ground without marking distant hills.
        const normal = hit.face.normal.clone().transformDirection(this.terrain.matrixWorld);
        this.material.uniforms.depth.value = this.material.uniforms.radius.value / Math.max(0.05, Math.abs(normal.dot(this.ray.ray.direction))) * 2;
        this.overlay.visible = true;
        return hit.point.clone();
    }
    /** Release only owned rendering resources; the terrain owner remains responsible for geometry. */
    dispose() { this.setTerrain(null); this.material.dispose(); }
}
