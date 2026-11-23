import {
  getStoryPhaseConfig,
  getThreatPhaseForScore,
  PLAYER_PADDLE,
  SENTINEL,
  STORY_POINTS_TO_WIN,
  TABLE,
  type Difficulty,
  type GameMode,
  type StoryStage,
  type ThreatPhaseConfig,
} from './constants';
import { SoundEngine } from './audio';
import {
  clamp,
  computeEdgeJumpTargetX,
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
  | 'CUTSCENE'
  | 'PAUSED'
  | 'GAME_OVER';

export interface StoryOutcome {
  action: 'continue' | 'trigger_stage2_cutscene' | 'game_over';
  winner: Side | null;
}

/**
 * Pure Story Mode match progression evaluator (First to 5, win by 2):
 * Winning Stage 1 triggers the surprise Stage 2 boss-destruction & cityscape cutscene.
 */
export function evaluateStoryMatchOutcome(
  stage: StoryStage,
  playerPoints: number,
  sentinelPoints: number
): StoryOutcome {
  const reachedTarget =
    playerPoints >= STORY_POINTS_TO_WIN || sentinelPoints >= STORY_POINTS_TO_WIN;
  const lead = Math.abs(playerPoints - sentinelPoints);
  if (!reachedTarget || lead < 2) {
    return { action: 'continue', winner: null };
  }
  const winner: Side = playerPoints > sentinelPoints ? 'player' : 'sentinel';
  if (stage === 1 && winner === 'player') {
    return { action: 'trigger_stage2_cutscene', winner: 'player' };
  }
  return { action: 'game_over', winner };
}

export interface HudSnapshot {
  state: GamePhaseState;
  mode: GameMode;
  difficulty: Difficulty;
  storyStage: StoryStage;
  stage2Unlocked: boolean;
  canSkipCutscene: boolean;
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
}

export class GameEngine {
  public readonly sceneManager: SceneManager;
  public readonly audio = new SoundEngine();

  private state: GamePhaseState = 'LOADING';
  private mode: GameMode = 'duel';
  private difficulty: Difficulty = 'easy';
  private storyStage: StoryStage = 1;
  private stage2Unlocked = false;
  private canSkipCutscene = false;
  private cutsceneElapsed = 0;
  private cutsceneReady = false;
  private cutsceneFinishing = false;
  private readonly cutsceneDuration = 5.75;
  private prePauseState: GamePhaseState = 'SERVE';
  private onStage2Unlocked?: () => void;

  private ball: BallState = createBallState();
  private playerPaddle: PaddleState = {
    pos: { x: 0, y: TABLE.SURFACE_Y + 0.28, z: PLAYER_PADDLE.BASE_Z },
    prevPos: { x: 0, y: TABLE.SURFACE_Y + 0.28, z: PLAYER_PADDLE.BASE_Z },
    vel: { x: 0, y: 0, z: 0 },
    smashCharge: 0,
  };
  // Invisible second hitbox locked right to the player's true cursor position during rapid desyncs/edge-jumps
  private ghostCursorPaddle: PaddleState = {
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
  private cursorAnchorPos: { x: number; y: number; z: number } = {
    x: 0,
    y: TABLE.SURFACE_Y + 0.28,
    z: PLAYER_PADDLE.BASE_Z,
  };
  private ghostJumpLatched = false;
  private ghostDesyncTimer = 0;
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

  constructor(
    sceneManager: SceneManager,
    onHudUpdate: (snap: HudSnapshot) => void,
    opts: { initialStage2Unlocked?: boolean; onStage2Unlocked?: () => void } = {}
  ) {
    this.sceneManager = sceneManager;
    this.onHudUpdate = onHudUpdate;
    this.stage2Unlocked = Boolean(opts.initialStage2Unlocked);
    this.onStage2Unlocked = opts.onStage2Unlocked;

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
      if (
        document.hidden &&
        (this.state === 'RALLY' || this.state === 'SERVE' || this.state === 'CUTSCENE')
      ) {
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
    this.sceneManager.vfx.clearFloatingPoints();
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

  public startNewGame(
    mode: GameMode,
    difficulty: Difficulty = this.difficulty,
    startStage: StoryStage = 1
  ): void {
    this.audio.unlock();
    this.mode = mode;
    this.difficulty = difficulty;
    const effectiveStage: StoryStage =
      mode === 'duel' && startStage === 2 && this.stage2Unlocked ? 2 : 1;
    this.storyStage = effectiveStage;
    this.cutsceneElapsed = 0;
    this.cutsceneReady = false;
    this.cutsceneFinishing = false;
    this.canSkipCutscene = false;

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
    this.ghostJumpLatched = false;
    this.ghostDesyncTimer = 0;
    this.ghostCursorPaddle.prevPos = { ...this.playerPaddle.pos };
    this.ghostCursorPaddle.pos = { ...this.playerPaddle.pos };
    this.maxPhaseReached = effectiveStage === 2 ? 2 : 1;
    this.winner = null;
    this.lastPointReason = '';
    this.bonusCooldown = 4.5;
    this.sceneManager.vfx.hideBonusRing();
    this.sceneManager.vfx.clearTrail();
    this.sceneManager.vfx.clearFloatingPoints();

    void this.sceneManager.setEnvironmentStage(effectiveStage);
    if (mode === 'duel' && effectiveStage === 1) {
      // Preload Stage 2 silently in background so boss-destruction cutscene has zero hitch
      void this.sceneManager.preloadStage2Assets();
    }

    this.enterServeState();
    this.pushHud(true);
  }

  public pauseGame(): void {
    if (
      this.state === 'RALLY' ||
      this.state === 'SERVE' ||
      this.state === 'POINT_PAUSE' ||
      this.state === 'CUTSCENE'
    ) {
      this.prePauseState = this.state;
      this.state = 'PAUSED';
      this.autoBulletTimeLatched = false;
      this.setBulletTime(false);
      this.pushHud(true);
    }
  }

  public resumeGame(): void {
    if (this.state === 'PAUSED') {
      if (this.prePauseState === 'CUTSCENE') {
        this.state = 'CUTSCENE';
      } else {
        this.state = this.ball.active ? 'RALLY' : 'SERVE';
      }
      this.ghostJumpLatched = false;
      this.ghostDesyncTimer = 0;
      this.ghostCursorPaddle.prevPos = { ...this.ghostCursorPaddle.pos };
      this.lastFrameTime = performance.now();
      this.pushHud(true);
    }
  }

  public returnToMenu(): void {
    this.setBulletTime(false);
    this.autoBulletTimeLatched = false;
    this.cutsceneReady = false;
    this.cutsceneFinishing = false;
    this.storyStage = 1;
    void this.sceneManager.setEnvironmentStage(1);
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

  public setOneToOneMode(enabled: boolean): void {
    this.oneToOneMode = enabled;
    if (!enabled) {
      this.autoBulletTimeLatched = false;
    }
    this.pushHud(true);
  }

  public toggleOneToOneMode(): boolean {
    this.setOneToOneMode(!this.oneToOneMode);
    return this.oneToOneMode;
  }

  public isOneToOneMode(): boolean {
    return this.oneToOneMode;
  }

  public getCurrentThreatPhase(): ThreatPhaseConfig {
    if (this.mode === 'duel') {
      return getStoryPhaseConfig(this.difficulty, this.storyStage);
    }
    const p = getThreatPhaseForScore(this.score);
    if (p.phase > this.maxPhaseReached) {
      this.maxPhaseReached = p.phase;
      this.audio.playSmashWarning();
      this.sceneManager.addCameraShake(0.05);
    }
    return p;
  }

  private startStage2Cutscene(persistUnlock = true): void {
    const wasAlreadyUnlocked = this.stage2Unlocked;
    if (persistUnlock) {
      this.stage2Unlocked = true;
      this.onStage2Unlocked?.();
    }
    this.canSkipCutscene = wasAlreadyUnlocked;

    this.state = 'CUTSCENE';
    this.cutsceneElapsed = 0;
    this.cutsceneReady = false;
    this.cutsceneFinishing = false;
    this.ball.active = false;
    this.autoBulletTimeLatched = false;
    this.setBulletTime(false);
    this.sceneManager.vfx.clearTrail();
    this.sceneManager.vfx.clearFloatingPoints();
    this.pushHud(true);

    void this.sceneManager.beginStage2Cutscene().then(() => {
      if (this.state === 'CUTSCENE') {
        this.cutsceneReady = true;
      }
    });
  }

  public triggerCutscenePreview(): void {
    this.mode = 'duel';
    this.storyStage = 1;
    this.score = 1500;
    this.startStage2Cutscene(false);
  }

  private completeStage2Cutscene(): void {
    if (this.cutsceneFinishing) return;
    this.cutsceneFinishing = true;
    this.storyStage = 2;
    this.maxPhaseReached = Math.max(this.maxPhaseReached, 2);
    this.playerPoints = 0;
    this.sentinelPoints = 0;
    this.totalDuelPoints = 0;
    this.server = 'player';
    void this.sceneManager.finishStage2Cutscene().then(() => {
      if (this.state === 'CUTSCENE') {
        this.cutsceneReady = false;
        this.cutsceneFinishing = false;
        this.enterServeState();
        this.pushHud(true);
      }
    });
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

  private setBulletTime(active: boolean): void {
    if (this.bulletTimeActive === active) return;
    this.bulletTimeActive = active;
    this.audio.setBulletTimeAudio(active);
  }

  private step(realDt: number, nowMs: number): void {
    const phase = this.getCurrentThreatPhase();

    // Dedicated real-time 3D Story Mode Boss-Destruction & Cityscape-Expansion Cutscene
    if (this.state === 'CUTSCENE') {
      if (this.cutsceneReady) {
        this.cutsceneElapsed += realDt;
        const stage2Phase = getStoryPhaseConfig(this.difficulty, 2);
        this.sceneManager.updateStage2Cutscene(
          this.cutsceneElapsed,
          realDt,
          this.audio,
          this.ball,
          stage2Phase
        );
        if (this.cutsceneElapsed >= this.cutsceneDuration) {
          this.completeStage2Cutscene();
        }
      } else {
        // Still finishing silent preload — keep rendering smoothly
        this.sceneManager.updateVisuals(0, realDt, this.ball, this.playerPaddle, {
          isMenu: false,
          bulletTime: false,
          phaseNumber: phase.phase,
        });
      }
      return;
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
          this.audio.playBonusRing();
          this.sceneManager.vfx.spawnFloatingPoints(
            this.sceneManager.vfx.getBonusRingPosition(),
            `+${bonusPts}`,
            { subText: 'RING', tone: 'emerald', side: 'world' }
          );
        }
      }

      const sentinelCtrl = this.sceneManager.sentinelController;
      if (sentinelCtrl) {
        const events = stepPhysics(this.ball, simDt, {
          playerPaddle: this.playerPaddle,
          ghostPlayerPaddle: this.ghostCursorPaddle,
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
          } else if (ev.type === 'paddle_hit') {
            this.audio.playPaddleHit(ev);
            if (ev.by === 'player') {
              this.rally += 1;
              if (this.rally > this.bestRally) this.bestRally = this.rally;
              sentinelCtrl.notifyPlayerHit();

              const mult = this.getComboMultiplier();
              let gained = 100 * mult;
              let sparkColor = 0x3dff9e;
              let subTag: string | undefined;
              let popupTone: 'mint' | 'emerald' | 'gold' | 'cyan' = 'mint';

              if (ev.counterSmash) {
                gained += 550 * mult;
                sparkColor = 0xffe45e;
                subTag = 'COUNTER';
                popupTone = 'gold';
                this.sceneManager.addCameraShake(0.085);
              } else if (ev.perfect) {
                this.perfectHits += 1;
                gained += 120 * mult;
                sparkColor = 0x55ffaa;
                subTag = ev.smash ? 'PERFECT SMASH' : 'PERFECT';
                popupTone = ev.smash ? 'gold' : 'emerald';
                this.sceneManager.addCameraShake(ev.smash ? 0.055 : 0.025);
              } else if (ev.curve) {
                gained += 80 * mult;
                sparkColor = 0x1affd5;
                subTag = 'CURVE';
                popupTone = 'cyan';
              } else if (ev.smash) {
                gained += 90 * mult;
                sparkColor = 0xffdd66;
                subTag = 'SMASH';
                popupTone = 'gold';
                this.sceneManager.addCameraShake(0.04);
              }

              this.score += gained;
              this.sceneManager.vfx.emitSparks(
                ev.pos,
                sparkColor,
                ev.smash ? 24 : 14,
                ev.smash ? 1.4 : 0.9
              );
              this.sceneManager.vfx.spawnFloatingPoints(this.playerPaddle.pos, `+${gained}`, {
                subText: subTag,
                tone: popupTone,
                side: 'player',
              });
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
    this.sceneManager.syncPlayerPaddle(this.playerPaddle, this.bulletTimeActive, {
      anchor: this.cursorAnchorPos,
      active: this.ghostJumpLatched,
      desyncDuration: this.ghostDesyncTimer,
      visible: this.state === 'RALLY' || this.state === 'POINT_PAUSE',
    });
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
      const sentinelPos = this.sceneManager.sentinelController?.paddleState.pos ?? {
        x: 0,
        y: TABLE.SURFACE_Y + 0.35,
        z: SENTINEL.PADDLE_BASE_Z,
      };
      this.sceneManager.vfx.spawnFloatingPoints(sentinelPos, `+${killBonus}`, {
        subText: 'WINNER',
        tone: 'emerald',
        side: 'sentinel',
        duration: 1.05,
      });
    } else {
      this.sentinelPoints += 1;
      this.sceneManager.addCameraShake(0.055);
      if (this.mode === 'arcade') {
        this.shields = Math.max(0, this.shields - 1);
      }
      this.sceneManager.vfx.spawnFloatingPoints(
        this.playerPaddle.pos,
        this.mode === 'arcade' ? '-1 SHIELD' : 'SENTINEL PT',
        { tone: 'crimson', side: 'player', duration: 0.9 }
      );
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
      // Story Mode: Stage 1 (First to 5, win by 2) -> Surprise Stage 2 Cutscene -> Stage 2 (First to 5, win by 2)
      this.totalDuelPoints += 1;
      const outcome = evaluateStoryMatchOutcome(
        this.storyStage,
        this.playerPoints,
        this.sentinelPoints
      );

      if (outcome.action === 'trigger_stage2_cutscene') {
        this.score += 1500;
        this.startStage2Cutscene();
        return;
      }

      if (outcome.action === 'game_over') {
        this.winner = outcome.winner;
        if (this.winner === 'player') {
          const diffBonus =
            this.difficulty === 'hard' ? 4000 : this.difficulty === 'medium' ? 2500 : 1400;
          const marginBonus = (this.playerPoints - this.sentinelPoints) * 320;
          this.score += diffBonus + marginBonus;
        }
        this.state = 'GAME_OVER';
        this.pushHud(true);
        return;
      }

      // Service rotation: every 2 points (every 1 at deuce 4-4+)
      const deuceThreshold = STORY_POINTS_TO_WIN - 1;
      if (this.playerPoints >= deuceThreshold && this.sentinelPoints >= deuceThreshold) {
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

    // Record the player's true un-jumped cursor anchor & update the invisible second ghost hitbox!
    this.cursorAnchorPos.x = targetX;
    this.cursorAnchorPos.y = targetY;
    this.cursorAnchorPos.z = targetZ;

    this.ghostCursorPaddle.prevPos.x = this.ghostCursorPaddle.pos.x;
    this.ghostCursorPaddle.prevPos.y = this.ghostCursorPaddle.pos.y;
    this.ghostCursorPaddle.prevPos.z = this.ghostCursorPaddle.pos.z;
    this.ghostCursorPaddle.pos.x = targetX;
    this.ghostCursorPaddle.pos.y = targetY;
    this.ghostCursorPaddle.pos.z = targetZ;
    this.ghostCursorPaddle.smashCharge = this.playerPaddle.smashCharge;
    if (dt > 1e-4) {
      const gvx = clamp((targetX - this.ghostCursorPaddle.prevPos.x) / dt, -5.2, 5.2);
      const gvy = clamp((targetY - this.ghostCursorPaddle.prevPos.y) / dt, -5.2, 5.2);
      const gvz = clamp((targetZ - this.ghostCursorPaddle.prevPos.z) / dt, -5.2, 5.2);
      this.ghostCursorPaddle.vel.x = this.ghostCursorPaddle.vel.x * 0.45 + gvx * 0.55;
      this.ghostCursorPaddle.vel.y = this.ghostCursorPaddle.vel.y * 0.45 + gvy * 0.55;
      this.ghostCursorPaddle.vel.z = this.ghostCursorPaddle.vel.z * 0.45 + gvz * 0.55;
    }

    // Edge-reach horizontal auto-jump: when near screen edge + vertically aligned, jump to catch wide/off-screen balls
    let edgeJumping = false;
    if (this.state === 'RALLY') {
      const edgeRes = computeEdgeJumpTargetX({
        ball: this.ball,
        rawNdcX: this.rawNdcX,
        baseTargetX: targetX,
        baseTargetY: targetY,
        targetZ,
      });
      if (edgeRes.active) {
        targetX = edgeRes.targetX;
        edgeJumping = true;
      }
    }
    if (edgeJumping) {
      this.ghostJumpLatched = true;
      this.ghostDesyncTimer += dt;
    } else if (
      this.state !== 'RALLY' ||
      Math.abs(this.playerPaddle.pos.x - this.cursorAnchorPos.x) <= 0.1
    ) {
      this.ghostJumpLatched = false;
      this.ghostDesyncTimer = 0;
    } else if (this.ghostJumpLatched) {
      this.ghostDesyncTimer += dt;
    }

    const followRateX = edgeJumping ? 68 : this.oneToOneMode ? 44 : 26;
    const followRateYZ = this.oneToOneMode ? 44 : 26;
    const smoothX = 1 - Math.exp(-followRateX * dt);
    const smoothYZ = 1 - Math.exp(-followRateYZ * dt);
    const nextX = this.playerPaddle.pos.x + (targetX - this.playerPaddle.pos.x) * smoothX;
    const nextY = this.playerPaddle.pos.y + (targetY - this.playerPaddle.pos.y) * smoothYZ;
    const nextZ = this.playerPaddle.pos.z + (targetZ - this.playerPaddle.pos.z) * smoothYZ;

    if (dt > 1e-4) {
      const rawVx = (nextX - this.playerPaddle.pos.x) / dt;
      const rawVy = (nextY - this.playerPaddle.pos.y) / dt;
      const rawVz = (nextZ - this.playerPaddle.pos.z) / dt;
      // Keep artificial auto-jump speed from triggering an overswing fault so rescue shots land cleanly on-table
      const effectiveVx = edgeJumping ? clamp(rawVx, -2.2, 2.2) : rawVx;
      this.playerPaddle.vel.x = this.playerPaddle.vel.x * 0.45 + effectiveVx * 0.55;
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
      if (this.state === 'CUTSCENE' && this.canSkipCutscene && this.cutsceneReady) {
        this.completeStage2Cutscene();
      } else if (this.state === 'SERVE' && this.server === 'player') {
        this.triggerPlayerServe();
      } else if (this.state === 'RALLY') {
        this.isChargingSmash = true;
      }
    } else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.bulletTimeRequested = true;
    } else if (e.code === 'Escape' || e.code === 'KeyP') {
      if (this.state === 'PAUSED') {
        this.resumeGame();
      } else if (
        this.state === 'RALLY' ||
        this.state === 'SERVE' ||
        this.state === 'CUTSCENE'
      ) {
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
      storyStage: this.storyStage,
      stage2Unlocked: this.stage2Unlocked,
      canSkipCutscene: this.canSkipCutscene,
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
