import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import {
  checkSweptPaddleHit,
  clearSwipeMemory,
  computeEdgeJumpTargetX,
  createBallState,
  createSwipeMemory,
  CURVE_COYOTE_HOLD_S,
  CURVE_COYOTE_WINDOW_S,
  evaluateAutoSlowMo,
  predictBallAtZ,
  rememberedSwipeVelX,
  resolveCurveSwingVelX,
  solveBallisticShot,
  stepPhysics,
  swipeMemoryWeight,
  updateSwipeMemory,
  type PaddleState,
  type SwipeMemory,
} from '../src/game/physics';
import { computeGhostPaddleOpacity, projectNdcToZPlane } from '../src/game/sceneManager';
import { computeFloatingPopupOrigin } from '../src/game/visualEffects';
import { assetUrl } from '../src/game/assetUrl';
import { evaluateStoryMatchOutcome } from '../src/game/gameEngine';
import { DEFAULT_ROBOT_SKIN_ID, getRobotSkin, ROBOT_SKINS } from '../src/game/robotSkins';
import { DUEL_DIFFICULTIES, PLAYER_PADDLE, ROBOT, STORY_STAGE2_CONFIGS, TABLE } from '../src/game/constants';
import { RobotController } from '../src/game/robotRig';
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
    const robot = results.find((r) => r.file === 'robot.glb');
    expect(robot).toBeDefined();
    expect(robot!.triangles).toBeGreaterThan(4000);
    expect(robot!.textures).toBeGreaterThanOrEqual(2);

    const robotRef = results.find((r) => r.file === 'robot_reference.glb');
    expect(robotRef).toBeDefined();
    expect(robotRef!.triangles).toBeGreaterThan(8000);
    expect(robotRef!.textures).toBeGreaterThanOrEqual(2);

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
    expect(getRobotSkin('reference').modelUrl).toBe('/models/robot_reference.glb');
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
      winner: 'robot',
    });
    // Winning or losing Stage 2 ends the full Story Mode match
    expect(evaluateStoryMatchOutcome(2, 5, 2)).toEqual({
      action: 'game_over',
      winner: 'player',
    });
    expect(evaluateStoryMatchOutcome(2, 3, 5)).toEqual({
      action: 'game_over',
      winner: 'robot',
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
    const robotPaddle = makePaddle(0.95, 1.2, ROBOT.PADDLE_BASE_Z); // out of the way

    let bouncedRobot = false;
    let hitNetStop = false;
    for (let i = 0; i < 90; i++) {
      const evs = stepPhysics(ball, 1 / 60, { playerPaddle, robotPaddle });
      for (const e of evs) {
        if (e.type === 'table_bounce' && e.side === 'robot') bouncedRobot = true;
        if (e.type === 'net_hit' && !e.cleared) hitNetStop = true;
      }
      if (bouncedRobot) break;
    }

    expect(hitNetStop).toBe(false);
    expect(bouncedRobot).toBe(true);
  });

  it('detects double bounce on player side and awards point to Robot', () => {
    const ball = createBallState();
    ball.pos = { x: 0, y: TABLE.SURFACE_Y + 0.22, z: 0.7 };
    ball.vel = { x: 0, y: -1.8, z: 0.2 };
    ball.active = true;
    ball.lastHitBy = 'robot';

    const playerPaddle = makePaddle(0.95, 1.0, PLAYER_PADDLE.BASE_Z);
    const robotPaddle = makePaddle(0, 1.0, ROBOT.PADDLE_BASE_Z);

    let endEvent: { winner: string; reason: string } | null = null;
    for (let i = 0; i < 180 && !endEvent; i++) {
      const evs = stepPhysics(ball, 1 / 60, { playerPaddle, robotPaddle });
      for (const e of evs) {
        if (e.type === 'point_end') {
          endEvent = { winner: e.winner, reason: e.reason };
        }
      }
    }

    expect(endEvent).not.toBeNull();
    expect(endEvent!.winner).toBe('robot');
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
      robotPaddle: makePaddle(0, 1, ROBOT.PADDLE_BASE_Z),
    });

    expect(Number.isFinite(ball.pos.x)).toBe(true);
    expect(Number.isFinite(ball.pos.y)).toBe(true);
    expect(Number.isFinite(ball.pos.z)).toBe(true);
    expect(Math.abs(ball.pos.z)).toBeLessThan(1.5);
  });

  it('predicts incoming ball trajectory across Robot strike plane accurately', () => {
    const ball = createBallState();
    ball.pos = { x: 0.1, y: 1.05, z: 0.9 };
    ball.vel = solveBallisticShot(ball.pos, -0.25, -0.85, 0.56, { x: 10, y: 0, z: 0 });
    ball.spin = { x: 10, y: 0, z: 0 };
    ball.active = true;
    const pred = predictBallAtZ(ball, ROBOT.PADDLE_BASE_Z);
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

  it('triggers 1:1 Auto Slow-Mo only inside the near-miss ring (not when far away or lined up)', () => {
    const ball = createBallState();
    // Incoming ball ~0.18s from player strike plane heading to x = 0.45, y = 1.05
    ball.pos = { x: 0.45, y: 1.05, z: PLAYER_PADDLE.BASE_Z - 0.8 };
    ball.vel = { x: 0, y: 0.6, z: 4.5 };
    ball.active = true;
    ball.lastHitBy = 'robot';

    // 0.30m off-center -> missRatio ~ 1.40 (inside near-miss forgiveness ring 0.96..2.35)
    const nearMissPaddle = makePaddle(0.15, 1.05, PLAYER_PADDLE.BASE_Z);
    // 0.90m off-center -> missRatio ~ 4.19 (far-away misread, outside ring)
    const farMissPaddle = makePaddle(-0.45, 1.05, PLAYER_PADDLE.BASE_Z);
    // Lined up directly on predicted crossing point -> missRatio ~ 0
    const alignedPaddle = makePaddle(0.45, 1.05, PLAYER_PADDLE.BASE_Z);

    // 1) 1:1 ON + paddle just outside hitbox (near miss) -> triggers!
    const trig = evaluateAutoSlowMo({
      oneToOneMode: true,
      ball,
      playerPaddle: nearMissPaddle,
      alreadyLatched: false,
    });
    expect(trig.active).toBe(true);
    expect(trig.newlyTriggered).toBe(true);

    // 2) 1:1 ON + paddle far away from trajectory -> does NOT trigger!
    const tooFar = evaluateAutoSlowMo({
      oneToOneMode: true,
      ball,
      playerPaddle: farMissPaddle,
      alreadyLatched: false,
    });
    expect(tooFar.active).toBe(false);

    // 3) 1:1 OFF -> does NOT auto-trigger
    const disabled = evaluateAutoSlowMo({
      oneToOneMode: false,
      ball,
      playerPaddle: nearMissPaddle,
      alreadyLatched: false,
    });
    expect(disabled.active).toBe(false);

    // 4) Paddle already lined up to hit -> does NOT trigger
    const linedUp = evaluateAutoSlowMo({
      oneToOneMode: true,
      ball,
      playerPaddle: alignedPaddle,
      alreadyLatched: false,
    });
    expect(linedUp.active).toBe(false);

    // 5) Once latched, stays smoothly latched while aligning, then releases once ball passes paddle
    const held = evaluateAutoSlowMo({
      oneToOneMode: true,
      ball,
      playerPaddle: alignedPaddle,
      alreadyLatched: true,
    });
    expect(held.active).toBe(true);
    expect(held.newlyTriggered).toBe(false);

    ball.pos.z = PLAYER_PADDLE.BASE_Z + 0.15;
    const passed = evaluateAutoSlowMo({
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

  it('keeps MK-I EASY & Stage 2 APEX genuinely beatable via cross-court smashes while still returning straight shots', () => {
    const simulateShot = (
      phaseCfg: typeof DUEL_DIFFICULTIES.easy,
      robotStartX: number,
      targetX: number,
      flightTime: number,
      isSmash: boolean
    ): 'returned' | 'player_winner' | 'other' => {
      const dummyRoot = new THREE.Group();
      const dummyPaddle = new THREE.Group();
      const ctrl = new RobotController(dummyRoot, dummyPaddle);
      ctrl.paddleState.pos.x = robotStartX;
      ctrl.paddleState.prevPos.x = robotStartX;

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
          robotPaddle: ctrl.paddleState,
        });
        for (const ev of evs) {
          if (ev.type === 'paddle_hit' && ev.by === 'robot') return 'returned';
          if (ev.type === 'point_end' && ev.winner === 'player') return 'player_winner';
        }
      }
      return 'other';
    };

    // 1) Straight medium shot right at MK-I EASY is cleanly returned so rallies stay fun
    expect(simulateShot(DUEL_DIFFICULTIES.easy, 0.0, 0.02, 0.62, false)).toBe('returned');

    // 2) Cross-court Power Smash away from MK-I EASY's corner cleanly scores a winner!
    expect(simulateShot(DUEL_DIFFICULTIES.easy, -0.58, 0.62, 0.42, true)).toBe('player_winner');

    // 3) Cross-court Power Smash also beats Stage 2 APEX ROBOT (easy tier)!
    expect(simulateShot(STORY_STAGE2_CONFIGS.easy, -0.58, 0.64, 0.38, true)).toBe('player_winner');
  });

  it('auto-jumps horizontally to catch wide off-screen bounced shots when near the screen edge and vertically aligned', () => {
    const ball = createBallState();
    // Wide ball that ALREADY bounced on player's side and is angling off-screen to x = +1.55m
    ball.pos = { x: 1.05, y: 1.08, z: PLAYER_PADDLE.BASE_Z - 0.8 };
    ball.vel = { x: 2.5, y: 0.4, z: 4.0 };
    ball.active = true;
    ball.lastHitBy = 'robot';
    ball.bouncesOnPlayer = 1;

    // 1) Cursor near right edge + vertically aligned -> jumps horizontally straight onto predicted X (~1.53m)!
    const jump = computeEdgeJumpTargetX({
      ball,
      rawNdcX: 0.88,
      baseTargetX: 1.25,
      baseTargetY: 1.05,
      targetZ: PLAYER_PADDLE.BASE_Z,
    });
    expect(jump.active).toBe(true);
    expect(jump.targetX).toBeGreaterThan(1.38);
    expect(jump.targetX).toBeLessThan(1.75);

    // 2) Cursor near right edge, but vertical height is way off -> does NOT jump!
    const badHeight = computeEdgeJumpTargetX({
      ball,
      rawNdcX: 0.88,
      baseTargetX: 1.25,
      baseTargetY: 1.75,
      targetZ: PLAYER_PADDLE.BASE_Z,
    });
    expect(badHeight.active).toBe(false);

    // 3) Cursor near middle of screen -> does NOT jump!
    const centerCursor = computeEdgeJumpTargetX({
      ball,
      rawNdcX: 0.25,
      baseTargetX: 0.3,
      baseTargetY: 1.05,
      targetZ: PLAYER_PADDLE.BASE_Z,
    });
    expect(centerCursor.active).toBe(false);

    // 4) Cursor on opposite (left) edge -> does NOT jump!
    const wrongEdge = computeEdgeJumpTargetX({
      ball,
      rawNdcX: -0.9,
      baseTargetX: -1.25,
      baseTargetY: 1.05,
      targetZ: PLAYER_PADDLE.BASE_Z,
    });
    expect(wrongEdge.active).toBe(false);

    // 5) Unbounced Robot out-of-bounds fault flying wide (bouncesOnPlayer = 0) -> does NOT jump!
    ball.bouncesOnPlayer = 0;
    const outFault = computeEdgeJumpTargetX({
      ball,
      rawNdcX: 0.88,
      baseTargetX: 1.25,
      baseTargetY: 1.05,
      targetZ: PLAYER_PADDLE.BASE_Z,
    });
    expect(outFault.active).toBe(false);

    // 6) Striking a wide off-screen bounced ball at x = +1.55m returns cleanly onto Robot's table half!
    ball.bouncesOnPlayer = 1;
    const edgePaddle = makePaddle(jump.targetX, 1.05, PLAYER_PADDLE.BASE_Z);
    edgePaddle.vel.x = 2.0; // clamped during auto-jump
    const farRobot = makePaddle(-0.95, 1.0, ROBOT.PADDLE_BASE_Z);
    let hitByPlayer = false;
    let landedOnRobot = false;
    for (let i = 0; i < 120; i++) {
      const evs = stepPhysics(ball, 1 / 60, {
        playerPaddle: edgePaddle,
        robotPaddle: farRobot,
      });
      for (const ev of evs) {
        if (ev.type === 'paddle_hit' && ev.by === 'player') hitByPlayer = true;
        if (ev.type === 'table_bounce' && ev.side === 'robot') landedOnRobot = true;
      }
      if (landedOnRobot) break;
    }
    expect(hitByPlayer).toBe(true);
    expect(landedOnRobot).toBe(true);
  });

  it('hides the ghost visual on brief non-edge desyncs, shows clearly without glow when flicked to edge or sustained, and lets the invisible ghost hitbox catch balls', () => {
    const anchor = { x: 0.85, y: 1.05, z: PLAYER_PADDLE.BASE_Z };
    // 1) Normal rapid swipe lag (active=false): completely hidden
    expect(
      computeGhostPaddleOpacity({ x: 1.45, y: 1.05, z: PLAYER_PADDLE.BASE_Z }, anchor, false, 0.5)
    ).toBe(0);
    // 2) Brief non-edge desync (0.05s < 0.10s, x=1.05 <= 1.12): stays invisible!
    expect(
      computeGhostPaddleOpacity({ x: 1.05, y: 1.05, z: PLAYER_PADDLE.BASE_Z }, anchor, true, 0.05)
    ).toBe(0);
    // 3) Paddle flicked to/off screen edge (x=1.45 > 1.12): clearly visible at non-glowing max opacity (0.46)
    expect(
      computeGhostPaddleOpacity({ x: 1.45, y: 1.05, z: PLAYER_PADDLE.BASE_Z }, anchor, true, 0.03)
    ).toBeCloseTo(0.46, 2);
    // 4) Sustained edge-jump desync (0.25s >= 0.10s, sep=0.20m): clearly visible (~0.25)
    expect(
      computeGhostPaddleOpacity({ x: 1.05, y: 1.05, z: PLAYER_PADDLE.BASE_Z }, anchor, true, 0.25)
    ).toBeGreaterThan(0.2);

    // 5) Invisible ghost second hitbox catches a ball at cursor position even while primary paddle is desynced!
    const ball = createBallState();
    ball.pos = { x: 0.42, y: 1.05, z: PLAYER_PADDLE.BASE_Z - 0.08 };
    ball.vel = { x: 0, y: 0.2, z: 6.5 };
    ball.active = true;
    ball.lastHitBy = 'robot';

    const laggingPrimaryPaddle = makePaddle(-0.3, 1.05, PLAYER_PADDLE.BASE_Z); // still catching up!
    const invisibleGhostCursor = makePaddle(0.42, 1.05, PLAYER_PADDLE.BASE_Z); // right on cursor!
    const farRobot = makePaddle(-0.9, 1.0, ROBOT.PADDLE_BASE_Z);

    const evs = stepPhysics(ball, 1 / 60, {
      playerPaddle: laggingPrimaryPaddle,
      ghostPlayerPaddle: invisibleGhostCursor,
      robotPaddle: farRobot,
    });
    const playerHit = evs.find((e) => e.type === 'paddle_hit' && e.by === 'player');
    expect(playerHit).toBeDefined();
    expect(ball.vel.z).toBeLessThan(0); // returned cleanly back toward Robot!
  });
});

describe('Curve Coyote Time', () => {
  const FRAME = 1 / 60;
  // Sideways paddle speed at which a hit starts counting as a curve shot (|spinY| >= 12, spinY = v * 5.8)
  const CURVE_MIN_SWING = 12 / 5.8;

  /** A ball flying straight into a paddle, then followed to its first bounce. */
  function strike(paddle: PaddleState) {
    const ball = createBallState();
    ball.pos = { x: 0, y: 1.05, z: PLAYER_PADDLE.BASE_Z - 0.08 };
    ball.vel = { x: 0, y: 0.2, z: 6.5 };
    ball.active = true;
    ball.lastHitBy = 'robot';
    const robotPaddle = makePaddle(-0.95, 1.0, ROBOT.PADDLE_BASE_Z); // out of the way

    const first = stepPhysics(ball, FRAME, { playerPaddle: paddle, robotPaddle });
    const hit = first.find((e) => e.type === 'paddle_hit' && e.by === 'player');
    if (!hit || hit.type !== 'paddle_hit') throw new Error('expected the player paddle to strike the ball');

    // null when the shot never touches the table (e.g. a deliberate overswing that sails wide)
    let landing: { side: string; x: number; z: number } | null = null;
    for (let i = 0; i < 240 && !landing; i++) {
      for (const e of stepPhysics(ball, FRAME, { playerPaddle: paddle, robotPaddle })) {
        if (e.type === 'table_bounce' && !landing) landing = { side: e.side, x: e.pos.x, z: e.pos.z };
      }
    }
    return { hit, landing };
  }

  function strikeAndLand(paddle: PaddleState) {
    const res = strike(paddle);
    if (!res.landing) throw new Error('expected the returned ball to bounce on the table');
    return { hit: res.hit, landing: res.landing };
  }

  function stillPaddle(memory?: SwipeMemory, liveVelX = 0): PaddleState {
    const paddle = makePaddle(0, 1.05, PLAYER_PADDLE.BASE_Z);
    paddle.vel.x = liveVelX;
    if (memory) paddle.swipeMemory = memory;
    return paddle;
  }

  it('remembers a swipe at full strength briefly, then fades it out completely', () => {
    expect(swipeMemoryWeight(0)).toBe(1);
    expect(swipeMemoryWeight(CURVE_COYOTE_HOLD_S)).toBe(1);
    expect(swipeMemoryWeight(CURVE_COYOTE_WINDOW_S)).toBe(0);
    expect(swipeMemoryWeight(1)).toBe(0);

    // Strictly decreasing between hold and window
    let prev = 1;
    for (let age = CURVE_COYOTE_HOLD_S + 0.005; age < CURVE_COYOTE_WINDOW_S; age += 0.005) {
      const w = swipeMemoryWeight(age);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThan(prev);
      prev = w;
    }

    // The window is deliberately small: a grace period, not an aim assist
    expect(CURVE_COYOTE_WINDOW_S).toBeLessThanOrEqual(0.15);

    // Nonsense ages never count
    expect(swipeMemoryWeight(-0.01)).toBe(0);
    expect(swipeMemoryWeight(Number.NaN)).toBe(0);
    expect(swipeMemoryWeight(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('keeps the strongest recent swipe, lets a stronger one replace it, and forgets it after the window', () => {
    const mem = createSwipeMemory();
    expect(rememberedSwipeVelX(mem)).toBe(0);

    updateSwipeMemory(mem, 5, FRAME);
    expect(mem).toEqual({ velX: 5, age: 0 });

    // Hand stops: weaker live readings do not overwrite the remembered swipe, they only age it
    updateSwipeMemory(mem, 2.25, FRAME);
    updateSwipeMemory(mem, 1.0, FRAME);
    expect(mem.velX).toBe(5);
    expect(mem.age).toBeCloseTo(2 * FRAME, 6);
    expect(rememberedSwipeVelX(mem)).toBe(5);

    // A stronger swipe the other way takes over immediately
    updateSwipeMemory(mem, -6, FRAME);
    expect(mem).toEqual({ velX: -6, age: 0 });

    // Left alone, it expires and the memory falls back to the (tiny) live reading
    for (let t = 0; t < CURVE_COYOTE_WINDOW_S + 0.05; t += FRAME) updateSwipeMemory(mem, 0.1, FRAME);
    expect(rememberedSwipeVelX(mem)).toBeCloseTo(0.1, 6);

    // Bad inputs never corrupt the memory
    const safe = createSwipeMemory();
    updateSwipeMemory(safe, 4, FRAME);
    updateSwipeMemory(safe, 1, Number.NaN); // unusable dt: no ageing, weaker reading ignored
    updateSwipeMemory(safe, 1, -5);
    updateSwipeMemory(safe, 1, 0);
    expect(safe).toEqual({ velX: 4, age: 0 });
    updateSwipeMemory(safe, Number.NaN, FRAME); // unusable velocity: time still passes, swipe is kept
    expect(safe.velX).toBe(4);
    expect(safe.age).toBeCloseTo(FRAME, 6);
    expect(Number.isFinite(rememberedSwipeVelX(safe))).toBe(true);

    clearSwipeMemory(safe);
    expect(safe).toEqual({ velX: 0, age: 0 });
  });

  it('extends the curve window from about one frame to a few frames after a swipe ends', () => {
    // The engine smooths paddle velocity, so once the hand stops the live reading collapses by x0.45 per frame
    const framesStillCurving = (swipe: number, withMemory: boolean): number => {
      const mem = createSwipeMemory();
      let live = swipe;
      updateSwipeMemory(mem, live, FRAME);
      let frames = 0;
      for (let i = 0; i < 30; i++) {
        live *= 0.45;
        updateSwipeMemory(mem, live, FRAME);
        const swing = resolveCurveSwingVelX(live, withMemory ? mem : undefined);
        if (Math.abs(swing) < CURVE_MIN_SWING) break;
        frames++;
      }
      return frames;
    };

    for (const swipe of [3, 4, 5.5, 7]) {
      const before = framesStillCurving(swipe, false);
      const after = framesStillCurving(swipe, true);
      expect(before).toBeLessThanOrEqual(1);
      expect(after).toBeGreaterThanOrEqual(3);
      // Subtle: never more than the window allows (0.13 s is under 8 frames at 60 fps)
      expect(after * FRAME).toBeLessThan(CURVE_COYOTE_WINDOW_S);
    }
    // A stronger swipe earns a little more grace than a weak one, never less
    expect(framesStillCurving(7, true)).toBeGreaterThanOrEqual(framesStillCurving(3, true));
  });

  it('curves the ball when contact lands just after the swipe, and not once the window has passed', () => {
    const none = strike(stillPaddle());
    expect(none.hit.curve).toBe(false);
    expect(none.hit.spinY).toBeCloseTo(0, 6);

    // Swipe ended 30 ms ago: full-strength curve even though the paddle is no longer moving
    const fresh = strike(stillPaddle({ velX: 5, age: 0.03 }));
    expect(fresh.hit.curve).toBe(true);
    expect(fresh.hit.spinY).toBeCloseTo(29, 4);

    // Mirrored for a swipe the other way
    const freshLeft = strike(stillPaddle({ velX: -5, age: 0.03 }));
    expect(freshLeft.hit.curve).toBe(true);
    expect(freshLeft.hit.spinY).toBeCloseTo(-29, 4);

    // 90 ms ago: still a curve, but weaker
    const fading = strike(stillPaddle({ velX: 5, age: 0.09 }));
    expect(fading.hit.curve).toBe(true);
    expect(Math.abs(fading.hit.spinY)).toBeLessThan(Math.abs(fresh.hit.spinY));
    expect(Math.abs(fading.hit.spinY)).toBeGreaterThanOrEqual(12);

    // 200 ms ago: too late, no curve
    const stale = strike(stillPaddle({ velX: 5, age: 0.2 }));
    expect(stale.hit.curve).toBe(false);
    expect(stale.hit.spinY).toBeCloseTo(0, 6);
  });

  it('never weakens or overrides a live swipe, and leaves paddles without a memory unchanged', () => {
    // A live swipe stronger than the remembered one wins
    expect(strike(stillPaddle({ velX: 3, age: 0.02 }, 6)).hit.spinY).toBeCloseTo(32, 4);

    // A remembered swipe beats a small live wobble in the opposite direction
    expect(strike(stillPaddle({ velX: 5, age: 0.02 }, -0.4)).hit.spinY).toBeCloseTo(29, 4);

    // Paddles with no memory behave exactly as before
    expect(strike(stillPaddle(undefined, 3)).hit.spinY).toBeCloseTo(3 * 5.8, 4);
    expect(resolveCurveSwingVelX(3)).toBe(3);
    expect(resolveCurveSwingVelX(99)).toBe(7);
    expect(resolveCurveSwingVelX(0, { velX: 99, age: 0 })).toBe(7);
    expect(resolveCurveSwingVelX(0, { velX: -99, age: 0 })).toBe(-7);
  });

  it('only adds curve: a remembered swipe does not move where the shot lands or push it off the table', () => {
    const baseline = strikeAndLand(stillPaddle());
    expect(baseline.landing.side).toBe('robot');

    for (const velX of [-7, -5, -2.5, 2.5, 5, 7]) {
      for (const age of [0, 0.03, 0.05, 0.08, 0.11]) {
        const res = strikeAndLand(stillPaddle({ velX, age }));
        expect(res.landing.side).toBe('robot');
        expect(Math.abs(res.landing.x)).toBeLessThanOrEqual(TABLE.HALF_WIDTH);
        // Same aim as the no-swipe shot, give or take the solver's curve approximation
        expect(Math.abs(res.landing.x - baseline.landing.x)).toBeLessThan(0.2);
        expect(Math.abs(res.landing.z - baseline.landing.z)).toBeLessThan(0.2);
      }
    }
  });
});

describe('Asset URL resolution', () => {
  it('resolves model paths against the base the app is served from (root, sub-path, or relative)', () => {
    // Domain root (Node server / dev)
    expect(assetUrl('/models/table.glb', '/')).toBe('/models/table.glb');
    // Relative base used by the production build — works under any sub-path
    expect(assetUrl('/models/table.glb', './')).toBe('./models/table.glb');
    // Explicit sub-path, with and without a trailing slash
    expect(assetUrl('/models/table.glb', '/some-repo/')).toBe('/some-repo/models/table.glb');
    expect(assetUrl('/models/table.glb', '/some-repo')).toBe('/some-repo/models/table.glb');
    // Never doubles or drops slashes whatever the input looks like
    expect(assetUrl('models/table.glb', './')).toBe('./models/table.glb');
    expect(assetUrl('//models/table.glb', '/')).toBe('/models/table.glb');
    // Default base comes from the build configuration and always ends in a slash
    expect(assetUrl('/models/table.glb')).toMatch(/^(\.\/|\/)models\/table\.glb$/);
  });
});

describe('Leaderboard Persistence & Validation', () => {
  it('sanitizes XSS/invalid callsigns and rejects out-of-range payloads', () => {
    expect(sanitizeCallsign('<script>ace!</script>')).toBe('SCRIPTACESCRIPT');
    expect(sanitizeCallsign('  player_99  ')).toBe('PLAYER_99');

    const badEmpty = validateEntryPayload({ name: '   ', mode: 'arcade', score: 100 });
    expect(badEmpty.ok).toBe(false);

    const badScore = validateEntryPayload({ name: 'ACE', mode: 'arcade', score: -50 });
    expect(badScore.ok).toBe(false);

    const badMode = validateEntryPayload({ name: 'ACE', mode: 'invalid', score: 500 });
    expect(badMode.ok).toBe(false);
  });

  it('accepts only the current difficulty values, rejects anything else, and defaults only when omitted', () => {
    const base = { name: 'ACE', mode: 'duel', score: 500 };

    for (const diff of ['easy', 'medium', 'hard', 'overdrive']) {
      const res = validateEntryPayload({ ...base, difficulty: diff });
      expect(res.ok).toBe(true);
      expect(res.entry?.difficulty).toBe(diff);
    }
    // Case-insensitive, stored lowercase
    expect(validateEntryPayload({ ...base, difficulty: 'HARD' }).entry?.difficulty).toBe('hard');

    // Unrecognised values are rejected outright — never stored, never remapped to a default
    for (const bad of ['nightmare', 'retired-tier', '', ' easy', 3, true, {}, ['easy']]) {
      const res = validateEntryPayload({ ...base, difficulty: bad });
      expect(res.ok).toBe(false);
      expect(res.entry).toBeUndefined();
      expect(res.error).toMatch(/Difficulty/);
    }

    // Omitted (or null) difficulty keeps the per-mode default
    expect(validateEntryPayload(base).entry?.difficulty).toBe('medium');
    expect(validateEntryPayload({ ...base, difficulty: null }).entry?.difficulty).toBe('medium');
    expect(validateEntryPayload({ ...base, mode: 'arcade' }).entry?.difficulty).toBe('overdrive');
  });

  it('starts empty of generated scores, persists & ranks personal scores, strips legacy seeds, and recovers from corrupt JSON', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-lb-'));
    const dataFile = path.join(tmpDir, 'leaderboard.json');

    try {
      const store = new LeaderboardStore(dataFile);
      const initial = await store.list('arcade', 10);
      expect(initial.entries.length).toBe(0);

      // Submit concurrent personal high scores
      const [r1, r2] = await Promise.all([
        store.submit({ name: 'ACE_ONE', mode: 'arcade', score: 99000, bestRally: 42, maxPhase: 4 }),
        store.submit({ name: 'ACE_TWO', mode: 'arcade', score: 55000, bestRally: 31, maxPhase: 4 }),
      ]);
      expect(r1.ok).toBe(true);
      expect(r1.rank).toBe(1);
      expect(r1.isTopRecord).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r2.rank).toBe(2);

      // Verify legacy generated seed-* entries are stripped while preserving real personal scores
      await fs.writeFile(
        dataFile,
        JSON.stringify({
          version: 1,
          entries: {
            arcade: [
              { id: 'seed-arc-1', name: 'FAKE_BOT', mode: 'arcade', score: 999999, createdAt: '2026-01-01T00:00:00Z' },
              { id: 'real-1', name: 'NYAA', mode: 'arcade', score: 7670, createdAt: '2026-11-23T04:37:34Z' },
            ],
            duel: [],
          },
        }),
        'utf8'
      );
      const cleaned = await store.list('arcade', 10);
      expect(cleaned.entries.length).toBe(1);
      expect(cleaned.entries[0].name).toBe('NYAA');

      // Corrupt the JSON file intentionally and verify automatic recovery to clean empty list
      await fs.writeFile(dataFile, '{corrupted_json!!!', 'utf8');
      const recovered = await store.list('arcade', 10);
      expect(recovered.recovered).toBe(true);
      expect(recovered.entries.length).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
