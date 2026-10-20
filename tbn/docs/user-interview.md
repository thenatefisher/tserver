# User Interview Guide

## Creative Axes
1. **Visual Style**: 3D (Three.js/Babylon.js), 2D Canvas, ASCII Terminal, Cyberpunk Neon.
2. **Vehicle**: Hovercraft, mech walker, heavy tank, drone orb.
3. **Controls**: Keyboard (WASD), mouse-aim, touch joysticks.
4. **Juice & Audio**: Particle trails, Web Audio synthesis, screen shake, CRT scanlines.

## Quick Prompt
```
Awesome! Let's vibe-code your client. Tell me:
1. Visual Style (3D, 2D, ASCII, Cyberpunk)?
2. Vehicle Vibe (hovercraft, mech, tank)?
3. Controls (WASD, mouse-aim, touch)?
4. Juice (particles, sound FX, screen shake)?
```

## Build-time actor properties
Alongside the creative questions, ask the user to choose **maximum speed (`maxSpeed`) in m/s, from 1 to 100 inclusive**. If their reply omits it, obtain their choice before generating the final actor package. Select controller mode (ground, hover, aircraft, mecha, boat) to match the vehicle design. Explain that speed and controller are the selectable fields, with no tradeoff cost or points budget.

Write the chosen value to `actor.json` as `physicsProfile.maxSpeed` and validate it against `tbn/schemas/actor.schema.json`. More parameters and tradeoffs may be added in the future through explicit updates to the schemas and matching contracts.

Write the controller to `physicsProfile.controller`. Use the capability table and suggested mappings in [physics-controls.md](physics-controls.md); do not promise flight, strafe, or jumping for a controller that does not support it.

## Air-vehicle defaults

For planes, gliders, jets and freely flying drones, use [air-vehicle-experience.md](air-vehicle-experience.md) as the default experience after capturing the user's preferences. Recommend assisted flight with throttle-controlled target speed, intuitive banked turns, conventional pull-up pitch and a smooth chase view. Basic flight needs no client stability-controller design interview. Preserve preferences already supplied, and distinguish free flight from explicitly requested terrain-following hover behavior.
