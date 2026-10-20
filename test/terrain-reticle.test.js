const { test } = require('node:test');
const assert = require('node:assert/strict');
/** Build two actual sloped ground triangles so projection tests exercise the rendered surface. */
async function fixture(t) {
    const THREE = await import('three');
    const { TerrainReticle } = await import('../modules/server/public/terrain-reticle.mjs');
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-50,-10,-50, 50,10,-50, -50,-10,50, 50,10,50], 3));
    geometry.setIndex([0,2,1,1,2,3]); geometry.computeVertexNormals();
    const terrain = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const reticle = new TerrainReticle(3); reticle.setTerrain(terrain);
    t.after(() => { reticle.dispose(); geometry.dispose(); terrain.material.dispose(); });
    return { THREE, terrain, reticle };
}
test('aim circle projects to the actual sloping terrain and hides when aim misses', async t => {
    const { THREE, terrain, reticle } = await fixture(t);
    const direction = new THREE.Vector3(1, -1, 0).normalize();
    const hit = reticle.update(new THREE.Vector3(0, 12, 0), direction);
    assert.ok(hit && Math.abs(hit.x - 10) < 1e-5 && Math.abs(hit.y - 2) < 1e-5);
    assert.equal(reticle.overlay.visible, true);
    assert.equal(reticle.overlay.geometry, terrain.geometry, 'projection uses the terrain surface itself, not a floating ring plane');
    assert.ok(reticle.material.uniforms.center.value.distanceTo(hit) < 1e-8);
    assert.equal(reticle.update(new THREE.Vector3(0, 12, 0), new THREE.Vector3(0, 1, 0)), null);
    assert.equal(reticle.overlay.visible, false);
});
test('terrain replacement removes stale projection without disposing borrowed geometry', async t => {
    const { terrain, reticle } = await fixture(t); let disposed = false;
    terrain.geometry.addEventListener('dispose', () => { disposed = true; });
    reticle.setTerrain(null);
    assert.equal(terrain.children.length, 0); assert.equal(disposed, false);
});
