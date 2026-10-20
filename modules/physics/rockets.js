/**
 * Own authoritative straight-flight rockets and short-lived explosion snapshots.
 * Inputs: Held fire controls, registered hardpoints, Rapier non-actor colliders, targets and dt.
 * Outputs: Canonical projectile/explosion state with stable IDs and a five-metre visual blast radius.
 * Side effects: Allocates projectile IDs, alternates hardpoints and advances/removes ordnance; no actor damage or impulses.
 * Coupling: PhysicsModel drives substeps; sessions supply visible targets; contracts owns weapon tuning.
 */
const { RAPIER } = require('./runtime');
const { rotateVector } = require('./rotation');
const { add, scale } = require('./vector');
const { wrap } = require('../terrain/sampling');
const { invariants } = require('../contracts');
/** Return segment entry distance for a solid axis-aligned target cube, or Infinity on a miss. */
function boxHit(origin, direction, target, maxDistance, grid) {
    let lo = 0, hi = maxDistance;
    const center = { x:target.x, y:target.y, z:target.z };
    if (grid?.boundary === 'wrap') for (const [axis,length] of [['x',grid.width],['z',grid.depth]]) center[axis] = origin[axis] + wrap(center[axis]-origin[axis],-length/2,length);
    const radius = (target.size || 1)/2;
    for (const axis of ['x','y','z']) {
        if (Math.abs(direction[axis])<1e-10) { if (Math.abs(origin[axis]-center[axis])>radius) return Infinity; continue; }
        const a=(center[axis]-radius-origin[axis])/direction[axis], b=(center[axis]+radius-origin[axis])/direction[axis];
        lo=Math.max(lo,Math.min(a,b)); hi=Math.min(hi,Math.max(a,b)); if (lo>hi) return Infinity;
    }
    return lo;
}
class Rockets {
    /** Own per-session ordnance only; no timers or independent physics world. */
    constructor() { this.projectiles=[]; this.explosions=[]; this.serial=0; }
    /** Fire at server cadence from alternating registered hardpoints; held fire never bypasses stale-input gating. */
    fire(record, frame, time) {
        const origins=record.actor.projectileOrigins || [], p=invariants.weapons;
        if (!frame.fire || !origins.length || time < (record.nextRocketAt ?? -Infinity) || this.projectiles.length>=p.maxRockets) return;
        const index=(record.nextWing || 0)%origins.length, hardpoint=origins[index], q=record.rb.rotation();
        record.nextWing=index+1; record.nextRocketAt=time+p.rocketIntervalSeconds;
        const input=hardpoint.direction || {x:1,y:0,z:0};
        // Scale before normalization to avoid overflow/underflow from valid finite vectors.
        const largest=Math.max(Math.abs(input.x),Math.abs(input.y),Math.abs(input.z));
        if (!largest) return;
        const unit={x:input.x/largest,y:input.y/largest,z:input.z/largest};
        const direction=rotateVector(scale(unit,1/Math.hypot(unit.x,unit.y,unit.z)),q);
        const velocity=add(scale(direction,p.rocketSpeed),record.rb.linvel());
        this.projectiles.push({id:`rocket-${++this.serial}`,ownerId:record.actor.id,hardpointId:hardpoint.id,
            position:add(record.rb.translation(),rotateVector(hardpoint.position,q)),velocity,age:0});
    }
    /** Sweep each step against non-actor solids/target cubes; split at wrapped seams to avoid tunnelling. */
    step(world, records, images, terrain, targets, dt) {
        const p=invariants.weapons, grid=terrain?.grid;
        // Collision exclusions are explicit handles, independent of actor collision-group diagnostics.
        const excluded=new Set([...records.values()].map(r=>r.collider.handle));
        for (const image of images?.values() || []) excluded.add(image.collider.handle);
        // Retain impact records across several snapshots so slow clients still receive each burst.
        this.explosions=this.explosions.filter(e=>(e.age+=dt)<p.explosionSeconds);
        const alive=[];
        for (const rocket of this.projectiles) {
            rocket.age+=dt; if (rocket.age>p.rocketLifetimeSeconds) continue;
            let remaining=dt, position={...rocket.position}, impact=null;
            // At 120 m/s and fixed 1/120 s steps, at most one crossing per axis is usual.
            for (let segment=0; remaining>1e-9 && segment<8; segment++) {
                let duration=remaining; const crossings=[];
                if (grid?.boundary==='wrap') for (const [axis,start,length] of [['x',grid.origin.x,grid.width],['z',grid.origin.z,grid.depth]]) {
                    position[axis]=wrap(position[axis],start,length);
                    // A negative ray on the lower edge starts at its equivalent upper edge.
                    if (position[axis]===start && rocket.velocity[axis]<0) position[axis]=start+length;
                    const v=rocket.velocity[axis], distance=v>0 ? start+length-position[axis] : start-position[axis];
                    const t=v===0 ? Infinity : distance/v;
                    if (t>=0 && t<=duration) { if(t<duration-1e-9) crossings.length=0; duration=t; crossings.push(axis); }
                }
                const speed=Math.hypot(rocket.velocity.x,rocket.velocity.y,rocket.velocity.z);
                if (speed<1e-8) break;
                const direction=scale(rocket.velocity,1/speed), distance=speed*duration;
                const hit=world.castRay(new RAPIER.Ray(position,direction),distance,true,undefined,undefined,undefined,undefined,c=>!excluded.has(c.handle));
                let nearest=hit?.timeOfImpact ?? Infinity;
                for (const target of targets || []) nearest=Math.min(nearest,boxHit(position,direction,target,distance,grid));
                if (nearest<=distance) { impact=add(position,scale(direction,nearest)); break; }
                position=add(position,scale(rocket.velocity,duration)); remaining-=duration;
                if (grid?.boundary==='wrap') for (const axis of crossings) {
                    const start=grid.origin[axis], length=axis==='x'?grid.width:grid.depth;
                    position[axis]=rocket.velocity[axis]>0 ? start : start+length;
                }
            }
            const result=impact || position;
            if (grid?.boundary==='wrap') { result.x=wrap(result.x,grid.origin.x,grid.width); result.z=wrap(result.z,grid.origin.z,grid.depth); }
            if (impact) this.explosions.push({id:`explosion-${++this.serial}`,position:result,radius:p.explosionRadius,age:0});
            else { rocket.position=result; alive.push(rocket); }
        }
        this.projectiles=alive;
    }
    /** Discard ordnance on terrain replacement/session disposal; retain unique ID progression. */
    clear() { this.projectiles=[]; this.explosions=[]; }
}
module.exports={Rockets};
