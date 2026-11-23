import type { Difficulty, GameMode, StoryStage } from './game/constants';
import { GameEngine, type HudSnapshot } from './game/gameEngine';
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
  private selectedStoryStage: StoryStage = 1;
  private stage2Unlocked = false;
  private bloomOn = true;
  private lastSnapshot: HudSnapshot | null = null;
  private hasSubmittedRun = false;
  private lastSubmittedId: string | null = null;
  private prevState: string = 'LOADING';
  private lastSavedOneToOne: boolean | null = null;
  private lastPhaseNum = 1;
  private lastShields = 3;

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
  private readonly hudSmashBar = byId<HTMLDivElement>('hud-smash-bar');
  private readonly hudServePrompt = byId<HTMLDivElement>('hud-serve-prompt');
  private readonly btnHudMute = byId<HTMLButtonElement>('btn-hud-mute');
  private readonly btnHudBloom = byId<HTMLButtonElement>('btn-hud-bloom');

  private readonly duelDiffWrap = byId<HTMLDivElement>('duel-diff-wrap');
  private readonly storyStageWrap = byId<HTMLDivElement>('story-stage-wrap');
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
    this.syncStageUnlockVisibility();
    this.bindUiEvents();
    const savedName = window.localStorage.getItem(CALLSIGN_STORAGE_KEY);
    if (savedName) {
      this.inputCallsign.value = savedName;
    }
    void this.initArena();
  }

  private syncStageUnlockVisibility(): void {
    const showStagePicker = this.selectedMode === 'duel' && this.stage2Unlocked;
    this.storyStageWrap.classList.toggle('hidden', !showStagePicker);
    if (!this.stage2Unlocked) {
      this.selectedStoryStage = 1;
    }
    document.querySelectorAll<HTMLButtonElement>('.stage-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.stage) === this.selectedStoryStage);
    });
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
        this.syncStageUnlockVisibility();
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

    // Unlocked Story Stage selector buttons
    document.querySelectorAll<HTMLButtonElement>('.stage-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!this.stage2Unlocked) return;
        const stg = Number(btn.dataset.stage) === 2 ? 2 : 1;
        this.selectedStoryStage = stg;
        this.syncStageUnlockVisibility();
        void this.sceneManager?.setEnvironmentStage(stg);
      });
    });

    byId<HTMLButtonElement>('btn-start-game').addEventListener('click', () => {
      this.hasSubmittedRun = false;
      this.lastSubmittedId = null;
      const startStage: StoryStage =
        this.selectedMode === 'duel' && this.stage2Unlocked ? this.selectedStoryStage : 1;
      this.engine?.startNewGame(this.selectedMode, this.selectedDifficulty, startStage);
    });

    // HUD controls
    this.btnHudMute.addEventListener('click', () => {
      this.engine?.toggleMute();
    });

    this.btnHudBloom.addEventListener('click', () => {
      this.bloomOn = !this.bloomOn;
      this.sceneManager?.setBloomEnabled(this.bloomOn);
      this.btnHudBloom.textContent = this.bloomOn ? 'BLOOM ON' : 'BLOOM OFF';
    });

    byId<HTMLButtonElement>('btn-hud-pause').addEventListener('click', () => {
      this.engine?.pauseGame();
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
      this.selectedStoryStage = 1;
      this.syncStageUnlockVisibility();
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
      this.selectedStoryStage = 1;
      this.syncStageUnlockVisibility();
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
            this.syncStageUnlockVisibility();
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
      this.hudDuelScore.classList.remove('hidden');
      this.hudPPts.textContent = String(snap.playerPoints);
      this.hudRPts.textContent = String(snap.robotPoints);
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
