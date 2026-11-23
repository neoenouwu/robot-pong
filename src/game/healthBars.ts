import { STORY_POINTS_TO_WIN } from './constants';

export interface HealthBarSide {
  /** Filled segments, 0..STORY_POINTS_TO_WIN. 0 means the match is lost. */
  segments: number;
  /** True when the last segment will break on the next point conceded. */
  cracked: boolean;
}

export interface StoryHealthBars {
  player: HealthBarSide;
  robot: HealthBarSide;
  /** Both sides have reached STORY_POINTS_TO_WIN - 1 points (win-by-2 phase). */
  deuce: boolean;
}

function clampSegments(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

/**
 * Maps a Story mode score to fighting-game style health bars.
 *
 * Normal phase: each point conceded removes one segment from the side that conceded.
 * Deuce phase (both sides at N-1 or more): both sides sit on their last segment; the
 * side trailing by one has that segment cracked, and a side trailing by two is out.
 */
export function computeStoryHealthBars(
  playerPoints: number,
  robotPoints: number,
  pointsToWin: number = STORY_POINTS_TO_WIN
): StoryHealthBars {
  const p = Math.max(0, Math.floor(playerPoints));
  const r = Math.max(0, Math.floor(robotPoints));
  const n = pointsToWin;
  const deuce = p >= n - 1 && r >= n - 1;

  if (!deuce) {
    return {
      player: { segments: clampSegments(n - r, n), cracked: false },
      robot: { segments: clampSegments(n - p, n), cracked: false },
      deuce: false,
    };
  }

  const diff = p - r;
  return {
    player: { segments: diff <= -2 ? 0 : 1, cracked: diff === -1 },
    robot: { segments: diff >= 2 ? 0 : 1, cracked: diff === 1 },
    deuce: true,
  };
}
