/**
 * Apply session diagnostic collision filtering while retaining physical terrain support.
 * Inputs: Rapier world and the set of terrain collider handles.
 * Outputs: Count of non-terrain colliders filtered by the policy.
 * Side effects: Updates collision groups and wakes affected rigid bodies; removes no geometry or mass.
 * Coupling: PhysicsModel invokes this after admin activation, before stepping and after terrain replacement.
 */
// Rapier groups encode membership in the upper 16 bits and accepted groups in the lower 16.
const TERRAIN = 0x0001ffff, OBJECT = 0x00020001;
/** Classify every collider by terrain ownership; objects accept only terrain, never each other. */
function terrainOnlyCollisionPolicy(world, terrainHandles) {
    let affected = 0;
    world.forEachCollider(collider => {
        const isTerrain = terrainHandles.has(collider.handle), groups = isTerrain ? TERRAIN : OBJECT;
        if (collider.collisionGroups() !== groups) {
            collider.setCollisionGroups(groups);
            collider.parent()?.wakeUp();
        }
        if (!isTerrain) affected++;
    });
    return affected;
}
module.exports = { terrainOnlyCollisionPolicy };
