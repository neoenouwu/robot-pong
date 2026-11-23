import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ROBOT, TABLE, type StoryStage, type ThreatPhaseConfig } from './constants';
import type { SoundEngine } from './audio';
import { createDataRainWalls, GameplayVFX, SteamMistSystem } from './visualEffects';
import { getRobotSkin, type RobotSkinDefinition } from './robotSkins';
import { RobotController } from './robotRig';
import type { BallState, PaddleState } from './physics';

export interface LoadedModels {
  robot: THREE.Object3D;
  table: THREE.Object3D;
  robotPaddle: THREE.Object3D;
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
 * warm amber catwalk horizon) so the wet tabletop and gunmetal robot armor reflect
 * vibrant green and orange highlights just like the reference artwork.
 */
function buildCyberpunkEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x050c09);

  // Towering emerald vertical light strips (server banks)
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

  // Crimson central Robot glow accent in front (-Z)
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

export function computeGhostPaddleOpacity(
  paddlePos: { x: number; y: number; z: number },
  cursorAnchor: { x: number; y: number; z: number },
  active: boolean,
  desyncDuration = 0
): number {
  if (!active) return 0;
  const sep = Math.hypot(
    paddlePos.x - cursorAnchor.x,
    paddlePos.y - cursorAnchor.y
  );
  if (sep <= 0.1) return 0;

  // Suppress tiny micro-desyncs unless the paddle jumped near/past the edge or stayed desynced >= 0.10s
  const flickedToEdge = Math.abs(paddlePos.x) > 1.12;
  if (!flickedToEdge && desyncDuration < 0.1) {
    return 0;
  }

  const timeFade = flickedToEdge ? 1 : Math.min(1, (desyncDuration - 0.1) / 0.1);
  const sepFade = Math.min(1, (sep - 0.1) / 0.18);
  return timeFade * sepFade * 0.46;
}

export class SceneManager {
  public readonly container: HTMLElement;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private bloomEnabled = true;

  public robotController: RobotController | null = null;
  public playerPaddleObj: THREE.Object3D | null = null;
  private ghostPaddleObj: THREE.Object3D | null = null;
  private ghostPaddleMat: THREE.MeshBasicMaterial | null = null;
  private ghostTetherLine: THREE.Line | null = null;
  private ghostTetherMat: THREE.LineBasicMaterial | null = null;
  private ghostTetherPositions = new Float32Array(6);
  public robotPaddleObj: THREE.Object3D | null = null;
  public ballObj: THREE.Object3D | null = null;
  public readonly vfx: GameplayVFX;
  private readonly steam: SteamMistSystem;
  private readonly dataRain: ReturnType<typeof createDataRainWalls>;
  private readonly robotEyeLight: THREE.PointLight;
  private readonly gltfLoader = new GLTFLoader();
  private readonly robotSkinCache = new Map<string, THREE.Object3D>();
  private activeRobotObj: THREE.Object3D | null = null;
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

    // Scene & moody emerald-black fog
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030806);
    this.scene.fog = new THREE.FogExp2(0x06140d, 0.048);
    this.scene.environment = buildCyberpunkEnvMap(this.renderer);

    // Camera framed over player's end of the table looking right at the towering Robot
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

    // 2) Emerald rim backlight separating Robot carapace silhouette from the data rain
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

    // 4) Dynamic Crimson Robot Eye Light
    this.robotEyeLight = new THREE.PointLight(0xff1428, 8.5, 9.5, 1.6);
    this.robotEyeLight.position.set(0, 2.05, -1.65);
    this.scene.add(this.robotEyeLight);

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
    this.dataRain = createDataRainWalls();
    this.scene.add(this.dataRain.group);

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
      { key: 'robot', url: skin.modelUrl, label: `Robot (${skin.name})` },
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
    const robot = loaded.robot;
    const robotPaddle = loaded.paddle;
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
    enableShadows(robot, true, true);
    enableShadows(robotPaddle, true, false);
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

    // Crisp, calm non-glowing VR ghost silhouette + outline rim + hairline tether (below bloom threshold)
    const ghostPaddle = loaded.paddle.clone(true);
    const ghostMat = new THREE.MeshBasicMaterial({
      color: 0x9fd0c4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    ghostPaddle.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.material = ghostMat;
      }
    });
    // Subtle rim outline ring around blade so the ghost stays readable over dark floor/walls without glowing
    const rimMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.075, 0.083, 32),
      ghostMat
    );
    rimMesh.position.set(0, 0.004, -0.009);
    rimMesh.rotation.y = Math.PI;
    ghostPaddle.add(rimMesh);

    ghostPaddle.rotation.y = Math.PI;
    ghostPaddle.scale.setScalar(1.12);
    ghostPaddle.visible = false;

    const tetherGeo = new THREE.BufferGeometry();
    tetherGeo.setAttribute('position', new THREE.BufferAttribute(this.ghostTetherPositions, 3));
    const tetherMat = new THREE.LineBasicMaterial({
      color: 0x8ec4b6,
      transparent: true,
      opacity: 0,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    const tetherLine = new THREE.Line(tetherGeo, tetherMat);
    tetherLine.frustumCulled = false;
    tetherLine.visible = false;

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
    this.scene.add(robot);
    this.scene.add(robotPaddle);
    this.scene.add(playerPaddle);
    this.scene.add(ghostPaddle);
    this.scene.add(tetherLine);
    this.scene.add(ball);

    this.robotSkinCache.set(skin.id, robot);
    this.activeRobotObj = robot;
    this.activeSkinId = skin.id;
    this.robotPaddleObj = robotPaddle;
    this.playerPaddleObj = playerPaddle;
    this.ghostPaddleObj = ghostPaddle;
    this.ghostPaddleMat = ghostMat;
    this.ghostTetherLine = tetherLine;
    this.ghostTetherMat = tetherMat;
    this.ballObj = ball;
    this.robotController = new RobotController(
      robot,
      robotPaddle,
      this.robotEyeLight,
      skin.armArcStyle
    );

    return {
      robot,
      table,
      robotPaddle,
      playerPaddle,
      ball,
      arena,
    };
  }

  /**
   * Hot-swaps the Robot 3D model skin live in the scene (cached after first load,
   * race-guarded via monotonic sequence id, preserving active gameplay rig state).
   */
  public async setRobotSkin(skin: RobotSkinDefinition): Promise<{ applied: boolean; skinId: string }> {
    if (this.activeSkinId === skin.id && this.activeRobotObj) {
      return { applied: true, skinId: skin.id };
    }
    if (!this.robotPaddleObj) {
      throw new Error('Arena is not initialized yet.');
    }

    const reqSeq = ++this.skinLoadSeq;
    let model = this.robotSkinCache.get(skin.id);

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
      this.robotSkinCache.set(skin.id, model);
    }

    // Ignore stale async completion if user clicked another skin while loading
    if (reqSeq !== this.skinLoadSeq) {
      return { applied: false, skinId: this.activeSkinId };
    }

    const prevState = this.robotController?.exportState();
    if (this.activeRobotObj) {
      this.scene.remove(this.activeRobotObj);
    }

    this.scene.add(model);
    this.activeRobotObj = model;
    this.activeSkinId = skin.id;

    const nextCtrl = new RobotController(
      model,
      this.robotPaddleObj,
      this.robotEyeLight,
      skin.armArcStyle
    );
    if (prevState) {
      nextCtrl.importState(prevState);
    }
    this.robotController = nextCtrl;

    return { applied: true, skinId: skin.id };
  }

  public getActiveSkinId(): string {
    return this.activeSkinId;
  }

  /**
   * Silently preloads Stage 2 assets (1:1 Apex Robot + Emerald Megacity Expansion)
   * in the background without exposing them in UI or altering Stage 1.
   */
  public preloadStage2Assets(): Promise<void> {
    if (this.stage2PreloadPromise) return this.stage2PreloadPromise;

    this.stage2PreloadPromise = (async () => {
      const refSkin = getRobotSkin('reference');

      const loadSkinTask = (async () => {
        if (this.robotSkinCache.has(refSkin.id)) return;
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
            this.robotSkinCache.set(refSkin.id, gltf.scene);
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
    this.dataRain.setExpansion(t);

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
   * or Stage 2 (1:1 Apex Robot + expanded Emerald Megacity).
   */
  public async setEnvironmentStage(stage: StoryStage): Promise<void> {
    this.cutsceneActive = false;
    this.currentStage = stage;

    // Clean up any leftover cutscene actors
    if (this.defeatedMk1Obj && this.defeatedMk1Obj !== this.activeRobotObj) {
      this.scene.remove(this.defeatedMk1Obj);
      this.defeatedMk1Obj.visible = true;
      this.defeatedMk1Obj.rotation.set(0, 0, 0);
      this.defeatedMk1Obj.position.set(
        ROBOT.HOME_POS.x,
        ROBOT.HOME_POS.y,
        ROBOT.HOME_POS.z
      );
    }
    this.defeatedMk1Obj = null;

    if (this.apexCutsceneObj && this.apexCutsceneObj !== this.activeRobotObj) {
      this.scene.remove(this.apexCutsceneObj);
    }
    this.apexCutsceneObj = null;

    if (this.ballObj) this.ballObj.visible = true;
    if (this.playerPaddleObj) this.playerPaddleObj.visible = true;

    if (stage === 2) {
      await this.preloadStage2Assets();
      const refSkin = getRobotSkin('reference');
      await this.setRobotSkin(refSkin);
      this.applyExpansionVisuals(1);
    } else {
      const classicSkin = getRobotSkin('classic');
      await this.setRobotSkin(classicSkin);
      if (this.activeRobotObj) {
        this.activeRobotObj.visible = true;
        this.activeRobotObj.rotation.set(0, 0, 0);
        this.activeRobotObj.position.set(
          ROBOT.HOME_POS.x,
          ROBOT.HOME_POS.y,
          ROBOT.HOME_POS.z
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
   * MK-I sparks/fails -> 1:1 Apex Robot descends & crushes MK-I -> Cityscape expands outward.
   */
  public async beginStage2Cutscene(): Promise<void> {
    await this.preloadStage2Assets();

    // Ensure MK-I classic is mounted as the victim at its exact current position
    const classicObj = this.robotSkinCache.get('classic') ?? this.activeRobotObj;
    const apexObj = this.robotSkinCache.get('reference') ?? null;

    this.cutsceneActive = true;
    if (this.ballObj) this.ballObj.visible = false;
    if (this.playerPaddleObj) this.playerPaddleObj.visible = false;
    if (this.ghostPaddleObj) this.ghostPaddleObj.visible = false;
    if (this.ghostTetherLine) this.ghostTetherLine.visible = false;
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
    this.dataRain.update(realDt * 1.45, 1.25);

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
      if (this.robotController && this.robotController.root === this.defeatedMk1Obj) {
        this.robotController.update(realDt, ball, stage2Phase, false);
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
    if (elapsed >= 2.0 && elapsed < 2.22 && this.robotPaddleObj) {
      const popT = (elapsed - 2.0) / 0.22;
      this.robotPaddleObj.position.y = TABLE.SURFACE_Y + 0.34 + Math.sin(popT * Math.PI) * 0.28;
      this.robotPaddleObj.rotation.z = popT * 1.4;
    }

    // Phase B (1.0s - 2.15s): 1:1 Apex Robot plunges down from ceiling cables & slams MK-I!
    if (this.apexCutsceneObj && elapsed >= 0.95 && !this.cutsceneSwappedController) {
      this.apexCutsceneObj.visible = true;
      const diveT = Math.max(0, Math.min(1, (elapsed - 0.95) / 1.05));
      // Accelerating predator slam curve
      const easeIn = diveT * diveT * diveT;
      this.apexCutsceneObj.position.set(
        0,
        7.8 + (ROBOT.HOME_POS.y + 0.18 - 7.8) * easeIn,
        -5.6 + (ROBOT.HOME_POS.z + 0.1 - -5.6) * easeIn
      );
      this.apexCutsceneObj.rotation.set(0.32 * (1 - easeIn), 0, 0);
      this.robotEyeLight.position.set(
        0,
        this.apexCutsceneObj.position.y,
        this.apexCutsceneObj.position.z + 0.85
      );
      this.robotEyeLight.intensity = 10 + diveT * 10;
    }

    // Impact moment (t = 2.00s): Massive metallic crush + shockwave + hurl MK-I into the abyss!
    if (!this.cutsceneCrushFired && elapsed >= 2.0) {
      this.cutsceneCrushFired = true;
      audio.playBossCrush();
      this.addCameraShake(0.14);
      const impactCenter = {
        x: ROBOT.HOME_POS.x,
        y: ROBOT.HOME_POS.y,
        z: ROBOT.HOME_POS.z + 0.25,
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

    // At t = 2.22s: Apex Robot snaps into command & snatches the airborne red paddle!
    if (!this.cutsceneSwappedController && elapsed >= 2.22 && this.apexCutsceneObj && this.robotPaddleObj) {
      this.cutsceneSwappedController = true;
      this.activeRobotObj = this.apexCutsceneObj;
      this.activeSkinId = 'reference';
      this.robotController = new RobotController(
        this.apexCutsceneObj,
        this.robotPaddleObj,
        this.robotEyeLight,
        'high_coil'
      );
      this.robotController.triggerSwing(true);
    }

    if (this.cutsceneSwappedController && this.robotController) {
      this.robotController.update(realDt, ball, stage2Phase, false);
    }

    // Phase C (2.70s - 5.15s): Data rain horizon pushes far outward & 3D Emerald Megacity expands!
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
      // Wide grand panorama showcasing the expanding 3D Emerald Megacity behind the untouched table
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

    if (this.robotController) {
      this.robotController.getMainEyeWorldPosition(this.eyeWorldScratch);
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

  public syncPlayerPaddle(
    paddle: PaddleState,
    slowMo: boolean,
    ghost?: {
      anchor: { x: number; y: number; z: number };
      active: boolean;
      desyncDuration: number;
      visible: boolean;
    }
  ): void {
    if (!this.playerPaddleObj) return;
    this.playerPaddleObj.position.set(paddle.pos.x, paddle.pos.y, paddle.pos.z);

    // Responsive wrist tilt based on horizontal position & swipe velocity
    const tiltZ = -paddle.pos.x * 0.42 - paddle.vel.x * 0.045;
    const tiltX = -0.18 + Math.min(0.45, paddle.smashCharge * 0.42) - paddle.vel.z * 0.05;
    const tiltY = Math.PI + paddle.pos.x * 0.24;
    this.playerPaddleObj.rotation.set(tiltX, tiltY, tiltZ);

    // Subtle scale pop when charging power smash or in Slow-Mo
    const s = 1.12 + paddle.smashCharge * 0.1 + (slowMo ? 0.04 : 0);
    this.playerPaddleObj.scale.setScalar(s);

    // Subtle muted VR ghost silhouette + faint tether (only on off-screen or sustained edge-jumps)
    if (this.ghostPaddleObj && this.ghostPaddleMat && this.ghostTetherLine && this.ghostTetherMat) {
      const opacity =
        ghost && ghost.visible && !this.cutsceneActive
          ? computeGhostPaddleOpacity(paddle.pos, ghost.anchor, ghost.active, ghost.desyncDuration)
          : 0;

      if (opacity > 0.005 && ghost) {
        this.ghostPaddleObj.visible = true;
        this.ghostPaddleObj.position.set(ghost.anchor.x, ghost.anchor.y, ghost.anchor.z);
        this.ghostPaddleObj.rotation.set(
          -0.18,
          Math.PI + ghost.anchor.x * 0.24,
          -ghost.anchor.x * 0.42
        );
        this.ghostPaddleObj.scale.setScalar(1.06);
        this.ghostPaddleMat.opacity = opacity;

        this.ghostTetherPositions[0] = ghost.anchor.x;
        this.ghostTetherPositions[1] = ghost.anchor.y;
        this.ghostTetherPositions[2] = ghost.anchor.z;
        this.ghostTetherPositions[3] = paddle.pos.x;
        this.ghostTetherPositions[4] = paddle.pos.y;
        this.ghostTetherPositions[5] = paddle.pos.z;
        (this.ghostTetherLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate =
          true;
        this.ghostTetherMat.opacity = opacity * 0.85;
        this.ghostTetherLine.visible = true;
      } else {
        this.ghostPaddleObj.visible = false;
        this.ghostTetherLine.visible = false;
      }
    }
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
      slowMo: boolean;
      phaseNumber: number;
    }
  ): void {
    if (this.contextLost) return;

    this.cameraClock += realDt;
    this.shakeMagnitude = Math.max(0, this.shakeMagnitude - realDt * 0.55);

    // Data rain slows down dramatically in Slow-Mo and intensifies at higher Threat Phases!
    const rainDt = opts.slowMo ? dt * 0.35 : realDt * (1 + (opts.phaseNumber - 1) * 0.18);
    const baseRainIntensity = this.currentStage === 2 ? 1.18 : 1.05;
    this.dataRain.update(
      rainDt,
      opts.slowMo ? 1.38 : baseRainIntensity + (opts.phaseNumber - 1) * 0.08
    );
    this.steam.update(this.cameraClock);

    // Update gameplay VFX
    if (this.robotController) {
      this.robotController.getMainEyeWorldPosition(this.eyeWorldScratch);
      this.vfx.update(
        dt,
        realDt,
        ball,
        this.eyeWorldScratch,
        this.robotController.getSmashTelegraph()
      );
    }

    // Dynamic camera framing:
    // - On Menu: slow cinematic dramatic hero angle showcasing the Robot & wet table (just like the reference image!)
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
      const clampedPadX = Math.max(-1.45, Math.min(1.45, playerPaddle.pos.x));
      const targetCamX = clampedPadX * 0.22 + shakeX;
      const targetCamY = (opts.slowMo ? 1.54 : 1.66) + shakeY;
      const targetCamZ = opts.slowMo ? 2.38 : 2.56;
      this.camera.position.x += (targetCamX - this.camera.position.x) * Math.min(1, realDt * 6.5);
      this.camera.position.y += (targetCamY - this.camera.position.y) * Math.min(1, realDt * 6.5);
      this.camera.position.z += (targetCamZ - this.camera.position.z) * Math.min(1, realDt * 6.5);
      this.camera.lookAt(clampedPadX * 0.12, TABLE.SURFACE_Y + 0.34, -0.95);
    }

    if (this.bloomPass) {
      this.bloomPass.strength = opts.slowMo ? 0.56 : 0.36;
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
    this.ghostPaddleMat?.dispose();
    this.ghostTetherMat?.dispose();
    this.ghostTetherLine?.geometry.dispose();
    this.renderer.dispose();
  }
}
