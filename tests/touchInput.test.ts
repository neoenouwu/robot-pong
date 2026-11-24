import { describe, expect, it } from 'vitest';
import {
  applyTouchReach,
  isTouchTap,
  mapTouchToNdc,
  TOUCH_PORTRAIT_MAX_FOV,
  TOUCH_PORTRAIT_MAX_PULLBACK,
  TOUCH_REACH_X,
  TOUCH_TAP_MAX_MS,
  TOUCH_TAP_SLOP_PX,
  touchPortraitCameraPullback,
  touchPortraitFov,
  touchReachGain,
  touchSteerOffsetPx,
  TouchTracker,
} from '../src/game/touchInput';

const RALLY = { rally: true, playerServe: false };
const SERVE = { rally: false, playerServe: true };

describe('touch steering offset', () => {
  it('scales with the play area and stays within sensible bounds', () => {
    expect(touchSteerOffsetPx(844)).toBeCloseTo(84.4, 5);
    expect(touchSteerOffsetPx(390)).toBe(48);
    expect(touchSteerOffsetPx(2000)).toBe(88);
    expect(touchSteerOffsetPx(100)).toBe(25);
    expect(touchSteerOffsetPx(0)).toBe(0);
    expect(touchSteerOffsetPx(Number.NaN)).toBe(0);
  });
});

describe('mapTouchToNdc', () => {
  const W = 390;
  const H = 844;
  const OFF = 80;

  it('aims above the finger away from the bottom edge', () => {
    const plain = mapTouchToNdc(195, 500, W, H, 0);
    const aimed = mapTouchToNdc(195, 500, W, H, OFF);
    expect(aimed.ndcX).toBeCloseTo(plain.ndcX, 9);
    expect(aimed.ndcY - plain.ndcY).toBeCloseTo((2 * OFF) / H, 9);
  });

  it('leaves the horizontal mapping identical to a mouse', () => {
    expect(mapTouchToNdc(0, 400, W, H, OFF).ndcX).toBe(-1);
    expect(mapTouchToNdc(W, 400, W, H, OFF).ndcX).toBe(1);
    expect(mapTouchToNdc(W / 4, 400, W, H, OFF).ndcX).toBeCloseTo(-0.5, 9);
  });

  it('reaches the bottom edge and the top edge', () => {
    expect(mapTouchToNdc(100, H, W, H, OFF).ndcY).toBe(-1);
    expect(mapTouchToNdc(100, OFF, W, H, OFF).ndcY).toBe(1);
    expect(mapTouchToNdc(100, 0, W, H, OFF).ndcY).toBe(1);
  });

  it('is continuous and never moves the aim the wrong way (every mouse aim point is reachable)', () => {
    let prev = -Infinity;
    let maxStep = 0;
    for (let y = H; y >= 0; y -= 0.5) {
      const ndcY = mapTouchToNdc(100, y, W, H, OFF).ndcY;
      expect(ndcY).toBeGreaterThanOrEqual(prev);
      if (prev !== -Infinity) maxStep = Math.max(maxStep, ndcY - prev);
      prev = ndcY;
    }
    // Steepest part is the bottom ramp: twice the finger's movement, never a jump
    expect(maxStep).toBeLessThanOrEqual((2 * 2 * 0.5) / H + 1e-9);
  });

  it('keeps the aim at or above the finger everywhere', () => {
    for (let y = 0; y <= H; y += 7) {
      const fingerNdcY = -((y / H) * 2 - 1);
      expect(mapTouchToNdc(100, y, W, H, OFF).ndcY).toBeGreaterThanOrEqual(fingerNdcY - 1e-9);
    }
  });

  it('handles degenerate sizes safely', () => {
    expect(mapTouchToNdc(10, 10, 0, 0, OFF)).toEqual({ ndcX: 0, ndcY: 0 });
    expect(mapTouchToNdc(-50, H + 50, W, H, OFF)).toEqual({ ndcX: -1, ndcY: -1 });
  });
});

describe('TouchTracker', () => {
  it('lets the first finger steer without charging a smash during a rally', () => {
    const t = new TouchTracker();
    const first = t.down(1, 100, 600, 0, true, RALLY);
    expect(first.role).toBe('steer');
    expect(first.charging).toBe(false);
    expect(t.isCharging()).toBe(false);
    expect(t.move(1, 160, 560)).toBe(true);
    expect(t.isCharging()).toBe(false);
  });

  it('makes a second finger hold a charge, and never steer', () => {
    const t = new TouchTracker();
    t.down(1, 100, 600, 0, true, RALLY);
    const second = t.down(2, 300, 300, 50, false, RALLY);
    expect(second.role).toBe('charge');
    expect(t.isCharging()).toBe(true);
    expect(t.move(2, 10, 10)).toBe(false);
    expect(t.steeringId()).toBe(1);
    const up = t.up(2, 500, false);
    expect(up?.releaseSmash).toBe(true);
    expect(t.isCharging()).toBe(false);
  });

  it('does not swing when a charging finger is cancelled by the browser', () => {
    const t = new TouchTracker();
    t.down(1, 100, 600, 0, true, RALLY);
    t.down(2, 300, 300, 50, false, RALLY);
    const up = t.up(2, 500, true);
    expect(up?.releaseSmash).toBe(false);
    expect(up?.tap).toBe(false);
    expect(t.isCharging()).toBe(false);
  });

  it('a second finger outside a rally does not charge', () => {
    const t = new TouchTracker();
    t.down(1, 100, 600, 0, true, SERVE);
    expect(t.down(2, 300, 300, 10, false, SERVE).charging).toBe(false);
    expect(t.isCharging()).toBe(false);
  });

  it('a leftover finger does not take over steering when the steering finger lifts', () => {
    const t = new TouchTracker();
    t.down(1, 100, 600, 0, true, RALLY);
    t.down(2, 300, 300, 10, false, RALLY);
    t.up(1, 400, false);
    expect(t.steeringId()).toBeNull();
    expect(t.move(2, 50, 50)).toBe(false);
    // The next new finger steers
    expect(t.down(3, 200, 700, 600, false, RALLY).role).toBe('steer');
  });

  it('drops stale fingers when a fresh primary touch starts', () => {
    const t = new TouchTracker();
    t.down(1, 100, 600, 0, true, RALLY);
    t.down(2, 300, 300, 10, false, RALLY);
    // Ends for 1 and 2 were never delivered
    const fresh = t.down(7, 120, 620, 2000, true, RALLY);
    expect(fresh.role).toBe('steer');
    expect(t.size).toBe(1);
    expect(t.isCharging()).toBe(false);
  });

  it('defers steering during the player serve until the finger really moves', () => {
    const t = new TouchTracker();
    const f = t.down(1, 100, 600, 0, true, SERVE);
    expect(f.steerDeferred).toBe(true);
    expect(t.move(1, 100 + TOUCH_TAP_SLOP_PX - 1, 600)).toBe(false);
    expect(t.move(1, 100 + TOUCH_TAP_SLOP_PX + 1, 600)).toBe(true);
    // After a real drag it keeps steering even back near the start point
    expect(t.move(1, 100, 600)).toBe(true);
    expect(t.up(1, 100, false)?.tap).toBe(false);
  });

  it('reports a quick still touch as a tap (serve), but not a long press or a cancel', () => {
    const t = new TouchTracker();
    t.down(1, 100, 600, 1000, true, SERVE);
    t.move(1, 103, 604);
    expect(t.up(1, 1000 + TOUCH_TAP_MAX_MS, false)?.tap).toBe(true);

    t.down(2, 100, 600, 0, true, SERVE);
    expect(t.up(2, TOUCH_TAP_MAX_MS + 1, false)?.tap).toBe(false);

    t.down(3, 100, 600, 0, true, SERVE);
    expect(t.up(3, 50, true)?.tap).toBe(false);
  });

  it('ignores fingers it never saw go down', () => {
    const t = new TouchTracker();
    expect(t.move(9, 1, 1)).toBe(false);
    expect(t.up(9, 1, false)).toBeNull();
  });

  it('dropCharges stops charging without forgetting the fingers', () => {
    const t = new TouchTracker();
    t.down(1, 100, 600, 0, true, RALLY);
    t.down(2, 300, 300, 10, false, RALLY);
    t.dropCharges();
    expect(t.isCharging()).toBe(false);
    expect(t.up(2, 100, false)?.releaseSmash).toBe(false);
    expect(t.steeringId()).toBe(1);
  });

  it('isTouchTap rejects bad timings', () => {
    const touch = {
      id: 1,
      role: 'steer' as const,
      startX: 0,
      startY: 0,
      startTime: 100,
      moved: false,
      steerDeferred: false,
      charging: false,
    };
    expect(isTouchTap(touch, 50, false)).toBe(false);
    expect(isTouchTap(touch, Number.NaN, false)).toBe(false);
    expect(isTouchTap(touch, 200, false)).toBe(true);
  });
});

describe('touchPortraitFov', () => {
  it('leaves landscape and square screens alone', () => {
    expect(touchPortraitFov(16 / 9, 50)).toBe(50);
    expect(touchPortraitFov(1, 68)).toBe(68);
  });

  it('widens a phone held upright so a fixed horizontal angle is visible', () => {
    const aspect = 390 / 844;
    const fov = touchPortraitFov(aspect, 68);
    expect(fov).toBeGreaterThan(68);
    expect(fov).toBeLessThanOrEqual(TOUCH_PORTRAIT_MAX_FOV);
    const halfWidthTan = Math.tan(((fov / 2) * Math.PI) / 180) * aspect;
    expect(halfWidthTan).toBeCloseTo(0.44, 5);
  });

  it('never narrows the base view and caps very tall screens', () => {
    expect(touchPortraitFov(0.75, 68)).toBe(68);
    expect(touchPortraitFov(0.2, 68)).toBe(TOUCH_PORTRAIT_MAX_FOV);
    expect(touchPortraitFov(Number.NaN, 68)).toBe(68);
  });
});

describe('touch reach on narrow screens', () => {
  it('scales sideways travel so the screen edge reaches the full paddle range', () => {
    const visibleHalf = 0.5;
    const gain = touchReachGain(visibleHalf);
    expect(gain).toBeCloseTo(TOUCH_REACH_X / visibleHalf, 9);
    expect(applyTouchReach(0.5, 0, gain)).toBeCloseTo(TOUCH_REACH_X, 9);
    expect(applyTouchReach(-0.5, 0, gain)).toBeCloseTo(-TOUCH_REACH_X, 9);
    // The screen centre stays where it is
    expect(applyTouchReach(0.1, 0.1, gain)).toBeCloseTo(0.1, 9);
  });

  it('never shrinks travel on wide screens and ignores bad input', () => {
    expect(touchReachGain(2)).toBe(1);
    expect(touchReachGain(TOUCH_REACH_X)).toBe(1);
    expect(touchReachGain(0)).toBe(1);
    expect(touchReachGain(Number.NaN)).toBe(1);
    expect(applyTouchReach(0.7, 0, 1)).toBe(0.7);
  });
});

describe('touchPortraitCameraPullback', () => {
  it('is zero in landscape and full on tall phones', () => {
    expect(touchPortraitCameraPullback(16 / 9)).toBe(0);
    expect(touchPortraitCameraPullback(1)).toBe(0);
    expect(touchPortraitCameraPullback(390 / 844)).toBe(TOUCH_PORTRAIT_MAX_PULLBACK);
    expect(touchPortraitCameraPullback(0.75)).toBeCloseTo(TOUCH_PORTRAIT_MAX_PULLBACK / 2, 9);
    expect(touchPortraitCameraPullback(Number.NaN)).toBe(0);
  });
});
