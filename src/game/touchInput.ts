/**
 * Touch-screen input decisions, kept free of DOM and engine state so they can be unit tested.
 * Only pointers with pointerType === 'touch' are ever routed here; mouse and pen input never are.
 *
 * Scheme:
 * - The first finger on the play area steers. It does not charge a smash.
 * - The paddle is drawn a little above the steering finger so the finger does not hide it.
 * - On a narrow screen, sideways finger travel is scaled up so the screen edges reach as far as
 *   the paddle can go (see touchReachGain).
 * - While a steering finger is down, any further finger holds a smash charge; lifting it swings.
 * - A quick tap (any finger) serves when it is the player's serve.
 */

/** Distance a finger may wander and still count as a tap (CSS px). */
export const TOUCH_TAP_SLOP_PX = 12;
/** Longest press that still counts as a tap (ms). */
export const TOUCH_TAP_MAX_MS = 350;

/** How far above the finger the paddle aims, in CSS px, for a play area of the given height. */
export function touchSteerOffsetPx(viewHeightPx: number): number {
  if (!Number.isFinite(viewHeightPx) || viewHeightPx <= 0) return 0;
  const preferred = Math.min(88, Math.max(48, viewHeightPx * 0.1));
  // Never more than a quarter of a very short play area
  return Math.min(preferred, viewHeightPx * 0.25);
}

/**
 * Maps a finger position inside the play area to the normalized device coordinates the paddle
 * follows. The aim point sits `offsetPx` above the finger, except in a band at the bottom edge
 * (as tall as the offset) where the offset ramps down to zero. That keeps the mapping continuous
 * and lets the finger reach every aim point a mouse can: the bottom edge maps to the bottom edge,
 * and the top edge is reached `offsetPx` below the top of the screen.
 *
 * `localX`/`localY` are CSS px from the play area's top-left corner.
 */
export function mapTouchToNdc(
  localX: number,
  localY: number,
  width: number,
  height: number,
  offsetPx: number
): { ndcX: number; ndcY: number } {
  if (!(width > 0) || !(height > 0)) return { ndcX: 0, ndcY: 0 };
  const off = Math.max(0, Number.isFinite(offsetPx) ? offsetPx : 0);
  const fromBottom = Math.min(height, Math.max(0, height - localY));
  let aimFromBottom: number;
  if (off <= 0) {
    aimFromBottom = fromBottom;
  } else if (fromBottom >= off) {
    aimFromBottom = fromBottom + off;
  } else {
    // Bottom band: slope 2 ramp from (0 -> 0) up to (off -> 2*off)
    aimFromBottom = fromBottom * 2;
  }
  aimFromBottom = Math.min(height, aimFromBottom);
  const ndcX = Math.min(1, Math.max(-1, (localX / width) * 2 - 1));
  const ndcY = Math.min(1, Math.max(-1, (aimFromBottom / height) * 2 - 1));
  return { ndcX, ndcY };
}

export type TouchRole = 'steer' | 'charge';

export interface TrackedTouch {
  readonly id: number;
  readonly role: TouchRole;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  /** Moved further than the tap slop at some point. */
  moved: boolean;
  /**
   * Steering finger that started during the player's serve: it does not move the paddle until it
   * has moved past the tap slop, so a tap serves from where the paddle already is.
   */
  steerDeferred: boolean;
  /** Charge finger that is holding a smash charge (only set if it went down during a rally). */
  charging: boolean;
}

export interface TouchDownContext {
  /** Game is in a rally (a second finger charges a smash). */
  rally: boolean;
  /** Game is waiting for the player to serve. */
  playerServe: boolean;
}

export interface TouchUpResult {
  touch: TrackedTouch;
  /** Short press without real movement, ended normally (not cancelled). */
  tap: boolean;
  /** A held smash charge ended normally: the paddle should swing. */
  releaseSmash: boolean;
}

export function isTouchTap(touch: TrackedTouch, endTime: number, cancelled: boolean): boolean {
  if (cancelled || touch.moved) return false;
  const held = endTime - touch.startTime;
  return Number.isFinite(held) && held >= 0 && held <= TOUCH_TAP_MAX_MS;
}

/**
 * Tracks the fingers on the play area by pointerId. Exactly one finger steers at a time; a finger
 * that lands while another is steering never takes over steering, so it cannot make the paddle jump.
 */
export class TouchTracker {
  private readonly touches = new Map<number, TrackedTouch>();

  get size(): number {
    return this.touches.size;
  }

  get(id: number): TrackedTouch | undefined {
    return this.touches.get(id);
  }

  steeringId(): number | null {
    for (const t of this.touches.values()) {
      if (t.role === 'steer') return t.id;
    }
    return null;
  }

  /** True while any finger is holding a smash charge. */
  isCharging(): boolean {
    for (const t of this.touches.values()) {
      if (t.charging) return true;
    }
    return false;
  }

  /**
   * Registers a finger. `isPrimary` (PointerEvent.isPrimary) is true only when no other finger is
   * on the screen, so any fingers still tracked at that point are stale (their end was never
   * delivered) and are dropped.
   */
  down(
    id: number,
    x: number,
    y: number,
    time: number,
    isPrimary: boolean,
    ctx: TouchDownContext
  ): TrackedTouch {
    if (isPrimary) this.touches.clear();
    this.touches.delete(id);
    const role: TouchRole = this.steeringId() === null ? 'steer' : 'charge';
    const touch: TrackedTouch = {
      id,
      role,
      startX: x,
      startY: y,
      startTime: time,
      moved: false,
      steerDeferred: role === 'steer' && ctx.playerServe,
      charging: role === 'charge' && ctx.rally,
    };
    this.touches.set(id, touch);
    return touch;
  }

  /**
   * Updates a finger's movement. Returns true when this finger should steer the paddle to (x, y)
   * now. Unknown fingers (for example ones that started on a menu or button) never steer.
   */
  move(id: number, x: number, y: number): boolean {
    const touch = this.touches.get(id);
    if (!touch) return false;
    if (!touch.moved && Math.hypot(x - touch.startX, y - touch.startY) > TOUCH_TAP_SLOP_PX) {
      touch.moved = true;
      touch.steerDeferred = false;
    }
    return touch.role === 'steer' && !touch.steerDeferred;
  }

  /** Ends a finger (lifted, or cancelled by the browser). Unknown fingers return null. */
  up(id: number, time: number, cancelled: boolean): TouchUpResult | null {
    const touch = this.touches.get(id);
    if (!touch) return null;
    this.touches.delete(id);
    return {
      touch,
      tap: isTouchTap(touch, time, cancelled),
      releaseSmash: touch.charging && !cancelled,
    };
  }

  /** Stops every held smash charge without a swing (fingers stay tracked). */
  dropCharges(): void {
    for (const t of this.touches.values()) t.charging = false;
  }

  clear(): void {
    this.touches.clear();
  }
}

/**
 * True when the device's primary pointer is a finger (phones, most tablets). A desktop or laptop
 * whose primary pointer is a mouse or trackpad reports `(pointer: fine)` even if it also has a
 * touch screen, so this is false for them at every window size.
 */
export function isTouchPrimaryDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** Horizontal half-angle tangent a portrait touch screen should show (about 47 degrees across). */
export const TOUCH_PORTRAIT_HALF_WIDTH_TAN = 0.44;
export const TOUCH_PORTRAIT_MAX_FOV = 96;

/**
 * Vertical field of view (degrees) for a touch-primary screen. Landscape keeps `baseFov`; in
 * portrait the view is widened until it shows a fixed horizontal angle, so the table's width fits.
 * Never narrower than `baseFov`.
 */
export function touchPortraitFov(aspect: number, baseFov: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= 1) return baseFov;
  const wanted = (2 * Math.atan(TOUCH_PORTRAIT_HALF_WIDTH_TAN / aspect) * 180) / Math.PI;
  return Math.min(TOUCH_PORTRAIT_MAX_FOV, Math.max(baseFov, wanted));
}

/**
 * Sideways paddle reach (world metres either side of centre) a finger at the screen edge should
 * give: a little beyond the assisted-mode paddle limit (1.18), so wide balls are reachable on a
 * narrow screen. The edge auto-jump still covers balls wider than this.
 */
export const TOUCH_REACH_X = 1.25;

/**
 * Horizontal gain for touch steering in 1:1 mode. `visibleHalfWidth` is half the width of the
 * strike plane that is on screen. On a wide screen the edges already reach far enough and the
 * gain is 1; on a phone held upright the paddle travels further than the finger so that the
 * screen edges reach `reach`.
 */
export function touchReachGain(visibleHalfWidth: number, reach = TOUCH_REACH_X): number {
  if (!Number.isFinite(visibleHalfWidth) || visibleHalfWidth <= 0.05) return 1;
  return Math.max(1, reach / visibleHalfWidth);
}

/** Scales a projected paddle X away from the screen-centre X by `gain`. */
export function applyTouchReach(projectedX: number, centerX: number, gain: number): number {
  return centerX + (projectedX - centerX) * gain;
}

/** Maximum distance (metres) the gameplay camera moves back for a touch screen held upright. */
export const TOUCH_PORTRAIT_MAX_PULLBACK = 0.6;

/**
 * How far the gameplay camera moves back on a touch-primary screen, so more of the table's width
 * is in view in portrait. Zero for square and landscape screens; full at aspect 0.5 and narrower.
 */
export function touchPortraitCameraPullback(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= 1) return 0;
  const t = Math.min(1, (1 - aspect) / 0.5);
  return TOUCH_PORTRAIT_MAX_PULLBACK * t;
}
