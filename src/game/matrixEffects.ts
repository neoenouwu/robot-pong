import * as THREE from 'three';
import { TABLE } from './constants';
import type { BallState, Vec3 } from './physics';

/**
 * Creates towering animated emerald Matrix digital-rain server light walls
 * positioned behind the 3D industrial steel pillars of arena_structure.glb.
 */
export function createMatrixRainWalls(): {
  group: THREE.Group;
  update: (dt: number, intensity: number) => void;
  setExpansion: (progress: number) => void;
} {
  const group = new THREE.Group();
  group.name = 'MatrixRainWalls';

  const uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 1.0 },
  };

  const vertexShader = /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const fragmentShader = /* glsl */ `
    uniform float uTime;
    uniform float uIntensity;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    // Crisp procedural digital glyph pattern inside each cell
    float glyph(vec2 cellUv, float seed) {
      vec2 g = floor(cellUv * vec2(4.0, 5.0));
      float h = hash(g + floor(seed * 29.0));
      float border = step(0.14, cellUv.x) * step(cellUv.x, 0.86) * step(0.1, cellUv.y) * step(cellUv.y, 0.9);
      return step(0.42, h) * border;
    }

    void main() {
      // Dense vertical server columns of falling Matrix code
      vec2 grid = vec2(72.0, 52.0);
      vec2 cellId = floor(vUv * grid);
      vec2 cellUv = fract(vUv * grid);

      float colRand = hash(vec2(cellId.x, 1.0));
      float speed = 0.55 + colRand * 1.45;
      float phase = colRand * 23.0;

      // Vertical stream head position cycling downward
      float streamPos = fract(vUv.y + uTime * speed * 0.28 + phase);
      float trail = pow(1.0 - streamPos, 3.6);
      float head = smoothstep(0.06, 0.0, streamPos);

      // Flickering glyph seed changes every ~0.18s
      float glyphSeed = hash(cellId + floor(uTime * (4.0 + colRand * 5.0)) * 0.07);
      float charMask = glyph(cellUv, glyphSeed);

      // Large vertical light-curtain pillars matching the towering server banks in the artwork
      float bankMask = 0.35 + 0.65 * smoothstep(0.18, 0.85, sin(vUv.x * 28.0 + 0.7) * 0.5 + 0.5);
      float verticalFade = smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.72, vUv.y);

      // Ambient server glow behind the glyphs
      float glow = (0.14 + trail * 0.85) * bankMask;

      vec3 deepEmerald = vec3(0.02, 0.28, 0.12);
      vec3 brightGreen = vec3(0.12, 0.96, 0.42);
      vec3 headWhite = vec3(0.76, 1.0, 0.85);

      vec3 color = deepEmerald * glow * 0.55;
      color += brightGreen * charMask * trail * bankMask * 1.55;
      color += headWhite * charMask * head * bankMask * 1.9;
      color *= verticalFade * uIntensity;

      float alpha = clamp((glow * 0.42 + charMask * (trail + head)) * verticalFade, 0.0, 0.96);
      gl_FragColor = vec4(color, alpha);
    }
  `;

  const wallMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  // Back wall towering behind the cathedral rear columns
  const backGeo = new THREE.PlaneGeometry(24, 15);
  const backWall = new THREE.Mesh(backGeo, wallMat);
  backWall.position.set(0, 6.8, -11.8);
  group.add(backWall);

  // Left and right flanking server-code light curtains behind the steel I-beams
  const sideGeo = new THREE.PlaneGeometry(18, 15);
  const leftWall = new THREE.Mesh(sideGeo, wallMat);
  leftWall.position.set(-7.6, 6.8, -3.5);
  leftWall.rotation.y = Math.PI / 2;
  group.add(leftWall);

  const rightWall = new THREE.Mesh(sideGeo, wallMat);
  rightWall.position.set(7.6, 6.8, -3.5);
  rightWall.rotation.y = -Math.PI / 2;
  group.add(rightWall);

  return {
    group,
    update(dt: number, intensity: number) {
      uniforms.uTime.value += dt;
      uniforms.uIntensity.value = intensity;
    },
    setExpansion(progress: number) {
      const t = Math.max(0, Math.min(1, progress));
      // At t = 0: exact Stage 1 enclosure (back z = -11.8, sides x = ±7.6, scale 1)
      // At t = 1: colossal distant skyline rain curtain behind cityscape_expansion.glb
      const backScale = 1 + t * 3.1;
      const sideScale = 1 + t * 2.9;
      const yPos = 6.8 + t * 15.5;

      backWall.position.set(0, yPos, -11.8 - t * 47.0);
      backWall.scale.set(backScale, backScale, 1);

      leftWall.position.set(-7.6 - t * 30.5, yPos, -3.5 - t * 21.0);
      leftWall.scale.set(sideScale, sideScale, 1);

      rightWall.position.set(7.6 + t * 30.5, yPos, -3.5 - t * 21.0);
      rightWall.scale.set(sideScale, sideScale, 1);
    },
  };
}

function createSparkTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.35, 'rgba(220, 255, 235, 0.85)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a soft radial puff texture on an offscreen canvas for atmospheric steam/smoke.
 */
function createSteamTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(215, 232, 225, 0.42)');
    grad.addColorStop(0.4, 'rgba(150, 185, 175, 0.22)');
    grad.addColorStop(0.75, 'rgba(80, 115, 105, 0.07)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Volumetric-feel drifting industrial steam/mist clouds rising near the catwalks & table perimeter.
 */
export class SteamMistSystem {
  public readonly group = new THREE.Group();
  private readonly sprites: {
    sprite: THREE.Sprite;
    baseX: number;
    baseY: number;
    baseZ: number;
    speedX: number;
    speedY: number;
    phase: number;
    scale: number;
  }[] = [];

  constructor() {
    this.group.name = 'SteamMistSystem';
    const tex = createSteamTexture();

    const configs = [
      // Left catwalk warm-tinted steam plumes
      { x: -3.2, y: 1.0, z: -0.4, tint: 0xffc896, scale: 3.1, op: 0.22 },
      { x: -2.9, y: 1.5, z: -2.2, tint: 0xd0e6dc, scale: 3.6, op: 0.2 },
      { x: -2.4, y: 0.8, z: -4.1, tint: 0xaef5cc, scale: 3.9, op: 0.19 },
      { x: -3.8, y: 1.9, z: 0.6, tint: 0xffbe82, scale: 3.3, op: 0.2 },
      // Right catwalk plumes
      { x: 3.2, y: 1.0, z: -0.6, tint: 0xffc896, scale: 3.2, op: 0.22 },
      { x: 2.8, y: 1.4, z: -2.6, tint: 0xc2ead5, scale: 3.7, op: 0.19 },
      { x: 2.3, y: 0.85, z: -4.5, tint: 0x9ef0c5, scale: 4.1, op: 0.18 },
      { x: 3.9, y: 1.8, z: 0.5, tint: 0xffbd80, scale: 3.2, op: 0.18 },
      // Low mist beneath the Sentinel behind the far end of the table
      { x: -0.9, y: 0.72, z: -2.2, tint: 0xb7dfd0, scale: 2.8, op: 0.21 },
      { x: 0.9, y: 0.78, z: -2.4, tint: 0xb7dfd0, scale: 2.9, op: 0.2 },
      { x: 0.0, y: 0.65, z: -3.4, tint: 0x89dfb6, scale: 3.8, op: 0.2 },
      { x: -1.6, y: 1.25, z: -5.4, tint: 0x76e8a8, scale: 4.5, op: 0.18 },
      { x: 1.7, y: 1.25, z: -5.4, tint: 0x76e8a8, scale: 4.5, op: 0.18 },
    ];

    configs.forEach((c, idx) => {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: c.tint,
        transparent: true,
        opacity: c.op,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(c.x, c.y, c.z);
      sprite.scale.set(c.scale * 1.35, c.scale * 0.85, 1);
      this.group.add(sprite);
      this.sprites.push({
        sprite,
        baseX: c.x,
        baseY: c.y,
        baseZ: c.z,
        speedX: (idx % 2 === 0 ? 1 : -1) * (0.14 + (idx % 3) * 0.06),
        speedY: 0.12 + (idx % 4) * 0.04,
        phase: idx * 1.31,
        scale: c.scale,
      });
    });
  }

  public update(t: number): void {
    for (const s of this.sprites) {
      const driftX = Math.sin(t * s.speedX + s.phase) * 0.65;
      const driftY = Math.sin(t * s.speedY + s.phase * 0.7) * 0.24;
      s.sprite.position.set(s.baseX + driftX, s.baseY + driftY, s.baseZ);
      const breathe = 1 + Math.sin(t * 0.35 + s.phase) * 0.08;
      s.sprite.scale.set(s.scale * 1.35 * breathe, s.scale * 0.85 * breathe, 1);
    }
  }
}

export type FloatingTextTone = 'mint' | 'emerald' | 'gold' | 'cyan' | 'crimson';

const FLOATING_TONE_STYLES: Record<FloatingTextTone, { fill: string; glow: string; sub: string }> = {
  mint: { fill: '#e6fff2', glow: 'rgba(120, 255, 190, 0.55)', sub: 'rgba(210, 255, 232, 0.82)' },
  emerald: { fill: '#3bff9d', glow: 'rgba(24, 255, 136, 0.72)', sub: 'rgba(180, 255, 215, 0.9)' },
  gold: { fill: '#ffe573', glow: 'rgba(255, 188, 52, 0.75)', sub: 'rgba(255, 236, 165, 0.92)' },
  cyan: { fill: '#48fff0', glow: 'rgba(36, 255, 229, 0.72)', sub: 'rgba(190, 255, 248, 0.9)' },
  crimson: { fill: '#ff667c', glow: 'rgba(255, 36, 66, 0.65)', sub: 'rgba(255, 185, 195, 0.85)' },
};

/**
 * Computes an unobstructed 3D spawn point beside a paddle or target so floating
 * points never overlap the ball or center sightline.
 */
export function computeFloatingPopupOrigin(
  anchor: Vec3,
  options: { side: 'player' | 'sentinel' | 'world'; stackIndex?: number }
): Vec3 {
  const stack = options.stackIndex ?? 0;
  if (options.side === 'world') {
    return {
      x: anchor.x,
      y: anchor.y + 0.14 + stack * 0.11,
      z: anchor.z,
    };
  }

  // Push gently outward away from center X so text sits beside the paddle, never over the ball
  const outwardSign = anchor.x >= 0 ? 1 : -1;
  const sideOffset = options.side === 'player' ? 0.21 : 0.34;
  const x = Math.max(-1.24, Math.min(1.24, anchor.x + outwardSign * sideOffset));
  const y = anchor.y + (options.side === 'player' ? 0.14 : 0.22) + stack * 0.11;
  const z = anchor.z + (options.side === 'player' ? -0.05 : 0.12);
  return { x, y, z };
}

interface FloatingSlot {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture | null;
  active: boolean;
  age: number;
  duration: number;
  vel: THREE.Vector3;
  baseScaleX: number;
  baseScaleY: number;
}

/**
 * Reusable fixed-pool 3D world-space floating score text sprites (zero texture leaks,
 * borderless crisp typography floating beside paddles/targets in 3D space).
 */
export class FloatingTextSystem {
  public readonly group = new THREE.Group();
  private readonly slots: FloatingSlot[] = [];
  private cursor = 0;

  constructor(poolSize = 10) {
    this.group.name = 'FloatingTextSystem';

    for (let i = 0; i < poolSize; i++) {
      let canvas: HTMLCanvasElement | null = null;
      let ctx: CanvasRenderingContext2D | null = null;
      let texture: THREE.CanvasTexture | null = null;

      if (typeof document !== 'undefined') {
        canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 96;
        ctx = canvas.getContext('2d');
        texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
      }

      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 25;
      this.group.add(sprite);

      this.slots.push({
        sprite,
        material,
        canvas,
        ctx,
        texture,
        active: false,
        age: 0,
        duration: 0.8,
        vel: new THREE.Vector3(),
        baseScaleX: 0.44,
        baseScaleY: 0.165,
      });
    }
  }

  public spawn(
    anchor: Vec3,
    mainText: string,
    opts: {
      subText?: string;
      tone?: FloatingTextTone;
      side?: 'player' | 'sentinel' | 'world';
      scale?: number;
      duration?: number;
    } = {}
  ): void {
    const slot = this.slots[this.cursor];
    this.cursor = (this.cursor + 1) % this.slots.length;

    const side = opts.side ?? 'player';
    const tone = opts.tone ?? 'mint';
    const style = FLOATING_TONE_STYLES[tone];

    // Count nearby active popups so consecutive hits stagger cleanly vertically
    let nearbyCount = 0;
    for (const s of this.slots) {
      if (s !== slot && s.active && s.age < 0.35) {
        const dx = s.sprite.position.x - anchor.x;
        const dz = s.sprite.position.z - anchor.z;
        if (Math.hypot(dx, dz) < 0.6) nearbyCount++;
      }
    }

    if (slot.canvas && slot.ctx && slot.texture) {
      const w = slot.canvas.width;
      const h = slot.canvas.height;
      const ctx = slot.ctx;
      ctx.clearRect(0, 0, w, h);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Crisp dark halo shadow for effortless readability without any card background
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 9;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;

      const hasSub = Boolean(opts.subText);
      ctx.font = '800 36px "Cascadia Code", Consolas, ui-monospace, monospace';
      ctx.fillStyle = style.fill;
      ctx.fillText(mainText, w / 2, hasSub ? 36 : 48);

      // Subtle glow pass
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = 12;
      ctx.fillText(mainText, w / 2, hasSub ? 36 : 48);

      if (hasSub && opts.subText) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
        ctx.shadowBlur = 6;
        ctx.font = '700 15px "Cascadia Code", Consolas, ui-monospace, monospace';
        ctx.fillStyle = style.sub;
        ctx.fillText(opts.subText, w / 2, 68);
      }

      slot.texture.needsUpdate = true;
    }

    const origin = computeFloatingPopupOrigin(anchor, { side, stackIndex: nearbyCount });
    slot.sprite.position.set(origin.x, origin.y, origin.z);

    // Distance-balanced world scale: subtle near player paddle, legible near Sentinel far court
    const defaultScale = side === 'player' ? 0.36 : side === 'world' ? 0.56 : 0.68;
    const sc = opts.scale ?? defaultScale;
    slot.baseScaleX = sc;
    slot.baseScaleY = sc * (96 / 256);

    const driftOut = origin.x >= 0 ? 0.08 : -0.08;
    slot.vel.set(driftOut, side === 'player' ? 0.28 : 0.42, 0);
    slot.age = 0;
    slot.duration = opts.duration ?? 0.82;
    slot.active = true;
    slot.sprite.visible = true;
    slot.material.opacity = 0.01;
  }

  public clear(): void {
    for (const s of this.slots) {
      s.active = false;
      s.sprite.visible = false;
      s.material.opacity = 0;
    }
  }

  public update(realDt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      s.age += realDt;
      const p = s.age / s.duration;
      if (p >= 1) {
        s.active = false;
        s.sprite.visible = false;
        s.material.opacity = 0;
        continue;
      }

      // Gentle upward float with soft deceleration
      const decel = 1 - p * 0.55;
      s.sprite.position.x += s.vel.x * decel * realDt;
      s.sprite.position.y += s.vel.y * decel * realDt;

      // Crisp fade-in (first 12%), subtle hold, smooth fade-out (last 45%)
      const fadeIn = Math.min(1, p / 0.12);
      const fadeOut = p > 0.52 ? 1 - (p - 0.52) / 0.48 : 1;
      s.material.opacity = Math.max(0, Math.min(0.92, fadeIn * fadeOut * 0.92));

      // Gentle pop-in scale
      const pop = 0.86 + Math.min(1, p / 0.16) * 0.16;
      s.sprite.scale.set(s.baseScaleX * pop, s.baseScaleY * pop, 1);
    }
  }

  public dispose(): void {
    for (const s of this.slots) {
      s.texture?.dispose();
      s.material.dispose();
    }
  }
}

/**
 * Dynamic gameplay visual telemetry:
 * - Ball energy ribbon trail
 * - Contact shadow & depth targeting reticle on the tabletop
 * - Spark particle burst pool
 * - Sentinel crimson smash lock-on laser beam
 * - Floating Matrix bonus ring target
 * - Subtle 3D floating point popups
 */
export class GameplayVFX {
  public readonly group = new THREE.Group();
  public readonly floatingText = new FloatingTextSystem(10);

  // Trail
  private readonly trailMax = 28;
  private readonly trailPoints: THREE.Vector3[] = [];
  private readonly trailGeo: THREE.BufferGeometry;
  private readonly trailLine: THREE.Line;
  private readonly trailMat: THREE.LineBasicMaterial;

  // Depth reticle & table bounce ripple
  private readonly shadowMesh: THREE.Mesh;
  private readonly reticleRing: THREE.Mesh;
  private readonly reticleMat: THREE.MeshBasicMaterial;
  private readonly bounceRipple: THREE.Mesh;
  private readonly bounceRippleMat: THREE.MeshBasicMaterial;
  private rippleAge = 99;

  // Crimson lock-on laser
  private readonly laserLine: THREE.Line;
  private readonly laserMat: THREE.LineBasicMaterial;
  private readonly laserPositions: Float32Array;

  // Impact sparks
  private readonly sparkCount = 48;
  private readonly sparkPos: Float32Array;
  private readonly sparkVel: Float32Array;
  private readonly sparkLife: Float32Array;
  private readonly sparkGeo: THREE.BufferGeometry;
  private readonly sparkMat: THREE.PointsMaterial;

  // Bonus floating Matrix ring
  public readonly bonusRingGroup = new THREE.Group();
  private bonusActive = false;
  private bonusPos = new THREE.Vector3(0, 1.08, -0.78);
  private readonly bonusRadius = 0.22;
  private bonusTimer = 0;

  // Cinematic Boss-Destruction 3D Shockwave Ring
  private readonly shockwaveMesh: THREE.Mesh;
  private readonly shockwaveMat: THREE.MeshBasicMaterial;
  private shockwaveAge = 99;

  constructor() {
    this.group.name = 'GameplayVFX';

    // 1. Ball trail
    const trailArr = new Float32Array(this.trailMax * 3);
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(trailArr, 3));
    this.trailMat = new THREE.LineBasicMaterial({
      color: 0xd8fff0,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.trailLine = new THREE.Line(this.trailGeo, this.trailMat);
    this.trailLine.frustumCulled = false;
    this.group.add(this.trailLine);

    // 2. Contact shadow on table surface (huge depth perception aid!)
    const shadowGeo = new THREE.CircleGeometry(0.052, 20);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowMesh.position.y = TABLE.SURFACE_Y + 0.002;
    this.group.add(this.shadowMesh);

    // 3. Glowing depth targeting ring directly beneath the ball
    const ringGeo = new THREE.RingGeometry(0.042, 0.058, 28);
    ringGeo.rotateX(-Math.PI / 2);
    this.reticleMat = new THREE.MeshBasicMaterial({
      color: 0x00ff77,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.reticleRing = new THREE.Mesh(ringGeo, this.reticleMat);
    this.reticleRing.position.y = TABLE.SURFACE_Y + 0.004;
    this.group.add(this.reticleRing);

    // 4. Expanding bounce ripple
    const ripGeo = new THREE.RingGeometry(0.04, 0.065, 32);
    ripGeo.rotateX(-Math.PI / 2);
    this.bounceRippleMat = new THREE.MeshBasicMaterial({
      color: 0x3cff9a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.bounceRipple = new THREE.Mesh(ripGeo, this.bounceRippleMat);
    this.bounceRipple.position.y = TABLE.SURFACE_Y + 0.005;
    this.group.add(this.bounceRipple);

    // 5. Crimson smash lock-on laser
    this.laserPositions = new Float32Array(6);
    const laserGeo = new THREE.BufferGeometry();
    laserGeo.setAttribute('position', new THREE.BufferAttribute(this.laserPositions, 3));
    this.laserMat = new THREE.LineBasicMaterial({
      color: 0xff1636,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.laserLine = new THREE.Line(laserGeo, this.laserMat);
    this.laserLine.frustumCulled = false;
    this.group.add(this.laserLine);

    // 6. Spark burst points
    this.sparkPos = new Float32Array(this.sparkCount * 3);
    this.sparkVel = new Float32Array(this.sparkCount * 3);
    this.sparkLife = new Float32Array(this.sparkCount);
    this.sparkGeo = new THREE.BufferGeometry();
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    this.sparkMat = new THREE.PointsMaterial({
      color: 0x4dff9e,
      map: createSparkTexture(),
      size: 0.068,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      alphaTest: 0.02,
    });
    const sparks = new THREE.Points(this.sparkGeo, this.sparkMat);
    sparks.frustumCulled = false;
    this.group.add(sparks);

    // 7. Floating Matrix Bonus Ring
    const outerTorus = new THREE.Mesh(
      new THREE.TorusGeometry(this.bonusRadius, 0.012, 10, 6),
      new THREE.MeshBasicMaterial({
        color: 0x00ff7a,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
      })
    );
    const innerTorus = new THREE.Mesh(
      new THREE.TorusGeometry(this.bonusRadius * 0.72, 0.006, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xafffd4,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
      })
    );
    this.bonusRingGroup.add(outerTorus, innerTorus);
    this.bonusRingGroup.visible = false;
    this.group.add(this.bonusRingGroup);

    // 8. 3D floating point popups beside paddles & rings
    this.group.add(this.floatingText.group);

    // 9. Expanding 3D crimson shockwave ring for boss destruction cutscene
    const swGeo = new THREE.RingGeometry(0.18, 0.34, 48);
    this.shockwaveMat = new THREE.MeshBasicMaterial({
      color: 0xff2842,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.shockwaveMesh = new THREE.Mesh(swGeo, this.shockwaveMat);
    this.shockwaveMesh.visible = false;
    this.group.add(this.shockwaveMesh);
  }

  public spawnShockwave(pos: Vec3, colorHex = 0xff2842): void {
    this.shockwaveMesh.position.set(pos.x, pos.y, pos.z);
    this.shockwaveMat.color.setHex(colorHex);
    this.shockwaveAge = 0;
    this.shockwaveMesh.visible = true;
    this.shockwaveMesh.scale.setScalar(1);
  }

  public spawnFloatingPoints(
    anchor: Vec3,
    mainText: string,
    opts?: {
      subText?: string;
      tone?: FloatingTextTone;
      side?: 'player' | 'sentinel' | 'world';
      scale?: number;
      duration?: number;
    }
  ): void {
    this.floatingText.spawn(anchor, mainText, opts);
  }

  public clearFloatingPoints(): void {
    this.floatingText.clear();
  }

  public getBonusRingPosition(): Vec3 {
    return { x: this.bonusPos.x, y: this.bonusPos.y, z: this.bonusPos.z };
  }

  public clearTrail(): void {
    this.trailPoints.length = 0;
    this.trailGeo.setDrawRange(0, 0);
  }

  public spawnBounceRipple(pos: Vec3, isCrimson: boolean): void {
    this.bounceRipple.position.set(pos.x, TABLE.SURFACE_Y + 0.005, pos.z);
    this.bounceRippleMat.color.setHex(isCrimson ? 0xff2846 : 0x2cff8f);
    this.rippleAge = 0;
  }

  public emitSparks(pos: Vec3, colorHex: number, count = 18, speedScale = 1.0): void {
    this.sparkMat.color.setHex(colorHex);
    let spawned = 0;
    for (let i = 0; i < this.sparkCount && spawned < count; i++) {
      if (this.sparkLife[i] <= 0) {
        this.sparkLife[i] = 0.25 + Math.random() * 0.28;
        this.sparkPos[i * 3] = pos.x;
        this.sparkPos[i * 3 + 1] = pos.y;
        this.sparkPos[i * 3 + 2] = pos.z;

        const theta = Math.random() * Math.PI * 2;
        const up = 0.3 + Math.random() * 1.4;
        const spd = (1.1 + Math.random() * 2.2) * speedScale;
        this.sparkVel[i * 3] = Math.cos(theta) * spd;
        this.sparkVel[i * 3 + 1] = up * spd * 0.7;
        this.sparkVel[i * 3 + 2] = Math.sin(theta) * spd;
        spawned++;
      }
    }
  }

  public spawnBonusRing(): void {
    this.bonusActive = true;
    this.bonusTimer = 9.5;
    this.bonusPos.set(
      (Math.random() - 0.5) * 1.05,
      TABLE.SURFACE_Y + 0.26 + Math.random() * 0.22,
      -0.48 - Math.random() * 0.56
    );
    this.bonusRingGroup.position.copy(this.bonusPos);
    this.bonusRingGroup.visible = true;
  }

  public hideBonusRing(): void {
    this.bonusActive = false;
    this.bonusRingGroup.visible = false;
  }

  public checkBonusRingHit(ball: BallState): boolean {
    if (!this.bonusActive || !ball.active || ball.lastHitBy !== 'player') return false;
    const dx = ball.pos.x - this.bonusPos.x;
    const dy = ball.pos.y - this.bonusPos.y;
    const dz = ball.pos.z - this.bonusPos.z;
    if (Math.abs(dz) < 0.14 && Math.hypot(dx, dy) < this.bonusRadius + 0.05) {
      this.emitSparks(this.bonusPos, 0x00ff88, 28, 1.5);
      this.hideBonusRing();
      return true;
    }
    return false;
  }

  public update(
    dt: number,
    realDt: number,
    ball: BallState,
    eyeWorldPos: THREE.Vector3,
    smashTelegraph: number
  ): void {
    this.floatingText.update(realDt);
    // 1. Update ball trail
    if (ball.active) {
      this.trailPoints.push(new THREE.Vector3(ball.pos.x, ball.pos.y, ball.pos.z));
      if (this.trailPoints.length > this.trailMax) {
        this.trailPoints.shift();
      }
      const posAttr = this.trailGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < this.trailPoints.length; i++) {
        posAttr.setXYZ(i, this.trailPoints[i].x, this.trailPoints[i].y, this.trailPoints[i].z);
      }
      posAttr.needsUpdate = true;
      this.trailGeo.setDrawRange(0, this.trailPoints.length);

      if (ball.isCrimsonSmash) {
        this.trailMat.color.setHex(0xff2040);
        this.trailMat.opacity = 0.95;
      } else if (ball.isPlayerSmash) {
        this.trailMat.color.setHex(0xffe169);
        this.trailMat.opacity = 0.9;
      } else if (ball.isCurveShot) {
        this.trailMat.color.setHex(0x18ff98);
        this.trailMat.opacity = 0.82;
      } else {
        this.trailMat.color.setHex(0xd8f5e8);
        this.trailMat.opacity = 0.58;
      }
    } else if (this.trailPoints.length > 0) {
      this.trailPoints.shift();
      this.trailGeo.setDrawRange(0, this.trailPoints.length);
    }

    // 2. Depth contact shadow & reticle directly below ball
    const overTable =
      Math.abs(ball.pos.x) <= TABLE.HALF_WIDTH + 0.08 &&
      Math.abs(ball.pos.z) <= TABLE.HALF_LENGTH + 0.08;
    const heightAbove = Math.max(0, ball.pos.y - TABLE.SURFACE_Y);
    this.shadowMesh.visible = overTable && ball.pos.y >= TABLE.SURFACE_Y - 0.05;
    this.reticleRing.visible = overTable && ball.active;

    if (this.shadowMesh.visible) {
      this.shadowMesh.position.set(ball.pos.x, TABLE.SURFACE_Y + 0.002, ball.pos.z);
      const s = Math.max(0.45, 1.15 - heightAbove * 0.55);
      this.shadowMesh.scale.setScalar(s);
    }
    if (this.reticleRing.visible) {
      this.reticleRing.position.set(ball.pos.x, TABLE.SURFACE_Y + 0.004, ball.pos.z);
      // Shrink tight right as the ball touches the tabletop!
      const ringScale = 0.55 + Math.min(1.6, heightAbove * 1.45);
      this.reticleRing.scale.setScalar(ringScale);
      this.reticleMat.color.setHex(
        ball.isCrimsonSmash ? 0xff2244 : ball.pos.z > 0 ? 0x00ff77 : 0xffaa33
      );
      this.reticleMat.opacity = Math.max(0.18, 0.85 - heightAbove * 0.55);
    }

    // 3. Expanding bounce ripple
    if (this.rippleAge < 0.42) {
      this.rippleAge += dt;
      const p = this.rippleAge / 0.42;
      this.bounceRipple.visible = true;
      this.bounceRipple.scale.setScalar(1 + p * 3.8);
      this.bounceRippleMat.opacity = (1 - p) * 0.72;
    } else {
      this.bounceRipple.visible = false;
    }

    // 4. Crimson smash lock-on laser
    if (smashTelegraph > 0.05 && ball.active) {
      this.laserPositions[0] = eyeWorldPos.x;
      this.laserPositions[1] = eyeWorldPos.y;
      this.laserPositions[2] = eyeWorldPos.z;
      this.laserPositions[3] = ball.pos.x;
      this.laserPositions[4] = ball.pos.y;
      this.laserPositions[5] = ball.pos.z;
      (this.laserLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.laserMat.opacity = smashTelegraph * 0.82;
      this.laserLine.visible = true;
    } else {
      this.laserLine.visible = false;
    }

    // 5. Update sparks
    let anySpark = false;
    for (let i = 0; i < this.sparkCount; i++) {
      if (this.sparkLife[i] > 0) {
        anySpark = true;
        this.sparkLife[i] -= dt;
        this.sparkVel[i * 3 + 1] -= 6.5 * dt;
        this.sparkPos[i * 3] += this.sparkVel[i * 3] * dt;
        this.sparkPos[i * 3 + 1] += this.sparkVel[i * 3 + 1] * dt;
        this.sparkPos[i * 3 + 2] += this.sparkVel[i * 3 + 2] * dt;
      } else {
        this.sparkPos[i * 3 + 1] = -999;
      }
    }
    if (anySpark) {
      (this.sparkGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    // 6. Animate floating Matrix bonus ring
    if (this.bonusActive) {
      this.bonusTimer -= dt;
      this.bonusRingGroup.rotation.z += dt * 1.9;
      this.bonusRingGroup.position.y = this.bonusPos.y + Math.sin(this.bonusTimer * 3.1) * 0.035;
      if (this.bonusTimer <= 0) {
        this.hideBonusRing();
      }
    }

    // 7. Animate boss destruction shockwave ring
    if (this.shockwaveAge < 0.95) {
      this.shockwaveAge += realDt;
      const p = Math.min(1, this.shockwaveAge / 0.95);
      this.shockwaveMesh.visible = true;
      this.shockwaveMesh.scale.setScalar(1 + p * 18);
      this.shockwaveMat.opacity = Math.pow(1 - p, 1.5) * 0.9;
    } else {
      this.shockwaveMesh.visible = false;
    }
  }
}
