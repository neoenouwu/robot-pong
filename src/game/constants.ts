/**
 * Shared metric constants (Right-handed Y-up, meters) for Robot Pong.
 * Matches exact dimensions of public/models/table.glb, paddle.glb, ball.glb, and robot.glb.
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

export const ROBOT = {
  HOME_POS: { x: 0, y: 2.08, z: -2.42 },
  PADDLE_BASE_Z: -1.36,
  PADDLE_SCALE: 2.1, // Iconic towering boss paddle scale matching the artwork
  HIT_RADIUS_X: 0.195,
  HIT_RADIUS_Y: 0.195,
} as const;

export type GameMode = 'arcade' | 'duel';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type StoryStage = 1 | 2;

export const STORY_POINTS_TO_WIN = 5;

export interface ThreatPhaseConfig {
  phase: number;
  name: string;
  minScore: number;
  robotSpeed: number; // m/s lateral tracking
  reactionDelay: number; // seconds before AI reacts to a new player shot
  spinBlindness: number; // 0..1 fraction of lateral Magnus curve the AI misreads
  returnSpeed: number; // base shot speed
  spinIntensity: number; // rad/s Magnus spin
  smashChance: number; // 0..1 chance on high/mid balls
  errorMargin: number; // meters — realistic lateral positioning error on fast shots
  eyeColor: number;
  accentHex: string;
}

export const THREAT_PHASES: readonly ThreatPhaseConfig[] = [
  {
    phase: 1,
    name: 'RECON',
    minScore: 0,
    robotSpeed: 1.42,
    reactionDelay: 0.22,
    spinBlindness: 0.55,
    returnSpeed: 4.3,
    spinIntensity: 10,
    smashChance: 0.06,
    errorMargin: 0.16,
    eyeColor: 0xff1e24,
    accentHex: '#00ff6a',
  },
  {
    phase: 2,
    name: 'HUNTER',
    minScore: 1800,
    robotSpeed: 1.78,
    reactionDelay: 0.16,
    spinBlindness: 0.42,
    returnSpeed: 5.0,
    spinIntensity: 17,
    smashChance: 0.18,
    errorMargin: 0.13,
    eyeColor: 0xff2b14,
    accentHex: '#ffb020',
  },
  {
    phase: 3,
    name: 'OVERCLOCK',
    minScore: 4800,
    robotSpeed: 2.12,
    reactionDelay: 0.12,
    spinBlindness: 0.3,
    returnSpeed: 5.8,
    spinIntensity: 25,
    smashChance: 0.28,
    errorMargin: 0.1,
    eyeColor: 0xff0d3c,
    accentHex: '#ff4b3e',
  },
  {
    phase: 4,
    name: 'MELTDOWN',
    minScore: 9500,
    robotSpeed: 2.45,
    reactionDelay: 0.08,
    spinBlindness: 0.2,
    returnSpeed: 6.5,
    spinIntensity: 32,
    smashChance: 0.38,
    errorMargin: 0.08,
    eyeColor: 0xff0055,
    accentHex: '#ff1f5a',
  },
] as const;

export const DUEL_DIFFICULTIES: Record<Difficulty, ThreatPhaseConfig> = {
  easy: {
    phase: 1,
    name: 'EASY',
    minScore: 0,
    robotSpeed: 1.24,
    reactionDelay: 0.25,
    spinBlindness: 0.65,
    returnSpeed: 4.15,
    spinIntensity: 9,
    smashChance: 0.07,
    errorMargin: 0.18,
    eyeColor: 0xff2222,
    accentHex: '#00ff6a',
  },
  medium: {
    phase: 2,
    name: 'MEDIUM',
    minScore: 0,
    robotSpeed: 1.68,
    reactionDelay: 0.17,
    spinBlindness: 0.45,
    returnSpeed: 5.05,
    spinIntensity: 18,
    smashChance: 0.2,
    errorMargin: 0.13,
    eyeColor: 0xff1a22,
    accentHex: '#ffb020',
  },
  hard: {
    phase: 4,
    name: 'HARD',
    minScore: 0,
    robotSpeed: 2.12,
    reactionDelay: 0.11,
    spinBlindness: 0.28,
    returnSpeed: 6.05,
    spinIntensity: 28,
    smashChance: 0.34,
    errorMargin: 0.09,
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

export const STORY_STAGE2_CONFIGS: Record<Difficulty, ThreatPhaseConfig> = {
  easy: {
    phase: 2,
    name: 'APEX ROBOT',
    minScore: 0,
    robotSpeed: 1.56,
    reactionDelay: 0.19,
    spinBlindness: 0.48,
    returnSpeed: 4.85,
    spinIntensity: 16,
    smashChance: 0.18,
    errorMargin: 0.14,
    eyeColor: 0xff1626,
    accentHex: '#ff4b3e',
  },
  medium: {
    phase: 3,
    name: 'APEX ROBOT',
    minScore: 0,
    robotSpeed: 1.98,
    reactionDelay: 0.13,
    spinBlindness: 0.32,
    returnSpeed: 5.65,
    spinIntensity: 24,
    smashChance: 0.28,
    errorMargin: 0.1,
    eyeColor: 0xff0d34,
    accentHex: '#ff2442',
  },
  hard: {
    phase: 4,
    name: 'APEX ROBOT',
    minScore: 0,
    robotSpeed: 2.38,
    reactionDelay: 0.08,
    spinBlindness: 0.2,
    returnSpeed: 6.45,
    spinIntensity: 32,
    smashChance: 0.38,
    errorMargin: 0.075,
    eyeColor: 0xff004c,
    accentHex: '#ff1650',
  },
};

export function getStoryPhaseConfig(
  difficulty: Difficulty,
  stage: StoryStage
): ThreatPhaseConfig {
  return stage === 2 ? STORY_STAGE2_CONFIGS[difficulty] : DUEL_DIFFICULTIES[difficulty];
}
