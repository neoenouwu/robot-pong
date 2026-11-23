import { describe, expect, it } from 'vitest';
import { STORY_POINTS_TO_WIN } from '../src/game/constants';
import { evaluateStoryMatchOutcome } from '../src/game/gameEngine';
import { computeStoryHealthBars } from '../src/game/healthBars';

const N = STORY_POINTS_TO_WIN;

describe('computeStoryHealthBars', () => {
  it('starts with full bars on both sides', () => {
    expect(computeStoryHealthBars(0, 0)).toEqual({
      player: { segments: N, cracked: false },
      robot: { segments: N, cracked: false },
      deuce: false,
    });
  });

  it('removes one segment from the side that concedes in the normal phase', () => {
    expect(computeStoryHealthBars(0, 1).player).toEqual({ segments: N - 1, cracked: false });
    expect(computeStoryHealthBars(0, 1).robot).toEqual({ segments: N, cracked: false });
    expect(computeStoryHealthBars(2, 0).robot).toEqual({ segments: N - 2, cracked: false });
    const mid = computeStoryHealthBars(3, 2);
    expect(mid.player).toEqual({ segments: N - 2, cracked: false });
    expect(mid.robot).toEqual({ segments: N - 3, cracked: false });
    expect(mid.deuce).toBe(false);
    // One side at N-1 but not the other is still the normal phase.
    const nearly = computeStoryHealthBars(N - 1, 0);
    expect(nearly.deuce).toBe(false);
    expect(nearly.robot).toEqual({ segments: 1, cracked: false });
    expect(nearly.player).toEqual({ segments: N, cracked: false });
  });

  it('shows both sides on an intact last segment when level in deuce', () => {
    for (const p of [N - 1, N, N + 1, N + 4]) {
      expect(computeStoryHealthBars(p, p)).toEqual({
        player: { segments: 1, cracked: false },
        robot: { segments: 1, cracked: false },
        deuce: true,
      });
    }
  });

  it('cracks the robot last segment when the player leads by one in deuce', () => {
    for (const r of [N - 1, N, N + 3]) {
      expect(computeStoryHealthBars(r + 1, r)).toEqual({
        player: { segments: 1, cracked: false },
        robot: { segments: 1, cracked: true },
        deuce: true,
      });
    }
  });

  it('cracks the player last segment when the robot leads by one in deuce', () => {
    for (const p of [N - 1, N, N + 3]) {
      expect(computeStoryHealthBars(p, p + 1)).toEqual({
        player: { segments: 1, cracked: true },
        robot: { segments: 1, cracked: false },
        deuce: true,
      });
    }
  });

  it('knocks out the trailing side', () => {
    expect(computeStoryHealthBars(N, 0).robot).toEqual({ segments: 0, cracked: false });
    expect(computeStoryHealthBars(N, 0).player.segments).toBe(N);
    expect(computeStoryHealthBars(2, N).player).toEqual({ segments: 0, cracked: false });
    expect(computeStoryHealthBars(2, N).robot.segments).toBe(N - 2);
    expect(computeStoryHealthBars(N + 2, N)).toEqual({
      player: { segments: 1, cracked: false },
      robot: { segments: 0, cracked: false },
      deuce: true,
    });
    expect(computeStoryHealthBars(N - 1, N + 1).player).toEqual({ segments: 0, cracked: false });
  });

  it('keeps segments within 0..N', () => {
    for (let p = 0; p <= 9; p++) {
      for (let r = 0; r <= 9; r++) {
        const bars = computeStoryHealthBars(p, r);
        for (const side of [bars.player, bars.robot]) {
          expect(side.segments).toBeGreaterThanOrEqual(0);
          expect(side.segments).toBeLessThanOrEqual(N);
          if (side.cracked) expect(side.segments).toBe(1);
        }
      }
    }
  });

  it('shows 0 segments exactly when evaluateStoryMatchOutcome decides against that side', () => {
    for (const stage of [1, 2] as const) {
      for (let p = 0; p <= 9; p++) {
        for (let r = 0; r <= 9; r++) {
          const outcome = evaluateStoryMatchOutcome(stage, p, r);
          const bars = computeStoryHealthBars(p, r);
          const decided = outcome.action !== 'continue';
          expect(bars.player.segments === 0, `player ${p}-${r}`).toBe(
            decided && outcome.winner === 'robot'
          );
          expect(bars.robot.segments === 0, `robot ${p}-${r}`).toBe(
            decided && outcome.winner === 'player'
          );
        }
      }
    }
  });
});
