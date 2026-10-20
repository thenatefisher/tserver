/**
 * Map Flight Lab keys to complete aircraft control frames.
 * Inputs: Held key-code Set, target speed percent, announced protocol version and sequence.
 * Output: A fresh complete normalized frame; no mutations or side effects.
 * Coupling: fly.js sends frames; assisted-flight-v1 defines body-axis signs and target rates.
 */
/** Left/right lower their respective wing; pitch preserves the conventional pull-up mapping. */
export function flightInput(keys, throttle, protocolVersion, sequence) {
    const axis = (positive, negative) => Number(keys.has(positive)) - Number(keys.has(negative));
    return { protocolVersion, sequence, move: { x: throttle / 100, y: 0, z: 0 },
        // Positive body roll raises the left wing, so LEFT must send negative X.
        rotate: { x: axis('ArrowRight', 'ArrowLeft'), y: axis('ArrowUp', 'ArrowDown'), z: axis('KeyQ', 'KeyE') },
        brake: keys.has('KeyB') ? 1 : 0, jump: false, fire: keys.has('Space') };
}
