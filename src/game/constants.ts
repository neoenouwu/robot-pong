/**
 * Shared metric constants (Right-handed Y-up, meters) for Sentinel Pong.
 * Matches exact dimensions of public/models/table.glb, paddle.glb, ball.glb, and sentinel.glb.
 */
export const TABLE = {
  LENGTH: 2.74,
  HALF_LENGTH: 1.37,
  WIDTH: 1.525,
  HALF_WIDTH: 0.7625,
  SURFACE_Y: 0.76,
  NET_HEIGHT: 0.1525,
  NET_TOP_Y: 0.76 + 0.1525, // 0.9125m
  NET_HALF_WIDTH: 0.915,
} as const;

export const BALL = {
  RADIUS: 0.025,
  GRAVITY: -9.81,
  AIR_DRAG: 0.24,
  MAGNUS_COEFF: 0.055,
  TABLE_RESTITUTION: 0.87,
  NET_RESTITUTION: 0.28,
} as const;

export const PLAYER_PADDLE = {
  BASE_Z: 1.46,
  MIN_Z: 1.18,
  MAX_Z: 1.68,
  MIN_X: -1.18,
  MAX_X: 1.18,
  MIN_Y: 0.78,
  MAX_Y: 1.52,
  HIT_RADIUS_X: 0.215, // Generous sweet + edge hitbox around 0.156m visual blade
  HIT_RADIUS_Y: 0.215,
  SWEET_SPOT_RADIUS: 0.09,
} as const;

export const SENTINEL = {
  HOME_POS: { x: 0, y: 2.08, z: -2.42 },
  PADDLE_BASE_Z: -1.36,
  PADDLE_SCALE: 2.1, // Iconic towering boss paddle scale matching the artwork
  HIT_RADIUS_X: 0.29,
  HIT_RADIUS_Y: 0.29,
} as const;

export type GameMode = 'arcade' | 'duel';
export type Difficulty = 'scout' | 'hunter' | 'architect';

export interface ThreatPhaseConfig {
  phase: number;
  name: string;
  minScore: number;
  sentinelSpeed: number; // m/s lateral tracking
  returnSpeed: number; // base shot speed
  spinIntensity: number; // rad/s Magnus spin
  smashChance: number; // 0..1 chance on high/mid balls
  errorMargin: number; // meters — slight human-beatable imperfection
  eyeColor: number;
  accentHex: string;
}

export const THREAT_PHASES: readonly ThreatPhaseConfig[] = [
  {
    phase: 1,
    name: 'RECON',
    minScore: 0,
    sentinelSpeed: 3.1,
    returnSpeed: 4.5,
    spinIntensity: 10,
    smashChance: 0.06,
    errorMargin: 0.13,
    eyeColor: 0xff1e24,
    accentHex: '#00ff6a',
  },
  {
    phase: 2,
    name: 'HUNTER',
    minScore: 1800,
    sentinelSpeed: 4.0,
    returnSpeed: 5.3,
    spinIntensity: 18,
    smashChance: 0.18,
    errorMargin: 0.1,
    eyeColor: 0xff2b14,
    accentHex: '#ffb020',
  },
  {
    phase: 3,
    name: 'OVERCLOCK',
    minScore: 4800,
    sentinelSpeed: 4.9,
    returnSpeed: 6.1,
    spinIntensity: 26,
    smashChance: 0.3,
    errorMargin: 0.075,
    eyeColor: 0xff0d3c,
    accentHex: '#ff4b3e',
  },
  {
    phase: 4,
    name: 'ZION BREACH',
    minScore: 9500,
    sentinelSpeed: 5.8,
    returnSpeed: 6.9,
    spinIntensity: 34,
    smashChance: 0.42,
    errorMargin: 0.055,
    eyeColor: 0xff0055,
    accentHex: '#ff1f5a',
  },
] as const;

export const DUEL_DIFFICULTIES: Record<Difficulty, ThreatPhaseConfig> = {
  scout: {
    phase: 1,
    name: 'SCOUT',
    minScore: 0,
    sentinelSpeed: 2.9,
    returnSpeed: 4.4,
    spinIntensity: 9,
    smashChance: 0.08,
    errorMargin: 0.15,
    eyeColor: 0xff2222,
    accentHex: '#00ff6a',
  },
  hunter: {
    phase: 2,
    name: 'HUNTER',
    minScore: 0,
    sentinelSpeed: 4.15,
    returnSpeed: 5.4,
    spinIntensity: 20,
    smashChance: 0.22,
    errorMargin: 0.095,
    eyeColor: 0xff1a22,
    accentHex: '#ffb020',
  },
  architect: {
    phase: 4,
    name: 'ARCHITECT',
    minScore: 0,
    sentinelSpeed: 5.45,
    returnSpeed: 6.45,
    spinIntensity: 31,
    smashChance: 0.36,
    errorMargin: 0.058,
    eyeColor: 0xff0044,
    accentHex: '#ff1f5a',
  },
};

export function getThreatPhaseForScore(score: number): ThreatPhaseConfig {
  let current = THREAT_PHASES[0];
  for (const p of THREAT_PHASES) {
    if (score >= p.minScore) current = p;
  }
  return current;
}
