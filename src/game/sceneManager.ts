import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SENTINEL, TABLE, type StoryStage, type ThreatPhaseConfig } from './constants';
import type { SoundEngine } from './audio';
import { createMatrixRainWalls, GameplayVFX, SteamMistSystem } from './matrixEffects';
import { getRobotSkin, type RobotSkinDefinition } from './robotSkins';
import { SentinelController } from './sentinelRig';
import type { BallState, PaddleState } from './physics';

export interface LoadedModels {
  sentinel: THREE.Object3D;
  table: THREE.Object3D;
  sentinelPaddle: THREE.Object3D;
  playerPaddle: THREE.Object3D;
  ball: THREE.Object3D;
  arena: THREE.Object3D;
}

export interface SceneCallbacks {
  onLoadProgress?: (percent: number, label: string) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

/**
 * Generates a synthetic cyberpunk studio environment map (emerald server zenith +
 * warm amber catwalk horizon) so the wet tabletop and gunmetal Sentinel armor reflect
 * vibrant green and orange highlights just like the reference artwork.
 */
function buildCyberpunkEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x050c09);

  // Towering emerald vertical light strips (Matrix server banks)
  const greenMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.12, 0.85, 0.38) });
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 10), greenMat);
    strip.position.set(Math.cos(angle) * 8, 3.8, Math.sin(angle) * 8);
    strip.lookAt(0, 3.8, 0);
    envScene.add(strip);
  }

  // Warm amber catwalk work-light strips near lower horizon (reflected vividly on wet tabletop!)
  const amberMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.75, 0.68, 0.16) });
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const lamp = new THREE.Mesh(new THREE.PlaneGeometry(0.65, 0.45), amberMat);
    lamp.position.set(Math.cos(angle) * 7.2, -0.35, Math.sin(angle) * 7.2);
    lamp.lookAt(0, -0.35, 0);
    envScene.add(lamp);
  }

  // Crimson central Sentinel glow accent in front (-Z)
  const redMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.18, 0.22) });
  const redBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 12), redMat);
  redBeacon.position.set(0, 1.8, -6.5);
  envScene.add(redBeacon);

  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  return rt.texture;
}

export function projectNdcToZPlane(
  camera: THREE.PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  planeZ: number,
  ndcScratch = new THREE.Vector3(),
  dirScratch = new THREE.Vector3()
): { x: number; y: number } | null {
  camera.updateMatrixWorld();
  ndcScratch.set(ndcX, ndcY, 0.5).unproject(camera);
  dirScratch.copy(ndcScratch).sub(camera.position).normalize();

  if (Math.abs(dirScratch.z) < 1e-4) {
    return null;
  }

  const t = (planeZ - camera.position.z) / dirScratch.z;
  if (!Number.isFinite(t) || t <= 0.1 || t > 12) {
    return null;
  }

  return {
    x: camera.position.x + dirScratch.x * t,
    y: camera.position.y + dirScratch.y * t,
  };
}

export class SceneManager {
  public readonly container: HTMLElement;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private bloomEnabled = true;

  public sentinelController: SentinelController | null = null;
  public playerPaddleObj: THREE.Object3D | null = null;
  public sentinelPaddleObj: THREE.Object3D | null = null;
  public ballObj: THREE.Object3D | null = null;
  public readonly vfx: GameplayVFX;
  private readonly steam: SteamMistSystem;
  private readonly matrixRain: ReturnType<typeof createMatrixRainWalls>;
  private readonly sentinelEyeLight: THREE.PointLight;
  private readonly gltfLoader = new GLTFLoader();
  private readonly sentinelSkinCache = new Map<string, THREE.Object3D>();
  private activeSentinelObj: THREE.Object3D | null = null;
  private activeSkinId: string = 'classic';
  private skinLoadSeq = 0;

  // Stage 2 Expansion & Boss-Destruction Cutscene State
  private cityscapeObj: THREE.Object3D | null = null;
  private stage2PreloadPromise: Promise<void> | null = null;
  private readonly cityEmeraldLight: THREE.DirectionalLight;
  private readonly cityAmberLeft: THREE.PointLight;
  private readonly cityAmberRight: THREE.PointLight;
  private currentStage: StoryStage = 1;
  private cutsceneActive = false;
  private cutsceneRumbleFired = false;
  private cutsceneCrushFired = false;
  private cutsceneExpandFired = false;
  private cutsceneSwappedController = false;
  private cutsceneSparkAccum = 0;
  private defeatedMk1Obj: THREE.Object3D | null = null;
  private defeatedMk1Pos = new THREE.Vector3();
  private defeatedMk1Vel = new THREE.Vector3();
  private defeatedMk1Rot = new THREE.Euler();
  private apexCutsceneObj: THREE.Object3D | null = null;
  private readonly cutsceneCamPos = new THREE.Vector3();
  private readonly cutsceneCamLook = new THREE.Vector3();

  private shakeMagnitude = 0;
  private cameraClock = 0;
  private contextLost = false;
  private readonly eyeWorldScratch = new THREE.Vector3();
  private readonly rayNdcScratch = new THREE.Vector3();
  private readonly rayDirScratch = new THREE.Vector3();
  private readonly boundResize: () => void;

  constructor(container: HTMLElement, callbacks: SceneCallbacks = {}) {
    this.container = container;

    // Verify WebGL availability gracefully before constructing renderer
    const testCanvas = document.createElement('canvas');
    const gl =
      testCanvas.getContext('webgl2') ||
      testCanvas.getContext('webgl') ||
      testCanvas.getContext('experimental-webgl');
    if (!gl) {
      throw new Error('WebGL is unavailable in this browser or GPU context.');
    }

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    // Handle WebGL context loss & restoration cleanly
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      callbacks.onContextLost?.();
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      callbacks.onContextRestored?.();
    });

    // Scene & moody Matrix emerald-black fog
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030806);
    this.scene.fog = new THREE.FogExp2(0x06140d, 0.048);
    this.scene.environment = buildCyberpunkEnvMap(this.renderer);

    // Camera framed over player's end of the table looking right at the towering Sentinel
    const aspect =
      (container.clientWidth || window.innerWidth) /
      Math.max(1, container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(this.computeAdaptiveFov(aspect), aspect, 0.08, 155);
    this.camera.position.set(0, 1.62, 2.52);
    this.camera.lookAt(0, 1.06, -1.25);

    // Cinematic 3-color lighting palette directly matching the uploaded reference image:
    // 1) Cool emerald-teal industrial overhead key/fill
    const hemiLight = new THREE.HemisphereLight(0x4effa6, 0x2c1a0e, 0.72);
    this.scene.add(hemiLight);

    const overheadKey = new THREE.DirectionalLight(0xc2ffe0, 1.55);
    overheadKey.position.set(1.6, 7.2, 2.4);
    overheadKey.castShadow = true;
    overheadKey.shadow.mapSize.set(1024, 1024);
    overheadKey.shadow.camera.near = 1;
    overheadKey.shadow.camera.far = 16;
    overheadKey.shadow.camera.left = -3.2;
    overheadKey.shadow.camera.right = 3.2;
    overheadKey.shadow.camera.top = 3.2;
    overheadKey.shadow.camera.bottom = -3.2;
    overheadKey.shadow.bias = -0.0006;
    this.scene.add(overheadKey);

    // 2) Emerald rim backlight separating Sentinel carapace silhouette from the digital rain
    const emeraldRim = new THREE.DirectionalLight(0x18e06c, 1.05);
    emeraldRim.position.set(-1.2, 6.2, -8.5);
    this.scene.add(emeraldRim);

    // 3) Warm amber industrial catwalk lights (left & right) reflecting cleanly on the wet table
    const amberLeft = new THREE.PointLight(0xff7d1f, 8.5, 10, 1.7);
    amberLeft.position.set(-3.2, 1.35, -0.2);
    this.scene.add(amberLeft);

    const amberRight = new THREE.PointLight(0xff7d1f, 8.5, 10, 1.7);
    amberRight.position.set(3.2, 1.35, -0.4);
    this.scene.add(amberRight);

    const amberRearLeft = new THREE.PointLight(0xff6b14, 7.5, 11, 1.7);
    amberRearLeft.position.set(-3.3, 1.55, -3.9);
    this.scene.add(amberRearLeft);

    const amberRearRight = new THREE.PointLight(0xff6b14, 7.5, 11, 1.7);
    amberRearRight.position.set(3.3, 1.55, -3.9);
    this.scene.add(amberRearRight);

    // 4) Dynamic Crimson Sentinel Eye Light
    this.sentinelEyeLight = new THREE.PointLight(0xff1428, 8.5, 9.5, 1.6);
    this.sentinelEyeLight.position.set(0, 2.05, -1.65);
    this.scene.add(this.sentinelEyeLight);

    // 5) Stage 2 Distant Cityscape Atmospheric Lights (intensity = 0 on Stage 1 so Stage 1 is untouched!)
    this.cityEmeraldLight = new THREE.DirectionalLight(0x1dff80, 0);
    this.cityEmeraldLight.position.set(-26, 34, -18);
    this.scene.add(this.cityEmeraldLight);

    this.cityAmberLeft = new THREE.PointLight(0xff7d1f, 0, 52, 1.25);
    this.cityAmberLeft.position.set(-18, 4.5, -26);
    this.scene.add(this.cityAmberLeft);

    this.cityAmberRight = new THREE.PointLight(0xff7d1f, 0, 52, 1.25);
    this.cityAmberRight.position.set(18, 4.5, -26);
    this.scene.add(this.cityAmberRight);

    // Atmospheric VFX layers
    this.matrixRain = createMatrixRainWalls();
    this.scene.add(this.matrixRain.group);

    this.steam = new SteamMistSystem();
    this.scene.add(this.steam.group);

    this.vfx = new GameplayVFX();
    this.scene.add(this.vfx.group);

    // Selective post-processing bloom (safe try/catch fallback)
    this.initPostProcessing();

    this.boundResize = () => this.handleResize();
    window.addEventListener('resize', this.boundResize);
  }

  private computeAdaptiveFov(aspect: number): number {
    // Widen FOV slightly on narrow/portrait screens so the entire table width stays visible
    if (aspect < 1.1) return 68;
    if (aspect < 1.45) return 58;
    return 50;
  }

  private initPostProcessing(): void {
    try {
      const width = this.container.clientWidth || window.innerWidth;
      const height = this.container.clientHeight || window.innerHeight;
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        0.36, // crisp emissive-only neon/crimson glow without washing out the wet tabletop
        0.48,
        0.96
      );
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    } catch {
      this.composer = null;
      this.bloomPass = null;
    }
  }

  public setBloomEnabled(enabled: boolean): void {
    this.bloomEnabled = enabled;
  }

  public addCameraShake(amount: number): void {
    this.shakeMagnitude = Math.min(0.14, this.shakeMagnitude + amount);
  }

  /**
   * Projects normalized screen pointer coordinates (ndcX, ndcY in [-1, 1]) directly
   * through the active camera onto the vertical strike plane z = planeZ for true 1:1 tracking.
   */
  public projectPointerToStrikePlane(
    ndcX: number,
    ndcY: number,
    planeZ: number
  ): { x: number; y: number } | null {
    return projectNdcToZPlane(
      this.camera,
      ndcX,
      ndcY,
      planeZ,
      this.rayNdcScratch,
      this.rayDirScratch
    );
  }

  public async loadModels(
    onProgress?: (pct: number, label: string) => void,
    initialSkin?: RobotSkinDefinition
  ): Promise<LoadedModels> {
    const skin = initialSkin ?? getRobotSkin(null);
    const specs: { key: string; url: string; label: string }[] = [
      { key: 'arena', url: '/models/arena_structure.glb', label: 'Industrial Cathedral' },
      { key: 'table', url: '/models/table.glb', label: 'Wet Tournament Table' },
      { key: 'sentinel', url: skin.modelUrl, label: `Sentinel (${skin.name})` },
      { key: 'paddle', url: '/models/paddle.glb', label: 'Table Tennis Paddles' },
      { key: 'ball', url: '/models/ball.glb', label: 'Regulation Ball' },
    ];

    let completed = 0;
    const loaded: Record<string, THREE.Object3D> = {};

    const loadOneWithRetry = async (url: string, label: string): Promise<THREE.Object3D> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const gltf = await this.gltfLoader.loadAsync(url);
          return gltf.scene;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      throw new Error(
        `Failed to load 3D model "${label}" (${url}): ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`
      );
    };

    await Promise.all(
      specs.map(async (s) => {
        const obj = await loadOneWithRetry(s.url, s.label);
        loaded[s.key] = obj;
        completed += 1;
        onProgress?.(Math.round((completed / specs.length) * 100), s.label);
      })
    );

    const arena = loaded.arena;
    const table = loaded.table;
    const sentinel = loaded.sentinel;
    const sentinelPaddle = loaded.paddle;
    const playerPaddle = loaded.paddle.clone(true);
    const ball = loaded.ball;

    // Enable clean shadows across loaded 3D models
    const enableShadows = (root: THREE.Object3D, cast: boolean, receive: boolean) => {
      root.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          m.castShadow = cast;
          m.receiveShadow = receive;
        }
      });
    };

    enableShadows(arena, false, true);
    enableShadows(table, true, true);
    enableShadows(sentinel, true, true);
    enableShadows(sentinelPaddle, true, false);
    enableShadows(playerPaddle, false, false);
    enableShadows(ball, true, false);

    // Make player paddle subtly semi-transparent so it never obscures an incoming smash!
    playerPaddle.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const cloneMat = (m: THREE.Material) => {
          const copy = m.clone() as THREE.MeshStandardMaterial;
          copy.transparent = true;
          copy.opacity = 0.72;
          copy.depthWrite = false;
          return copy;
        };
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(cloneMat)
          : cloneMat(mesh.material);
      }
    });
    // Rotate player paddle 180 deg so player sees backhand / strikes forward cleanly
    playerPaddle.rotation.y = Math.PI;
    playerPaddle.scale.setScalar(1.12);

    // Slight visual polish on ball so it gleams brightly against dark shadows
    ball.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const std = mesh.material as THREE.MeshStandardMaterial;
        if (std && std.isMeshStandardMaterial) {
          std.emissive = new THREE.Color(0x28362e);
          std.emissiveIntensity = 0.45;
        }
      }
    });

    this.scene.add(arena);
    this.scene.add(table);
    this.scene.add(sentinel);
    this.scene.add(sentinelPaddle);
    this.scene.add(playerPaddle);
    this.scene.add(ball);

    this.sentinelSkinCache.set(skin.id, sentinel);
    this.activeSentinelObj = sentinel;
    this.activeSkinId = skin.id;
    this.sentinelPaddleObj = sentinelPaddle;
    this.playerPaddleObj = playerPaddle;
    this.ballObj = ball;
    this.sentinelController = new SentinelController(
      sentinel,
      sentinelPaddle,
      this.sentinelEyeLight,
      skin.armArcStyle
    );

    return {
      sentinel,
      table,
      sentinelPaddle,
      playerPaddle,
      ball,
      arena,
    };
  }

  /**
   * Hot-swaps the Sentinel 3D model skin live in the scene (cached after first load,
   * race-guarded via monotonic sequence id, preserving active gameplay rig state).
   */
  public async setSentinelSkin(skin: RobotSkinDefinition): Promise<{ applied: boolean; skinId: string }> {
    if (this.activeSkinId === skin.id && this.activeSentinelObj) {
      return { applied: true, skinId: skin.id };
    }
    if (!this.sentinelPaddleObj) {
      throw new Error('Arena is not initialized yet.');
    }

    const reqSeq = ++this.skinLoadSeq;
    let model = this.sentinelSkinCache.get(skin.id);

    if (!model) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const gltf = await this.gltfLoader.loadAsync(skin.modelUrl);
          model = gltf.scene;
          break;
        } catch (err) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (!model) {
        throw new Error(
          `Failed to load robot skin "${skin.name}" (${skin.modelUrl}): ${
            lastErr instanceof Error ? lastErr.message : String(lastErr)
          }`
        );
      }

      model.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      this.sentinelSkinCache.set(skin.id, model);
    }

    // Ignore stale async completion if user clicked another skin while loading
    if (reqSeq !== this.skinLoadSeq) {
      return { applied: false, skinId: this.activeSkinId };
    }

    const prevState = this.sentinelController?.exportState();
    if (this.activeSentinelObj) {
      this.scene.remove(this.activeSentinelObj);
    }

    this.scene.add(model);
    this.activeSentinelObj = model;
    this.activeSkinId = skin.id;

    const nextCtrl = new SentinelController(
      model,
      this.sentinelPaddleObj,
      this.sentinelEyeLight,
      skin.armArcStyle
    );
    if (prevState) {
      nextCtrl.importState(prevState);
    }
    this.sentinelController = nextCtrl;

    return { applied: true, skinId: skin.id };
  }

  public getActiveSkinId(): string {
    return this.activeSkinId;
  }

  /**
   * Silently preloads Stage 2 assets (1:1 Apex Sentinel + Matrix Cityscape Expansion)
   * in the background without exposing them in UI or altering Stage 1.
   */
  public preloadStage2Assets(): Promise<void> {
    if (this.stage2PreloadPromise) return this.stage2PreloadPromise;

    this.stage2PreloadPromise = (async () => {
      const refSkin = getRobotSkin('reference');

      const loadSkinTask = (async () => {
        if (this.sentinelSkinCache.has(refSkin.id)) return;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const gltf = await this.gltfLoader.loadAsync(refSkin.modelUrl);
            gltf.scene.traverse((obj) => {
              if ((obj as THREE.Mesh).isMesh) {
                const m = obj as THREE.Mesh;
                m.castShadow = true;
                m.receiveShadow = true;
              }
            });
            this.sentinelSkinCache.set(refSkin.id, gltf.scene);
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      })();

      const loadCityTask = (async () => {
        if (this.cityscapeObj) return;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const gltf = await this.gltfLoader.loadAsync('/models/cityscape_expansion.glb');
            const city = gltf.scene;
            city.visible = false;
            city.position.set(0, 0, 0);
            this.scene.add(city);
            this.cityscapeObj = city;
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      })();

      await Promise.all([loadSkinTask, loadCityTask]);
    })();

    return this.stage2PreloadPromise;
  }

  private applyExpansionVisuals(progress: number): void {
    const t = Math.max(0, Math.min(1, progress));
    this.matrixRain.setExpansion(t);

    if (this.scene.fog instanceof THREE.FogExp2) {
      // Stage 1: exact 0.048 dense indoor haze -> Stage 2: 0.0105 deep cyberpunk skyline vista
      this.scene.fog.density = 0.048 + (0.0105 - 0.048) * t;
    }

    this.cityEmeraldLight.intensity = 1.15 * t;
    this.cityAmberLeft.intensity = 65 * t;
    this.cityAmberRight.intensity = 65 * t;

    if (this.cityscapeObj) {
      this.cityscapeObj.visible = t > 0.005;
      const easeOut = 1 - Math.pow(1 - t, 3);
      this.cityscapeObj.position.set(0, -6.5 * (1 - easeOut), 0);
      this.cityscapeObj.scale.setScalar(0.94 + 0.06 * easeOut);
    }
  }

  /**
   * Snaps environment and active boss cleanly to Stage 1 (exact classic look)
   * or Stage 2 (1:1 Apex Sentinel + expanded Matrix Machine Cityscape).
   */
  public async setEnvironmentStage(stage: StoryStage): Promise<void> {
    this.cutsceneActive = false;
    this.currentStage = stage;

    // Clean up any leftover cutscene actors
    if (this.defeatedMk1Obj && this.defeatedMk1Obj !== this.activeSentinelObj) {
      this.scene.remove(this.defeatedMk1Obj);
      this.defeatedMk1Obj.visible = true;
      this.defeatedMk1Obj.rotation.set(0, 0, 0);
      this.defeatedMk1Obj.position.set(
        SENTINEL.HOME_POS.x,
        SENTINEL.HOME_POS.y,
        SENTINEL.HOME_POS.z
      );
    }
    this.defeatedMk1Obj = null;

    if (this.apexCutsceneObj && this.apexCutsceneObj !== this.activeSentinelObj) {
      this.scene.remove(this.apexCutsceneObj);
    }
    this.apexCutsceneObj = null;

    if (this.ballObj) this.ballObj.visible = true;
    if (this.playerPaddleObj) this.playerPaddleObj.visible = true;

    if (stage === 2) {
      await this.preloadStage2Assets();
      const refSkin = getRobotSkin('reference');
      await this.setSentinelSkin(refSkin);
      this.applyExpansionVisuals(1);
    } else {
      const classicSkin = getRobotSkin('classic');
      await this.setSentinelSkin(classicSkin);
      if (this.activeSentinelObj) {
        this.activeSentinelObj.visible = true;
        this.activeSentinelObj.rotation.set(0, 0, 0);
        this.activeSentinelObj.position.set(
          SENTINEL.HOME_POS.x,
          SENTINEL.HOME_POS.y,
          SENTINEL.HOME_POS.z
        );
      }
      this.applyExpansionVisuals(0);
    }
  }

  public getEnvironmentStage(): StoryStage {
    return this.currentStage;
  }

  /**
   * Begins the real-time 3D Story Mode Stage 1 -> Stage 2 transformation cutscene:
   * MK-I sparks/fails -> 1:1 Apex Sentinel descends & crushes MK-I -> Cityscape expands outward.
   */
  public async beginStage2Cutscene(): Promise<void> {
    await this.preloadStage2Assets();

    // Ensure MK-I classic is mounted as the victim at its exact current position
    const classicObj = this.sentinelSkinCache.get('classic') ?? this.activeSentinelObj;
    const apexObj = this.sentinelSkinCache.get('reference') ?? null;

    this.cutsceneActive = true;
    if (this.ballObj) this.ballObj.visible = false;
    if (this.playerPaddleObj) this.playerPaddleObj.visible = false;
    this.cutsceneRumbleFired = false;
    this.cutsceneCrushFired = false;
    this.cutsceneExpandFired = false;
    this.cutsceneSwappedController = false;
    this.cutsceneSparkAccum = 0;

    this.defeatedMk1Obj = classicObj ?? null;
    if (this.defeatedMk1Obj) {
      if (!this.defeatedMk1Obj.parent) this.scene.add(this.defeatedMk1Obj);
      this.defeatedMk1Obj.visible = true;
      this.defeatedMk1Pos.copy(this.defeatedMk1Obj.position);
      this.defeatedMk1Rot.copy(this.defeatedMk1Obj.rotation);
      this.defeatedMk1Vel.set(0.9, 1.4, -7.8);
    }

    this.apexCutsceneObj = apexObj;
    if (this.apexCutsceneObj) {
      if (!this.apexCutsceneObj.parent) this.scene.add(this.apexCutsceneObj);
      this.apexCutsceneObj.visible = false;
      this.apexCutsceneObj.position.set(0, 7.8, -5.6);
      this.apexCutsceneObj.rotation.set(0.28, 0, 0);
    }

    // Start at exact Stage 1 environment (expansion = 0)
    this.applyExpansionVisuals(0);
  }

  /**
   * Drives one frame of the 5.75s real-time boss-destruction & cityscape-expansion cutscene.
   */
  public updateStage2Cutscene(
    elapsed: number,
    realDt: number,
    audio: SoundEngine,
    ball: BallState,
    stage2Phase: ThreatPhaseConfig
  ): void {
    if (!this.cutsceneActive || this.contextLost) return;

    this.cameraClock += realDt;
    this.shakeMagnitude = Math.max(0, this.shakeMagnitude - realDt * 0.45);
    this.steam.update(this.cameraClock);
    this.matrixRain.update(realDt * 1.45, 1.25);

    const smoothstep = (x: number) => {
      const c = Math.max(0, Math.min(1, x));
      return c * c * (3 - 2 * c);
    };

    // Phase A (0.0s - 1.15s): MK-I sparks violently & shudders in critical failure
    if (!this.cutsceneRumbleFired && elapsed >= 0.02) {
      this.cutsceneRumbleFired = true;
      audio.playBossRumble();
    }

    if (this.defeatedMk1Obj && elapsed < 2.0) {
      // Keep MK-I's arm actively gripping the red paddle while sparking & failing
      if (this.sentinelController && this.sentinelController.root === this.defeatedMk1Obj) {
        this.sentinelController.update(realDt, ball, stage2Phase, false);
      }
      const stress = Math.min(1, elapsed / 1.5);
      const jitter = 0.045 + stress * 0.08;
      this.defeatedMk1Obj.position.x += (Math.random() - 0.5) * jitter;
      this.defeatedMk1Obj.position.y += (Math.random() - 0.5) * jitter - stress * 0.1;
      this.defeatedMk1Obj.position.z += (Math.random() - 0.5) * jitter;
      this.defeatedMk1Obj.rotation.x += Math.sin(elapsed * 26) * 0.1;
      this.defeatedMk1Obj.rotation.z += Math.sin(elapsed * 33) * 0.14;

      this.cutsceneSparkAccum += realDt;
      if (this.cutsceneSparkAccum >= 0.13) {
        this.cutsceneSparkAccum = 0;
        this.vfx.emitSparks(
          {
            x: this.defeatedMk1Obj.position.x + (Math.random() - 0.5) * 0.9,
            y: this.defeatedMk1Obj.position.y + (Math.random() - 0.5) * 0.5,
            z: this.defeatedMk1Obj.position.z + 0.45,
          },
          Math.random() < 0.5 ? 0xff7a1f : 0xff2240,
          16,
          1.35
        );
      }
    }

    // Between crush impact (2.00s) and Apex snatch (2.22s), red paddle pops briefly into the air
    if (elapsed >= 2.0 && elapsed < 2.22 && this.sentinelPaddleObj) {
      const popT = (elapsed - 2.0) / 0.22;
      this.sentinelPaddleObj.position.y = TABLE.SURFACE_Y + 0.34 + Math.sin(popT * Math.PI) * 0.28;
      this.sentinelPaddleObj.rotation.z = popT * 1.4;
    }

    // Phase B (1.0s - 2.15s): 1:1 Apex Sentinel plunges down from ceiling cables & slams MK-I!
    if (this.apexCutsceneObj && elapsed >= 0.95 && !this.cutsceneSwappedController) {
      this.apexCutsceneObj.visible = true;
      const diveT = Math.max(0, Math.min(1, (elapsed - 0.95) / 1.05));
      // Accelerating predator slam curve
      const easeIn = diveT * diveT * diveT;
      this.apexCutsceneObj.position.set(
        0,
        7.8 + (SENTINEL.HOME_POS.y + 0.18 - 7.8) * easeIn,
        -5.6 + (SENTINEL.HOME_POS.z + 0.1 - -5.6) * easeIn
      );
      this.apexCutsceneObj.rotation.set(0.32 * (1 - easeIn), 0, 0);
      this.sentinelEyeLight.position.set(
        0,
        this.apexCutsceneObj.position.y,
        this.apexCutsceneObj.position.z + 0.85
      );
      this.sentinelEyeLight.intensity = 10 + diveT * 10;
    }

    // Impact moment (t = 2.00s): Massive metallic crush + shockwave + hurl MK-I into the abyss!
    if (!this.cutsceneCrushFired && elapsed >= 2.0) {
      this.cutsceneCrushFired = true;
      audio.playBossCrush();
      this.addCameraShake(0.14);
      const impactCenter = {
        x: SENTINEL.HOME_POS.x,
        y: SENTINEL.HOME_POS.y,
        z: SENTINEL.HOME_POS.z + 0.25,
      };
      this.vfx.spawnShockwave(impactCenter, 0xff2842);
      this.vfx.emitSparks(impactCenter, 0xff8a24, 36, 2.3);
      this.vfx.emitSparks(impactCenter, 0xff1e3c, 28, 1.9);
      this.vfx.emitSparks(impactCenter, 0xfff0b0, 16, 2.5);
    }

    // Destroyed MK-I tumbles backward into the dark abyss & disappears
    if (this.defeatedMk1Obj && elapsed >= 2.0) {
      if (this.defeatedMk1Obj.visible) {
        this.defeatedMk1Vel.y -= 13.5 * realDt;
        this.defeatedMk1Obj.position.addScaledVector(this.defeatedMk1Vel, realDt);
        this.defeatedMk1Obj.rotation.x += 4.6 * realDt;
        this.defeatedMk1Obj.rotation.y += 3.2 * realDt;
        this.defeatedMk1Obj.rotation.z -= 5.1 * realDt;

        this.cutsceneSparkAccum += realDt;
        if (this.cutsceneSparkAccum >= 0.07) {
          this.cutsceneSparkAccum = 0;
          this.vfx.emitSparks(
            {
              x: this.defeatedMk1Obj.position.x,
              y: this.defeatedMk1Obj.position.y,
              z: this.defeatedMk1Obj.position.z,
            },
            0xff6a1a,
            10,
            1.4
          );
        }

        if (this.defeatedMk1Obj.position.y < -4.2) {
          this.defeatedMk1Obj.visible = false;
        }
      }
    }

    // At t = 2.22s: Apex Sentinel snaps into command & snatches the airborne red paddle!
    if (!this.cutsceneSwappedController && elapsed >= 2.22 && this.apexCutsceneObj && this.sentinelPaddleObj) {
      this.cutsceneSwappedController = true;
      this.activeSentinelObj = this.apexCutsceneObj;
      this.activeSkinId = 'reference';
      this.sentinelController = new SentinelController(
        this.apexCutsceneObj,
        this.sentinelPaddleObj,
        this.sentinelEyeLight,
        'high_coil'
      );
      this.sentinelController.triggerSwing(true);
    }

    if (this.cutsceneSwappedController && this.sentinelController) {
      this.sentinelController.update(realDt, ball, stage2Phase, false);
    }

    // Phase C (2.70s - 5.15s): Matrix rain horizon pushes far outward & 3D Machine Cityscape expands!
    if (!this.cutsceneExpandFired && elapsed >= 2.7) {
      this.cutsceneExpandFired = true;
      audio.playCityExpand();
      this.addCameraShake(0.055);
    }

    if (elapsed >= 2.7) {
      const expT = smoothstep((elapsed - 2.7) / 2.45);
      this.applyExpansionVisuals(expT);
    }

    // Cinematic camera choreography across the 5.75s reveal:
    const shakeX = (Math.random() - 0.5) * this.shakeMagnitude;
    const shakeY = (Math.random() - 0.5) * this.shakeMagnitude;

    if (elapsed < 2.7) {
      // Dramatic low angle framing MK-I destruction & Apex descent
      const tA = smoothstep(elapsed / 1.4);
      this.cutsceneCamPos.set(
        0.24 * tA + shakeX,
        1.66 + (1.28 - 1.66) * tA + shakeY,
        2.56 + (2.74 - 2.56) * tA
      );
      this.cutsceneCamLook.set(0, 1.1 + 0.72 * tA, -1.9);
    } else if (elapsed < 4.95) {
      // Wide grand panorama showcasing the expanding 3D Matrix Cityscape behind the untouched table
      const tB = smoothstep((elapsed - 2.7) / 1.6);
      this.cutsceneCamPos.set(
        0.24 * (1 - tB) + shakeX,
        1.28 + (1.58 - 1.28) * tB + shakeY,
        2.74 + (3.08 - 2.74) * tB
      );
      this.cutsceneCamLook.set(0, 1.82 + 0.42 * tB, -4.5);
    } else {
      // Smooth glide back to exact crisp gameplay camera over the untouched table
      const tC = smoothstep((elapsed - 4.95) / 0.8);
      this.cutsceneCamPos.set(
        shakeX,
        1.58 + (1.66 - 1.58) * tC + shakeY,
        3.08 + (2.56 - 3.08) * tC
      );
      this.cutsceneCamLook.set(
        0,
        2.24 + (TABLE.SURFACE_Y + 0.34 - 2.24) * tC,
        -4.5 + (-0.95 - -4.5) * tC
      );
    }

    this.camera.position.lerp(this.cutsceneCamPos, Math.min(1, realDt * 7.5));
    this.camera.lookAt(this.cutsceneCamLook);

    if (this.sentinelController) {
      this.sentinelController.getMainEyeWorldPosition(this.eyeWorldScratch);
    } else {
      this.eyeWorldScratch.set(0, 2.05, -2.1);
    }
    this.vfx.update(realDt, realDt, ball, this.eyeWorldScratch, elapsed >= 1.5 && elapsed < 2.2 ? 0.9 : 0);

    if (this.bloomPass) {
      this.bloomPass.strength = elapsed >= 1.95 && elapsed <= 2.45 ? 0.65 : 0.4;
    }
    if (this.bloomEnabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  public async finishStage2Cutscene(): Promise<void> {
    await this.setEnvironmentStage(2);
  }

  public syncPlayerPaddle(paddle: PaddleState, bulletTime: boolean): void {
    if (!this.playerPaddleObj) return;
    this.playerPaddleObj.position.set(paddle.pos.x, paddle.pos.y, paddle.pos.z);

    // Responsive wrist tilt based on horizontal position & swipe velocity
    const tiltZ = -paddle.pos.x * 0.42 - paddle.vel.x * 0.045;
    const tiltX = -0.18 + Math.min(0.45, paddle.smashCharge * 0.42) - paddle.vel.z * 0.05;
    const tiltY = Math.PI + paddle.pos.x * 0.24;
    this.playerPaddleObj.rotation.set(tiltX, tiltY, tiltZ);

    // Subtle scale pop when charging power smash or in Bullet Time
    const s = 1.12 + paddle.smashCharge * 0.1 + (bulletTime ? 0.04 : 0);
    this.playerPaddleObj.scale.setScalar(s);
  }

  public syncBall(ball: BallState, dt: number): void {
    if (!this.ballObj) return;
    this.ballObj.position.set(ball.pos.x, ball.pos.y, ball.pos.z);
    // Spin the actual 3D ball mesh visibly!
    this.ballObj.rotation.x += ball.spin.x * dt;
    this.ballObj.rotation.y += ball.spin.y * dt;
    this.ballObj.rotation.z += (ball.vel.x * 2.5) * dt;
  }

  public updateVisuals(
    dt: number,
    realDt: number,
    ball: BallState,
    playerPaddle: PaddleState,
    opts: {
      isMenu: boolean;
      bulletTime: boolean;
      phaseNumber: number;
    }
  ): void {
    if (this.contextLost) return;

    this.cameraClock += realDt;
    this.shakeMagnitude = Math.max(0, this.shakeMagnitude - realDt * 0.55);

    // Matrix rain slows down dramatically in Bullet Time and intensifies at higher Threat Phases!
    const rainDt = opts.bulletTime ? dt * 0.35 : realDt * (1 + (opts.phaseNumber - 1) * 0.18);
    const baseRainIntensity = this.currentStage === 2 ? 1.18 : 1.05;
    this.matrixRain.update(
      rainDt,
      opts.bulletTime ? 1.38 : baseRainIntensity + (opts.phaseNumber - 1) * 0.08
    );
    this.steam.update(this.cameraClock);

    // Update gameplay VFX
    if (this.sentinelController) {
      this.sentinelController.getMainEyeWorldPosition(this.eyeWorldScratch);
      this.vfx.update(
        dt,
        realDt,
        ball,
        this.eyeWorldScratch,
        this.sentinelController.getSmashTelegraph()
      );
    }

    // Dynamic camera framing:
    // - On Menu: slow cinematic dramatic hero angle showcasing the Sentinel & wet table (just like the reference image!)
    // - In Gameplay: crisp elevated player eye-view tracking subtly with player's paddle for awesome depth clarity
    const shakeX = (Math.random() - 0.5) * this.shakeMagnitude;
    const shakeY = (Math.random() - 0.5) * this.shakeMagnitude;

    if (this.playerPaddleObj && !this.cutsceneActive) {
      this.playerPaddleObj.visible = !opts.isMenu;
    }

    if (opts.isMenu) {
      const swayX = Math.sin(this.cameraClock * 0.38) * 0.36;
      const swayY = Math.cos(this.cameraClock * 0.27) * 0.06;
      this.camera.position.lerp(
        new THREE.Vector3(swayX, 1.44 + swayY, 2.52),
        Math.min(1, realDt * 2.5)
      );
      this.camera.lookAt(0, 1.02, -1.45);
    } else {
      const targetCamX = playerPaddle.pos.x * 0.22 + shakeX;
      const targetCamY = (opts.bulletTime ? 1.54 : 1.66) + shakeY;
      const targetCamZ = opts.bulletTime ? 2.38 : 2.56;
      this.camera.position.x += (targetCamX - this.camera.position.x) * Math.min(1, realDt * 6.5);
      this.camera.position.y += (targetCamY - this.camera.position.y) * Math.min(1, realDt * 6.5);
      this.camera.position.z += (targetCamZ - this.camera.position.z) * Math.min(1, realDt * 6.5);
      this.camera.lookAt(playerPaddle.pos.x * 0.12, TABLE.SURFACE_Y + 0.34, -0.95);
    }

    if (this.bloomPass) {
      this.bloomPass.strength = opts.bulletTime ? 0.56 : 0.36;
    }

    if (this.bloomEnabled && this.composer) {
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  public handleResize(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);
    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.fov = this.computeAdaptiveFov(aspect);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    if (this.composer) {
      this.composer.setSize(width, height);
    }
  }

  public dispose(): void {
    window.removeEventListener('resize', this.boundResize);
    this.vfx.floatingText.dispose();
    this.renderer.dispose();
  }
}
