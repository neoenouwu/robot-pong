import {
  STORY_POINTS_TO_WIN,
  type Difficulty,
  type GameMode,
  type StoryStage,
} from './game/constants';
import { GameEngine, type HudSnapshot } from './game/gameEngine';
import { computeStoryHealthBars, type HealthBarSide } from './game/healthBars';
import { HUD_STYLE_STORAGE_KEY, parseHudStyle, type HudStyle } from './game/hudStyle';
import { getRobotSkin } from './game/robotSkins';
import { SceneManager } from './game/sceneManager';
import {
  fetchLeaderboard,
  submitLeaderboardScore,
  type LeaderboardEntry,
} from './services/leaderboardClient';

const CALLSIGN_STORAGE_KEY = 'robot_pong_callsign';
const ONE_TO_ONE_STORAGE_KEY = 'robot_pong_1to1_mode';
const STAGE2_UNLOCKED_STORAGE_KEY = 'robot_pong_stage2_unlocked';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required UI element #${id}`);
  return el as T;
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[ch] || ch;
  });
}

class RobotPongApp {
  private sceneManager: SceneManager | null = null;
  private engine: GameEngine | null = null;

  private selectedMode: GameMode = 'duel';
  private selectedDifficulty: Difficulty = 'easy';
  private stage2Unlocked = false;
  private bloomOn = true;
  private lastSnapshot: HudSnapshot | null = null;
  private hasSubmittedRun = false;
  private lastSubmittedId: string | null = null;
  private prevState: string = 'LOADING';
  private lastSavedOneToOne: boolean | null = null;
  private lastPhaseNum = 1;
  private lastShields = 3;
  private lastStoryPoints: { player: number; robot: number } | null = null;
  private lastHealthKey = '';
  private hudStyle: HudStyle = 'classic';

  // DOM refs
  private readonly canvasContainer = byId<HTMLDivElement>('canvas-container');
  private readonly screenLoading = byId<HTMLDivElement>('screen-loading');
  private readonly loadingStatus = byId<HTMLParagraphElement>('loading-status');
  private readonly loadingBar = byId<HTMLDivElement>('loading-bar');
  private readonly loadingError = byId<HTMLDivElement>('loading-error');
  private readonly btnRetryLoad = byId<HTMLButtonElement>('btn-retry-load');

  private readonly screenMenu = byId<HTMLDivElement>('screen-menu');
  private readonly screenPause = byId<HTMLDivElement>('screen-pause');
  private readonly screenGameOver = byId<HTMLDivElement>('screen-gameover');
  private readonly screenContextLost = byId<HTMLDivElement>('screen-context-lost');

  private readonly hudEl = byId<HTMLDivElement>('hud');
  private readonly fxSlowMo = byId<HTMLDivElement>('fx-slowmo-vignette');
  private readonly fxSmashWarn = byId<HTMLDivElement>('fx-smash-warning');
  private readonly fxLetterboxTop = byId<HTMLDivElement>('fx-letterbox-top');
  private readonly fxLetterboxBottom = byId<HTMLDivElement>('fx-letterbox-bottom');
  private readonly cutsceneSkipHint = byId<HTMLDivElement>('cutscene-skip-hint');

  private readonly hudScore = byId<HTMLSpanElement>('hud-score');
  private readonly hudCombo = byId<HTMLSpanElement>('hud-combo');
  private readonly hudRally = byId<HTMLElement>('hud-rally');
  private readonly hudBestRally = byId<HTMLElement>('hud-best-rally');
  private readonly hudPhaseBadge = byId<HTMLDivElement>('hud-phase-badge');
  private readonly hudArcadeShields = byId<HTMLDivElement>('hud-arcade-shields');
  private readonly hudDuelScore = byId<HTMLDivElement>('hud-duel-score');
  private readonly hudPPts = byId<HTMLElement>('hud-p-pts');
  private readonly hudRPts = byId<HTMLElement>('hud-r-pts');
  private readonly hudHealthPlayer = byId<HTMLDivElement>('hud-health-player');
  private readonly hudHealthRobot = byId<HTMLDivElement>('hud-health-robot');
  private readonly hudSmashBar = byId<HTMLDivElement>('hud-smash-bar');
  private readonly hudServePrompt = byId<HTMLDivElement>('hud-serve-prompt');
  private readonly btnHudMute = byId<HTMLButtonElement>('btn-hud-mute');
  private readonly btnHudBloom = byId<HTMLButtonElement>('btn-hud-bloom');
  private readonly btnHudPauseIcon = byId<HTMLButtonElement>('btn-hud-pause-icon');
  private readonly btnToggleSfx = byId<HTMLButtonElement>('btn-toggle-sfx');
  private readonly btnToggleBloom = byId<HTMLButtonElement>('btn-toggle-bloom');
  private readonly screenSettings = byId<HTMLDivElement>('screen-settings');
  private readonly btnOpenSettings = byId<HTMLButtonElement>('btn-open-settings');
  private readonly btnSettingBars = byId<HTMLButtonElement>('btn-setting-bars');
  private readonly btnSettingSfx = byId<HTMLButtonElement>('btn-setting-sfx');
  private readonly btnSettingBloom = byId<HTMLButtonElement>('btn-setting-bloom');
  private lastMuted: boolean | null = null;
  private focusResumeOnPause = false;

  private readonly duelDiffWrap = byId<HTMLDivElement>('duel-diff-wrap');
  private readonly btnRetryStage2 = byId<HTMLButtonElement>('btn-retry-stage2');
  private readonly menuLbList = byId<HTMLDivElement>('menu-lb-list');
  private readonly previewSourceBadge = byId<HTMLSpanElement>('preview-source-badge');

  private readonly goEyebrow = byId<HTMLDivElement>('go-eyebrow');
  private readonly goTitle = byId<HTMLHeadingElement>('go-title');
  private readonly goScore = byId<HTMLDivElement>('go-score');
  private readonly goRally = byId<HTMLDivElement>('go-rally');
  private readonly goPerfect = byId<HTMLDivElement>('go-perfect');
  private readonly goFourthLabel = byId<HTMLDivElement>('go-fourth-label');
  private readonly goFourthVal = byId<HTMLDivElement>('go-fourth-val');
  private readonly formSubmit = byId<HTMLFormElement>('form-submit-score');
  private readonly inputCallsign = byId<HTMLInputElement>('input-callsign');
  private readonly btnSubmitScore = byId<HTMLButtonElement>('btn-submit-score');
  private readonly submitFeedback = byId<HTMLDivElement>('submit-feedback');
  private readonly goLbPreview = byId<HTMLDivElement>('go-lb-preview');

  constructor() {
    try {
      this.stage2Unlocked = window.localStorage.getItem(STAGE2_UNLOCKED_STORAGE_KEY) === '1';
    } catch {
      this.stage2Unlocked = false;
    }
    try {
      this.hudStyle = parseHudStyle(window.localStorage.getItem(HUD_STYLE_STORAGE_KEY));
    } catch {
      this.hudStyle = 'classic';
    }
    this.setToggleState(this.btnSettingBars, this.hudStyle === 'bars');
    this.buildHealthSegments(this.hudHealthPlayer);
    this.buildHealthSegments(this.hudHealthRobot);
    this.bindUiEvents();
    const savedName = window.localStorage.getItem(CALLSIGN_STORAGE_KEY);
    if (savedName) {
      this.inputCallsign.value = savedName;
    }
    void this.initArena();
  }

  private bindUiEvents(): void {
    this.btnRetryLoad.addEventListener('click', () => {
      this.loadingError.classList.add('hidden');
      this.btnRetryLoad.classList.add('hidden');
      void this.initArena();
    });

    // Mode selector buttons
    document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = (btn.dataset.mode as GameMode) || 'duel';
        this.selectedMode = mode;
        document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.duelDiffWrap.classList.toggle('hidden', mode !== 'duel');
        void this.refreshMenuLeaderboard(mode);
      });
    });

    // Story difficulty buttons
    document.querySelectorAll<HTMLButtonElement>('.diff-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedDifficulty = (btn.dataset.diff as Difficulty) || 'easy';
        document.querySelectorAll('.diff-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    byId<HTMLButtonElement>('btn-start-game').addEventListener('click', () => {
      this.hasSubmittedRun = false;
      this.lastSubmittedId = null;
      // A match started from the menu always begins at Stage 1; Stage 2 is reached by winning it.
      this.engine?.startNewGame(this.selectedMode, this.selectedDifficulty, 1);
    });

    // HUD controls (classic HUD)
    this.btnHudMute.addEventListener('click', () => {
      this.engine?.toggleMute();
    });

    this.btnHudBloom.addEventListener('click', () => {
      this.setBloom(!this.bloomOn);
    });

    byId<HTMLButtonElement>('btn-hud-pause').addEventListener('click', () => {
      this.engine?.pauseGame();
    });

    // Health bars HUD: pause icon and pause-menu toggles
    this.btnHudPauseIcon.addEventListener('click', () => {
      this.engine?.pauseGame();
      // Leave the icon so Space (serve) cannot re-trigger it; focus moves into the menu once shown.
      this.btnHudPauseIcon.blur();
      this.focusResumeOnPause = true;
    });

    this.btnToggleSfx.addEventListener('click', () => {
      this.engine?.toggleMute();
    });

    this.btnToggleBloom.addEventListener('click', () => {
      this.setBloom(!this.bloomOn);
    });

    // Settings (main menu)
    this.btnOpenSettings.addEventListener('click', () => this.openSettings());
    byId<HTMLButtonElement>('btn-close-settings').addEventListener('click', () =>
      this.closeSettings()
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.screenSettings.classList.contains('hidden')) {
        e.preventDefault();
        this.closeSettings();
      }
    });

    this.btnSettingBars.addEventListener('click', () => {
      this.setHudStyle(this.hudStyle === 'bars' ? 'classic' : 'bars');
    });

    this.btnSettingSfx.addEventListener('click', () => {
      this.engine?.toggleMute();
    });

    this.btnSettingBloom.addEventListener('click', () => {
      this.setBloom(!this.bloomOn);
    });

    // Pause controls
    byId<HTMLButtonElement>('btn-resume').addEventListener('click', () => {
      this.engine?.resumeGame();
    });

    byId<HTMLButtonElement>('btn-restart-pause').addEventListener('click', () => {
      this.hasSubmittedRun = false;
      const restartStage: StoryStage =
        this.selectedMode === 'duel' && this.lastSnapshot?.storyStage === 2 && this.stage2Unlocked
          ? 2
          : 1;
      this.engine?.startNewGame(this.selectedMode, this.selectedDifficulty, restartStage);
    });

    byId<HTMLButtonElement>('btn-quit-menu').addEventListener('click', () => {
      // returnToMenu also switches the arena back to Stage 1.
      this.engine?.returnToMenu();
      void this.refreshMenuLeaderboard(this.selectedMode);
    });

    byId<HTMLInputElement>('input-sensitivity').addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value);
      this.engine?.setSensitivity(val);
    });

    // Game Over actions
    this.btnRetryStage2.addEventListener('click', () => {
      this.hasSubmittedRun = false;
      this.lastSubmittedId = null;
      this.engine?.startNewGame('duel', this.selectedDifficulty, 2);
    });

    byId<HTMLButtonElement>('btn-play-again').addEventListener('click', () => {
      this.hasSubmittedRun = false;
      this.lastSubmittedId = null;
      this.engine?.startNewGame(this.selectedMode, this.selectedDifficulty, 1);
    });

    byId<HTMLButtonElement>('btn-go-menu').addEventListener('click', () => {
      this.engine?.returnToMenu();
      void this.refreshMenuLeaderboard(this.selectedMode);
    });

    // Leaderboard submission
    this.formSubmit.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.handleSubmitScore();
    });

    byId<HTMLButtonElement>('btn-reload-page').addEventListener('click', () => {
      window.location.reload();
    });
  }

  private async initArena(): Promise<void> {
    this.loadingStatus.textContent = 'Initializing WebGL2 renderer...';
    this.loadingBar.style.width = '10%';

    try {
      if (!this.sceneManager) {
        this.sceneManager = new SceneManager(this.canvasContainer, {
          onContextLost: () => {
            this.engine?.pauseGame();
            this.screenContextLost.classList.remove('hidden');
          },
          onContextRestored: () => {
            this.screenContextLost.classList.add('hidden');
          },
        });
      }

      // Always boot into exact Stage 1 (MK-I Classic + indoor cathedral) — zero Stage 2 spoilers!
      await this.sceneManager.loadModels((pct, label) => {
        this.loadingBar.style.width = `${Math.max(12, pct)}%`;
        this.loadingStatus.textContent = `Loaded 3D model: ${label} (${pct}%)`;
      }, getRobotSkin('classic'));

      this.engine = new GameEngine(
        this.sceneManager,
        (snap) => this.renderHud(snap),
        {
          initialStage2Unlocked: this.stage2Unlocked,
          onStage2Unlocked: () => {
            this.stage2Unlocked = true;
            try {
              window.localStorage.setItem(STAGE2_UNLOCKED_STORAGE_KEY, '1');
            } catch {
              // Ignore storage quota errors
            }
          },
        }
      );
      this.engine.setReadyMenu();
      this.engine.startLoop();

      this.screenLoading.classList.add('hidden');
      void this.refreshMenuLeaderboard(this.selectedMode);

      const params = new URLSearchParams(window.location.search);
      if (params.get('preview') === 'cutscene') {
        this.engine.triggerCutscenePreview();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.loadingStatus.textContent = 'Initialization halted.';
      this.loadingError.textContent = msg;
      this.loadingError.classList.remove('hidden');
      this.btnRetryLoad.classList.remove('hidden');
    }
  }

  private renderHud(snap: HudSnapshot): void {
    this.lastSnapshot = snap;

    const isMenu = snap.state === 'MENU';
    const isCutscene = snap.state === 'CUTSCENE';
    const isPlaying =
      snap.state === 'SERVE' || snap.state === 'RALLY' || snap.state === 'POINT_PAUSE';
    const isPaused = snap.state === 'PAUSED';
    const isGameOver = snap.state === 'GAME_OVER';

    this.screenMenu.classList.toggle('hidden', !isMenu);
    this.hudEl.classList.toggle('hidden', !isPlaying && !isPaused);
    this.screenPause.classList.toggle('hidden', !isPaused);
    if (!isMenu && !this.screenSettings.classList.contains('hidden')) {
      this.screenSettings.classList.add('hidden');
    }
    const barsHud = this.hudStyle === 'bars';
    this.hudEl.classList.toggle('hud--bars', barsHud);
    this.screenPause.classList.toggle('pause--bars', barsHud);
    if (this.focusResumeOnPause) {
      this.focusResumeOnPause = false;
      if (isPaused) byId<HTMLButtonElement>('btn-resume').focus();
    }
    this.screenGameOver.classList.toggle('hidden', !isGameOver);

    // Cinematic letterbox bars during Stage 1 -> Stage 2 transformation cutscene
    this.fxLetterboxTop.classList.toggle('active', isCutscene);
    this.fxLetterboxBottom.classList.toggle('active', isCutscene);
    this.cutsceneSkipHint.classList.toggle('hidden', !(isCutscene && snap.canSkipCutscene));

    // Vignettes
    this.fxSlowMo.classList.toggle('active', snap.slowMoActive);
    this.fxSmashWarn.classList.toggle('active', snap.smashWarning && isPlaying);

    // Numbers & bars
    this.hudScore.textContent = snap.score.toLocaleString();
    this.hudCombo.textContent = `x${snap.comboMultiplier}`;
    this.hudRally.textContent = String(snap.rally);
    this.hudBestRally.textContent = String(snap.bestRally);
    this.hudSmashBar.style.width = `${Math.round(snap.smashCharge * 100)}%`;
    this.btnHudMute.textContent = snap.muted ? 'SFX OFF' : 'SFX ON';
    if (this.lastMuted !== snap.muted) {
      this.lastMuted = snap.muted;
      this.setToggleState(this.btnToggleSfx, !snap.muted);
      this.setToggleState(this.btnSettingSfx, !snap.muted);
    }
    if (this.lastSavedOneToOne !== snap.oneToOneMode) {
      this.lastSavedOneToOne = snap.oneToOneMode;
      try {
        window.localStorage.setItem(ONE_TO_ONE_STORAGE_KEY, snap.oneToOneMode ? '1' : '0');
      } catch {
        // Ignore storage restrictions
      }
    }

    // Mode-specific top center
    if (snap.mode === 'arcade') {
      this.hudPhaseBadge.textContent = `PHASE ${snap.threatPhase.phase} // ${snap.threatPhase.name}`;
      this.hudPhaseBadge.style.color = snap.threatPhase.accentHex;
      this.hudArcadeShields.classList.remove('hidden');
      this.hudDuelScore.classList.add('hidden');
      this.setStoryBarsActive(false);

      let pips = '';
      for (let i = 0; i < snap.maxShields; i++) {
        pips += `<span class="shield-pip${i >= snap.shields ? ' lost' : ''}"></span>`;
      }
      this.hudArcadeShields.innerHTML = pips;
    } else {
      this.hudPhaseBadge.textContent =
        snap.storyStage === 2
          ? `STAGE 2 // ${snap.threatPhase.name}`
          : `STORY MODE // ${snap.difficulty.toUpperCase()}`;
      this.hudPhaseBadge.style.color = snap.threatPhase.accentHex;
      this.hudArcadeShields.classList.add('hidden');
      if (barsHud) {
        this.hudDuelScore.classList.add('hidden');
        this.setStoryBarsActive(true);
        this.renderHealthBars(snap.playerPoints, snap.robotPoints);
      } else {
        this.setStoryBarsActive(false);
        this.hudDuelScore.classList.remove('hidden');
        this.hudPPts.textContent = String(snap.playerPoints);
        this.hudRPts.textContent = String(snap.robotPoints);
      }
    }

    // Serve prompt (bottom edge only — zero center-screen callouts)
    const showServe = snap.state === 'SERVE' && snap.server === 'player';
    this.hudServePrompt.classList.toggle('hidden', !showServe);

    // Subtle top-bar highlight pulse when Threat Phase advances or shield drops
    if (snap.threatPhase.phase !== this.lastPhaseNum) {
      this.lastPhaseNum = snap.threatPhase.phase;
      this.hudPhaseBadge.classList.remove('hud-pulse');
      void this.hudPhaseBadge.offsetWidth;
      this.hudPhaseBadge.classList.add('hud-pulse');
    }
    if (snap.shields < this.lastShields) {
      this.hudArcadeShields.classList.remove('hud-pulse');
      void this.hudArcadeShields.offsetWidth;
      this.hudArcadeShields.classList.add('hud-pulse');
    }
    this.lastShields = snap.shields;

    // Populate Game Over modal once on transition
    if (isGameOver && this.prevState !== 'GAME_OVER') {
      this.populateGameOver(snap);
    }
    this.prevState = snap.state;
  }

  private setToggleState(btn: HTMLButtonElement, on: boolean): void {
    btn.setAttribute('aria-checked', String(on));
    const state = btn.querySelector('.toggle-state');
    if (state) state.textContent = on ? 'ON' : 'OFF';
  }

  private buildHealthSegments(bar: HTMLElement): void {
    const bezel = bar.querySelector<HTMLElement>('.health-bezel');
    if (!bezel) throw new Error('Missing .health-bezel in health bar');
    bezel.replaceChildren();
    // Segment 0 is the innermost one (next to the centre gap); health is lost from the outer end.
    for (let i = 0; i < STORY_POINTS_TO_WIN; i++) {
      const seg = document.createElement('span');
      seg.className = 'health-seg';
      const ghost = document.createElement('span');
      ghost.className = 'health-ghost';
      seg.appendChild(ghost);
      bezel.appendChild(seg);
    }
    // Clear one-shot reaction classes so they do not replay when the HUD is shown again.
    // Hiding the HUD mid-animation (e.g. on the match point) cancels it instead of ending it.
    const clearReaction = (event: AnimationEvent): void => {
      if (event.animationName.startsWith('healthHit')) {
        bar.classList.remove('is-hit');
      } else if (event.animationName.startsWith('healthGhost')) {
        (event.target as HTMLElement).closest('.health-seg')?.classList.remove('is-draining');
      }
    };
    bar.addEventListener('animationend', clearReaction);
    bar.addEventListener('animationcancel', clearReaction);
  }

  private clearHitReactions(): void {
    for (const bar of [this.hudHealthPlayer, this.hudHealthRobot]) {
      bar.classList.remove('is-hit');
      bar.querySelectorAll('.is-draining').forEach((seg) => seg.classList.remove('is-draining'));
    }
  }

  /** Story mode with the health bars HUD. Off in Arcade and in the classic HUD. */
  private setStoryBarsActive(active: boolean): void {
    this.hudEl.classList.toggle('hud--story', active);
    if (!active && (this.lastStoryPoints || this.lastHealthKey)) this.resetHealthBarTracking();
  }

  private resetHealthBarTracking(): void {
    this.lastStoryPoints = null;
    this.lastHealthKey = '';
    this.clearHitReactions();
  }

  private setHudStyle(style: HudStyle): void {
    this.hudStyle = style;
    this.setToggleState(this.btnSettingBars, style === 'bars');
    this.resetHealthBarTracking();
    try {
      window.localStorage.setItem(HUD_STYLE_STORAGE_KEY, style);
    } catch {
      // Ignore storage restrictions; the choice still applies for this session
    }
  }

  private setBloom(on: boolean): void {
    this.bloomOn = on;
    this.sceneManager?.setBloomEnabled(on);
    this.btnHudBloom.textContent = on ? 'BLOOM ON' : 'BLOOM OFF';
    this.setToggleState(this.btnToggleBloom, on);
    this.setToggleState(this.btnSettingBloom, on);
  }

  private openSettings(): void {
    this.screenSettings.classList.remove('hidden');
    this.btnSettingBars.focus();
  }

  private closeSettings(): void {
    this.screenSettings.classList.add('hidden');
    this.btnOpenSettings.focus();
  }

  private renderHealthBars(playerPoints: number, robotPoints: number): void {
    const prev = this.lastStoryPoints;
    this.lastStoryPoints = { player: playerPoints, robot: robotPoints };
    // A drop in either score means a new match or stage started: no hit reaction.
    const isReset = !prev || playerPoints < prev.player || robotPoints < prev.robot;
    const playerHit = !isReset && robotPoints > prev.robot;
    const robotHit = !isReset && playerPoints > prev.player;
    if (isReset) this.clearHitReactions();

    const bars = computeStoryHealthBars(playerPoints, robotPoints);
    const key = `${bars.player.segments}${bars.player.cracked}|${bars.robot.segments}${bars.robot.cracked}`;
    if (key === this.lastHealthKey && !playerHit && !robotHit) return;
    this.lastHealthKey = key;

    this.applyHealthBar(this.hudHealthPlayer, 'You', bars.player, playerHit);
    this.applyHealthBar(this.hudHealthRobot, 'Robot', bars.robot, robotHit);
  }

  private applyHealthBar(
    bar: HTMLElement,
    label: string,
    side: HealthBarSide,
    hit: boolean
  ): void {
    const segs = bar.querySelectorAll<HTMLElement>('.health-seg');
    segs.forEach((seg, i) => {
      const filled = i < side.segments;
      const wasFilled = seg.classList.contains('is-filled');
      const wasCracked = seg.classList.contains('is-cracked');
      const cracked = filled && side.cracked && i === side.segments - 1;
      seg.classList.toggle('is-filled', filled);
      seg.classList.toggle('is-cracked', cracked);
      const justDamaged = hit && ((wasFilled && !filled) || (cracked && !wasCracked));
      seg.classList.remove('is-draining');
      if (justDamaged) {
        void seg.offsetWidth;
        seg.classList.add('is-draining');
      }
    });

    bar.dataset.segments = String(side.segments);
    bar.classList.toggle('is-low', side.segments === 1);
    bar.classList.toggle('is-out', side.segments === 0);
    bar.setAttribute(
      'aria-label',
      `${label}: ${side.segments} of ${STORY_POINTS_TO_WIN}${side.cracked ? ', cracked' : ''}`
    );

    if (hit) {
      bar.classList.remove('is-hit');
      void bar.offsetWidth;
      bar.classList.add('is-hit');
    }
  }

  private populateGameOver(snap: HudSnapshot): void {
    this.submitFeedback.classList.add('hidden');
    this.btnSubmitScore.disabled = false;
    this.btnSubmitScore.textContent = 'SAVE SCORE';
    this.hasSubmittedRun = false;
    this.goEyebrow.classList.add('hidden');

    if (snap.mode === 'duel') {
      const won = snap.winner === 'player';
      const isStage2 = snap.storyStage === 2;
      this.goTitle.textContent = won
        ? 'VICTORY'
        : isStage2
          ? 'STAGE 2 DEFEAT'
          : 'DEFEAT';
      this.goTitle.style.color = won ? 'var(--emerald)' : 'var(--crimson)';
      this.goFourthLabel.textContent = isStage2 ? 'STAGE 2' : 'SCORE';
      this.goFourthVal.textContent = `${snap.playerPoints}-${snap.robotPoints}`;
      this.btnRetryStage2.classList.toggle('hidden', !(isStage2 && !won && this.stage2Unlocked));
    } else {
      this.goTitle.textContent = 'GAME OVER';
      this.goTitle.style.color = 'var(--crimson)';
      this.goFourthLabel.textContent = 'MAX PHASE';
      this.goFourthVal.textContent = `${snap.maxPhaseReached}`;
      this.btnRetryStage2.classList.add('hidden');
    }

    this.goScore.textContent = snap.score.toLocaleString();
    this.goRally.textContent = String(snap.bestRally);
    this.goPerfect.textContent = String(snap.perfectHits);

    void this.refreshGameOverLeaderboard(snap.mode);
  }

  private async handleSubmitScore(): Promise<void> {
    if (!this.lastSnapshot || this.hasSubmittedRun) return;
    const rawName = this.inputCallsign.value.trim();
    if (!rawName) {
      this.showSubmitFeedback('Enter a name (1–16 letters or numbers).', true);
      return;
    }

    this.btnSubmitScore.disabled = true;
    this.btnSubmitScore.textContent = 'SAVING...';

    const snap = this.lastSnapshot;
    const res = await submitLeaderboardScore({
      name: rawName,
      mode: snap.mode,
      score: snap.score,
      bestRally: snap.bestRally,
      maxPhase: snap.maxPhaseReached,
      perfectHits: snap.perfectHits,
      difficulty: snap.mode === 'arcade' ? 'overdrive' : snap.difficulty,
      matchScore: snap.mode === 'duel' ? `${snap.playerPoints}-${snap.robotPoints}` : undefined,
    });

    if (!res.ok) {
      this.btnSubmitScore.disabled = false;
      this.btnSubmitScore.textContent = 'SAVE SCORE';
      this.showSubmitFeedback(res.error || 'Could not save score.', true);
      return;
    }

    this.hasSubmittedRun = true;
    this.lastSubmittedId = res.entry?.id ?? null;
    if (res.entry?.name) {
      window.localStorage.setItem(CALLSIGN_STORAGE_KEY, res.entry.name);
      this.inputCallsign.value = res.entry.name;
    }

    const rankText = res.rank ? `#${res.rank}` : 'SAVED';
    const recordTag = res.isTopRecord ? ' (NEW BEST)' : '';
    const cacheTag = res.source === 'local' ? ' [LOCAL]' : '';
    this.showSubmitFeedback(`SAVED — ${rankText}${recordTag}${cacheTag}`, false);
    this.btnSubmitScore.textContent = 'SAVED';

    if (res.entries) {
      this.renderMiniLeaderboard(this.goLbPreview, res.entries.slice(0, 20), this.lastSubmittedId);
      const hi = this.goLbPreview.querySelector('.highlight');
      hi?.scrollIntoView({ block: 'nearest' });
    } else {
      void this.refreshGameOverLeaderboard(snap.mode);
    }
  }

  private showSubmitFeedback(msg: string, isErr: boolean): void {
    this.submitFeedback.textContent = msg;
    this.submitFeedback.classList.toggle('err', isErr);
    this.submitFeedback.classList.remove('hidden');
  }

  private renderMiniLeaderboard(
    container: HTMLElement,
    entries: LeaderboardEntry[],
    highlightId: string | null = null
  ): void {
    if (entries.length === 0) {
      container.innerHTML = '<div class="muted-copy">No personal scores yet.</div>';
      return;
    }
    container.innerHTML = entries
      .map(
        (entry, idx) => `
          <div class="lb-mini-row${highlightId && entry.id === highlightId ? ' highlight' : ''}">
            <span class="lb-rank">#${idx + 1}</span>
            <span class="lb-name">${escapeHtml(entry.name)}</span>
            <span class="lb-score">${entry.score.toLocaleString()}</span>
          </div>
        `
      )
      .join('');
  }

  private async refreshMenuLeaderboard(mode: GameMode): Promise<void> {
    const res = await fetchLeaderboard(mode, 6);
    const isOffline = res.source !== 'server';
    this.previewSourceBadge.textContent = 'LOCAL';
    this.previewSourceBadge.classList.toggle('local', isOffline);
    this.previewSourceBadge.classList.toggle('hidden', !isOffline);
    this.renderMiniLeaderboard(this.menuLbList, res.entries);
  }

  private async refreshGameOverLeaderboard(mode: GameMode): Promise<void> {
    const res = await fetchLeaderboard(mode, 15);
    this.renderMiniLeaderboard(this.goLbPreview, res.entries, this.lastSubmittedId);
    const hi = this.goLbPreview.querySelector('.highlight');
    hi?.scrollIntoView({ block: 'nearest' });
  }
}

new RobotPongApp();
