/**
 * Render authoritative rockets, expanding puffy smoke and five-metre explosion effects.
 * Inputs: Snapshot ordnance, local frame times, periodic world and displayed player reference.
 * Outputs: Instanced smoke/fire clouds and interpolated rocket meshes; no physics or damage predictions.
 * Side effects: Owns scene meshes, bounded particle/history caches and GPU buffers.
 * Coupling: FlightPoses supplies delayed interpolation; world-wrap chooses continuous nearby images.
 */
import * as THREE from 'three';
import { FlightPoses } from './flight-poses.mjs';
import { nearestImage } from './world-wrap.mjs';
const MAX_PUFFS=1100;
/** Allocate a shaded instanced cloud; per-instance alpha makes old smoke disperse smoothly. */
function cloudMesh() {
    const geometry=new THREE.IcosahedronGeometry(1,1);
    geometry.setAttribute('puffAlpha',new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS),1));
    geometry.setAttribute('puffTint',new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS*3),3));
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:true,
        vertexShader:`attribute float puffAlpha; attribute vec3 puffTint; varying float alpha; varying vec3 tint; varying vec3 n;
          void main(){alpha=puffAlpha;tint=puffTint;n=normalize(mat3(modelMatrix)*mat3(instanceMatrix)*normal);
          gl_Position=projectionMatrix*viewMatrix*modelMatrix*instanceMatrix*vec4(position,1.0);}`,
        fragmentShader:`varying float alpha; varying vec3 tint; varying vec3 n;
          void main(){float light=0.65+0.35*max(0.0,dot(normalize(n),normalize(vec3(1.,2.,1.))));gl_FragColor=vec4(tint*light,alpha);}`});
    const mesh=new THREE.InstancedMesh(geometry,material,MAX_PUFFS);mesh.count=0;mesh.frustumCulled=false;return mesh;
}
export class FlightEffects {
    /** Own bounded visual pools; scene additions do not change server objects or terrain. */
    constructor(scene) {
        this.scene=scene;this.cloud=cloudMesh();scene.add(this.cloud);
        this.poses=new FlightPoses(100);this.rockets=new Map();this.lastSmoke=new Map();this.puffs=[];this.pending=[];this.seen=new Set();
        this.geometry=new THREE.ConeGeometry(0.09,0.65,7);this.material=new THREE.MeshStandardMaterial({color:0xffd089,emissive:0x9d3612});
        this.transform=new THREE.Object3D();this.direction=new THREE.Vector3(0,1,0);
    }
    /** Adopt topology for ordnance interpolation; map updates alone do not reset ongoing visual effects. */
    setWorld(grid) {this.grid=grid;this.poses.setWorld(grid);}
    /** Cache state and deduplicate persistent explosion snapshots; missing collections mean empty. */
    push(state,time) {
        this.poses.push({actors:(state.projectiles||[]).map(p=>({...p,orientation:{x:0,y:0,z:0,order:'XYZ'}}))},time);
        this.latest=new Map((state.projectiles||[]).map(p=>[p.id,p]));
        for(const e of state.explosions||[]) if(!this.seen.has(e.id)) {
            this.seen.add(e.id);this.pending.push({...e,at:time+100-e.age*1000});
            if(this.seen.size>2048)this.seen.delete(this.seen.values().next().value);
        }
    }
    /** Emit soft spherical puffs along the swept visual path, bounded for long jumps or delayed snapshots. */
    trail(from,to,now) {
        const distance=from.distanceTo(to),steps=Math.min(80,Math.ceil(distance/0.8));
        for(let i=0;i<steps;i++)this.puffs.push({position:from.clone().lerp(to,(i+1)/steps),born:now,life:1.9,
            radius:0.45+Math.random()*0.4,drift:new THREE.Vector3((Math.random()-.5)*.25,.35,(Math.random()-.5)*.25),heat:false});
    }
    /** Spawn a five-metre visual fireball plus irregular smoke lobes; no client damage calculation. */
    burst(e,now,reference) {
        const center=nearestImage(new THREE.Vector3(e.position.x,e.position.y,e.position.z),reference,this.grid);
        this.puffs.push({position:center,born:now,life:.7,radius:e.radius,drift:new THREE.Vector3(),heat:true});
        for(let i=0;i<18;i++) {
            const offset=new THREE.Vector3(Math.random()-.5,Math.random()-.2,Math.random()-.5).normalize().multiplyScalar(Math.random()*e.radius*.65);
            this.puffs.push({position:center.clone().add(offset),born:now,life:1.5,radius:e.radius*.3,
                drift:offset.clone().multiplyScalar(.1),heat:i<7});
        }
    }
    /** Draw current delayed rocket poses and age the bounded particle pool across wrapped seams. */
    update(now,reference) {
        const visible=new Set();
        for(const pose of this.poses.sample(now)) {
            const data=this.latest?.get(pose.id);if(!data)continue;
            visible.add(pose.id);const position=nearestImage(pose.position,reference,this.grid);
            let mesh=this.rockets.get(pose.id);
            if(!mesh){mesh=new THREE.Mesh(this.geometry,this.material);this.scene.add(mesh);this.rockets.set(pose.id,mesh);}
            mesh.position.copy(position);mesh.quaternion.setFromUnitVectors(this.direction,new THREE.Vector3(data.velocity.x,data.velocity.y,data.velocity.z).normalize());
            const previous=this.lastSmoke.get(pose.id);
            if(previous)this.trail(nearestImage(previous,position,this.grid),position,now);
            this.lastSmoke.set(pose.id,position.clone());
        }
        for(const [id,mesh]of this.rockets)if(!visible.has(id)){mesh.removeFromParent();this.rockets.delete(id);this.lastSmoke.delete(id);}
        const pending=[];for(const e of this.pending){if(now>=e.at)this.burst(e,now,reference);else pending.push(e);}this.pending=pending;
        this.puffs=this.puffs.filter(p=>(now-p.born)/1000<p.life).slice(-MAX_PUFFS);
        const alpha=this.cloud.geometry.attributes.puffAlpha,tint=this.cloud.geometry.attributes.puffTint;
        this.puffs.forEach((p,i)=>{
            const age=(now-p.born)/1000,f=age/p.life;
            this.transform.position.copy(nearestImage(p.position.clone().addScaledVector(p.drift,age),reference,this.grid));
            this.transform.scale.setScalar(p.radius*(p.heat?Math.min(1,age/.12):.25+.75*f));this.transform.updateMatrix();this.cloud.setMatrixAt(i,this.transform.matrix);
            alpha.setX(i,(p.heat?.8:.55)*(1-f));
            tint.setXYZ(i,p.heat?1:.78,p.heat?.45+.3*f:.8,p.heat?.08+.5*f:.82);
        });
        this.cloud.count=this.puffs.length;this.cloud.instanceMatrix.needsUpdate=true;alpha.needsUpdate=true;tint.needsUpdate=true;
    }
    /** Clear session-local visual history while retaining reusable geometry and GPU allocations. */
    clear(){for(const mesh of this.rockets.values())mesh.removeFromParent();this.rockets.clear();this.lastSmoke.clear();this.poses.clear();this.puffs=[];this.pending=[];this.seen.clear();this.cloud.count=0;}
    /** Release owned resources; never disposes terrain or actor assets. */
    dispose(){this.clear();this.cloud.removeFromParent();this.cloud.geometry.dispose();this.cloud.material.dispose();this.geometry.dispose();this.material.dispose();}
}
