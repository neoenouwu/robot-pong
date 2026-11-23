import { BALL, PLAYER_PADDLE, SENTINEL, TABLE } from './constants';

export type Side = 'player' | 'sentinel';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface PaddleState {
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3; // m/s smoothed
  smashCharge: number; // 0..1
}

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  spin: Vec3; // rad/s (y = sidespin curve, x = topspin/backspin)
  active: boolean;
  lastHitBy: Side | null;
  bouncesOnPlayer: number;
  bouncesOnSentinel: number;
  hitCooldown: number;
  isCrimsonSmash: boolean;
  isPlayerSmash: boolean;
  isCurveShot: boolean;
  stuckTimer: number;
}

export type PhysicsEvent =
  | {
      type: 'table_bounce';
      side: Side;
      pos: Vec3;
      speed: number;
      bounceCount: number;
    }
  | {
      type: 'net_hit';
      pos: Vec3;
      cleared: boolean;
    }
  | {
      type: 'paddle_hit';
      by: Side;
      pos: Vec3;
      speed: number;
      perfect: boolean;
      smash: boolean;
      curve: boolean;
      counterSmash: boolean;
      spinY: number;
    }
  | {
      type: 'point_end';
      winner: Side;
      reason: 'double_bounce' | 'out' | 'net_fault' | 'missed' | 'timeout';
      pos: Vec3;
    };

export function createBallState(): BallState {
  return {
    pos: { x: 0, y: TABLE.SURFACE_Y + 0.25, z: 0.9 },
    vel: { x: 0, y: 0, z: 0 },
    spin: { x: 0, y: 0, z: 0 },
    active: false,
    lastHitBy: null,
    bouncesOnPlayer: 0,
    bouncesOnSentinel: 0,
    hitCooldown: 0,
    isCrimsonSmash: false,
    isPlayerSmash: false,
    isCurveShot: false,
    stuckTimer: 0,
  };
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Computes an authentic physics-driven parabolic velocity (with drag & Magnus compensation)
 * from `origin` to land near `(targetX, TABLE.SURFACE_Y + BALL.RADIUS, targetZ)`
 * in `flightTime` seconds, guaranteeing net clearance unless intentionally clipped.
 */
export function solveBallisticShot(
  origin: Vec3,
  targetX: number,
  targetZ: number,
  flightTime: number,
  spin: Vec3,
  minNetClearance = 0.055
): Vec3 {
  const T = clamp(flightTime, 0.24, 1.35);
  const targetY = TABLE.SURFACE_Y + BALL.RADIUS;

  // First-order drag factor: integral of exp(-k*t) dt ~ T * (1 - 0.5*k*T)
  const dragComp = 1 / Math.max(0.65, 1 - 0.48 * BALL.AIR_DRAG * T);

  // Estimate average lateral Magnus drift over flightTime:
  // a_x ~ MAGNUS_COEFF * spin.y * vz
  const approxVz = ((targetZ - origin.z) / T) * dragComp;
  const approxMagnusAx = BALL.MAGNUS_COEFF * spin.y * approxVz;
  const magnusDriftX = 0.5 * approxMagnusAx * T * T;

  // Estimate vertical Magnus dip from topspin (spin.x):
  // positive spin.x with negative vz (player -> sentinel) pushes ball DOWN (classic topspin dive!)
  const magnusAy = BALL.MAGNUS_COEFF * spin.x * approxVz;
  const effG = BALL.GRAVITY + magnusAy;

  const vx = ((targetX - origin.x - magnusDriftX) / T) * dragComp;
  const vz = approxVz;
  let vy = (targetY - origin.y - 0.5 * effG * T * T) / T;

  // Verify net clearance when crossing z = 0
  if ((origin.z > 0 && targetZ < 0) || (origin.z < 0 && targetZ > 0)) {
    const tNet = clamp(-origin.z / (targetZ - origin.z), 0.1, 0.9) * T;
    const yAtNet = origin.y + vy * tNet + 0.5 * effG * tNet * tNet;
    const requiredY = TABLE.NET_TOP_Y + BALL.RADIUS + minNetClearance;
    if (yAtNet < requiredY) {
      vy += (requiredY - yAtNet) / tNet;
    }
  }

  return { x: vx, y: vy, z: vz };
}

/**
 * Predicts where an incoming ball will cross `targetZ` (used by both AI and trajectory HUD).
 */
export function predictBallAtZ(ball: BallState, targetZ: number): {
  willReach: boolean;
  time: number;
  x: number;
  y: number;
} {
  if (!ball.active) return { willReach: false, time: 0, x: 0, y: TABLE.SURFACE_Y + 0.25 };
  const dz = targetZ - ball.pos.z;
  if (Math.abs(ball.vel.z) < 0.05 || dz * ball.vel.z <= 0) {
    return { willReach: false, time: 0, x: ball.pos.x, y: ball.pos.y };
  }

  // Forward simulate up to 2.2s in coarse 1/120s steps so bounces & Magnus curve are accurately predicted!
  let px = ball.pos.x;
  let py = ball.pos.y;
  let pz = ball.pos.z;
  let vx = ball.vel.x;
  let vy = ball.vel.y;
  let vz = ball.vel.z;
  let sx = ball.spin.x;
  let sy = ball.spin.y;

  const step = 1 / 120;
  const maxSteps = 264;
  for (let i = 0; i < maxSteps; i++) {
    const prevZ = pz;
    const ax = -BALL.AIR_DRAG * vx + BALL.MAGNUS_COEFF * sy * vz;
    const ay = BALL.GRAVITY - BALL.AIR_DRAG * vy + BALL.MAGNUS_COEFF * sx * vz;
    const az = -BALL.AIR_DRAG * vz - BALL.MAGNUS_COEFF * sy * vx;

    vx += ax * step;
    vy += ay * step;
    vz += az * step;
    px += vx * step;
    py += vy * step;
    pz += vz * step;

    // Bounce on table
    if (
      py <= TABLE.SURFACE_Y + BALL.RADIUS &&
      vy < 0 &&
      Math.abs(px) <= TABLE.HALF_WIDTH + BALL.RADIUS &&
      Math.abs(pz) <= TABLE.HALF_LENGTH + BALL.RADIUS
    ) {
      py = TABLE.SURFACE_Y + BALL.RADIUS;
      vy = -vy * BALL.TABLE_RESTITUTION;
      vx += sy * 0.015;
      sx *= 0.72;
      sy *= 0.8;
    }

    const crossed =
      (prevZ >= targetZ && pz <= targetZ) || (prevZ <= targetZ && pz >= targetZ);
    if (crossed) {
      return {
        willReach: true,
        time: (i + 1) * step,
        x: px,
        y: clamp(py, TABLE.SURFACE_Y + 0.04, 2.2),
      };
    }

    if (py < 0.1 || Math.abs(pz) > 4.2) break;
  }

  return { willReach: false, time: 0, x: px, y: py };
}

export interface AutoBulletTimeInput {
  oneToOneMode: boolean;
  ball: BallState;
  playerPaddle: PaddleState;
  alreadyLatched: boolean;
}

export const AUTO_BULLET_TIME_NEAR_MISS_MIN_RATIO = 0.96;
export const AUTO_BULLET_TIME_NEAR_MISS_MAX_RATIO = 2.35;

/**
 * Determines whether 1:1 Auto Bullet Time should engage or stay latched
 * when an incoming ball's predicted crossing point is just outside the paddle
 * (within the near-miss forgiveness ring) rather than far away or already lined up.
 */
export function evaluateAutoBulletTime(input: AutoBulletTimeInput): {
  active: boolean;
  newlyTriggered: boolean;
} {
  const { oneToOneMode, ball, playerPaddle, alreadyLatched } = input;

  if (
    !oneToOneMode ||
    !ball.active ||
    ball.lastHitBy === 'player' ||
    ball.vel.z <= 0.25 ||
    ball.pos.z > playerPaddle.pos.z + 0.08
  ) {
    return { active: false, newlyTriggered: false };
  }

  // Keep latched until hit or passed behind paddle (avoids mid-save speed jerk)
  if (alreadyLatched) {
    return { active: true, newlyTriggered: false };
  }

  const pred = predictBallAtZ(ball, playerPaddle.pos.z);
  if (!pred.willReach || pred.time <= 0 || pred.time > 0.34) {
    return { active: false, newlyTriggered: false };
  }

  // Don't slow down balls flying outside the playable court zone
  if (
    Math.abs(pred.x) > 1.32 ||
    pred.y < TABLE.SURFACE_Y - 0.05 ||
    pred.y > 1.96
  ) {
    return { active: false, newlyTriggered: false };
  }

  const missRatio = Math.hypot(
    (pred.x - playerPaddle.pos.x) / PLAYER_PADDLE.HIT_RADIUS_X,
    (pred.y - playerPaddle.pos.y) / PLAYER_PADDLE.HIT_RADIUS_Y
  );

  // Only reward near-misses within range of the paddle — not far-away misreads or already-lined-up hits
  if (
    missRatio > AUTO_BULLET_TIME_NEAR_MISS_MIN_RATIO &&
    missRatio <= AUTO_BULLET_TIME_NEAR_MISS_MAX_RATIO
  ) {
    return { active: true, newlyTriggered: true };
  }

  return { active: false, newlyTriggered: false };
}

/**
 * Continuous swept plane-crossing hit test between a moving ball segment and a moving paddle.
 * Prevents high-speed balls from ever tunneling through the paddle.
 */
export function checkSweptPaddleHit(
  prevBall: Vec3,
  currBall: Vec3,
  paddle: PaddleState,
  side: Side
): { hit: boolean; hitPos: Vec3; offsetX: number; offsetY: number; dist: number } {
  const paddleZ = paddle.pos.z;
  const prevPaddleZ = paddle.prevPos.z;
  const rx = side === 'player' ? PLAYER_PADDLE.HIT_RADIUS_X : SENTINEL.HIT_RADIUS_X;
  const ry = side === 'player' ? PLAYER_PADDLE.HIT_RADIUS_Y : SENTINEL.HIT_RADIUS_Y;
  const thickness = side === 'player' ? 0.155 : 0.17;

  // Relative Z signed distance before and after substep
  const d0 = prevBall.z - prevPaddleZ;
  const d1 = currBall.z - paddleZ;

  // Did ball cross or overlap the paddle slab moving toward this side?
  const movingTowardSide =
    side === 'player' ? currBall.z >= prevBall.z - 0.002 : currBall.z <= prevBall.z + 0.002;
  if (!movingTowardSide) {
    return { hit: false, hitPos: currBall, offsetX: 0, offsetY: 0, dist: 999 };
  }

  let t = -1;
  if ((d0 <= 0 && d1 >= 0) || (d0 >= 0 && d1 <= 0)) {
    const denom = d1 - d0;
    t = Math.abs(denom) > 1e-6 ? clamp(-d0 / denom, 0, 1) : 0.5;
  } else if (Math.abs(d1) <= thickness) {
    t = 1;
  } else if (Math.abs(d0) <= thickness) {
    t = 0;
  }

  if (t < 0) {
    return { hit: false, hitPos: currBall, offsetX: 0, offsetY: 0, dist: 999 };
  }

  const bx = prevBall.x + (currBall.x - prevBall.x) * t;
  const by = prevBall.y + (currBall.y - prevBall.y) * t;
  const bz = prevBall.z + (currBall.z - prevBall.z) * t;

  const px = paddle.prevPos.x + (paddle.pos.x - paddle.prevPos.x) * t;
  const py = paddle.prevPos.y + (paddle.pos.y - paddle.prevPos.y) * t;

  const dx = bx - px;
  const dy = by - py;
  const normDist = Math.hypot(dx / rx, dy / ry);

  if (normDist <= 1.0) {
    return {
      hit: true,
      hitPos: { x: bx, y: by, z: bz },
      offsetX: dx,
      offsetY: dy,
      dist: Math.hypot(dx, dy),
    };
  }

  return { hit: false, hitPos: currBall, offsetX: dx, offsetY: dy, dist: Math.hypot(dx, dy) };
}

export interface StepOptions {
  playerPaddle: PaddleState;
  sentinelPaddle: PaddleState;
  sentinelReturnFn?: (ball: BallState, hitPos: Vec3) => {
    targetX: number;
    targetZ: number;
    flightTime: number;
    spin: Vec3;
    isSmash: boolean;
  };
}

/**
 * Advances ball physics using sub-stepped fixed integration (max 1/240s per substep).
 * Returns all events generated during this frame.
 */
export function stepPhysics(ball: BallState, rawDt: number, opts: StepOptions): PhysicsEvent[] {
  const events: PhysicsEvent[] = [];
  if (!ball.active) return events;

  // Clamp dt strictly so tab switches or lag spikes can never explode physics
  const dt = clamp(Number.isFinite(rawDt) ? rawDt : 0, 0, 0.05);
  if (dt <= 0) return events;

  const substeps = Math.max(4, Math.ceil(dt / (1 / 240)));
  const h = dt / substeps;

  for (let s = 0; s < substeps; s++) {
    if (!ball.active) break;

    if (ball.hitCooldown > 0) {
      ball.hitCooldown = Math.max(0, ball.hitCooldown - h);
    }

    const prevPos: Vec3 = { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z };

    // Forces: gravity + air drag + Magnus spin force
    const ax = -BALL.AIR_DRAG * ball.vel.x + BALL.MAGNUS_COEFF * ball.spin.y * ball.vel.z;
    const ay =
      BALL.GRAVITY - BALL.AIR_DRAG * ball.vel.y + BALL.MAGNUS_COEFF * ball.spin.x * ball.vel.z;
    const az = -BALL.AIR_DRAG * ball.vel.z - BALL.MAGNUS_COEFF * ball.spin.y * ball.vel.x;

    ball.vel.x += ax * h;
    ball.vel.y += ay * h;
    ball.vel.z += az * h;

    ball.pos.x += ball.vel.x * h;
    ball.pos.y += ball.vel.y * h;
    ball.pos.z += ball.vel.z * h;

    // Spin decays gently in air
    const spinDecay = Math.exp(-0.35 * h);
    ball.spin.x *= spinDecay;
    ball.spin.y *= spinDecay;
    ball.spin.z *= spinDecay;

    // 1. Net collision check (crossing z = 0)
    const crossedNet =
      (prevPos.z > 0 && ball.pos.z <= 0) || (prevPos.z < 0 && ball.pos.z >= 0);
    if (crossedNet && Math.abs(ball.pos.x) <= TABLE.NET_HALF_WIDTH + BALL.RADIUS) {
      const denom = ball.pos.z - prevPos.z;
      const tNet = Math.abs(denom) > 1e-6 ? clamp(-prevPos.z / denom, 0, 1) : 0.5;
      const yAtNet = prevPos.y + (ball.pos.y - prevPos.y) * tNet;

      if (yAtNet < TABLE.NET_TOP_Y + BALL.RADIUS && yAtNet >= TABLE.SURFACE_Y - 0.02) {
        const nearTopTape = yAtNet >= TABLE.NET_TOP_Y - 0.028;
        if (nearTopTape) {
          // Exciting net-cord clip: slows down and pops slightly upward over the net!
          ball.vel.z *= 0.52;
          ball.vel.y = Math.max(ball.vel.y * 0.45, 1.35);
          ball.vel.x *= 0.72;
          ball.pos.y = TABLE.NET_TOP_Y + BALL.RADIUS + 0.008;
          events.push({
            type: 'net_hit',
            pos: { x: ball.pos.x, y: yAtNet, z: 0 },
            cleared: true,
          });
        } else {
          // Solid net stop: rebounds back
          ball.pos.z = prevPos.z > 0 ? BALL.RADIUS + 0.005 : -(BALL.RADIUS + 0.005);
          ball.vel.z = -ball.vel.z * BALL.NET_RESTITUTION;
          ball.vel.x *= 0.45;
          ball.vel.y = Math.min(ball.vel.y * 0.3, 0.35);
          events.push({
            type: 'net_hit',
            pos: { x: ball.pos.x, y: yAtNet, z: 0 },
            cleared: false,
          });
        }
      }
    }

    // 2. Table bounce check
    const onTableXZ =
      Math.abs(ball.pos.x) <= TABLE.HALF_WIDTH + BALL.RADIUS * 0.9 &&
      Math.abs(ball.pos.z) <= TABLE.HALF_LENGTH + BALL.RADIUS * 0.9;
    if (onTableXZ && prevPos.y >= TABLE.SURFACE_Y + BALL.RADIUS - 0.035 && ball.pos.y <= TABLE.SURFACE_Y + BALL.RADIUS && ball.vel.y < 0) {
      ball.pos.y = TABLE.SURFACE_Y + BALL.RADIUS;
      const impactSpeed = Math.abs(ball.vel.y);
      ball.vel.y = Math.max(impactSpeed * BALL.TABLE_RESTITUTION, 0.35);
      // Spin-table kick
      ball.vel.x += ball.spin.y * 0.018;
      ball.vel.z += (ball.lastHitBy === 'player' ? -1 : 1) * Math.max(0, ball.spin.x) * 0.012;
      ball.spin.x *= 0.72;
      ball.spin.y *= 0.78;

      const side: Side = ball.pos.z >= 0 ? 'player' : 'sentinel';
      if (side === 'player') {
        ball.bouncesOnPlayer += 1;
      } else {
        ball.bouncesOnSentinel += 1;
      }

      const bounceCount = side === 'player' ? ball.bouncesOnPlayer : ball.bouncesOnSentinel;
      events.push({
        type: 'table_bounce',
        side,
        pos: { x: ball.pos.x, y: TABLE.SURFACE_Y, z: ball.pos.z },
        speed: impactSpeed,
        bounceCount,
      });

      // Double bounce rule: whoever let it bounce twice on their side loses the point!
      if (bounceCount >= 2) {
        ball.active = false;
        events.push({
          type: 'point_end',
          winner: side === 'player' ? 'sentinel' : 'player',
          reason: 'double_bounce',
          pos: { ...ball.pos },
        });
        break;
      }

      // If a player hit the ball directly onto their OWN side (excluding initial serve toss handled externally)
      if (ball.lastHitBy === side && bounceCount >= 1) {
        // Only penalize if it already failed to clear the net
        if (Math.abs(ball.vel.z) < 0.8) {
          ball.active = false;
          events.push({
            type: 'point_end',
            winner: side === 'player' ? 'sentinel' : 'player',
            reason: 'net_fault',
            pos: { ...ball.pos },
          });
          break;
        }
      }
    }

    // 3. Player paddle swept collision check
    if (ball.hitCooldown <= 0 && ball.lastHitBy !== 'player' && ball.vel.z > 0.1) {
      const hitRes = checkSweptPaddleHit(prevPos, ball.pos, opts.playerPaddle, 'player');
      if (hitRes.hit) {
        const paddleVel = opts.playerPaddle.vel;
        const swingHoriz = clamp(paddleVel.x, -7, 7);
        const swingForward = clamp(-paddleVel.z, -2, 6);
        const smashCharge = clamp(opts.playerPaddle.smashCharge, 0, 1);

        const perfect = hitRes.dist <= PLAYER_PADDLE.SWEET_SPOT_RADIUS;
        const counterSmash = ball.isCrimsonSmash;
        const isSmash =
          smashCharge >= 0.45 ||
          swingForward > 2.3 ||
          (perfect && hitRes.hitPos.y > TABLE.SURFACE_Y + 0.34);

        // Aim target on Sentinel half based on paddle position, horizontal swipe, and contact offset
        let targetX =
          hitRes.hitPos.x * 0.42 + swingHoriz * 0.145 + hitRes.offsetX * 1.4;
        // Keep well-aimed shots crisp while allowing wild overswings to risk going wide
        const overSwing = Math.abs(swingHoriz) > 5.8 ? (Math.abs(swingHoriz) - 5.8) * 0.12 : 0;
        targetX = clamp(
          targetX + Math.sign(swingHoriz || 1) * overSwing,
          -TABLE.HALF_WIDTH * 1.06,
          TABLE.HALF_WIDTH * 1.06
        );
        // Clamp fair regular shots inside table corners unless wildly overswung
        if (Math.abs(swingHoriz) <= 5.8) {
          targetX = clamp(targetX, -TABLE.HALF_WIDTH + 0.08, TABLE.HALF_WIDTH - 0.08);
        }

        const powerFactor = clamp(
          0.35 + smashCharge * 0.55 + Math.max(0, swingForward) * 0.12 + (perfect ? 0.15 : 0),
          0.25,
          1.15
        );
        const targetZ = clamp(-0.55 - powerFactor * 0.68, -TABLE.HALF_LENGTH + 0.09, -0.34);
        const flightTime = clamp(
          (isSmash ? 0.42 : 0.63) - powerFactor * 0.13 - (counterSmash ? 0.05 : 0),
          0.31,
          0.74
        );

        const spinY = clamp(swingHoriz * 5.8, -32, 32);
        const spinX = clamp((isSmash ? 24 : 12) + Math.max(0, paddleVel.y) * 5, -14, 34);
        const isCurve = Math.abs(spinY) >= 12;

        const newVel = solveBallisticShot(
          hitRes.hitPos,
          targetX,
          targetZ,
          flightTime,
          { x: spinX, y: spinY, z: 0 },
          isSmash ? 0.032 : 0.068
        );

        ball.pos.x = hitRes.hitPos.x;
        ball.pos.y = hitRes.hitPos.y;
        ball.pos.z = Math.min(hitRes.hitPos.z, opts.playerPaddle.pos.z - 0.035);
        ball.vel = newVel;
        ball.spin = { x: spinX, y: spinY, z: 0 };
        ball.lastHitBy = 'player';
        ball.bouncesOnPlayer = 0;
        ball.bouncesOnSentinel = 0;
        ball.hitCooldown = 0.12;
        ball.isPlayerSmash = isSmash;
        ball.isCrimsonSmash = false;
        ball.isCurveShot = isCurve;
        ball.stuckTimer = 0;

        events.push({
          type: 'paddle_hit',
          by: 'player',
          pos: { ...ball.pos },
          speed: Math.hypot(newVel.x, newVel.y, newVel.z),
          perfect,
          smash: isSmash,
          curve: isCurve,
          counterSmash,
          spinY,
        });
        continue;
      }
    }

    // 4. Sentinel paddle swept collision check
    if (
      ball.hitCooldown <= 0 &&
      ball.lastHitBy !== 'sentinel' &&
      ball.vel.z < -0.1 &&
      ball.bouncesOnSentinel >= 1
    ) {
      const hitRes = checkSweptPaddleHit(prevPos, ball.pos, opts.sentinelPaddle, 'sentinel');
      if (hitRes.hit) {
        const plan = opts.sentinelReturnFn
          ? opts.sentinelReturnFn(ball, hitRes.hitPos)
          : {
              targetX: clamp(-hitRes.hitPos.x * 0.6, -0.58, 0.58),
              targetZ: 0.92,
              flightTime: 0.62,
              spin: { x: 10, y: 0, z: 0 },
              isSmash: false,
            };

        const newVel = solveBallisticShot(
          hitRes.hitPos,
          plan.targetX,
          plan.targetZ,
          plan.flightTime,
          plan.spin,
          plan.isSmash ? 0.035 : 0.075
        );

        ball.pos.x = hitRes.hitPos.x;
        ball.pos.y = hitRes.hitPos.y;
        ball.pos.z = Math.max(hitRes.hitPos.z, opts.sentinelPaddle.pos.z + 0.04);
        ball.vel = newVel;
        ball.spin = { ...plan.spin };
        ball.lastHitBy = 'sentinel';
        ball.bouncesOnPlayer = 0;
        ball.bouncesOnSentinel = 0;
        ball.hitCooldown = 0.14;
        ball.isCrimsonSmash = plan.isSmash;
        ball.isPlayerSmash = false;
        ball.isCurveShot = Math.abs(plan.spin.y) >= 12;
        ball.stuckTimer = 0;

        events.push({
          type: 'paddle_hit',
          by: 'sentinel',
          pos: { ...ball.pos },
          speed: Math.hypot(newVel.x, newVel.y, newVel.z),
          perfect: plan.isSmash,
          smash: plan.isSmash,
          curve: ball.isCurveShot,
          counterSmash: false,
          spinY: plan.spin.y,
        });
        continue;
      }
    }

    // 5. Out-of-bounds / floor / missed ball detection
    const fellBelowTable = ball.pos.y < TABLE.SURFACE_Y - 0.34;
    const farBehindPlayer = ball.pos.z > TABLE.HALF_LENGTH + 1.15;
    const farBehindSentinel = ball.pos.z < -(TABLE.HALF_LENGTH + 1.15);
    const farWide = Math.abs(ball.pos.x) > TABLE.HALF_WIDTH + 1.4;

    if (fellBelowTable || farBehindPlayer || farBehindSentinel || farWide) {
      ball.active = false;
      let winner: Side;
      let reason: 'out' | 'missed' = 'out';

      if (ball.lastHitBy === 'player') {
        // Player hit it: if it bounced on Sentinel's side first, player scored a winner!
        // Otherwise it flew out without touching Sentinel's half -> Sentinel's point.
        if (ball.bouncesOnSentinel >= 1) {
          winner = 'player';
          reason = 'missed';
        } else {
          winner = 'sentinel';
          reason = 'out';
        }
      } else if (ball.lastHitBy === 'sentinel') {
        if (ball.bouncesOnPlayer >= 1) {
          winner = 'sentinel';
          reason = 'missed';
        } else {
          winner = 'player';
          reason = 'out';
        }
      } else {
        winner = ball.pos.z > 0 ? 'sentinel' : 'player';
      }

      events.push({
        type: 'point_end',
        winner,
        reason,
        pos: { ...ball.pos },
      });
      break;
    }

    // 6. Stuck / zero-velocity safety watchdog
    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
    if (speed < 0.12) {
      ball.stuckTimer += h;
      if (ball.stuckTimer > 1.25) {
        ball.active = false;
        events.push({
          type: 'point_end',
          winner: ball.pos.z >= 0 ? 'sentinel' : 'player',
          reason: 'timeout',
          pos: { ...ball.pos },
        });
        break;
      }
    } else {
      ball.stuckTimer = 0;
    }
  }

  return events;
}
