import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { TABLE } from './constants';
import { createMatrixRainWalls, GameplayVFX, SteamMistSystem } from './matrixEffects';
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
  public ballObj: THREE.Object3D | null = null;
  public readonly vfx: GameplayVFX;
  private readonly steam: SteamMistSystem;
  private readonly matrixRain: ReturnType<typeof createMatrixRainWalls>;
  private readonly sentinelEyeLight: THREE.PointLight;

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
    this.camera = new THREE.PerspectiveCamera(this.computeAdaptiveFov(aspect), aspect, 0.08, 60);
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

  public async loadModels(onProgress?: (pct: number, label: string) => void): Promise<LoadedModels> {
    const loader = new GLTFLoader();
    const specs: { key: string; url: string; label: string }[] = [
      { key: 'arena', url: '/models/arena_structure.glb', label: 'Industrial Cathedral' },
      { key: 'table', url: '/models/table.glb', label: 'Wet Tournament Table' },
      { key: 'sentinel', url: '/models/sentinel.glb', label: 'Sentinel Boss Rig' },
      { key: 'paddle', url: '/models/paddle.glb', label: 'Table Tennis Paddles' },
      { key: 'ball', url: '/models/ball.glb', label: 'Regulation Ball' },
    ];

    let completed = 0;
    const loaded: Record<string, THREE.Object3D> = {};

    const loadOneWithRetry = async (url: string, label: string): Promise<THREE.Object3D> => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const gltf = await loader.loadAsync(url);
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

    this.playerPaddleObj = playerPaddle;
    this.ballObj = ball;
    this.sentinelController = new SentinelController(
      sentinel,
      sentinelPaddle,
      this.sentinelEyeLight
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
    this.matrixRain.update(rainDt, opts.bulletTime ? 1.38 : 1.05 + (opts.phaseNumber - 1) * 0.08);
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
