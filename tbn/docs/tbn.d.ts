/**
 * TBN Game Protocol & SDK TypeScript Definitions
 * Invariant Type Contracts
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Body-local support point in the XY ground plane. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Client rotation contract: Euler radians, XYZ order; x=roll, y=pitch, z=yaw. */
export interface ClientEulerAngles extends Vec3 {
  order: 'XYZ';
}

/** Build-time user choices from actor.schema.json: only maxSpeed; no tradeoffs yet. */
export interface PhysicsProfile {
  /** Required maximum speed in m/s, inclusive range [1, 100]. */
  maxSpeed: number;
}

export interface GroundingMetadata {
  /** Ground contact plane: Strictly 0.0 */
  contactPlaneZ: 0.0;
  /** Clearance above terrain in meters (0.0 to 0.1) */
  clearance: number;
  /** Ground contact points inside hitbox (|x| <= 1.0, |y| <= 1.0) */
  supportPoints: Vec2[];
}

/** Weapon hardpoint in body coordinates: +X forward, +Y left, +Z up. */
export interface ProjectileOrigin {
  /** At most 8 characters. */
  id: string;
  /** Actor-local meters: X/Y [-1.5, 1.5], Z [0, 3]; full cube allowed. */
  position: Vec3;
  direction?: Vec3;
}

export interface MeshMetadata {
  /** Absolute extents in meters: each dimension > 0 and <= 3 */
  visualSize: Vec3;
  grounding?: GroundingMetadata;
  projectileOrigins: ProjectileOrigin[];
}

/**
 * Agent prepares attributes and mesh at build time, before execution/connection.
 * Send after player server registration and before joining a game session.
 * See tbn/schemas/actor.schema.json; binary limits require runtime validation.
 */
export interface ActorRegistrationPayload {
  /** At most 30 characters. */
  name: string;
  clientType: string;
  /** Build-time actor attributes. */
  physicsProfile: PhysicsProfile;
  mesh: {
    /** Base64 GLB version 2; decoded bytes <= 16777216 (16 MiB), <= 5000 triangles. */
    glb: string;
    metadata: MeshMetadata;
  };
}

/** Mandatory build outputs; actorJson.mesh.glb encodes the exact actorGlb bytes. */
export interface ActorBuildArtifacts {
  glbPath: './actor.glb';
  jsonPath: './actor.json';
  actorGlb: Uint8Array;
  actorJson: ActorRegistrationPayload;
}

export interface DtedTerrainData {
  type: 'dted';
  width: number;
  depth: number;
  columns: number;
  rows: number;
  origin: { x: number; z: number };
  spacing: { x: number; z: number };
  /** Fixed meters per elevation sample unit. */
  elevationScale: 0.1;
  noDataValue?: number;
  /** Integer samples in 0.1 m units; length rows*columns, rows +Z, columns +X. */
  depthMap: number[];
}

export interface MapData extends WorldDimensions {
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  walls?: any[];
  ramps?: any[];
  targets?: any[];
}

/**
 * Linear X/Y/Z components are bounded by ±3/±1/±5 g; angular components by ±1 rad/s².
 * Only x, y, z are allowed; omitted parameters retain their previous value (tbn/schemas/actions.schema.json).
 * TypeScript cannot enforce numeric ranges or exact object keys at runtime.
 */
export interface NormalizedActionVector {
  x?: number;
  y?: number;
  z?: number;
}

export interface ActionInput {
  /** Linear acceleration in g (9.81 m/s^2), X/Y/Z limits ±3/±1/±5: +X forward, +Y left, +Z up. */
  linear?: NormalizedActionVector;
  /** Angular acceleration in rad/s^2, each axis in [-1, 1], about body axes through the center of mass. */
  angular?: NormalizedActionVector;
}

export interface ActorState {
  id: string;
  name: string;
  health: number;
  position: Vec3;
  velocity: Vec3;
  /** Body-axis Euler radians in XYZ order, then convert body basis to world. */
  orientation: ClientEulerAngles;
}

export interface GameStateUpdate {
  actors: ActorState[];
  projectiles: Array<{ id: string; position: Vec3; velocity: Vec3 }>;
  /** New events since the previous broadcast; deduplicate by id. */
  hitEvents: PlayerHitEvent[];
}

export interface PlayerHitEvent {
  id: string;
  targetId: string;
  sourceId: string;
  damage: number;
  remainingHealth: number;
  hitLocation: Vec3;
}

/** World dimensions in meters, defined by tbn/schemas/world.schema.json. */
export interface WorldDimensions {
  size: { x: 1000; y: 1000; z: 1000 };
  terrain: DtedTerrainData;
}

/** Server-enforced geometry limits; not client-selectable registration fields. */
export interface ServerActorGeometryLimits {
  minMeshVolumeCubicMeters: 1;
  hitboxSizeMeters: { x: 2; y: 2; z: 2 };
  hitboxCenter: { x: 0; y: 0; z: 0 };
}
