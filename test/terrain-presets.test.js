const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { terrainPresets, createDtedTerrain, createMap, validateMap } = require('../modules/terrain');
const { TerrainModel } = require('../modules/terrain/model');
const { SessionManager } = require('../modules/sessions/manager');
const { initializePhysics, RAPIER } = require('../modules/physics');
const { validate } = require('../modules/contracts');
const fixture = require('./mesh-fixture'), frame = require('./control-frame');
before(() => initializePhysics());

/** Generate a standard preset with a reproducible grid and expose its physical height sampler. */
function sample(preset, seed = 0) { return new TerrainModel(createDtedTerrain({ preset, seed })); }

test('all six schema-defined presets produce deterministic, distinct schema-valid heightfields', () => {
    assert.equal(terrainPresets.length, 6);
    const signatures = new Set();
    for (const { id } of terrainPresets) {
        const a = createMap({ preset: id, seed: 7 }), b = createDtedTerrain({ preset: id, seed: 7 });
        validateMap(a); assert.deepEqual(a.terrain, b);
        assert.ok(a.terrain.depthMap.every(Number.isInteger)); assert.equal(a.terrain.preset, id);
        signatures.add(JSON.stringify(a.terrain.depthMap));
    }
    assert.equal(signatures.size, 6);
    assert.throws(() => createMap({ preset: 'unknown' }), /Unknown terrain preset/);
    const bad = createMap({ preset: 'flat' }); bad.terrain.preset = 'unknown'; assert.throws(() => validate('world', bad));
});

test('presets have recognizable valley, plateau, mountain, corner-hill and city-street shapes', () => {
    const valley = sample('valley'); assert.equal(valley.heightAt(0,0), 0); assert.ok(valley.heightAt(0,400) > 60); assert.equal(valley.heightAt(-200,0), 0);
    const plateau = sample('plateau'); assert.equal(plateau.heightAt(0,0),70); assert.equal(plateau.heightAt(100,0),70); assert.equal(plateau.heightAt(450,450),0);
    const mountain = sample('mountain-range'); assert.ok(mountain.heightAt(0,0) > 60); assert.ok(mountain.heightAt(-275,0) > mountain.heightAt(-140,0));
    assert.notDeepEqual(sample('mountain-range',1).grid.depthMap, sample('mountain-range',2).grid.depthMap);
    const corners = sample('corner-hills'); for (const x of [-360,360]) for (const z of [-360,360]) assert.ok(corners.heightAt(x,z)>70);
    assert.ok(corners.heightAt(0,0)<0.1);
    const city = sample('city-blocks'); assert.equal(city.heightAt(0,50),0); assert.equal(city.heightAt(50,0),0);
    assert.ok(city.heightAt(50,50)>=24); assert.equal(city.heightAt(40,40), city.heightAt(60,60));
    assert.ok(sample('flat').grid.depthMap.every(v=>v===0));
});

test('session creation selects a preset, switching rebuilds physics/data and preserves session state', t => {
    const sessions = new SessionManager(); t.after(()=>sessions.close());
    const a = sessions.createSession({ id:'a', terrainPreset:'flat' }), b = sessions.createSession({ id:'b', terrainPreset:'corner-hills' });
    assert.equal(a.description().terrainPreset,'flat'); assert.equal(b.description().terrainPreset,'corner-hills');
    a.actors.create('p','address'); a.actors.register('p',fixture.registration());
    a.actors.action('p',frame({sequence:20,move:{x:1}})); a.tick();
    a.disableObjectCollisions(); a.removeTargets();
    const otherTerrain=b.terrain, otherVersion=b.data.resources.get('terrain').version;
    const pose={...a.data.actors.get('p').position}, before=a.data.resources.get('terrain').version;
    const result=a.setTerrainPreset('plateau');
    assert.equal(result.version,before+1); assert.equal(result.preset,'plateau'); assert.equal(a.description().terrainPreset,'plateau');
    assert.equal(a.physics.terrainOnlyCollisions,true); assert.equal(a.data.map.targets.length,0);
    assert.equal(a.data.actors.get('p').position.x,pose.x); assert.equal(a.data.actors.get('p').position.z,pose.z);
    assert.ok(a.data.actors.get('p').position.y>=70); assert.equal(a.data.actors.get('p').action.sequence,20);
    a.tick();
    const hit=a.physics.world.castRay(new RAPIER.Ray({x:100,y:150,z:100},{x:0,y:-1,z:0}),200,true);
    assert.ok(hit && Math.abs(150-hit.timeOfImpact-70)<0.001);
    assert.equal(b.terrain,otherTerrain); assert.equal(b.data.resources.get('terrain').version,otherVersion);
    const grid=a.terrain.grid, version=a.data.resources.get('terrain').version;
    assert.throws(()=>a.setTerrainPreset('invalid'),/Unknown terrain preset/); assert.equal(a.terrain.grid,grid); assert.equal(a.data.resources.get('terrain').version,version);
    a.actors.create('new','address2'); a.actors.register('new',fixture.registration()); assert.ok(a.data.actors.get('new').position.y>=70);
    a.flattenTerrain(); assert.equal(a.data.map.terrain.preset,'flat'); assert.equal(a.data.actors.get('p').position.y,0);
});

test('terrain previews match applied samples without changing terrain, actors, colliders or versions', t => {
    const sessions = new SessionManager(); t.after(() => sessions.close());
    const session = sessions.createSession({ id: 'preview', terrainPreset: 'flat', terrainSeed: 42 });
    session.actors.create('p', 'address'); session.actors.register('p', fixture.registration());
    const terrain = session.terrain, map = structuredClone(session.data.map), actors = session.physics.getState();
    const handles = [...session.physics.terrainHandles], version = session.data.resources.get('terrain').version;
    const preview = session.previewTerrainPreset('mountain-range');
    assert.equal(preview.baseVersion, version); assert.equal(preview.sessionId, 'preview'); assert.equal(preview.terrain.seed, 42);
    assert.equal(session.terrain, terrain); assert.deepEqual(session.data.map, map); assert.deepEqual(session.physics.getState(), actors);
    assert.deepEqual([...session.physics.terrainHandles], handles); assert.equal(session.data.resources.get('terrain').version, version);
    session.setTerrainPreset('mountain-range'); assert.deepEqual(session.terrain.grid, preview.terrain);
});
