/**
 * Buffer authoritative snapshots for smooth, delayed display poses.
 * Inputs: Schema-valid actor snapshots and local monotonic receipt/render times (ms).
 * Outputs: Interpolated root positions and world quaternions; never predicted physics state.
 * Side effects: Retains at most 12 snapshots; clear discards interpolation history.
 * Coupling: Three.js quaternion math, the shared Euler/body basis contract, and fly.js rendering.
 */
import { Vector3, Quaternion, Euler } from 'three';
const basis = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
/** Convert one wire actor into an independent render pose without mutating its authoritative state. */
function pose(actor) {
    const o = actor.orientation;
    return { id: actor.id, position: new Vector3(actor.position.x, actor.position.y, actor.position.z),
        quaternion: basis.clone().multiply(new Quaternion().setFromEuler(new Euler(o.x, o.y, o.z, 'XYZ'))) };
}
export class FlightPoses {
    /** Own a small receipt-time buffer; delay hides normal 15 Hz snapshot spacing/jitter. */
    constructor(delay = 100) { this.delay = delay; this.frames = []; }
    /** Remove history after reconnect/session transfer or an explicit world repositioning. */
    clear() { this.frames.length = 0; }
    /** Store independent actor poses; coalesce equal local receipt times and bound retained memory. */
    push(state, time) {
        const frame = { time, actors: new Map(state.actors.map(actor => [actor.id, pose(actor)])) };
        if (this.frames.at(-1)?.time === time) this.frames.pop();
        this.frames.push(frame); if (this.frames.length > 12) this.frames.shift();
    }
    /** Interpolate position and shortest quaternion arc; freeze on starvation instead of extrapolating through terrain. */
    sample(time) {
        if (!this.frames.length) return [];
        const target = time - this.delay;
        let a = this.frames[0], b = a;
        for (const frame of this.frames) { b = frame; if (frame.time >= target) break; a = frame; }
        const alpha = a.time === b.time ? 0 : Math.max(0, Math.min(1, (target - a.time) / (b.time - a.time)));
        return [...b.actors.values()].map(next => {
            const previous = a.actors.get(next.id) || next;
            return { id: next.id, position: previous.position.clone().lerp(next.position, alpha),
                quaternion: previous.quaternion.clone().slerp(next.quaternion, alpha) };
        });
    }
}
