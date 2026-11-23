import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import {
  checkSweptPaddleHit,
  createBallState,
  evaluateAutoBulletTime,
  predictBallAtZ,
  solveBallisticShot,
  stepPhysics,
  type PaddleState,
} from '../src/game/physics';
import { projectNdcToZPlane } from '../src/game/sceneManager';
import { computeFloatingPopupOrigin } from '../src/game/matrixEffects';
import { evaluateStoryMatchOutcome } from '../src/game/gameEngine';
import { DEFAULT_ROBOT_SKIN_ID, getRobotSkin, ROBOT_SKINS } from '../src/game/robotSkins';
import { DUEL_DIFFICULTIES, PLAYER_PADDLE, SENTINEL, STORY_STAGE2_CONFIGS, TABLE } from '../src/game/constants';
import { SentinelController } from '../src/game/sentinelRig';
import {
  LeaderboardStore,
  sanitizeCallsign,
  validateEntryPayload,
} from '../server/leaderboardStore.mjs';
import { verifyAllModels } from '../scripts/verify-models.mjs';

function makePaddle(x: number, y: number, z: number): PaddleState {
  return {
    pos: { x, y, z },
    prevPos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    smashCharge: 0,
  };
}

describe('Constructed 3D GLB Model Integrity', () => {
  it('verifies all 7 binary GLB models exist, conform to glTF 2.0, and expose required nodes', () => {
    const results = verifyAllModels();
    expect(results.length).toBe(7);
    for (const model of results) {
      expect(model.triangles).toBeGreaterThan(300);
      expect(model.nodes).toBeGreaterThan(1);
      expect(model.materials).toBeGreaterThan(0);
    }
    const sentinel = results.find((r) => r.file === 'sentinel.glb');
    expect(sentinel).toBeDefined();
    expect(sentinel!.triangles).toBeGreaterThan(4000);
    expect(sentinel!.textures).toBeGreaterThanOrEqual(2);

    const sentinelRef = results.find((r) => r.file === 'sentinel_reference.glb');
    expect(sentinelRef).toBeDefined();
    expect(sentinelRef!.triangles).toBeGreaterThan(8000);
    expect(sentinelRef!.textures).toBeGreaterThanOrEqual(2);

    const cityscape = results.find((r) => r.file === 'cityscape_expansion.glb');
    expect(cityscape).toBeDefined();
    expect(cityscape!.triangles).toBeGreaterThan(8000);
    expect(cityscape!.textures).toBeGreaterThanOrEqual(2);
  });

  it('resolves robot skin registry with classic as default and graceful fallback on unknown IDs', () => {
    expect(DEFAULT_ROBOT_SKIN_ID).toBe('classic');
    expect(ROBOT_SKINS.length).toBeGreaterThanOrEqual(2);
    expect(getRobotSkin(null).id).toBe('classic');
    expect(getRobotSkin('does-not-exist').id).toBe('classic');
    expect(getRobotSkin('reference').modelUrl).toBe('/models/sentinel_reference.glb');
  });

  it('evaluates Story Mode Stage 1 -> Stage 2 surprise cutscene & deuce rules accurately', () => {
    // 4-4 deuce continues
    expect(evaluateStoryMatchOutcome(1, 4, 4).action).toBe('continue');
    expect(evaluateStoryMatchOutcome(1, 5, 4).action).toBe('continue');
    // Winning Stage 1 (5-3 or 6-4) triggers the surprise Stage 2 cutscene!
    expect(evaluateStoryMatchOutcome(1, 5, 3)).toEqual({
      action: 'trigger_stage2_cutscene',
      winner: 'player',
    });
    expect(evaluateStoryMatchOutcome(1, 6, 4)).toEqual({
      action: 'trigger_stage2_cutscene',
      winner: 'player',
    });
    // Losing Stage 1 ends game cleanly without spoiling Stage 2
    expect(evaluateStoryMatchOutcome(1, 2, 5)).toEqual({
      action: 'game_over',
      winner: 'sentinel',
    });
    // Winning or losing Stage 2 ends the full Story Mode match
    expect(evaluateStoryMatchOutcome(2, 5, 2)).toEqual({
      action: 'game_over',
      winner: 'player',
    });
    expect(evaluateStoryMatchOutcome(2, 3, 5)).toEqual({
      action: 'game_over',
      winner: 'sentinel',
    });
  });
});

describe('3D Table Tennis Physics Engine', () => {
  it('prevents fast-ball tunneling via swept paddle collision', () => {
    const paddle = makePaddle(0, 1.0, PLAYER_PADDLE.BASE_Z);
    // Ball travels 0.65m across the paddle plane in a single fast step
    const prev = { x: 0.02, y: 1.01, z: PLAYER_PADDLE.BASE_Z - 0.35 };
    const curr = { x: 0.02, y: 1.01, z: PLAYER_PADDLE.BASE_Z + 0.3 };
    const res = checkSweptPaddleHit(prev, curr, paddle, 'player');
    expect(res.hit).toBe(true);
    expect(Math.abs(res.offsetX)).toBeLessThan(0.05);
  });

  it('solves a ballistic arc that clears the net and bounces on the opponent table half', () => {
    const ball = createBallState();
    const origin = { x: 0.2, y: TABLE.SURFACE_Y + 0.28, z: 1.32 };
    const vel = solveBallisticShot(origin, -0.32, -0.82, 0.58, { x: 14, y: 8, z: 0 });
    ball.pos = { ...origin };
    ball.vel = vel;
    ball.spin = { x: 14, y: 8, z: 0 };
    ball.active = true;
    ball.lastHitBy = 'player';

    const playerPaddle = makePaddle(0.8, 1.0, PLAYER_PADDLE.BASE_Z);
    const sentinelPaddle = makePaddle(0.95, 1.2, SENTINEL.PADDLE_BASE_Z); // out of the way

    let bouncedSentinel = false;
    let hitNetStop = false;
    for (let i = 0; i < 90; i++) {
      const evs = stepPhysics(ball, 1 / 60, { playerPaddle, sentinelPaddle });
      for (const e of evs) {
        if (e.type === 'table_bounce' && e.side === 'sentinel') bouncedSentinel = true;
        if (e.type === 'net_hit' && !e.cleared) hitNetStop = true;
      }
      if (bouncedSentinel) break;
    }

    expect(hitNetStop).toBe(false);
    expect(bouncedSentinel).toBe(true);
  });

  it('detects double bounce on player side and awards point to Sentinel', () => {
    const ball = createBallState();
    ball.pos = { x: 0, y: TABLE.SURFACE_Y + 0.22, z: 0.7 };
    ball.vel = { x: 0, y: -1.8, z: 0.2 };
    ball.active = true;
    ball.lastHitBy = 'sentinel';

    const playerPaddle = makePaddle(0.95, 1.0, PLAYER_PADDLE.BASE_Z);
    const sentinelPaddle = makePaddle(0, 1.0, SENTINEL.PADDLE_BASE_Z);

    let endEvent: { winner: string; reason: string } | null = null;
    for (let i = 0; i < 180 && !endEvent; i++) {
      const evs = stepPhysics(ball, 1 / 60, { playerPaddle, sentinelPaddle });
      for (const e of evs) {
        if (e.type === 'point_end') {
          endEvent = { winner: e.winner, reason: e.reason };
        }
      }
    }

    expect(endEvent).not.toBeNull();
    expect(endEvent!.winner).toBe('sentinel');
    expect(endEvent!.reason).toBe('double_bounce');
  });

  it('clamps extreme dt spikes safely without producing NaN coordinates', () => {
    const ball = createBallState();
    ball.pos = { x: 0, y: 1.0, z: 0.4 };
    ball.vel = { x: 2.0, y: 1.0, z: -4.0 };
    ball.active = true;
    ball.lastHitBy = 'player';

    stepPhysics(ball, 12.5, {
      playerPaddle: makePaddle(0, 1, PLAYER_PADDLE.BASE_Z),
      sentinelPaddle: makePaddle(0, 1, SENTINEL.PADDLE_BASE_Z),
    });

    expect(Number.isFinite(ball.pos.x)).toBe(true);
    expect(Number.isFinite(ball.pos.y)).toBe(true);
    expect(Number.isFinite(ball.pos.z)).toBe(true);
    expect(Math.abs(ball.pos.z)).toBeLessThan(1.5);
  });

  it('predicts incoming ball trajectory across Sentinel strike plane accurately', () => {
    const ball = createBallState();
    ball.pos = { x: 0.1, y: 1.05, z: 0.9 };
    ball.vel = solveBallisticShot(ball.pos, -0.25, -0.85, 0.56, { x: 10, y: 0, z: 0 });
    ball.spin = { x: 10, y: 0, z: 0 };
    ball.active = true;
    const pred = predictBallAtZ(ball, SENTINEL.PADDLE_BASE_Z);
    expect(pred.willReach).toBe(true);
    expect(pred.time).toBeGreaterThan(0.2);
    expect(Math.abs(pred.x)).toBeLessThan(1.2);
  });

  it('projects 1:1 cursor NDC coordinates accurately onto the strike plane and handles behind-camera planes', () => {
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.08, 60);
    cam.position.set(0, 1.66, 2.56);
    cam.lookAt(0, TABLE.SURFACE_Y + 0.34, -0.95);
    cam.updateProjectionMatrix();

    const bottom = projectNdcToZPlane(cam, 0, -0.8, PLAYER_PADDLE.BASE_Z);
    const top = projectNdcToZPlane(cam, 0, 0.8, PLAYER_PADDLE.BASE_Z);
    const right = projectNdcToZPlane(cam, 0.7, 0, PLAYER_PADDLE.BASE_Z);

    expect(bottom).not.toBeNull();
    expect(top).not.toBeNull();
    expect(right).not.toBeNull();
    // Vertical span in 1:1 mode covers far more than the old 0.72m range
    expect(top!.y - bottom!.y).toBeGreaterThan(0.8);
    expect(right!.x).toBeGreaterThan(0.5);

    // Plane behind the camera must safely return null instead of inverted coordinates
    const behind = projectNdcToZPlane(cam, 0, 0, 5.0);
    expect(behind).toBeNull();
  });

  it('triggers 1:1 Auto Bullet Time only inside the near-miss ring (not when far away or lined up)', () => {
    const ball = createBallState();
    // Incoming ball ~0.18s from player strike plane heading to x = 0.45, y = 1.05
    ball.pos = { x: 0.45, y: 1.05, z: PLAYER_PADDLE.BASE_Z - 0.8 };
    ball.vel = { x: 0, y: 0.6, z: 4.5 };
    ball.active = true;
    ball.lastHitBy = 'sentinel';

    // 0.30m off-center -> missRatio ~ 1.40 (inside near-miss forgiveness ring 0.96..2.35)
    const nearMissPaddle = makePaddle(0.15, 1.05, PLAYER_PADDLE.BASE_Z);
    // 0.90m off-center -> missRatio ~ 4.19 (far-away misread, outside ring)
    const farMissPaddle = makePaddle(-0.45, 1.05, PLAYER_PADDLE.BASE_Z);
    // Lined up directly on predicted crossing point -> missRatio ~ 0
    const alignedPaddle = makePaddle(0.45, 1.05, PLAYER_PADDLE.BASE_Z);

    // 1) 1:1 ON + paddle just outside hitbox (near miss) -> triggers!
    const trig = evaluateAutoBulletTime({
      oneToOneMode: true,
      ball,
      playerPaddle: nearMissPaddle,
      alreadyLatched: false,
    });
    expect(trig.active).toBe(true);
    expect(trig.newlyTriggered).toBe(true);

    // 2) 1:1 ON + paddle far away from trajectory -> does NOT trigger!
    const tooFar = evaluateAutoBulletTime({
      oneToOneMode: true,
      ball,
      playerPaddle: farMissPaddle,
      alreadyLatched: false,
    });
    expect(tooFar.active).toBe(false);

    // 3) 1:1 OFF -> does NOT auto-trigger
    const disabled = evaluateAutoBulletTime({
      oneToOneMode: false,
      ball,
      playerPaddle: nearMissPaddle,
      alreadyLatched: false,
    });
    expect(disabled.active).toBe(false);

    // 4) Paddle already lined up to hit -> does NOT trigger
    const linedUp = evaluateAutoBulletTime({
      oneToOneMode: true,
      ball,
      playerPaddle: alignedPaddle,
      alreadyLatched: false,
    });
    expect(linedUp.active).toBe(false);

    // 5) Once latched, stays smoothly latched while aligning, then releases once ball passes paddle
    const held = evaluateAutoBulletTime({
      oneToOneMode: true,
      ball,
      playerPaddle: alignedPaddle,
      alreadyLatched: true,
    });
    expect(held.active).toBe(true);
    expect(held.newlyTriggered).toBe(false);

    ball.pos.z = PLAYER_PADDLE.BASE_Z + 0.15;
    const passed = evaluateAutoBulletTime({
      oneToOneMode: true,
      ball,
      playerPaddle: nearMissPaddle,
      alreadyLatched: true,
    });
    expect(passed.active).toBe(false);
  });

  it('positions 3D floating point popups outward beside paddles and staggers stacked hits', () => {
    const rightPaddle = computeFloatingPopupOrigin(
      { x: 0.35, y: 1.0, z: PLAYER_PADDLE.BASE_Z },
      { side: 'player', stackIndex: 0 }
    );
    const stacked = computeFloatingPopupOrigin(
      { x: 0.35, y: 1.0, z: PLAYER_PADDLE.BASE_Z },
      { side: 'player', stackIndex: 1 }
    );
    const leftPaddle = computeFloatingPopupOrigin(
      { x: -0.35, y: 1.0, z: PLAYER_PADDLE.BASE_Z },
      { side: 'player', stackIndex: 0 }
    );

    // Nudged outward away from center sightline & above paddle
    expect(rightPaddle.x).toBeGreaterThan(0.5);
    expect(leftPaddle.x).toBeLessThan(-0.5);
    expect(rightPaddle.y).toBeGreaterThan(1.1);
    expect(stacked.y).toBeGreaterThan(rightPaddle.y);
  });

  it('keeps MK-I SCOUT & Stage 2 APEX genuinely beatable via cross-court smashes while still returning straight shots', () => {
    const simulateShot = (
      phaseCfg: typeof DUEL_DIFFICULTIES.scout,
      sentinelStartX: number,
      targetX: number,
      flightTime: number,
      isSmash: boolean
    ): 'returned' | 'player_winner' | 'other' => {
      const dummyRoot = new THREE.Group();
      const dummyPaddle = new THREE.Group();
      const ctrl = new SentinelController(dummyRoot, dummyPaddle);
      ctrl.paddleState.pos.x = sentinelStartX;
      ctrl.paddleState.prevPos.x = sentinelStartX;

      const ball = createBallState();
      const origin = { x: 0.1, y: TABLE.SURFACE_Y + 0.3, z: 1.32 };
      ball.pos = { ...origin };
      ball.spin = { x: isSmash ? 22 : 10, y: 0, z: 0 };
      ball.vel = solveBallisticShot(origin, targetX, -0.95, flightTime, ball.spin);
      ball.active = true;
      ball.lastHitBy = 'player';
      ball.isPlayerSmash = isSmash;
      ctrl.notifyPlayerHit();

      const outOfWayPlayer = makePaddle(1.1, 1.0, PLAYER_PADDLE.BASE_Z);
      for (let i = 0; i < 160; i++) {
        ctrl.update(1 / 60, ball, phaseCfg, true);
        const evs = stepPhysics(ball, 1 / 60, {
          playerPaddle: outOfWayPlayer,
          sentinelPaddle: ctrl.paddleState,
        });
        for (const ev of evs) {
          if (ev.type === 'paddle_hit' && ev.by === 'sentinel') return 'returned';
          if (ev.type === 'point_end' && ev.winner === 'player') return 'player_winner';
        }
      }
      return 'other';
    };

    // 1) Straight medium shot right at MK-I SCOUT is cleanly returned so rallies stay fun
    expect(simulateShot(DUEL_DIFFICULTIES.scout, 0.0, 0.02, 0.62, false)).toBe('returned');

    // 2) Cross-court Power Smash away from MK-I SCOUT's corner cleanly scores a winner!
    expect(simulateShot(DUEL_DIFFICULTIES.scout, -0.58, 0.62, 0.42, true)).toBe('player_winner');

    // 3) Cross-court Power Smash also beats Stage 2 APEX SENTINEL (scout tier)!
    expect(simulateShot(STORY_STAGE2_CONFIGS.scout, -0.58, 0.64, 0.38, true)).toBe('player_winner');
  });
});

describe('Leaderboard Persistence & Validation', () => {
  it('sanitizes XSS/invalid callsigns and rejects out-of-range payloads', () => {
    expect(sanitizeCallsign('<script>neo!</script>')).toBe('SCRIPTNEOSCRIPT');
    expect(sanitizeCallsign('  trinity_99  ')).toBe('TRINITY_99');

    const badEmpty = validateEntryPayload({ name: '   ', mode: 'arcade', score: 100 });
    expect(badEmpty.ok).toBe(false);

    const badScore = validateEntryPayload({ name: 'NEO', mode: 'arcade', score: -50 });
    expect(badScore.ok).toBe(false);

    const badMode = validateEntryPayload({ name: 'NEO', mode: 'invalid', score: 500 });
    expect(badMode.ok).toBe(false);
  });

  it('persists, ranks, handles concurrent submits, and recovers from corrupt JSON', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-lb-'));
    const dataFile = path.join(tmpDir, 'leaderboard.json');

    try {
      const store = new LeaderboardStore(dataFile);
      const initial = await store.list('arcade', 10);
      expect(initial.entries.length).toBeGreaterThanOrEqual(4);

      // Submit concurrent high scores
      const [r1, r2] = await Promise.all([
        store.submit({ name: 'ACE_ONE', mode: 'arcade', score: 99000, bestRally: 42, maxPhase: 4 }),
        store.submit({ name: 'ACE_TWO', mode: 'arcade', score: 55000, bestRally: 31, maxPhase: 4 }),
      ]);
      expect(r1.ok).toBe(true);
      expect(r1.rank).toBe(1);
      expect(r1.isTopRecord).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r2.rank).toBe(2);

      // Corrupt the JSON file intentionally and verify automatic recovery
      await fs.writeFile(dataFile, '{corrupted_json!!!', 'utf8');
      const recovered = await store.list('arcade', 10);
      expect(recovered.recovered).toBe(true);
      expect(recovered.entries.length).toBeGreaterThanOrEqual(4);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
