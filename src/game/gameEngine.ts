import {
  DUEL_DIFFICULTIES,
  getThreatPhaseForScore,
  PLAYER_PADDLE,
  SENTINEL,
  TABLE,
  type Difficulty,
  type GameMode,
  type ThreatPhaseConfig,
} from './constants';
import { SoundEngine } from './audio';
import {
  clamp,
  createBallState,
  evaluateAutoBulletTime,
  solveBallisticShot,
  stepPhysics,
  type BallState,
  type PaddleState,
  type Side,
} from './physics';
import { SceneManager } from './sceneManager';

export type GamePhaseState =
  | 'LOADING'
  | 'MENU'
  | 'SERVE'
  | 'RALLY'
  | 'POINT_PAUSE'
  | 'PAUSED'
  | 'GAME_OVER';

export interface CalloutMessage {
  id: number;
  text: string;
  tone: 'emerald' | 'gold' | 'crimson' | 'cyan';
}

export interface HudSnapshot {
  state: GamePhaseState;
  mode: GameMode;
  difficulty: Difficulty;
  score: number;
  rally: number;
  bestRally: number;
  comboMultiplier: number;
  perfectHits: number;
  shields: number;
  maxShields: number;
  playerPoints: number;
  sentinelPoints: number;
  server: Side;
  focus: number; // 0..100
  bulletTimeActive: boolean;
  smashCharge: number; // 0..1
  threatPhase: ThreatPhaseConfig;
  maxPhaseReached: number;
  winner: Side | null;
  lastPointReason: string;
  smashWarning: boolean;
  muted: boolean;
  oneToOneMode: boolean;
  callout: CalloutMessage | null;
}

export class GameEngine {
  public readonly sceneManager: SceneManager;
  public readonly audio = new SoundEngine();

  private state: GamePhaseState = 'LOADING';
  private mode: GameMode = 'arcade';
  private difficulty: Difficulty = 'hunter';

  private ball: BallState = createBallState();
  private playerPaddle: PaddleState = {
    pos: { x: 0, y: TABLE.SURFACE_Y + 0.28, z: PLAYER_PADDLE.BASE_Z },
    prevPos: { x: 0, y: TABLE.SURFACE_Y + 0.28, z: PLAYER_PADDLE.BASE_Z },
    vel: { x: 0, y: 0, z: 0 },
    smashCharge: 0,
  };

  // Input state
  private pointerNormX = 0; // -1..1 (assisted mode)
  private pointerNormY = 0; // -1..1 (assisted mode)
  private rawNdcX = 0; // exact [-1, 1] viewport NDC for true 1:1 ray projection
  private rawNdcY = 0;
  private oneToOneMode = true;
  private isChargingSmash = false;
  private lungeTimer = 0;
  private keys = new Set<string>();
  private sensitivity = 1.0;

  // Progression & score state
  private score = 0;
  private rally = 0;
  private bestRally = 0;
  private perfectHits = 0;
  private shields = 3;
  private readonly maxShields = 3;
  private playerPoints = 0;
  private sentinelPoints = 0;
  private totalDuelPoints = 0;
  private server: Side = 'player';
  private focus = 100; // Unlimited Bullet Time Focus
  private bulletTimeRequested = false;
  private autoBulletTimeLatched = false;
  private bulletTimeActive = false;
  private maxPhaseReached = 1;
  private winner: Side | null = null;
  private lastPointReason = '';
  private pointPauseTimer = 0;
  private serveAutoTimer = 0;
  private bonusCooldown = 5.5;
  private calloutId = 0;
  private callout: CalloutMessage | null = null;
  private calloutExpiry = 0;

  private rafId = 0;
  private lastFrameTime = 0;
  private running = false;
  private onHudUpdate: (snap: HudSnapshot) => void;
  private lastHudPush = 0;

  // Bound listeners for clean teardown
  private readonly onPointerMoveBound: (e: PointerEvent) => void;
  private readonly onPointerDownBound: (e: PointerEvent) => void;
  private readonly onPointerUpBound: (e: PointerEvent) => void;
  private readonly onContextMenuBound: (e: MouseEvent) => void;
  private readonly onKeyDownBound: (e: KeyboardEvent) => void;
  private readonly onKeyUpBound: (e: KeyboardEvent) => void;
  private readonly onVisibilityBound: () => void;

  constructor(sceneManager: SceneManager, onHudUpdate: (snap: HudSnapshot) => void) {
    this.sceneManager = sceneManager;
    this.onHudUpdate = onHudUpdate;

    this.onPointerMoveBound = (e) => this.handlePointerMove(e);
    this.onPointerDownBound = (e) => this.handlePointerDown(e);
    this.onPointerUpBound = (e) => this.handlePointerUp(e);
    this.onContextMenuBound = (e) => {
      if (this.state === 'RALLY' || this.state === 'SERVE') {
        e.preventDefault();
      }
    };
    this.onKeyDownBound = (e) => this.handleKeyDown(e);
    this.onKeyUpBound = (e) => this.handleKeyUp(e);
    this.onVisibilityBound = () => {
      if (document.hidden && (this.state === 'RALLY' || this.state === 'SERVE')) {
        this.pauseGame();
      }
    };

    const canvas = this.sceneManager.renderer.domElement;
    window.addEventListener('pointermove', this.onPointerMoveBound);
    canvas.addEventListener('pointerdown', this.onPointerDownBound);
    window.addEventListener('pointerup', this.onPointerUpBound);
    canvas.addEventListener('contextmenu', this.onContextMenuBound);
    window.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('keyup', this.onKeyUpBound);
    document.addEventListener('visibilitychange', this.onVisibilityBound);
  }

  public setReadyMenu(): void {
    this.state = 'MENU';
    this.ball.active = false;
    this.ball.pos = { x: 0, y: TABLE.SURFACE_Y + 0.38, z: -0.25 };
    this.sceneManager.vfx.clearTrail();
    this.sceneManager.vfx.hideBonusRing();
    this.pushHud(true);
  }

  public startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const realDt = clamp((now - this.lastFrameTime) / 1000, 0, 0.05);
      this.lastFrameTime = now;
      this.step(realDt, now);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  public startNewGame(mode: GameMode, difficulty: Difficulty = this.difficulty): void {
    this.audio.unlock();
    this.mode = mode;
    this.difficulty = difficulty;
    this.score = 0;
    this.rally = 0;
    this.bestRally = 0;
    this.perfectHits = 0;
    this.shields = this.maxShields;
    this.playerPoints = 0;
    this.sentinelPoints = 0;
    this.totalDuelPoints = 0;
    this.server = 'player';
    this.focus = 100;
    this.bulletTimeActive = false;
    this.bulletTimeRequested = false;
    this.autoBulletTimeLatched = false;
    this.maxPhaseReached = 1;
    this.winner = null;
    this.lastPointReason = '';
    this.bonusCooldown = 4.5;
    this.sceneManager.vfx.hideBonusRing();
    this.sceneManager.vfx.clearTrail();
    this.enterServeState();
    this.showCallout(
      mode === 'arcade' ? 'OVERDRIVE ENGAGED // CLICK TO SERVE' : `BOSS DUEL (${difficulty.toUpperCase()}) // SERVE`,
      'emerald'
    );
    this.pushHud(true);
  }

  public pauseGame(): void {
    if (this.state === 'RALLY' || this.state === 'SERVE' || this.state === 'POINT_PAUSE') {
      this.state = 'PAUSED';
      this.autoBulletTimeLatched = false;
      this.setBulletTime(false);
      this.pushHud(true);
    }
  }

  public resumeGame(): void {
    if (this.state === 'PAUSED') {
      this.state = this.ball.active ? 'RALLY' : 'SERVE';
      this.lastFrameTime = performance.now();
      this.pushHud(true);
    }
  }

  public returnToMenu(): void {
    this.setBulletTime(false);
    this.setReadyMenu();
  }

  public toggleMute(): boolean {
    this.audio.unlock();
    const next = !this.audio.isMuted();
    this.audio.setMuted(next);
    this.pushHud(true);
    return next;
  }

  public setSensitivity(val: number): void {
    this.sensitivity = clamp(val, 0.6, 1.8);
  }

  public setOneToOneMode(enabled: boolean, announce = true): void {
    this.oneToOneMode = enabled;
    if (!enabled) {
      this.autoBulletTimeLatched = false;
    }
    if (announce && (this.state === 'RALLY' || this.state === 'SERVE')) {
      this.showCallout(enabled ? '1:1 + AUTO FOCUS ON' : 'ASSISTED TRACKING ON', 'cyan');
    }
    this.pushHud(true);
  }

  public toggleOneToOneMode(): boolean {
    this.setOneToOneMode(!this.oneToOneMode, true);
    return this.oneToOneMode;
  }

  public isOneToOneMode(): boolean {
    return this.oneToOneMode;
  }

  public getCurrentThreatPhase(): ThreatPhaseConfig {
    if (this.mode === 'duel') {
      return DUEL_DIFFICULTIES[this.difficulty];
    }
    const p = getThreatPhaseForScore(this.score);
    if (p.phase > this.maxPhaseReached) {
      this.maxPhaseReached = p.phase;
      this.showCallout(`THREAT LEVEL ${p.phase}: ${p.name}`, 'crimson');
      this.audio.playSmashWarning();
      this.sceneManager.addCameraShake(0.05);
    }
    return p;
  }

  public getComboMultiplier(): number {
    if (this.rally >= 22) return 8;
    if (this.rally >= 15) return 6;
    if (this.rally >= 10) return 4;
    if (this.rally >= 6) return 3;
    if (this.rally >= 3) return 2;
    return 1;
  }

  private enterServeState(): void {
    this.state = 'SERVE';
    this.rally = 0;
    this.ball = createBallState();
    this.ball.active = false;
    this.sceneManager.vfx.clearTrail();

    if (this.server === 'player') {
      this.ball.pos = { x: this.playerPaddle.pos.x * 0.5, y: TABLE.SURFACE_Y + 0.34, z: 1.08 };
      this.serveAutoTimer = 0;
    } else {
      this.ball.pos = { x: -0.18, y: TABLE.SURFACE_Y + 0.38, z: -1.16 };
      this.serveAutoTimer = 0.85;
    }
    this.pushHud(true);
  }

  public triggerPlayerServe(): void {
    if (this.state !== 'SERVE' || this.server !== 'player') return;
    this.audio.unlock();
    const startX = clamp(this.playerPaddle.pos.x * 0.72, -0.52, 0.52);
    const origin = { x: startX, y: TABLE.SURFACE_Y + 0.34, z: 1.12 };
    const targetX = clamp(-startX * 0.65 + (Math.random() - 0.5) * 0.35, -0.54, 0.54);
    const targetZ = -0.82;
    const spin = { x: 11, y: clamp(this.playerPaddle.vel.x * 3.5, -18, 18), z: 0 };

    this.ball = createBallState();
    this.ball.pos = { ...origin };
    this.ball.vel = solveBallisticShot(origin, targetX, targetZ, 0.62, spin, 0.08);
    this.ball.spin = spin;
    this.ball.active = true;
    this.ball.lastHitBy = 'player';
    this.ball.hitCooldown = 0.14;
    this.state = 'RALLY';
    this.sceneManager.sentinelController?.notifyPlayerHit();
    this.audio.playPaddleHit({
      by: 'player',
      perfect: false,
      smash: false,
      curve: Math.abs(spin.y) > 10,
      counterSmash: false,
    });
    this.sceneManager.vfx.emitSparks(origin, 0x3cff9e, 10, 0.7);
    this.pushHud(true);
  }

  private launchSentinelServe(): void {
    const phase = this.getCurrentThreatPhase();
    const origin = {
      x: this.sceneManager.sentinelController?.paddleState.pos.x ?? -0.2,
      y: TABLE.SURFACE_Y + 0.36,
      z: SENTINEL.PADDLE_BASE_Z + 0.1,
    };
    const targetX = (Math.random() - 0.5) * 0.92;
    const targetZ = 0.82 + Math.random() * 0.25;
    const spin = {
      x: -8,
      y: (Math.random() - 0.5) * phase.spinIntensity * 0.75,
      z: 0,
    };

    this.ball = createBallState();
    this.ball.pos = { ...origin };
    this.ball.vel = solveBallisticShot(origin, targetX, targetZ, 0.68, spin, 0.085);
    this.ball.spin = spin;
    this.ball.active = true;
    this.ball.lastHitBy = 'sentinel';
    this.ball.hitCooldown = 0.16;
    this.state = 'RALLY';
    this.sceneManager.sentinelController?.triggerSwing(false);
    this.audio.playPaddleHit({
      by: 'sentinel',
      perfect: false,
      smash: false,
      curve: false,
      counterSmash: false,
    });
    this.pushHud(true);
  }

  private showCallout(text: string, tone: CalloutMessage['tone']): void {
    this.calloutId += 1;
    this.callout = { id: this.calloutId, text, tone };
    this.calloutExpiry = performance.now() + 1350;
  }

  private setBulletTime(active: boolean): void {
    if (this.bulletTimeActive === active) return;
    this.bulletTimeActive = active;
    this.audio.setBulletTimeAudio(active);
  }

  private step(realDt: number, nowMs: number): void {
    const phase = this.getCurrentThreatPhase();

    // Update callout expiration
    if (this.callout && nowMs > this.calloutExpiry) {
      this.callout = null;
    }

    // Unlimited Bullet Time management (manual RMB/Shift OR automatic near-miss reflex in 1:1 mode)
    if (this.state === 'RALLY') {
      const autoCheck = evaluateAutoBulletTime({
        oneToOneMode: this.oneToOneMode,
        ball: this.ball,
        playerPaddle: this.playerPaddle,
        alreadyLatched: this.autoBulletTimeLatched,
      });
      this.autoBulletTimeLatched = autoCheck.active;
      if (autoCheck.newlyTriggered && !this.bulletTimeActive) {
        this.showCallout('AUTO FOCUS // SAVE IT!', 'cyan');
      }
    } else {
      this.autoBulletTimeLatched = false;
    }

    const wantsBulletTime = this.bulletTimeRequested || this.autoBulletTimeLatched;
    this.focus = 100;
    if (this.state === 'RALLY' && wantsBulletTime) {
      this.setBulletTime(true);
    } else {
      this.setBulletTime(false);
    }

    const simDt = this.state === 'PAUSED' ? 0 : this.bulletTimeActive ? realDt * 0.36 : realDt;

    // Update Player Paddle from mouse/touch/keyboard even during SERVE & RALLY
    if (this.state !== 'PAUSED') {
      this.updatePlayerPaddle(realDt);
    }

    // State-specific simulation
    if (this.state === 'MENU') {
      // Gentle hovering ball showcase over the wet table between player and Sentinel
      const t = nowMs * 0.001;
      this.ball.pos.x = Math.sin(t * 1.1) * 0.16;
      this.ball.pos.y = TABLE.SURFACE_Y + 0.36 + Math.sin(t * 2.2) * 0.07;
      this.ball.pos.z = -0.25 + Math.cos(t * 1.1) * 0.08;
      this.ball.spin.y = 6;
    } else if (this.state === 'SERVE') {
      if (this.server === 'player') {
        this.ball.pos.x = clamp(this.playerPaddle.pos.x * 0.72, -0.52, 0.52);
        this.ball.pos.y = TABLE.SURFACE_Y + 0.34 + Math.sin(nowMs * 0.007) * 0.035;
        this.ball.pos.z = 1.12;
      } else {
        this.serveAutoTimer -= realDt;
        if (this.serveAutoTimer <= 0) {
          this.launchSentinelServe();
        }
      }
    } else if (this.state === 'RALLY') {
      // Bonus Matrix Ring spawner (in Arcade Overdrive mode for high-score risk-reward!)
      if (this.mode === 'arcade') {
        this.bonusCooldown -= simDt;
        if (this.bonusCooldown <= 0 && !this.sceneManager.vfx.bonusRingGroup.visible) {
          this.sceneManager.vfx.spawnBonusRing();
          this.bonusCooldown = 11.5 + Math.random() * 5.0;
        }
        if (this.sceneManager.vfx.checkBonusRingHit(this.ball)) {
          const bonusPts = 500 * this.getComboMultiplier();
          this.score += bonusPts;
          this.focus = Math.min(100, this.focus + 32);
          this.audio.playBonusRing();
          this.showCallout(`DATA RING +${bonusPts}`, 'emerald');
        }
      }

      const sentinelCtrl = this.sceneManager.sentinelController;
      if (sentinelCtrl) {
        const events = stepPhysics(this.ball, simDt, {
          playerPaddle: this.playerPaddle,
          sentinelPaddle: sentinelCtrl.paddleState,
          sentinelReturnFn: (b, hitPos) =>
            sentinelCtrl.planReturnShot(b, hitPos, phase, this.rally),
        });

        for (const ev of events) {
          if (ev.type === 'table_bounce') {
            this.audio.playTableBounce(ev.speed);
            this.sceneManager.vfx.spawnBounceRipple(ev.pos, this.ball.isCrimsonSmash);
          } else if (ev.type === 'net_hit') {
            this.audio.playNetHit();
            this.sceneManager.vfx.emitSparks(ev.pos, 0xffe49a, 10, 0.7);
            if (ev.cleared) {
              this.showCallout('NET CORD!', 'gold');
            }
          } else if (ev.type === 'paddle_hit') {
            this.audio.playPaddleHit(ev);
            if (ev.by === 'player') {
              this.rally += 1;
              if (this.rally > this.bestRally) this.bestRally = this.rally;
              sentinelCtrl.notifyPlayerHit();

              const mult = this.getComboMultiplier();
              let gained = 100 * mult;
              let sparkColor = 0x3dff9e;

              if (ev.counterSmash) {
                gained += 550 * mult;
                this.focus = Math.min(100, this.focus + 28);
                sparkColor = 0xffe45e;
                this.sceneManager.addCameraShake(0.085);
                this.showCallout(`CRIMSON COUNTER! +${gained}`, 'gold');
              } else if (ev.perfect) {
                this.perfectHits += 1;
                gained += 120 * mult;
                this.focus = Math.min(100, this.focus + 16);
                sparkColor = 0x55ffaa;
                this.sceneManager.addCameraShake(ev.smash ? 0.055 : 0.025);
                this.showCallout(
                  ev.smash ? `PERFECT SMASH! +${gained}` : `PERFECT! +${gained}`,
                  ev.smash ? 'gold' : 'emerald'
                );
              } else if (ev.curve) {
                gained += 80 * mult;
                this.focus = Math.min(100, this.focus + 10);
                sparkColor = 0x1affd5;
                this.showCallout(`MATRIX CURVE +${gained}`, 'cyan');
              } else if (ev.smash) {
                gained += 90 * mult;
                this.focus = Math.min(100, this.focus + 12);
                sparkColor = 0xffdd66;
                this.sceneManager.addCameraShake(0.04);
                this.showCallout(`POWER SMASH +${gained}`, 'gold');
              } else {
                this.focus = Math.min(100, this.focus + 7);
              }

              this.score += gained;
              this.sceneManager.vfx.emitSparks(ev.pos, sparkColor, ev.smash ? 24 : 14, ev.smash ? 1.4 : 0.9);
            } else {
              // Sentinel returned the ball
              this.sceneManager.vfx.emitSparks(
                ev.pos,
                ev.smash ? 0xff1c3a : 0xff7730,
                ev.smash ? 26 : 14,
                ev.smash ? 1.5 : 0.9
              );
              if (ev.smash) {
                this.sceneManager.addCameraShake(0.06);
                this.showCallout('CRIMSON SMASH INCOMING!', 'crimson');
              }
            }
          } else if (ev.type === 'point_end') {
            this.handlePointEnd(ev.winner, ev.reason);
          }
        }
      }
    } else if (this.state === 'POINT_PAUSE') {
      this.pointPauseTimer -= realDt;
      if (this.pointPauseTimer <= 0) {
        this.enterServeState();
      }
    }

    // Update Sentinel 3D rig & AI
    if (this.sceneManager.sentinelController) {
      this.sceneManager.sentinelController.update(
        simDt > 0 ? simDt : realDt * (this.state === 'PAUSED' ? 0 : 1),
        this.ball,
        phase,
        this.state === 'RALLY',
        () => {
          this.audio.playSmashWarning();
        }
      );
    }

    // Sync 3D meshes and render frame
    this.sceneManager.syncPlayerPaddle(this.playerPaddle, this.bulletTimeActive);
    this.sceneManager.syncBall(this.ball, simDt);
    this.sceneManager.updateVisuals(simDt, realDt, this.ball, this.playerPaddle, {
      isMenu: this.state === 'MENU',
      bulletTime: this.bulletTimeActive,
      phaseNumber: phase.phase,
    });

    // Throttled HUD updates (~20 Hz during active play to keep DOM ultra-light)
    if (nowMs - this.lastHudPush > 50) {
      this.pushHud(false);
      this.lastHudPush = nowMs;
    }
  }

  private handlePointEnd(winner: Side, reason: string): void {
    this.autoBulletTimeLatched = false;
    this.setBulletTime(false);
    this.audio.playPointResult(winner === 'player');

    const reasonLabels: Record<string, string> = {
      double_bounce: 'DOUBLE BOUNCE',
      out: 'OUT OF BOUNDS',
      net_fault: 'NET FAULT',
      missed: 'CLEAN WINNER',
      timeout: 'DEAD BALL',
    };
    this.lastPointReason = reasonLabels[reason] || 'POINT';

    if (winner === 'player') {
      this.playerPoints += 1;
      this.sceneManager.sentinelController?.triggerRecoil();
      this.sceneManager.addCameraShake(0.07);
      const killBonus = 750 * this.getComboMultiplier();
      this.score += killBonus;
      this.focus = Math.min(100, this.focus + 22);
      this.showCallout(`SENTINEL BREACHED! +${killBonus}`, 'emerald');
    } else {
      this.sentinelPoints += 1;
      this.sceneManager.addCameraShake(0.055);
      if (this.mode === 'arcade') {
        this.shields = Math.max(0, this.shields - 1);
        this.showCallout(
          this.shields > 0 ? `SHIELD HIT (${this.shields} LEFT)` : 'SYSTEM BREACH // GAME OVER',
          'crimson'
        );
      } else {
        this.showCallout(`SENTINEL POINT (${this.lastPointReason})`, 'crimson');
      }
    }

    // Check game-over condition
    if (this.mode === 'arcade') {
      if (this.shields <= 0) {
        this.state = 'GAME_OVER';
        this.winner = 'sentinel';
        this.pushHud(true);
        return;
      }
      // Alternate who serves so player gets to receive menacing Sentinel serves too
      this.server = winner === 'player' ? 'sentinel' : 'player';
    } else {
      // Classic Boss Duel: First to 11, win by 2
      this.totalDuelPoints += 1;
      const reached11 = this.playerPoints >= 11 || this.sentinelPoints >= 11;
      const lead = Math.abs(this.playerPoints - this.sentinelPoints);
      if (reached11 && lead >= 2) {
        this.winner = this.playerPoints > this.sentinelPoints ? 'player' : 'sentinel';
        if (this.winner === 'player') {
          const diffBonus =
            this.difficulty === 'architect' ? 3500 : this.difficulty === 'hunter' ? 2000 : 1000;
          const marginBonus = (this.playerPoints - this.sentinelPoints) * 280;
          this.score += diffBonus + marginBonus;
        }
        this.state = 'GAME_OVER';
        this.pushHud(true);
        return;
      }
      // Standard table tennis service rotation: every 2 points (every 1 at deuce 10-10+)
      if (this.playerPoints >= 10 && this.sentinelPoints >= 10) {
        this.server = this.server === 'player' ? 'sentinel' : 'player';
      } else if (this.totalDuelPoints % 2 === 0) {
        this.server = this.server === 'player' ? 'sentinel' : 'player';
      }
    }

    this.state = 'POINT_PAUSE';
    this.pointPauseTimer = 1.05;
    this.pushHud(true);
  }

  private updatePlayerPaddle(dt: number): void {
    // Keyboard fallback steering
    const kbSpeed = 1.9 * dt;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) {
      this.pointerNormX -= kbSpeed;
      this.rawNdcX -= kbSpeed * 0.85;
    }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) {
      this.pointerNormX += kbSpeed;
      this.rawNdcX += kbSpeed * 0.85;
    }
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
      this.pointerNormY += kbSpeed;
      this.rawNdcY += kbSpeed * 0.85;
    }
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
      this.pointerNormY -= kbSpeed;
      this.rawNdcY -= kbSpeed * 0.85;
    }
    this.pointerNormX = clamp(this.pointerNormX, -1.15, 1.15);
    this.pointerNormY = clamp(this.pointerNormY, -1.0, 1.0);
    this.rawNdcX = clamp(this.rawNdcX, -1.0, 1.0);
    this.rawNdcY = clamp(this.rawNdcY, -1.0, 1.0);

    // Charge power smash while holding Left Mouse or Space
    if (this.isChargingSmash) {
      this.playerPaddle.smashCharge = clamp(this.playerPaddle.smashCharge + dt * 1.9, 0, 1);
    } else {
      this.playerPaddle.smashCharge = Math.max(0, this.playerPaddle.smashCharge - dt * 4.5);
    }
    this.lungeTimer = Math.max(0, this.lungeTimer - dt * 5.2);

    this.playerPaddle.prevPos.x = this.playerPaddle.pos.x;
    this.playerPaddle.prevPos.y = this.playerPaddle.pos.y;
    this.playerPaddle.prevPos.z = this.playerPaddle.pos.z;

    // Dynamic Z strike depth: pulls back when charging smash, snaps forward on lunge!
    const chargeBack = this.playerPaddle.smashCharge * 0.14;
    const lungeForward = this.lungeTimer * 0.24;
    const targetZ = clamp(
      PLAYER_PADDLE.BASE_Z + chargeBack - lungeForward,
      PLAYER_PADDLE.MIN_Z,
      PLAYER_PADDLE.MAX_Z
    );

    let targetX: number;
    let targetY: number;

    if (this.oneToOneMode) {
      // True 1:1 ray projection onto the strike plane with zero vertical auto-assist
      const projected = this.sceneManager.projectPointerToStrikePlane(
        this.rawNdcX,
        this.rawNdcY,
        targetZ
      );
      if (projected) {
        targetX = clamp(projected.x, -1.35, 1.35);
        targetY = clamp(projected.y, PLAYER_PADDLE.MIN_Y, 1.98);
      } else {
        targetX = clamp(this.rawNdcX * 1.25, -1.35, 1.35);
        targetY = clamp(1.38 + this.rawNdcY * 0.58, PLAYER_PADDLE.MIN_Y, 1.98);
      }
    } else {
      targetX = clamp(
        this.pointerNormX * 1.08 * this.sensitivity,
        PLAYER_PADDLE.MIN_X,
        PLAYER_PADDLE.MAX_X
      );

      // Smart ergonomic Y mapping + gentle vertical assist toward incoming ball height so returns feel intuitive
      targetY = clamp(
        TABLE.SURFACE_Y + 0.32 + this.pointerNormY * 0.42,
        PLAYER_PADDLE.MIN_Y,
        PLAYER_PADDLE.MAX_Y
      );
      if (this.ball.active && this.ball.vel.z > 0.2 && this.ball.pos.z > 0.25) {
        const assistedY = clamp(this.ball.pos.y, PLAYER_PADDLE.MIN_Y, PLAYER_PADDLE.MAX_Y);
        targetY = targetY * 0.65 + assistedY * 0.35;
      }
    }

    const followRate = this.oneToOneMode ? 44 : 26;
    const smooth = 1 - Math.exp(-followRate * dt);
    const nextX = this.playerPaddle.pos.x + (targetX - this.playerPaddle.pos.x) * smooth;
    const nextY = this.playerPaddle.pos.y + (targetY - this.playerPaddle.pos.y) * smooth;
    const nextZ = this.playerPaddle.pos.z + (targetZ - this.playerPaddle.pos.z) * smooth;

    if (dt > 1e-4) {
      const rawVx = (nextX - this.playerPaddle.pos.x) / dt;
      const rawVy = (nextY - this.playerPaddle.pos.y) / dt;
      const rawVz = (nextZ - this.playerPaddle.pos.z) / dt;
      this.playerPaddle.vel.x = this.playerPaddle.vel.x * 0.45 + rawVx * 0.55;
      this.playerPaddle.vel.y = this.playerPaddle.vel.y * 0.45 + rawVy * 0.55;
      this.playerPaddle.vel.z = this.playerPaddle.vel.z * 0.45 + rawVz * 0.55;
    }

    this.playerPaddle.pos.x = nextX;
    this.playerPaddle.pos.y = nextY;
    this.playerPaddle.pos.z = nextZ;
  }

  private handlePointerMove(e: PointerEvent): void {
    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.rawNdcX = clamp(nx, -1.0, 1.0);
    this.rawNdcY = clamp(ny, -1.0, 1.0);
    this.pointerNormX = clamp(nx * 1.12, -1.15, 1.15);
    this.pointerNormY = clamp(ny, -1.0, 1.0);
  }

  private handlePointerDown(e: PointerEvent): void {
    this.audio.unlock();
    if (e.button === 2) {
      // Right-click triggers Bullet Time Focus
      this.bulletTimeRequested = true;
      return;
    }
    if (e.button === 0) {
      if (this.state === 'SERVE' && this.server === 'player') {
        this.triggerPlayerServe();
        return;
      }
      if (this.state === 'RALLY') {
        this.isChargingSmash = true;
      }
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button === 2) {
      this.bulletTimeRequested = false;
    }
    if (e.button === 0 && this.isChargingSmash) {
      this.isChargingSmash = false;
      this.lungeTimer = 1.0;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Do not intercept typing when entering callsign in an input field!
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    this.keys.add(e.code);
    if (e.code === 'Space') {
      e.preventDefault();
      this.audio.unlock();
      if (this.state === 'SERVE' && this.server === 'player') {
        this.triggerPlayerServe();
      } else if (this.state === 'RALLY') {
        this.isChargingSmash = true;
      }
    } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.bulletTimeRequested = true;
    } else if (e.code === 'Escape' || e.code === 'KeyP') {
      if (this.state === 'PAUSED') {
        this.resumeGame();
      } else if (this.state === 'RALLY' || this.state === 'SERVE') {
        this.pauseGame();
      }
    } else if (e.code === 'KeyM') {
      this.toggleMute();
    } else if (e.code === 'KeyC') {
      this.toggleOneToOneMode();
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    if (e.code === 'Space' && this.isChargingSmash) {
      this.isChargingSmash = false;
      this.lungeTimer = 1.0;
    } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.bulletTimeRequested = false;
    }
  }

  private pushHud(force: boolean): void {
    if (!force && !this.running) return;
    const phase = this.getCurrentThreatPhase();
    const smashWarning =
      (this.sceneManager.sentinelController?.getSmashTelegraph() ?? 0) > 0.15 ||
      (this.ball.active && this.ball.isCrimsonSmash);

    this.onHudUpdate({
      state: this.state,
      mode: this.mode,
      difficulty: this.difficulty,
      score: Math.round(this.score),
      rally: this.rally,
      bestRally: this.bestRally,
      comboMultiplier: this.getComboMultiplier(),
      perfectHits: this.perfectHits,
      shields: this.shields,
      maxShields: this.maxShields,
      playerPoints: this.playerPoints,
      sentinelPoints: this.sentinelPoints,
      server: this.server,
      focus: Math.round(this.focus),
      bulletTimeActive: this.bulletTimeActive,
      smashCharge: this.playerPaddle.smashCharge,
      threatPhase: phase,
      maxPhaseReached: this.maxPhaseReached,
      winner: this.winner,
      lastPointReason: this.lastPointReason,
      smashWarning,
      muted: this.audio.isMuted(),
      oneToOneMode: this.oneToOneMode,
      callout: this.callout,
    });
  }

  public dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    const canvas = this.sceneManager.renderer.domElement;
    window.removeEventListener('pointermove', this.onPointerMoveBound);
    canvas.removeEventListener('pointerdown', this.onPointerDownBound);
    window.removeEventListener('pointerup', this.onPointerUpBound);
    canvas.removeEventListener('contextmenu', this.onContextMenuBound);
    window.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('keyup', this.onKeyUpBound);
    document.removeEventListener('visibilitychange', this.onVisibilityBound);
  }
}
