/**
 * Supply periodic images for actor contact pairs on opposite map edges.
 * Inputs: Session Rapier world, canonical actor records and a wrapped terrain grid.
 * Outputs: Private collision images, never public actors or independent simulation state.
 * Side effects: Creates/removes image bodies and synchronizes pose, mass, velocity and actuation each substep.
 * Coupling: PhysicsModel calls sync after controller actuation; terrain-only mode removes all images.
 */
const { RAPIER } = require('./runtime');
const { maxVisualSize } = require('../contracts');
const MARGIN = Math.hypot(...Object.values(maxVisualSize)) + 1;
class PeriodicActors {
    /** Own a bounded image registry; allocation waits until an actor approaches a seam. */
    constructor(world) { this.world = world; this.images = new Map(); }
    /** Remove image bodies only, leaving originals and terrain intact. */
    clear() { for (const image of this.images.values()) this.world.removeRigidBody(image.rb); this.images.clear(); }
    /** Mirror near-edge actors for equal-mass Rapier contact response; images collide only with original actors. */
    sync(records, grid, terrainHandles, disabled) {
        if (disabled || grid?.boundary !== 'wrap') { this.clear(); return; }
        const actorHandles = new Set([...records.values()].map(record => record.collider.handle));
        const imageHandles = new Set([...this.images.values()].map(image => image.collider.handle));
        // Reserve distinct memberships so images never hit terrain, obstacles or one another.
        this.world.forEachCollider(collider => {
            if (imageHandles.has(collider.handle)) return;
            collider.setCollisionGroups(actorHandles.has(collider.handle) ? 0x0002ffff : terrainHandles.has(collider.handle) ? 0x0001fffb : 0x0008fffb);
        });
        const wanted = new Set();
        for (const [id, record] of records) {
            const p = record.rb.translation();
            const xs = [0], zs = [0];
            if (p.x < grid.origin.x + MARGIN) xs.push(grid.width);
            if (p.x > grid.origin.x + grid.width - MARGIN) xs.push(-grid.width);
            if (p.z < grid.origin.z + MARGIN) zs.push(grid.depth);
            if (p.z > grid.origin.z + grid.depth - MARGIN) zs.push(-grid.depth);
            for (const x of xs) for (const z of zs) {
                if (!x && !z) continue;
                const key = `${id}:${x}:${z}`; wanted.add(key);
                let image = this.images.get(key);
                // Re-registration can change mass/shape even when the logical actor ID survives.
                if (image && image.source !== record.rb) { this.world.removeRigidBody(image.rb); this.images.delete(key); image = null; }
                if (!image) {
                    const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true));
                    const collider = this.world.createCollider(new RAPIER.ColliderDesc(record.collider.shape)
                        .setMassProperties(record.shape.mass, record.shape.centerOfMass, record.shape.inertia, { x: 0, y: 0, z: 0, w: 1 })
                        .setFriction(0).setRestitution(record.collider.restitution()).setCollisionGroups(0x00040002), rb);
                    rb.recomputeMassPropertiesFromColliders();
                    image = { rb, collider, source: record.rb }; this.images.set(key, image);
                }
                image.rb.setTranslation({ x: p.x + x, y: p.y, z: p.z + z }, true);
                image.rb.setRotation(record.rb.rotation(), true); image.rb.setLinvel(record.rb.linvel(), true); image.rb.setAngvel(record.rb.angvel(), true);
                image.rb.setAngularDamping(record.rb.angularDamping());
                image.rb.resetForces(false); image.rb.resetTorques(false);
                image.rb.addForce(record.rb.userForce(), true); image.rb.addTorque(record.rb.userTorque(), true);
            }
        }
        for (const [key, image] of this.images) if (!wanted.has(key)) { this.world.removeRigidBody(image.rb); this.images.delete(key); }
    }
}
module.exports = { PeriodicActors };
