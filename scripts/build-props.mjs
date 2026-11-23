/**
 * Procedural 3D Gameplay Prop Builder for "Sentinel Pong"
 *
 * Generates 3 high-detail glTF 2.0 binary (.glb) models with embedded
 * procedural PBR textures (baseColor, metallicRoughness, normal):
 *   1. public/models/table.glb   (Root: TableRoot)
 *   2. public/models/paddle.glb  (Root: PaddleRoot)
 *   3. public/models/ball.glb    (Root: BallRoot)
 *
 * Coordinate System: Right-handed Y-up, metric (meters).
 * Run directly via: node scripts/build-props.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  exportSceneToGLB,
  createPixelTexture,
  heightMapToNormalTexture,
  attachPBRTextures,
  fbmTileable,
  hash2D,
} from './glb-builder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../public/models');

const CLAMP = 33071; // glTF CLAMP_TO_EDGE
const REPEAT = 10497; // glTF REPEAT

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Create a BoxGeometry with clean world-scaled UVs and optional offset.
 */
function makeBox(w, h, d, uvScale = 1.0) {
  const geom = new THREE.BoxGeometry(w, h, d);
  if (uvScale !== 1.0) {
    const uv = geom.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale);
    }
    uv.needsUpdate = true;
  }
  return geom;
}

/**
 * Create a chamfered rectangular steel bar extruded along Y (centered at origin).
 */
function makeChamferedPost(w, d, h, bevel = 0.005) {
  const hw = w * 0.5;
  const hd = d * 0.5;
  const b = Math.min(bevel, hw * 0.45, hd * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-hw + b, -hd);
  shape.lineTo(hw - b, -hd);
  shape.lineTo(hw, -hd + b);
  shape.lineTo(hw, hd - b);
  shape.lineTo(hw - b, hd);
  shape.lineTo(-hw + b, hd);
  shape.lineTo(-hw, hd - b);
  shape.lineTo(-hw, -hd + b);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: h,
    bevelEnabled: false,
    curveSegments: 1,
  });
  // Extrude runs along +Z; rotate so it runs along Y centered at 0
  geom.translate(0, 0, -h * 0.5);
  geom.rotateX(-Math.PI * 0.5);
  // Normalize UVs smoothly so brushed metal texture tiles cleanly
  const pos = geom.getAttribute('position');
  const norm = geom.getAttribute('normal');
  const uv = geom.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ny = Math.abs(norm.getY(i));
    if (ny > 0.7) {
      uv.setXY(i, (x + hw) * 4.0, (z + hd) * 4.0);
    } else {
      const nx = Math.abs(norm.getX(i));
      uv.setXY(i, (nx > 0.5 ? z : x) * 4.0, (y + h * 0.5) * 2.0);
    }
  }
  uv.needsUpdate = true;
  geom.computeVertexNormals();
  return geom;
}

/**
 * Create a tubular diagonal steel strut between two 3D points.
 */
function makeStrut(p1, p2, radius = 0.014, radialSegments = 10) {
  const dir = new THREE.Vector3().subVectors(p2, p1);
  const len = dir.length();
  const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
  const geom = new THREE.CylinderGeometry(radius, radius, len, radialSegments, 1);
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize()
  );
  const mat4 = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
  geom.applyMatrix4(mat4);
  return geom;
}

/**
 * Create a LatheGeometry with guaranteed finite unit-length normals (no pole degeneracy).
 */
function makeCleanLathe(profilePoints, segments = 16) {
  const safePts = profilePoints.map(
    (p) => new THREE.Vector2(Math.max(0.0004, p.x), p.y)
  );
  const geom = new THREE.LatheGeometry(safePts, segments);
  geom.computeVertexNormals();
  const norm = geom.getAttribute('normal');
  for (let i = 0; i < norm.count; i++) {
    const nx = norm.getX(i);
    const ny = norm.getY(i);
    const nz = norm.getZ(i);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-4) {
      norm.setXYZ(i, 0, 1, 0);
    } else if (Math.abs(len - 1.0) > 1e-4) {
      norm.setXYZ(i, nx / len, ny / len, nz / len);
    }
  }
  norm.needsUpdate = true;
  return geom;
}

// ===========================================================================
// 1. TABLE TENNIS TABLE (`public/models/table.glb`)
// ===========================================================================

function createTableTopTextures() {
  const W = 512;
  const H = 512;

  // Regulation dims: width 1.525m (X -> u), length 2.740m (Z -> v)
  const sideLineU = 0.02 / 1.525; // ~0.01311
  const endLineV = 0.022 / 2.74; // ~0.00803 (slightly crisp for mip stability)
  const centerLineHalfU = 0.0045 / 1.525; // crisp thin center service line

  const heightMap = new Float32Array(W * H);
  const wetnessMap = new Float32Array(W * H);
  const lineMask = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const idx = y * W + x;

      // Domain-warped organic puddle mask + directional damp streaks
      const warpX = (fbmTileable(u, v, 3, 3, 101) - 0.5) * 0.14;
      const warpY = (fbmTileable(u, v, 3, 3, 202) - 0.5) * 0.14;
      const macroPuddle = fbmTileable(u + warpX, v + warpY, 4, 4, 303);
      const streak = fbmTileable(u * 1.4, v * 0.45, 6, 3, 404);
      const fineDrop = fbmTileable(u, v, 16, 3, 505);

      // Pool peaks become glossy wet puddles; troughs are slightly drier brushed streaks
      const wetCore = smoothstep(0.47, 0.62, macroPuddle * 0.78 + streak * 0.22);
      const dampBand = smoothstep(0.35, 0.58, macroPuddle * 0.65 + streak * 0.35);
      const wetness = clamp01(wetCore * 0.72 + dampBand * 0.28 + (fineDrop - 0.5) * 0.08);
      wetnessMap[idx] = wetness;

      // Subtle brushed slate grain (flattened inside wet pools where water fills micro-pores)
      const brushZ = fbmTileable(u * 2.5, v * 0.35, 24, 2, 606);
      const microGrain = fbmTileable(u, v, 32, 3, 707);
      let hVal = 0.5 + (microGrain - 0.5) * 0.14 * (1.0 - wetness * 0.78) + (brushZ - 0.5) * 0.07 * (1.0 - wetness * 0.6);

      // Center fold seam groove along z = 0 (v = 0.5)
      const distCenterZ = Math.abs(v - 0.5);
      if (distCenterZ < 0.008) {
        const groove = 1.0 - smoothstep(0.0, 0.007, distCenterZ);
        hVal -= groove * 0.36;
      }

      // Regulation white court lines (crisp anti-aliased edges)
      const leftEdge = 1.0 - smoothstep(sideLineU - 0.0018, sideLineU + 0.0018, u);
      const rightEdge = 1.0 - smoothstep(sideLineU - 0.0018, sideLineU + 0.0018, 1.0 - u);
      const nearEdge = 1.0 - smoothstep(endLineV - 0.0014, endLineV + 0.0014, v);
      const farEdge = 1.0 - smoothstep(endLineV - 0.0014, endLineV + 0.0014, 1.0 - v);
      const centerService = 1.0 - smoothstep(centerLineHalfU - 0.0008, centerLineHalfU + 0.001, Math.abs(u - 0.5));

      // Keep center line nicely bounded inside the perimeter
      const line = Math.max(leftEdge, rightEdge, nearEdge, farEdge, centerService * 0.92);
      lineMask[idx] = line;

      // Slightly raised paint edge on court lines
      hVal += line * 0.055;
      heightMap[idx] = clamp01(hVal);
    }
  }

  const baseColor = createPixelTexture(
    W,
    H,
    (out) => {
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          const idx = y * W + x;
          const p = idx * 4;

          const wet = wetnessMap[idx];
          const line = lineMask[idx];
          const wear = fbmTileable(u, v, 8, 3, 808);
          const scratch = fbmTileable(u * 2.0, v * 0.6, 20, 2, 909);

          // Deep dark charcoal-obsidian slate (#141a1e -> RGB 20, 26, 30)
          // Wet areas darken realistically by ~22% with a subtle cool slate-emerald undertone
          const wetDarken = lerp(1.06, 0.76, wet);
          const scuff = smoothstep(0.64, 0.88, wear) * 5.0 + smoothstep(0.75, 0.95, scratch) * 4.0;
          let r = (20 + scuff * 0.8) * wetDarken;
          let g = (26 + scuff * 0.95) * wetDarken + wet * 1.5;
          let b = (30 + scuff * 1.0) * wetDarken + wet * 1.2;

          // Subtle darkening right inside the center fold joint at z = 0
          const seamDark = 1.0 - smoothstep(0.0, 0.0045, Math.abs(v - 0.5));
          r *= 1.0 - seamDark * 0.55;
          g *= 1.0 - seamDark * 0.55;
          b *= 1.0 - seamDark * 0.55;

          // Crisp regulation bright white lines (#e8eff2) with realistic micro-wear & damp tint
          if (line > 0.001) {
            const paintWear = 0.93 + 0.07 * wear;
            const paintWet = lerp(1.0, 0.88, wet);
            const lr = 234 * paintWear * paintWet;
            const lg = 240 * paintWear * paintWet;
            const lb = 244 * paintWear * paintWet;
            r = lerp(r, lr, line);
            g = lerp(g, lg, line);
            b = lerp(b, lb, line);
          }

          out[p] = Math.round(clamp01(r / 255) * 255);
          out[p + 1] = Math.round(clamp01(g / 255) * 255);
          out[p + 2] = Math.round(clamp01(b / 255) * 255);
          out[p + 3] = 255;
        }
      }
    },
    { wrapS: CLAMP, wrapT: CLAMP }
  );

  // glTF 2.0 metallicRoughness: G = Roughness, B = Metalness
  const metallicRoughness = createPixelTexture(
    W,
    H,
    (out) => {
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          const idx = y * W + x;
          const p = idx * 4;

          const wet = wetnessMap[idx];
          const line = lineMask[idx];
          const fineVar = fbmTileable(u, v, 14, 3, 1111);

          // Wet puddles: roughness 0.06..0.11; drier damp streaks: up to 0.34
          let rough = lerp(0.34, 0.06, Math.pow(wet, 1.15)) + (fineVar - 0.5) * 0.04;
          let metal = lerp(0.20, 0.25, wet);

          // Painted lines are slightly more matte except where wet puddles wash across them
          if (line > 0.001) {
            const lineRough = lerp(0.36, 0.11, wet);
            rough = lerp(rough, lineRough, line);
            metal = lerp(metal, 0.06, line);
          }

          // Center fold seam is rougher dark crevice
          const seam = 1.0 - smoothstep(0.0, 0.0045, Math.abs(v - 0.5));
          rough = lerp(rough, 0.65, seam);

          out[p] = 0;
          out[p + 1] = Math.round(clamp01(rough) * 255);
          out[p + 2] = Math.round(clamp01(metal) * 255);
          out[p + 3] = 255;
        }
      }
    },
    { wrapS: CLAMP, wrapT: CLAMP }
  );

  const normal = heightMapToNormalTexture(W, H, heightMap, 1.8, {
    wrapS: CLAMP,
    wrapT: CLAMP,
  });

  return { baseColor, metallicRoughness, normal };
}

function createIndustrialSteelTextures() {
  const W = 256;
  const H = 256;
  const heightMap = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const brush = fbmTileable(u * 0.5, v * 3.0, 12, 3, 2101);
      const pit = fbmTileable(u, v, 16, 4, 2202);
      heightMap[y * W + x] = clamp01(0.5 + (brush - 0.5) * 0.22 + (pit - 0.5) * 0.16);
    }
  }

  const baseColor = createPixelTexture(W, H, (out) => {
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const idx = y * W + x;
        const p = idx * 4;
        const grime = fbmTileable(u, v, 6, 4, 2303);
        const h = heightMap[idx];
        const shade = lerp(0.75, 1.18, h) * lerp(0.84, 1.06, grime);
        out[p] = Math.round(clamp01((32 * shade) / 255) * 255);
        out[p + 1] = Math.round(clamp01((38 * shade) / 255) * 255);
        out[p + 2] = Math.round(clamp01((44 * shade) / 255) * 255);
        out[p + 3] = 255;
      }
    }
  });

  const metallicRoughness = createPixelTexture(W, H, (out) => {
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const idx = y * W + x;
        const p = idx * 4;
        const grime = fbmTileable(u, v, 6, 4, 2303);
        const rough = clamp01(0.28 + grime * 0.24);
        const metal = clamp01(0.86 - grime * 0.14);
        out[p] = 0;
        out[p + 1] = Math.round(rough * 255);
        out[p + 2] = Math.round(metal * 255);
        out[p + 3] = 255;
      }
    }
  });

  const normal = heightMapToNormalTexture(W, H, heightMap, 1.5);
  return { baseColor, metallicRoughness, normal };
}

function createNetTextures() {
  // 256x256 tile: covers 15.25cm x 15.25cm (repeated 12x horizontally across 1.83m!)
  // Top 15mm (~9.84% of height -> v = 0..0.098) is crisp bright off-white woven canvas tape;
  // Remaining height is a crisp transparent dark steel-nylon woven net grid (~14x14 mesh cells).
  const W = 256;
  const H = 256;
  const heightMap = new Float32Array(W * H);

  const tapeEndV = 0.015 / 0.1525; // ~0.09836
  const cells = 14; // ~10.9mm real ITTF mesh pitch

  const baseColor = createPixelTexture(
    W,
    H,
    (out) => {
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H; // v = 0 is TOP of net, v = 1 is BOTTOM of net
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          const idx = y * W + x;
          const p = idx * 4;

          if (v <= tapeEndV) {
            // Crisp bright white/light-gray woven canvas top tape
            const weaveX = Math.sin(u * Math.PI * 160) * 0.5 + 0.5;
            const weaveY = Math.sin(v * Math.PI * 160) * 0.5 + 0.5;
            const weave = (weaveX + weaveY) * 0.5;
            const stitch = smoothstep(0.005, 0.0, Math.abs(v - (tapeEndV - 0.012))) *
              (Math.sin(u * Math.PI * 48) > 0.15 ? 1.0 : 0.0);
            const grain = fbmTileable(u, v, 8, 2, 3101);
            const shade = (224 + weave * 14 + (grain - 0.5) * 10) * (1.0 - stitch * 0.24);
            out[p] = Math.round(clamp01(shade / 255) * 255);
            out[p + 1] = Math.round(clamp01((shade + 3) / 255) * 255);
            out[p + 2] = Math.round(clamp01((shade + 6) / 255) * 255);
            out[p + 3] = 255;
            heightMap[idx] = 0.65 + weave * 0.15 - stitch * 0.2;
          } else if (v >= 0.968) {
            // Bottom woven binding cord
            const twist = Math.sin((u * 40 + v * 6) * Math.PI) * 0.5 + 0.5;
            const c = 34 + twist * 16;
            out[p] = Math.round(c);
            out[p + 1] = Math.round(c + 4);
            out[p + 2] = Math.round(c + 6);
            out[p + 3] = 245;
            heightMap[idx] = 0.55 + twist * 0.18;
          } else {
            // Woven dark steel/nylon grid
            const gx = (u * cells) % 1.0;
            const gy = ((v - tapeEndV) / (0.968 - tapeEndV) * (cells - 1)) % 1.0;

            const distX = Math.min(gx, 1.0 - gx);
            const distY = Math.min(gy, 1.0 - gy);

            const threadHalf = 0.088; // crisp fine mesh strands (~2px wide)
            const strandX = 1.0 - smoothstep(threadHalf * 0.62, threadHalf * 1.18, distX);
            const strandY = 1.0 - smoothstep(threadHalf * 0.62, threadHalf * 1.18, distY);
            const knot = strandX * strandY;
            const thread = Math.max(strandX, strandY);

            // Subtle dark industrial steel-nylon sheen on fibers
            const twist = Math.sin((u * cells * 6 + v * cells * 6) * Math.PI) * 0.5 + 0.5;
            const baseShade = 28 + twist * 18 + knot * 14;
            out[p] = Math.round(baseShade);
            out[p + 1] = Math.round(baseShade + 5);
            out[p + 2] = Math.round(baseShade + 7);
            out[p + 3] = Math.round(clamp01(thread * 0.94 + knot * 0.06) * 255);
            heightMap[idx] = clamp01(0.2 + thread * 0.55 + knot * 0.2);
          }
        }
      }
    },
    { wrapS: REPEAT, wrapT: CLAMP }
  );

  const normal = heightMapToNormalTexture(W, H, heightMap, 1.4, {
    wrapS: REPEAT,
    wrapT: CLAMP,
  });

  return { baseColor, normal };
}

function buildTableTopSurfaceGeometry(width, length, yTop, segX = 24, segZ = 40) {
  // Custom top playing surface mesh with exact y = yTop, normal = (0, 1, 0),
  // UVs strictly (0..1, 0..1) matching glTF (0,0) = (-width/2, -length/2)
  const verts = [];
  const norms = [];
  const uvs = [];
  const indices = [];

  for (let iz = 0; iz <= segZ; iz++) {
    const v = iz / segZ;
    const z = -length * 0.5 + v * length;
    for (let ix = 0; ix <= segX; ix++) {
      const u = ix / segX;
      const x = -width * 0.5 + u * width;
      verts.push(x, yTop, z);
      norms.push(0, 1, 0);
      uvs.push(u, v);
    }
  }

  const row = segX + 1;
  for (let iz = 0; iz < segZ; iz++) {
    for (let ix = 0; ix < segX; ix++) {
      const a = iz * row + ix;
      const b = a + 1;
      const c = (iz + 1) * row + ix;
      const d = c + 1;
      // Counter-clockwise when viewed from +Y (upward normal +Y)
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  return geom;
}

function buildNetPlaneGeometry(width, yBottom, yTop, segX = 36, segY = 6, repeatU = 12) {
  const verts = [];
  const norms = [];
  const uvs = [];
  const indices = [];
  const height = yTop - yBottom;

  for (let iy = 0; iy <= segY; iy++) {
    const t = iy / segY; // 0 = top (v=0), 1 = bottom (v=1)
    const y = yTop - t * height;
    for (let ix = 0; ix <= segX; ix++) {
      const s = ix / segX;
      const x = -width * 0.5 + s * width;
      // Micro realistic taut fabric wave (sub-millimeter)
      const z = Math.sin(s * Math.PI) * Math.sin(t * Math.PI) * 0.0008;
      verts.push(x, y, z);
      norms.push(0, 0, 1);
      uvs.push(s * repeatU, t);
    }
  }

  const row = segX + 1;
  for (let iy = 0; iy < segY; iy++) {
    for (let ix = 0; ix < segX; ix++) {
      const a = iy * row + ix;
      const b = a + 1;
      const c = (iy + 1) * row + ix;
      const d = c + 1;
      // Counter-clockwise facing +Z
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function createNetPostGeometries() {
  const tableEdgeX = 0.1525;
  const jawReachX = tableEdgeX + 0.042; // 0.1945

  const postProfile = [
    new THREE.Vector2(0.0, -0.036),
    new THREE.Vector2(0.011, -0.036),
    new THREE.Vector2(0.012, -0.030),
    new THREE.Vector2(0.012, 0.002),
    new THREE.Vector2(0.0095, 0.006),
    new THREE.Vector2(0.0085, 0.145),
    new THREE.Vector2(0.0105, 0.148),
    new THREE.Vector2(0.0105, 0.153),
    new THREE.Vector2(0.007, 0.155),
    new THREE.Vector2(0.0, 0.155),
  ];

  return {
    tableEdgeX,
    jawReachX,
    postGeom: makeCleanLathe(postProfile, 18),
    sleeveGeom: new THREE.CylinderGeometry(0.0102, 0.0102, 0.149, 14),
    armGeom: makeChamferedPost(jawReachX, 0.034, 0.014, 0.0025),
    topPadGeom: makeBox(0.044, 0.003, 0.038),
    clampSpineGeom: makeChamferedPost(0.016, 0.036, 0.080, 0.0025),
    lowerJawGeom: makeChamferedPost(0.058, 0.034, 0.014, 0.0025),
    gussetGeom: makeStrut(
      new THREE.Vector3(0.005, -0.028, 0),
      new THREE.Vector3(tableEdgeX - 0.012, -0.054, 0),
      0.006,
      8
    ),
    screwShaftGeom: new THREE.CylinderGeometry(0.0045, 0.0045, 0.066, 12),
    pressDiscGeom: new THREE.CylinderGeometry(0.015, 0.014, 0.005, 16),
    thumbWheelGeom: new THREE.CylinderGeometry(0.018, 0.017, 0.012, 16),
    ribGeom: makeBox(0.038, 0.010, 0.004),
    tensionKnobGeom: new THREE.CylinderGeometry(0.008, 0.008, 0.016, 12),
    hookGeom: new THREE.TorusGeometry(0.0055, 0.0016, 8, 14),
    bottomClipGeom: new THREE.CylinderGeometry(0.0025, 0.0025, 0.018, 8),
  };
}

function buildNetPostAssembly(name, sideSign, shared, gunmetalMat, chromeMat, darkRubberMat) {
  // Post centerline sits at world x = sideSign * 0.915, y = 0.760, z = 0.
  // Built locally with post at (0, 0, 0) and clamp arm reaching +X inward;
  // for right side (sideSign = +1), rotate Math.PI around Y so clamp arm reaches -X inward.
  const group = new THREE.Group();
  group.name = name;
  group.position.set(sideSign * 0.915, 0.76, 0);
  if (sideSign > 0) {
    group.rotation.y = Math.PI;
  }

  const { tableEdgeX, jawReachX } = shared;

  // 1. Main vertical tension post rising from y_local = -0.036 (0.724) to +0.155 (0.915)
  const postMesh = new THREE.Mesh(shared.postGeom, gunmetalMat);
  postMesh.name = `${name}_Post`;
  group.add(postMesh);

  // 2. Vertical fabric/rubber net sleeve hugging the post (y_local = 0.002 to 0.151)
  const sleeveMesh = new THREE.Mesh(shared.sleeveGeom, darkRubberMat);
  sleeveMesh.name = `${name}_Sleeve`;
  sleeveMesh.position.set(0.002, 0.0765, 0);
  group.add(sleeveMesh);

  // 3. Heavy industrial horizontal clamp bridge arm connecting post to table C-clamp
  const armTop = new THREE.Mesh(shared.armGeom, gunmetalMat);
  armTop.name = `${name}_ClampTopArm`;
  armTop.position.set(jawReachX * 0.5 - 0.005, 0.0095, 0);
  group.add(armTop);

  // Protective dark rubber jaw pad gripping top edge of tabletop (y_local = 0.0005..0.0035)
  const topPad = new THREE.Mesh(shared.topPadGeom, darkRubberMat);
  topPad.name = `${name}_TopPad`;
  topPad.position.set(tableEdgeX + 0.020, 0.002, 0);
  group.add(topPad);

  // C-clamp vertical spine hugging outer edge of tabletop slab (y_local = -0.072..+0.008)
  const clampSpine = new THREE.Mesh(shared.clampSpineGeom, gunmetalMat);
  clampSpine.name = `${name}_ClampSpine`;
  clampSpine.position.set(tableEdgeX - 0.010, -0.032, 0);
  group.add(clampSpine);

  // Lower C-clamp jaw arm extending under slab (y_local = -0.072..-0.058)
  const lowerJaw = new THREE.Mesh(shared.lowerJawGeom, gunmetalMat);
  lowerJaw.name = `${name}_ClampLowerJaw`;
  lowerJaw.position.set(tableEdgeX + 0.014, -0.065, 0);
  group.add(lowerJaw);

  // Diagonal reinforcement gusset rib between outer post base and C-clamp spine
  const gusset = new THREE.Mesh(shared.gussetGeom, gunmetalMat);
  gusset.name = `${name}_Gusset`;
  group.add(gusset);

  // 4. Vertical under-table clamping screw, pressure pad & knurled thumbwheel
  const clampScrewX = tableEdgeX + 0.024;
  const screwShaft = new THREE.Mesh(shared.screwShaftGeom, chromeMat);
  screwShaft.name = `${name}_ClampScrew`;
  screwShaft.position.set(clampScrewX, -0.066, 0);
  group.add(screwShaft);

  // Pressure disc pressed firmly against underside of tabletop (y_local = -0.033)
  const pressDisc = new THREE.Mesh(shared.pressDiscGeom, darkRubberMat);
  pressDisc.name = `${name}_PressurePad`;
  pressDisc.position.set(clampScrewX, -0.0345, 0);
  group.add(pressDisc);

  // Knurled clamping thumbwheel at bottom (y_local = -0.095)
  const thumbWheel = new THREE.Mesh(shared.thumbWheelGeom, gunmetalMat);
  thumbWheel.name = `${name}_ThumbWheel`;
  thumbWheel.position.set(clampScrewX, -0.095, 0);
  group.add(thumbWheel);

  // Thumbwheel grip ribs (4 intersecting knurl bars)
  for (let i = 0; i < 4; i++) {
    const rib = new THREE.Mesh(shared.ribGeom, chromeMat);
    rib.position.set(clampScrewX, -0.095, 0);
    rib.rotation.y = (i * Math.PI) / 4;
    group.add(rib);
  }

  // 5. Net tensioning side thumbscrew & top tension hook on outer side of post
  const tensionKnob = new THREE.Mesh(shared.tensionKnobGeom, chromeMat);
  tensionKnob.name = `${name}_TensionKnob`;
  tensionKnob.rotation.z = Math.PI * 0.5;
  tensionKnob.position.set(-0.014, 0.132, 0);
  group.add(tensionKnob);

  // Tension hook eyelet near top of post
  const hook = new THREE.Mesh(shared.hookGeom, chromeMat);
  hook.name = `${name}_TensionHook`;
  hook.position.set(-0.009, 0.146, 0);
  group.add(hook);

  // Bottom retaining clip pin
  const bottomClip = new THREE.Mesh(shared.bottomClipGeom, chromeMat);
  bottomClip.rotation.z = Math.PI * 0.5;
  bottomClip.position.set(-0.008, 0.016, 0);
  group.add(bottomClip);

  return group;
}

export function buildTable() {
  const root = new THREE.Group();
  root.name = 'TableRoot';

  const TABLE_W = 1.525;
  const TABLE_L = 2.740;
  const TOP_Y = 0.760;
  const SLAB_THICK = 0.032;
  const SLAB_BOT_Y = TOP_Y - SLAB_THICK; // 0.728

  // --- Materials ---
  const topTextures = createTableTopTextures();
  const tableTopMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'TableTopWetSlateMat',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(0.85, 0.85),
    }),
    topTextures
  );

  const steelTextures = createIndustrialSteelTextures();
  const gunmetalMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'IndustrialGunmetalMat',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(0.65, 0.65),
    }),
    steelTextures
  );

  const slabEdgeMat = new THREE.MeshStandardMaterial({
    name: 'TableSlabEdgeMat',
    color: 0x161c22,
    roughness: 0.36,
    metalness: 0.42,
  });

  const chromeMat = new THREE.MeshStandardMaterial({
    name: 'BrushedSteelHardwareMat',
    color: 0x76828e,
    roughness: 0.24,
    metalness: 0.90,
  });

  const darkRubberMat = new THREE.MeshStandardMaterial({
    name: 'IndustrialRubberMat',
    color: 0x14171a,
    roughness: 0.76,
    metalness: 0.05,
  });

  // --- 1. TableTop (playing surface EXACTLY at y = 0.760m + structural 32mm slab child) ---
  const topSurfaceGeom = buildTableTopSurfaceGeometry(TABLE_W, TABLE_L, TOP_Y, 24, 40);
  const tableTop = new THREE.Mesh(topSurfaceGeom, tableTopMat);
  tableTop.name = 'TableTop';
  root.add(tableTop);

  // Structural 32mm beveled slab body sitting cleanly underneath y = 0.760 down to y = 0.728
  // Inset 0.6mm below TOP_Y so zero z-fighting with the crisp wet-slate playing surface
  const slabBodyH = SLAB_THICK - 0.0006;
  const slabHalfLen = TABLE_L * 0.5 - 0.0012; // subtle 2.4mm center folding split under net
  const slabHalfGeom = makeBox(TABLE_W, slabBodyH, slabHalfLen, 2.0);

  const slabNorth = new THREE.Mesh(slabHalfGeom, slabEdgeMat);
  slabNorth.name = 'TableTopSlab_North';
  slabNorth.position.set(0, SLAB_BOT_Y + slabBodyH * 0.5, -TABLE_L * 0.25 - 0.0006);
  tableTop.add(slabNorth);

  const slabSouth = new THREE.Mesh(slabHalfGeom, slabEdgeMat);
  slabSouth.name = 'TableTopSlab_South';
  slabSouth.position.set(0, SLAB_BOT_Y + slabBodyH * 0.5, TABLE_L * 0.25 + 0.0006);
  tableTop.add(slabSouth);

  // Steel edge trim molding strips recessed cleanly flush with exact 1.525m x 2.740m perimeter
  const trimLongGeom = makeBox(0.008, SLAB_THICK - 0.004, TABLE_L - 0.016);
  for (const sx of [-1, 1]) {
    const trim = new THREE.Mesh(trimLongGeom, gunmetalMat);
    trim.position.set(sx * (TABLE_W * 0.5 - 0.004), SLAB_BOT_Y + SLAB_THICK * 0.5 - 0.001, 0);
    tableTop.add(trim);
  }
  const trimShortGeom = makeBox(TABLE_W - 0.016, SLAB_THICK - 0.004, 0.008);
  for (const sz of [-1, 1]) {
    const trim = new THREE.Mesh(trimShortGeom, gunmetalMat);
    trim.position.set(0, SLAB_BOT_Y + SLAB_THICK * 0.5 - 0.001, sz * (TABLE_L * 0.5 - 0.004));
    tableTop.add(trim);
  }

  // --- 2. Heavy Industrial Steel Frame, Legs, Trusses & Folding Mechanism ---
  const frame = new THREE.Group();
  frame.name = 'TableFrame';
  root.add(frame);

  const apronInset = 0.032;
  const apronW = TABLE_W - apronInset * 2; // 1.461m
  const apronL = TABLE_L - apronInset * 2; // 2.676m
  const apronH = 0.056;
  const apronY = SLAB_BOT_Y - apronH * 0.5; // 0.700

  // Perimeter C-channel apron rails (2 long sides + 2 end rails)
  const sideApronGeom = makeBox(0.026, apronH, apronL - 0.04, 3.0);
  const sideFlangeGeom = makeBox(0.042, 0.009, apronL - 0.04, 3.0);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(sideApronGeom, gunmetalMat);
    rail.position.set(sx * (apronW * 0.5 - 0.013), apronY, 0);
    frame.add(rail);

    const botFlange = new THREE.Mesh(sideFlangeGeom, gunmetalMat);
    botFlange.position.set(sx * (apronW * 0.5 - 0.021), SLAB_BOT_Y - apronH + 0.0045, 0);
    frame.add(botFlange);
  }

  const endApronGeom = makeBox(apronW - 0.04, apronH, 0.026, 2.0);
  const endFlangeGeom = makeBox(apronW - 0.04, 0.009, 0.042, 2.0);
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(endApronGeom, gunmetalMat);
    rail.position.set(0, apronY, sz * (apronL * 0.5 - 0.013));
    frame.add(rail);

    const botFlange = new THREE.Mesh(endFlangeGeom, gunmetalMat);
    botFlange.position.set(0, SLAB_BOT_Y - apronH + 0.0045, sz * (apronL * 0.5 - 0.021));
    frame.add(botFlange);
  }

  // 4 Chamfered Heavy Corner Armor Brackets + hex bolts
  const cornerBracketGeom = makeChamferedPost(0.072, 0.072, apronH + 0.006, 0.014);
  const boltHeadGeom = new THREE.CylinderGeometry(0.0055, 0.0055, 0.007, 6);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * (apronW * 0.5 - 0.020);
      const cz = sz * (apronL * 0.5 - 0.020);
      const corner = new THREE.Mesh(cornerBracketGeom, gunmetalMat);
      corner.position.set(cx, apronY - 0.001, cz);
      frame.add(corner);

      // Side rivets on each corner bracket
      for (const dy of [-0.014, 0.014]) {
        const boltX = new THREE.Mesh(boltHeadGeom, chromeMat);
        boltX.rotation.z = Math.PI * 0.5;
        boltX.position.set(cx + sx * 0.037, apronY + dy, cz - sz * 0.012);
        frame.add(boltX);

        const boltZ = new THREE.Mesh(boltHeadGeom, chromeMat);
        boltZ.rotation.x = Math.PI * 0.5;
        boltZ.position.set(cx - sx * 0.012, apronY + dy, cz + sz * 0.037);
        frame.add(boltZ);
      }
    }
  }

  // Longitudinal underside steel stringer beams under tabletop
  const stringerGeom = makeBox(0.034, 0.042, apronL - 0.08, 3.0);
  for (const sx of [-1, 1]) {
    const stringer = new THREE.Mesh(stringerGeom, gunmetalMat);
    stringer.position.set(sx * 0.44, SLAB_BOT_Y - 0.021, 0);
    frame.add(stringer);
  }

  // Transverse underside ribs
  const ribCrossGeom = makeBox(apronW - 0.06, 0.036, 0.028, 2.0);
  for (const rz of [-0.96, -0.42, 0.42, 0.96]) {
    const rib = new THREE.Mesh(ribCrossGeom, gunmetalMat);
    rib.position.set(0, SLAB_BOT_Y - 0.018, rz);
    frame.add(rib);
  }

  // 4 Heavy Braced Industrial Steel Legs (x = ±0.56, z = ±0.96) from y = 0.728 down to exact y = 0.000
  const legX = 0.56;
  const legZ = 0.96;

  // Shared leg sub-geometries
  const upperColGeom = makeChamferedPost(0.058, 0.058, 0.36, 0.008);
  const lowerColGeom = makeChamferedPost(0.048, 0.048, 0.33, 0.007);
  const collarGeom = makeChamferedPost(0.068, 0.068, 0.034, 0.010);
  const yokeGeom = makeChamferedPost(0.086, 0.096, 0.052, 0.010);
  const footProfile = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.038, 0.0),
    new THREE.Vector2(0.038, 0.010),
    new THREE.Vector2(0.030, 0.018),
    new THREE.Vector2(0.018, 0.022),
    new THREE.Vector2(0.012, 0.024),
    new THREE.Vector2(0.0, 0.024),
  ];
  const footPadGeom = makeCleanLathe(footProfile, 16);
  const spindleGeom = new THREE.CylinderGeometry(0.009, 0.009, 0.036, 12);
  const hexNutGeom = new THREE.CylinderGeometry(0.017, 0.017, 0.010, 6);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = sx * legX;
      const lz = sz * legZ;

      // Upper mounting yoke bolted to underside of slab & apron
      const yoke = new THREE.Mesh(yokeGeom, gunmetalMat);
      yoke.position.set(lx, SLAB_BOT_Y - 0.026, lz);
      frame.add(yoke);

      // Upper heavy column (y = 0.35..0.71)
      const upperCol = new THREE.Mesh(upperColGeom, gunmetalMat);
      upperCol.position.set(lx, 0.53, lz);
      frame.add(upperCol);

      // Mid reinforcement collar & locking pin (y = 0.35)
      const collar = new THREE.Mesh(collarGeom, gunmetalMat);
      collar.position.set(lx, 0.35, lz);
      frame.add(collar);

      const lockPin = new THREE.Mesh(boltHeadGeom, chromeMat);
      lockPin.rotation.z = Math.PI * 0.5;
      lockPin.position.set(lx + sx * 0.036, 0.35, lz);
      frame.add(lockPin);

      // Lower steel leg sleeve (y = 0.042..0.372)
      const lowerCol = new THREE.Mesh(lowerColGeom, gunmetalMat);
      lowerCol.position.set(lx, 0.207, lz);
      frame.add(lowerCol);

      // Threaded leveling spindle & hex locknut
      const spindle = new THREE.Mesh(spindleGeom, chromeMat);
      spindle.position.set(lx, 0.036, lz);
      frame.add(spindle);

      const nut = new THREE.Mesh(hexNutGeom, chromeMat);
      nut.position.set(lx, 0.034, lz);
      frame.add(nut);

      // Wide heavy leveling foot pad resting flush at EXACT y = 0.000
      const foot = new THREE.Mesh(footPadGeom, darkRubberMat);
      foot.position.set(lx, 0.0, lz);
      frame.add(foot);

      // Diagonal longitudinal truss strut from lower leg up toward inner apron
      const strutLong = new THREE.Mesh(
        makeStrut(
          new THREE.Vector3(lx, 0.22, lz - sz * 0.02),
          new THREE.Vector3(lx, 0.68, sz * 0.42),
          0.015,
          10
        ),
        gunmetalMat
      );
      frame.add(strutLong);

      // Diagonal lateral knee brace from upper leg inward to underside rib
      const strutLat = new THREE.Mesh(
        makeStrut(
          new THREE.Vector3(lx - sx * 0.02, 0.44, lz),
          new THREE.Vector3(sx * 0.28, 0.70, lz),
          0.013,
          10
        ),
        gunmetalMat
      );
      frame.add(strutLat);
    }
  }

  // Lateral cross-beams tying left & right legs together at both ends
  const endCrossBeamGeom = makeChamferedPost(legX * 2 - 0.04, 0.044, 0.044, 0.006);
  for (const sz of [-1, 1]) {
    const beam = new THREE.Mesh(endCrossBeamGeom, gunmetalMat);
    beam.position.set(0, 0.22, sz * legZ);
    frame.add(beam);
  }

  // Center Folding Mechanism & Undercarriage Crossbar under z = 0
  const centerGroup = new THREE.Group();
  centerGroup.name = 'CenterFoldingMechanism';
  frame.add(centerGroup);

  // Heavy lower center axle crossbar (z = 0, y = 0.17)
  const centerLowerBar = new THREE.Mesh(
    makeChamferedPost(1.22, 0.052, 0.052, 0.008),
    gunmetalMat
  );
  centerLowerBar.position.set(0, 0.17, 0);
  centerGroup.add(centerLowerBar);

  // Upper center hinge crossbar right under the z = 0 fold seam
  const centerUpperBar = new THREE.Mesh(
    makeChamferedPost(1.36, 0.048, 0.036, 0.006),
    gunmetalMat
  );
  centerUpperBar.position.set(0, 0.655, 0);
  centerGroup.add(centerUpperBar);

  // Twin vertical center stanchion pillars + heavy hinge brackets + transport caster assemblies
  const stanchionGeom = makeChamferedPost(0.054, 0.068, 0.53, 0.008);
  const hingeHubGeom = new THREE.CylinderGeometry(0.026, 0.026, 0.088, 16);
  const wheelTireGeom = new THREE.CylinderGeometry(0.052, 0.052, 0.032, 20);
  const wheelRimGeom = new THREE.CylinderGeometry(0.028, 0.028, 0.036, 14);

  for (const sx of [-1, 1]) {
    const cx = sx * 0.56;

    // Vertical stanchion pillar
    const stanchion = new THREE.Mesh(stanchionGeom, gunmetalMat);
    stanchion.position.set(cx, 0.435, 0);
    centerGroup.add(stanchion);

    // Pivot hinge drum & brushed steel axle
    const hub = new THREE.Mesh(hingeHubGeom, chromeMat);
    hub.rotation.z = Math.PI * 0.5;
    hub.position.set(cx, 0.655, 0);
    centerGroup.add(hub);

    // Industrial transport wheel assembly slightly hovering (bottom at y = 0.008) under center stanchion
    const fork = new THREE.Mesh(makeChamferedPost(0.062, 0.066, 0.11, 0.006), gunmetalMat);
    fork.position.set(cx, 0.115, 0);
    centerGroup.add(fork);

    const tire = new THREE.Mesh(wheelTireGeom, darkRubberMat);
    tire.rotation.z = Math.PI * 0.5;
    tire.position.set(cx, 0.060, 0);
    centerGroup.add(tire);

    const rim = new THREE.Mesh(wheelRimGeom, chromeMat);
    rim.rotation.z = Math.PI * 0.5;
    rim.position.set(cx, 0.060, 0);
    centerGroup.add(rim);

    // Fold-locking diagonal tie bars connecting center carriage to leg frames
    for (const sz of [-1, 1]) {
      const tieBar = new THREE.Mesh(
        makeStrut(
          new THREE.Vector3(cx, 0.17, sz * 0.025),
          new THREE.Vector3(cx, 0.22, sz * (legZ - 0.025)),
          0.015,
          10
        ),
        gunmetalMat
      );
      centerGroup.add(tieBar);

      const upperFoldLink = new THREE.Mesh(
        makeStrut(
          new THREE.Vector3(cx, 0.36, sz * 0.03),
          new THREE.Vector3(cx, 0.68, sz * 0.42),
          0.012,
          8
        ),
        chromeMat
      );
      centerGroup.add(upperFoldLink);
    }
  }

  // --- 3. Net Assembly along z = 0 ---
  const sharedNetPostGeoms = createNetPostGeometries();
  const netPostLeft = buildNetPostAssembly(
    'NetPostLeft',
    -1,
    sharedNetPostGeoms,
    gunmetalMat,
    chromeMat,
    darkRubberMat
  );
  const netPostRight = buildNetPostAssembly(
    'NetPostRight',
    +1,
    sharedNetPostGeoms,
    gunmetalMat,
    chromeMat,
    darkRubberMat
  );
  root.add(netPostLeft);
  root.add(netPostRight);

  // NetMesh: x = -0.915 to +0.915, y = 0.7610 to 0.9135 (exact height = 0.1525m)
  const netTextures = createNetTextures();
  const netMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'WovenNetMat',
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.18,
      transparent: true,
      opacity: 1.0,
      side: THREE.DoubleSide,
      normalScale: new THREE.Vector2(0.7, 0.7),
    }),
    netTextures
  );

  const netMesh = new THREE.Mesh(
    buildNetPlaneGeometry(1.830, 0.7610, 0.9135, 36, 6, 12),
    netMat
  );
  netMesh.name = 'NetMesh';
  root.add(netMesh);

  // Subtle 3D folded top canvas tape edge & braided tension cord attached as children of NetMesh
  // Stays strictly within x: [-0.915, +0.915], y: [0.8985, 0.9135] for crisp silhouette & exact bounds
  const topTapeMat = new THREE.MeshStandardMaterial({
    name: 'NetTopCanvasTapeMat',
    color: 0xe6ebef,
    roughness: 0.78,
    metalness: 0.04,
  });

  // Two thin front/back canvas strips bracketing z = ±0.0018 + top cap strip so zero z-fighting with NetMesh
  const tapeSideGeom = makeBox(1.824, 0.0145, 0.0012);
  const tapeFront = new THREE.Mesh(tapeSideGeom, topTapeMat);
  tapeFront.name = 'NetTopTape_Front';
  tapeFront.position.set(0, 0.9058, 0.0018);
  netMesh.add(tapeFront);

  const tapeBack = new THREE.Mesh(tapeSideGeom, topTapeMat);
  tapeBack.name = 'NetTopTape_Back';
  tapeBack.position.set(0, 0.9058, -0.0018);
  netMesh.add(tapeBack);

  const tapeCap = new THREE.Mesh(makeBox(1.824, 0.0014, 0.0048), topTapeMat);
  tapeCap.name = 'NetTopTape_Cap';
  tapeCap.position.set(0, 0.9128, 0);
  netMesh.add(tapeCap);

  // Braided steel-nylon top tension cord spanning cleanly between left & right posts
  const tensionCord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0014, 0.0014, 1.830, 8),
    chromeMat
  );
  tensionCord.name = 'NetTensionCord';
  tensionCord.rotation.z = Math.PI * 0.5;
  tensionCord.position.set(0, 0.908, 0);
  netMesh.add(tensionCord);

  const outputPath = path.join(MODELS_DIR, 'table.glb');
  return exportSceneToGLB(root, outputPath);
}

// ===========================================================================
// 2. PRO TABLE TENNIS PADDLE (`public/models/paddle.glb`)
// ===========================================================================

/**
 * Create realistic teardrop/oval table tennis blade 2D profile.
 * Origin (0,0) = exact center of hitting blade!
 * Full dimensions: width = 0.156m, height = 0.162m (-0.081 to +0.081).
 */
function createBladeShape(inset = 0.0, straightBottomY = null) {
  const hw = 0.078 - inset; // 0.078m half-width
  const topY = 0.081 - inset; // +0.081m apex
  const neckHalfW = Math.max(0.012, 0.0145 - inset * 0.4);
  const neckY = -0.081;

  const s = new THREE.Shape();

  if (straightBottomY !== null) {
    // Authentic pro rubber cut: follows exact teardrop outer arc down to straight horizontal cut line
    // above the handle throat (y = straightBottomY, e.g. -0.064m)
    const cutHalfW = 0.044 - inset;
    s.moveTo(-cutHalfW, straightBottomY);
    // Left lower wing up to widest point (+0.006m)
    s.bezierCurveTo(
      -hw * 0.92,
      -0.046,
      -hw,
      -0.018,
      -hw,
      0.008
    );
    // Left upper arc to top apex
    s.bezierCurveTo(
      -hw,
      0.052,
      -hw * 0.52,
      topY,
      0,
      topY
    );
    // Right upper arc down to widest point
    s.bezierCurveTo(
      hw * 0.52,
      topY,
      hw,
      0.052,
      hw,
      0.008
    );
    // Right lower wing down to straight rubber cut line
    s.bezierCurveTo(
      hw,
      -0.018,
      hw * 0.92,
      -0.046,
      cutHalfW,
      straightBottomY
    );
    s.closePath();
  } else {
    // Full wooden blade + tapered neck/tang extending smoothly into handle at y = -0.078..-0.081
    s.moveTo(-neckHalfW, neckY);
    // Smooth flare out from handle neck into left shoulder wing
    s.bezierCurveTo(
      -neckHalfW,
      -0.070,
      -0.032,
      -0.068,
      -0.050,
      -0.058
    );
    // Left lower arc up to widest point
    s.bezierCurveTo(
      -hw * 0.94,
      -0.042,
      -hw,
      -0.016,
      -hw,
      0.008
    );
    // Left upper arc to top apex
    s.bezierCurveTo(
      -hw,
      0.052,
      -hw * 0.52,
      topY,
      0,
      topY
    );
    // Right upper arc down to widest point
    s.bezierCurveTo(
      hw * 0.52,
      topY,
      hw,
      0.052,
      hw,
      0.008
    );
    // Right lower arc down to shoulder wing
    s.bezierCurveTo(
      hw,
      -0.016,
      hw * 0.94,
      -0.042,
      0.050,
      -0.058
    );
    // Smooth curve back into right handle neck
    s.bezierCurveTo(
      0.032,
      -0.068,
      neckHalfW,
      -0.070,
      neckHalfW,
      neckY
    );
    s.closePath();
  }

  return s;
}

/**
 * Normalize ExtrudeGeometry UVs cleanly into [0, 1] x [0, 1] over the blade face
 * (and ply-aligned UVs on side walls when `plySideUVs` is enabled).
 */
function normalizeBladeUVs(geom, { plySideUVs = false, zHalf = 0.003 } = {}) {
  const pos = geom.getAttribute('position');
  const norm = geom.getAttribute('normal');
  const uv = geom.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nz = Math.abs(norm.getZ(i));
    if (plySideUVs && nz < 0.55) {
      // Side wall of 5-ply wood core: u around perimeter angle, v across Z plies [0..1]
      const ang = (Math.atan2(y, x) / (2 * Math.PI)) + 0.5;
      const vPly = clamp01((z + zHalf) / (2 * zHalf));
      uv.setXY(i, ang * 3.0, vPly);
    } else {
      // Flat face of blade: u in [0..1] across width, v in [0..1] from top (+0.081) to bottom (-0.081)
      const u = clamp01((x + 0.078) / 0.156);
      const v = clamp01((0.081 - y) / 0.162);
      uv.setXY(i, u, v);
    }
  }
  uv.needsUpdate = true;
}

function createRubberTexturePair() {
  // Generates crisp 256x256 forehand crimson red (#c6201c) and backhand charcoal (#1c1e22)
  // baseColor maps plus a SHARED hexagonal micro-pimple normal & velvety metallicRoughness map!
  const W = 256;
  const H = 256;
  const heightMap = new Float32Array(W * H);

  // Hexagonal micro-pimple dimple pattern (authentic inverted table tennis rubber texture)
  const cols = 42;
  const rows = 48;

  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const idx = y * W + x;

      const fy = v * rows;
      const rowIdx = Math.floor(fy);
      const fx = u * cols + (rowIdx % 2) * 0.5;
      const cellX = fx - Math.floor(fx) - 0.5;
      const cellY = fy - Math.floor(fy) - 0.5;
      const r = Math.hypot(cellX, cellY);

      // Soft rounded circular micro-pimple bump
      const pimple = 1.0 - smoothstep(0.18, 0.44, r);
      const fineVelvet = fbmTileable(u, v, 32, 2, 4101);
      heightMap[idx] = clamp01(0.32 + pimple * 0.48 + (fineVelvet - 0.5) * 0.12);
    }
  }

  function makeRubberBaseColor(isRed) {
    const baseR = isRed ? 198 : 28; // #c6201c crimson red vs #1c1e22 charcoal black
    const baseG = isRed ? 32 : 30;
    const baseB = isRed ? 28 : 34;

    return createPixelTexture(
      W,
      H,
      (out) => {
        for (let y = 0; y < H; y++) {
          const v = (y + 0.5) / H;
          for (let x = 0; x < W; x++) {
            const u = (x + 0.5) / W;
            const idx = y * W + x;
            const p = idx * 4;

            const h = heightMap[idx];
            const patina = fbmTileable(u, v, 6, 3, isRed ? 4303 : 4404);
            // Subtle sweet-spot chalk/grip variation near blade center (u=0.5, v=0.45)
            const sweetDist = Math.hypot((u - 0.5) * 1.1, v - 0.44);
            const sweetGlow = (1.0 - smoothstep(0.08, 0.42, sweetDist)) * 0.05;

            const shade = lerp(0.92, 1.07, h) * lerp(0.96, 1.04, patina) + sweetGlow;

            // Subtle minimalist tournament bottom-edge stamp bar near throat (v = 0.81..0.86)
            let stamp = 0;
            if (v > 0.815 && v < 0.855 && Math.abs(u - 0.5) < 0.14) {
              const boxEdge =
                Math.abs(v - 0.835) > 0.015 || Math.abs(Math.abs(u - 0.5) - 0.132) < 0.007;
              const innerTicks =
                Math.abs(v - 0.835) < 0.007 && Math.floor((u - 0.36) * 90) % 3 === 0;
              if (boxEdge || innerTicks) stamp = 0.28;
            }

            let r = baseR * shade;
            let g = baseG * shade;
            let b = baseB * shade;

            if (stamp > 0) {
              r = lerp(r, isRed ? 236 : 92, stamp);
              g = lerp(g, isRed ? 210 : 98, stamp);
              b = lerp(b, isRed ? 196 : 104, stamp);
            }

            out[p] = Math.round(clamp01(r / 255) * 255);
            out[p + 1] = Math.round(clamp01(g / 255) * 255);
            out[p + 2] = Math.round(clamp01(b / 255) * 255);
            out[p + 3] = 255;
          }
        }
      },
      { wrapS: CLAMP, wrapT: CLAMP }
    );
  }

  const sharedMetallicRoughness = createPixelTexture(
    W,
    H,
    (out) => {
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          const idx = y * W + x;
          const p = idx * 4;

          const h = heightMap[idx];
          const wear = fbmTileable(u, v, 8, 3, 4505);
          // Velvety matte grippy table tennis rubber (~0.62 roughness)
          const rough = clamp01(0.65 - (h - 0.5) * 0.14 + (wear - 0.5) * 0.07);

          out[p] = 0;
          out[p + 1] = Math.round(rough * 255);
          out[p + 2] = Math.round(0.02 * 255);
          out[p + 3] = 255;
        }
      }
    },
    { wrapS: CLAMP, wrapT: CLAMP }
  );

  const sharedNormal = heightMapToNormalTexture(W, H, heightMap, 1.35, {
    wrapS: CLAMP,
    wrapT: CLAMP,
  });

  return {
    red: {
      baseColor: makeRubberBaseColor(true),
      metallicRoughness: sharedMetallicRoughness,
      normal: sharedNormal,
    },
    black: {
      baseColor: makeRubberBaseColor(false),
      metallicRoughness: sharedMetallicRoughness,
      normal: sharedNormal,
    },
  };
}

function createWoodPlyTextures() {
  // 5-ply laminated wood/carbon edge texture (v runs across Z thickness 0..1)
  const W = 256;
  const H = 256;
  const heightMap = new Float32Array(W * H);

  const baseColor = createPixelTexture(W, H, (out) => {
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H; // 0..1 across blade thickness
      // 5-ply structure: Outer Limba | Dark Carbon | Ayous Core | Dark Carbon | Outer Limba
      const dCenter = Math.abs(v - 0.5);
      const isCarbon = dCenter > 0.25 && dCenter < 0.33;
      const isCore = dCenter <= 0.25;

      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const idx = y * W + x;
        const p = idx * 4;
        const grain = fbmTileable(u * 4.0, v * 0.8, 12, 3, 5101);

        let r, g, b;
        if (isCarbon) {
          const weave = 0.85 + 0.25 * Math.sin(u * Math.PI * 80);
          r = 34 * weave;
          g = 38 * weave;
          b = 42 * weave;
          heightMap[idx] = 0.42;
        } else if (isCore) {
          const s = 0.90 + grain * 0.22;
          r = 212 * s;
          g = 172 * s;
          b = 122 * s;
          heightMap[idx] = 0.52 + (grain - 0.5) * 0.14;
        } else {
          const s = 0.88 + grain * 0.24;
          r = 186 * s;
          g = 136 * s;
          b = 86 * s;
          heightMap[idx] = 0.56 + (grain - 0.5) * 0.16;
        }

        out[p] = Math.round(clamp01(r / 255) * 255);
        out[p + 1] = Math.round(clamp01(g / 255) * 255);
        out[p + 2] = Math.round(clamp01(b / 255) * 255);
        out[p + 3] = 255;
      }
    }
  });

  const metallicRoughness = createPixelTexture(W, H, (out) => {
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      const dCenter = Math.abs(v - 0.5);
      const isCarbon = dCenter > 0.25 && dCenter < 0.33;
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        out[p] = 0;
        out[p + 1] = Math.round((isCarbon ? 0.35 : 0.54) * 255);
        out[p + 2] = Math.round((isCarbon ? 0.25 : 0.02) * 255);
        out[p + 3] = 255;
      }
    }
  });

  const normal = heightMapToNormalTexture(W, H, heightMap, 1.0);
  return { baseColor, metallicRoughness, normal };
}

function createHandleWoodTextures() {
  // Laminated ergonomic wood handle texture with natural longitudinal grain + dark/amber racing stripes
  // u = circumference angle [0..1] (0.0/1.0 = +X side, 0.25 = +Z front, 0.5 = -X side, 0.75 = -Z back)
  // v = along handle length [0..1] (0 = throat y=-0.072, 1 = butt y=-0.178)
  const W = 256;
  const H = 256;
  const heightMap = new Float32Array(W * H);

  const baseColor = createPixelTexture(
    W,
    H,
    (out) => {
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          const idx = y * W + x;
          const p = idx * 4;

          // Distance from front (+Z, u=0.25) and back (-Z, u=0.75) centerlines
          const dFront = Math.min(Math.abs(u - 0.25), Math.abs(u - 0.75));
          // Distance from ±X side tang seam (u=0, 0.5, 1.0)
          const dSide = Math.min(u, Math.abs(u - 0.5), 1.0 - u);

          // Natural longitudinal wood grain
          const ringNoise = fbmTileable(u * 2.0, v * 0.35, 8, 4, 6101);
          const pore = fbmTileable(u * 6.0, v * 0.5, 16, 2, 6202);
          const ringWave = Math.sin((u * 14 + ringNoise * 3.8) * Math.PI) * 0.5 + 0.5;
          const grainShade = lerp(0.84, 1.14, ringWave * 0.65 + pore * 0.35);

          // Warm cedar-walnut base wood
          let r = 148 * grainShade;
          let g = 100 * grainShade;
          let b = 60 * grainShade;
          let h = 0.5 + (pore - 0.5) * 0.22;

          // Center dark charcoal-ebony racing stripe + dual bright amber-gold accent pinstripes
          const inDarkStripe = 1.0 - smoothstep(0.036, 0.044, dFront);
          const inAmberStripe =
            smoothstep(0.042, 0.049, dFront) * (1.0 - smoothstep(0.068, 0.075, dFront));
          const inOuterDarkPin =
            smoothstep(0.074, 0.079, dFront) * (1.0 - smoothstep(0.088, 0.094, dFront));

          if (inDarkStripe > 0.001) {
            r = lerp(r, 30 * grainShade, inDarkStripe);
            g = lerp(g, 33 * grainShade, inDarkStripe);
            b = lerp(b, 36 * grainShade, inDarkStripe);
            h -= inDarkStripe * 0.04;
          }
          if (inAmberStripe > 0.001) {
            r = lerp(r, 214 * grainShade, inAmberStripe);
            g = lerp(g, 138 * grainShade, inAmberStripe);
            b = lerp(b, 44 * grainShade, inAmberStripe);
            h += inAmberStripe * 0.03;
          }
          if (inOuterDarkPin > 0.001) {
            r = lerp(r, 36 * grainShade, inOuterDarkPin);
            g = lerp(g, 38 * grainShade, inOuterDarkPin);
            b = lerp(b, 42 * grainShade, inOuterDarkPin);
          }

          // Visible laminated blade tang running down ±X sides of the handle
          const inTang = 1.0 - smoothstep(0.038, 0.048, dSide);
          if (inTang > 0.001) {
            const tangCenter = 1.0 - smoothstep(0.014, 0.022, dSide);
            const tr = lerp(196, 168, tangCenter) * grainShade;
            const tg = lerp(152, 124, tangCenter) * grainShade;
            const tb = lerp(102, 82, tangCenter) * grainShade;
            r = lerp(r, tr, inTang);
            g = lerp(g, tg, inTang);
            b = lerp(b, tb, inTang);
          }

          // Slightly darker oiled finish right at throat collar
          const throatFade = 1.0 - smoothstep(0.0, 0.07, v);
          r *= 1.0 - throatFade * 0.2;
          g *= 1.0 - throatFade * 0.2;
          b *= 1.0 - throatFade * 0.2;

          out[p] = Math.round(clamp01(r / 255) * 255);
          out[p + 1] = Math.round(clamp01(g / 255) * 255);
          out[p + 2] = Math.round(clamp01(b / 255) * 255);
          out[p + 3] = 255;
          heightMap[idx] = clamp01(h);
        }
      }
    },
    { wrapS: REPEAT, wrapT: CLAMP }
  );

  const metallicRoughness = createPixelTexture(
    W,
    H,
    (out) => {
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          const idx = y * W + x;
          const p = idx * 4;
          const pore = fbmTileable(u * 4.0, v * 0.5, 16, 2, 6202);
          // Hand-rubbed satin wood finish (0.38..0.52)
          const rough = clamp01(0.42 + (pore - 0.5) * 0.14);
          out[p] = 0;
          out[p + 1] = Math.round(rough * 255);
          out[p + 2] = Math.round(0.02 * 255);
          out[p + 3] = 255;
        }
      }
    },
    { wrapS: REPEAT, wrapT: CLAMP }
  );

  const normal = heightMapToNormalTexture(W, H, heightMap, 1.1, {
    wrapS: REPEAT,
    wrapT: CLAMP,
  });

  return { baseColor, metallicRoughness, normal };
}

/**
 * Sculpted ergonomic Flared (FL) wooden handle BufferGeometry
 * running along -Y from y = -0.072m to y = -0.178m.
 */
function buildFlaredHandleGeometry() {
  const yStart = -0.072;
  const yEnd = -0.178;
  const length = yStart - yEnd; // 0.106m
  const rings = 30;
  const radialSegs = 32;

  const verts = [];
  const uvs = [];
  const indices = [];

  // Cross-section super-ellipse exponent (0.86 gives realistic flattened palm sides + soft corners)
  const superPow = 0.86;
  const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

  function sampleProfile(t) {
    // t in [0..1] from throat (y=-0.072) to butt endcap (y=-0.178)
    // Width (2*rx): 26mm at throat -> slight 25mm pinch -> 35mm flared butt
    // Depth (2*rz): 21mm at throat -> 21.8mm mid -> 24mm butt
    let rx, rz;
    if (t < 0.06) {
      // Smooth chamfered throat entry blending into blade tang
      const k = t / 0.06;
      const ease = Math.sin(k * Math.PI * 0.5);
      rx = lerp(0.0112, 0.0130, ease);
      rz = lerp(0.0042, 0.0105, ease);
    } else if (t <= 0.91) {
      const s = (t - 0.06) / 0.85; // 0..1 along grip body
      // Subtle concave ergonomic waist around s=0.22, smooth flare toward butt
      const waistDip = -0.0008 * Math.sin(clamp01(s * 2.2) * Math.PI);
      const flare = Math.pow(s, 2.05);
      rx = 0.0130 + waistDip + flare * (0.0175 - 0.0130);
      rz = 0.0105 + Math.pow(s, 1.35) * (0.0120 - 0.0105);
    } else {
      // Rounded butt endcap from t=0.91 to t=1.0 (closing cleanly at y = -0.178)
      const c = (t - 0.91) / 0.09; // 0..1
      const scale = Math.sqrt(Math.max(0.0004, 1.0 - c * c * 0.985));
      rx = 0.0175 * scale;
      rz = 0.0120 * scale;
    }
    return { rx, rz };
  }

  for (let iy = 0; iy <= rings; iy++) {
    const t = iy / rings;
    const y = yStart - t * length;
    const { rx, rz } = sampleProfile(t);

    for (let ir = 0; ir <= radialSegs; ir++) {
      const u = ir / radialSegs;
      const ang = u * Math.PI * 2;
      const x = spow(Math.cos(ang), superPow) * rx;
      const z = spow(Math.sin(ang), superPow) * rz;
      verts.push(x, y, z);
      uvs.push(u, t);
    }
  }

  const stride = radialSegs + 1;
  for (let iy = 0; iy < rings; iy++) {
    for (let ir = 0; ir < radialSegs; ir++) {
      const a = iy * stride + ir;
      const b = a + 1;
      const c = (iy + 1) * stride + ir;
      const d = c + 1;
      // Note: ang increases from +X toward +Z (right-hand around -Y),
      // while y decreases from iy to iy+1; verify outward winding:
      // At ang=0 (+X), a=(+rx, y0, 0), b=(+rx, y0, +dz), c=(+rx, y1, 0) where y1 < y0.
      // (b - a) = (0, 0, +dz), (c - a) = (0, -dy, 0).
      // Cross((c-a), (b-a)) = (0,-dy,0) x (0,0,+dz) = (-dy*dz, 0, 0) -> inward!
      // Cross((b-a), (c-a)) = (0,0,+dz) x (0,-dy,0) = (+dy*dz, 0, 0) -> OUTWARD (+X)!
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  // Close tiny flat cap at butt center (y = -0.178) so mesh is watertight
  const bottomCenterIdx = verts.length / 3;
  verts.push(0, yEnd, 0);
  uvs.push(0.5, 1.0);
  const lastRingStart = rings * stride;
  for (let ir = 0; ir < radialSegs; ir++) {
    // Outward normal is -Y: looking from -Y, (a -> b) goes clockwise, so (center, b, a) -> check:
    // a=(+r, y, 0), b=(+r, y, +dz), center=(0, y, 0).
    // (a-c) x (b-c) = (+r, 0, 0) x (+r, 0, +dz) = (0, -r*dz, 0) -> OUTWARD (-Y)!
    indices.push(bottomCenterIdx, lastRingStart + ir, lastRingStart + ir + 1);
  }

  // Close top throat cap (y = -0.072) so mesh is watertight
  const topCenterIdx = verts.length / 3;
  verts.push(0, yStart, 0);
  uvs.push(0.5, 0.0);
  for (let ir = 0; ir < radialSegs; ir++) {
    // Outward normal is +Y: (b-c) x (a-c) = (0, +r*dz, 0)
    indices.push(topCenterIdx, ir + 1, ir);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/**
 * Build subtle black edge tape wrapping cleanly around the top arc of the blade perimeter.
 */
function buildBladeEdgeTapeGeometry(bladeShape) {
  const pts = bladeShape.getSpacedPoints(80);
  // Keep points along the upper ~240° arc (y >= -0.048)
  const arcPts = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.y >= -0.048) {
      arcPts.push(p);
    }
  }
  // Ensure points are ordered continuously along the arc from left shoulder over top to right shoulder
  arcPts.sort((a, b) => Math.atan2(a.y, -a.x) - Math.atan2(b.y, -b.x));

  const halfThickZ = 0.0056; // wraps wood core + sponge layers neatly
  const tapeOutset = 0.00075; // sits cleanly just outside wood edge
  const verts = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < arcPts.length; i++) {
    const p = arcPts[i];
    const prev = arcPts[Math.max(0, i - 1)];
    const next = arcPts[Math.min(arcPts.length - 1, i + 1)];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    // Outward 2D normal (left-hand perpendicular of clockwise arc from left->top->right)
    let nx = -ty;
    let ny = tx;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    // Verify outward from (0, 0)
    if (nx * p.x + ny * p.y < 0) {
      nx = -nx;
      ny = -ny;
    }

    const ox = p.x + nx * tapeOutset;
    const oy = p.y + ny * tapeOutset;
    const u = i / (arcPts.length - 1);

    // Outer face pair (+Z, -Z)
    verts.push(ox, oy, halfThickZ);
    uvs.push(u, 0);
    verts.push(ox, oy, -halfThickZ);
    uvs.push(u, 1);
  }

  for (let i = 0; i < arcPts.length - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = (i + 1) * 2;
    const d = c + 1;
    // Check outward normal at top apex (0, +0.081):
    // arc moves +X (a->c is +X), a->b is -Z.
    // (c-a) x (b-a) = (+X) x (-Z) = +Y -> OUTWARD!
    indices.push(a, c, b);
    indices.push(b, c, d);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

export function buildPaddle() {
  const root = new THREE.Group();
  root.name = 'PaddleRoot';

  // --- Materials ---
  const woodPlyMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'BladeWoodCoreMat',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(0.7, 0.7),
    }),
    createWoodPlyTextures()
  );

  const rubberTexPair = createRubberTexturePair();

  const redRubberMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'ForehandRedRubberMat',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(0.85, 0.85),
    }),
    rubberTexPair.red
  );

  const blackRubberMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'BackhandBlackRubberMat',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(0.85, 0.85),
    }),
    rubberTexPair.black
  );

  const redSpongeMat = new THREE.MeshStandardMaterial({
    name: 'ForehandSpongeMat',
    color: 0xd98a3c, // authentic pro tensor amber-cream sponge
    roughness: 0.86,
    metalness: 0.0,
  });

  const blackSpongeMat = new THREE.MeshStandardMaterial({
    name: 'BackhandSpongeMat',
    color: 0x263240, // pro high-density blue-charcoal sponge
    roughness: 0.86,
    metalness: 0.0,
  });

  const edgeTapeMat = new THREE.MeshStandardMaterial({
    name: 'BladeEdgeTapeMat',
    color: 0x16191d,
    roughness: 0.72,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });

  const handleWoodMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'HandleWoodMat',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(0.75, 0.75),
    }),
    createHandleWoodTextures()
  );

  const badgeMetalMat = new THREE.MeshStandardMaterial({
    name: 'HandleBadgeMetalMat',
    color: 0x9aa6b2,
    roughness: 0.22,
    metalness: 0.92,
  });

  const badgeAccentMat = new THREE.MeshStandardMaterial({
    name: 'HandleBadgeEmeraldMat',
    color: 0x105e3a,
    roughness: 0.26,
    metalness: 0.45,
  });

  // --- 1. 5-Ply Laminated Wood/Carbon Core (`BladeWoodCore`) ---
  // Target exact thickness = 0.006m (z = -0.003 to +0.003), outer dims 0.156m x 0.162m
  const coreBevel = 0.0005;
  const coreShape = createBladeShape(coreBevel, null);
  const coreGeom = new THREE.ExtrudeGeometry(coreShape, {
    depth: 0.006 - coreBevel * 2, // 0.005
    bevelEnabled: true,
    bevelThickness: coreBevel,
    bevelSize: coreBevel,
    bevelSegments: 2,
    curveSegments: 20,
  });
  coreGeom.translate(0, 0, -(0.006 - coreBevel * 2) * 0.5);
  normalizeBladeUVs(coreGeom, { plySideUVs: true, zHalf: 0.003 });

  const bladeCore = new THREE.Mesh(coreGeom, woodPlyMat);
  bladeCore.name = 'BladeWoodCore';
  root.add(bladeCore);

  // Subtle black edge tape along the upper arc of the blade perimeter
  const fullProfileShape = createBladeShape(0.0, null);
  const edgeTape = new THREE.Mesh(buildBladeEdgeTapeGeometry(fullProfileShape), edgeTapeMat);
  edgeTape.name = 'BladeEdgeTape';
  bladeCore.add(edgeTape);

  // --- 2. Forehand Red Rubber (`BladeRed`, facing +Z to z = +0.0075m) ---
  // Sponge sub-layer (z = +0.0029 to +0.0046)
  const spongeShape = createBladeShape(0.0010, -0.064);
  const spongeGeom = new THREE.ExtrudeGeometry(spongeShape, {
    depth: 0.0017,
    bevelEnabled: false,
    curveSegments: 18,
  });

  const redSpongeGeom = spongeGeom.clone();
  redSpongeGeom.translate(0, 0, 0.0029);
  const redSponge = new THREE.Mesh(redSpongeGeom, redSpongeMat);
  redSponge.name = 'BladeRedSponge';

  // Red topsheet: z = +0.0044 to EXACT +0.0075m (inset ~0.6mm from core edge)
  const rubberBevel = 0.0009;
  const rubberShape = createBladeShape(0.0006 + rubberBevel, -0.064);
  const rubberDepth = 0.0031 - rubberBevel * 2; // 0.0013
  const redGeom = new THREE.ExtrudeGeometry(rubberShape, {
    depth: rubberDepth,
    bevelEnabled: true,
    bevelThickness: rubberBevel,
    bevelSize: rubberBevel,
    bevelSegments: 2,
    curveSegments: 20,
  });
  // Spans z = -rubberBevel to rubberDepth + rubberBevel; translate so max z = +0.0075
  redGeom.translate(0, 0, 0.0075 - (rubberDepth + rubberBevel));
  normalizeBladeUVs(redGeom);

  const bladeRed = new THREE.Mesh(redGeom, redRubberMat);
  bladeRed.name = 'BladeRed';
  bladeRed.add(redSponge);
  root.add(bladeRed);

  // --- 3. Backhand Black Rubber (`BladeBlack`, facing -Z to z = -0.0075m) ---
  const blackSpongeGeom = spongeGeom.clone();
  blackSpongeGeom.translate(0, 0, -0.0046);
  const blackSponge = new THREE.Mesh(blackSpongeGeom, blackSpongeMat);
  blackSponge.name = 'BladeBlackSponge';

  const blackGeom = new THREE.ExtrudeGeometry(rubberShape, {
    depth: rubberDepth,
    bevelEnabled: true,
    bevelThickness: rubberBevel,
    bevelSize: rubberBevel,
    bevelSegments: 2,
    curveSegments: 20,
  });
  // Translate so min z = -0.0075
  blackGeom.translate(0, 0, -0.0075 + rubberBevel);
  normalizeBladeUVs(blackGeom);

  const bladeBlack = new THREE.Mesh(blackGeom, blackRubberMat);
  bladeBlack.name = 'BladeBlack';
  bladeBlack.add(blackSponge);
  root.add(bladeBlack);

  // --- 4. Contoured Flared Ergonomic Handle (`Handle`, y = -0.072m to -0.178m) ---
  const handleGeom = buildFlaredHandleGeometry();
  const handle = new THREE.Mesh(handleGeom, handleWoodMat);
  handle.name = 'Handle';
  root.add(handle);

  // Metallic brand badge inlay recessed flush at base butt endcap (y_min = -0.1780)
  const buttBezel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0095, 0.0085, 0.0020, 18),
    badgeMetalMat
  );
  buttBezel.name = 'HandleButtBadge';
  buttBezel.scale.set(1.25, 1.0, 0.78); // sleek oval medallion matching flared butt
  buttBezel.position.set(0, -0.1769, 0);
  handle.add(buttBezel);

  const buttCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0068, 0.0068, 0.0022, 16),
    badgeAccentMat
  );
  buttCore.scale.set(1.25, 1.0, 0.78);
  buttCore.position.set(0, -0.1769, 0);
  handle.add(buttCore);

  // Small inset metallic pro-lens badge on lower +Z face of handle
  const lensBezel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0062, 0.0062, 0.0018, 16),
    badgeMetalMat
  );
  lensBezel.name = 'HandleFrontBadge';
  lensBezel.rotation.x = Math.PI * 0.5;
  lensBezel.scale.set(1.0, 1.0, 1.55); // vertical oval lens
  lensBezel.position.set(0, -0.150, 0.0114);
  handle.add(lensBezel);

  const lensCore = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0044, 0.0044, 0.0022, 14),
    badgeAccentMat
  );
  lensCore.rotation.x = Math.PI * 0.5;
  lensCore.scale.set(1.0, 1.0, 1.55);
  lensCore.position.set(0, -0.150, 0.0115);
  handle.add(lensCore);

  const outputPath = path.join(MODELS_DIR, 'paddle.glb');
  return exportSceneToGLB(root, outputPath);
}

// ===========================================================================
// 3. TABLE TENNIS BALL (`public/models/ball.glb`)
// ===========================================================================

/**
 * Signed distance to a 5-pointed star centered at (0,0) with outer radius R.
 * Negative inside the star, positive outside.
 */
function sdStar5(px, py, R) {
  const r = Math.hypot(px, py);
  const ang = Math.atan2(py, px) + Math.PI * 0.5;
  const sector = (2 * Math.PI) / 5;
  const a = ((((ang % sector) + sector) % sector) - sector * 0.5);
  const absA = Math.abs(a);
  // Star edge runs from tip (0, R) to inner valley (sector/2, R * 0.40)
  const innerR = R * 0.40;
  const x1 = 0;
  const y1 = R;
  const x2 = Math.sin(sector * 0.5) * innerR;
  const y2 = Math.cos(sector * 0.5) * innerR;
  const qx = Math.sin(absA) * r;
  const qy = Math.cos(absA) * r;
  // Perpendicular outward normal of segment (x1,y1)->(x2,y2)
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  return (qx - x1) * nx + (qy - y1) * ny;
}

function createBallTextures() {
  // 512x256 equirectangular texture -> 2:1 natural sphere aspect ratio!
  // Uses exact 3D unit-sphere polar projection onto opposite poles (+Y and -Y) so
  // the dark-emerald & charcoal 3-star / Matrix-ring emblem is 100% distortion-free!
  const W = 512;
  const H = 256;
  const heightMap = new Float32Array(W * H);
  const inkMask = new Float32Array(W * H);

  const baseColor = createPixelTexture(
    W,
    H,
    (out) => {
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H; // glTF v=0 -> -Y pole, v=1 -> +Y pole
        const theta = (1.0 - v) * Math.PI; // 0 at +Y, PI at -Y
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);

        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          const phi = u * Math.PI * 2;
          const idx = y * W + x;
          const p = idx * 4;

          // Unit sphere direction
          const sx = -Math.cos(phi) * sinT;
          const sy = cosT;
          const sz = Math.sin(phi) * sinT;

          // Subtle matte celluloid micro-grain
          const micro = (hash2D(x, y, 7101) - 0.5) * 0.025 +
            (fbmTileable(u, v, 16, 2, 7202) - 0.5) * 0.03;

          // Matte off-white celluloid (#f2efe8 -> 242, 239, 232)
          let r = 242 * (1.0 + micro);
          let g = 239 * (1.0 + micro);
          let b = 232 * (1.0 + micro);
          let h = 0.5 + micro * 1.4;

          // Faint equatorial seam line (sy = 0)
          const eqDist = Math.abs(sy);
          const seam = 1.0 - smoothstep(0.004, 0.016, eqDist);
          if (seam > 0.001) {
            r = lerp(r, 214, seam * 0.72);
            g = lerp(g, 209, seam * 0.72);
            b = lerp(b, 198, seam * 0.72);
            h += seam * 0.14;
          }

          // Subtle opposite equatorial alignment ticks at (±X, 0, 0) so even pure Y-spin reads clearly
          const eqTickDist = Math.hypot(Math.abs(sx) - 1.0, sy, sz);
          const eqTick = 1.0 - smoothstep(0.06, 0.085, eqTickDist);
          let emeraldAmt = 0;
          let charcoalAmt = 0;

          if (eqTick > 0.001 && Math.abs(sy) < 0.028) {
            emeraldAmt = Math.max(emeraldAmt, eqTick * 0.85);
          }

          // Opposite-pole Matrix-ring & 3-star emblem (projected distortion-free onto +Y and -Y poles)
          const absY = Math.abs(sy);
          if (absY > 0.72) {
            // Angular distance from nearest pole in radians (0 at pole, ~0.76 at cutoff)
            const rad = Math.acos(Math.min(1.0, absY));
            const ang = Math.atan2(sz, sx);
            // 2D tangent-plane coordinates around the pole
            const px = rad * Math.cos(ang);
            const py = rad * Math.sin(ang);

            // 1) Outer segmented charcoal Matrix ring (r = 0.42..0.475 rad)
            const outerRing =
              smoothstep(0.412, 0.424, rad) * (1.0 - smoothstep(0.468, 0.480, rad));
            // 4 sleek digital gaps in outer ring
            const notchMod = Math.abs(Math.sin(ang * 2.0));
            const outerSeg = outerRing * smoothstep(0.10, 0.18, notchMod);
            charcoalAmt = Math.max(charcoalAmt, outerSeg);

            // 2) Inner crisp dark-emerald Matrix ring (r = 0.32..0.365 rad)
            const innerRing =
              smoothstep(0.314, 0.324, rad) * (1.0 - smoothstep(0.360, 0.370, rad));
            emeraldAmt = Math.max(emeraldAmt, innerRing);

            // 3) Crisp 3-Star triad arranged in an upper arc inside the ring (clearly breaks rotational symmetry!)
            const starAngles = [-0.58, 0.0, 0.58];
            for (let sIdx = 0; sIdx < 3; sIdx++) {
              const sa = starAngles[sIdx] + Math.PI * 0.5;
              const sr = 0.185;
              const scx = Math.cos(sa) * sr;
              const scy = Math.sin(sa) * sr;
              const starR = sIdx === 1 ? 0.072 : 0.058;
              const dStar = sdStar5(px - scx, py - scy, starR);
              const starMask = 1.0 - smoothstep(-0.008, 0.008, dStar);
              if (sIdx === 1) {
                emeraldAmt = Math.max(emeraldAmt, starMask);
              } else {
                charcoalAmt = Math.max(charcoalAmt, starMask);
              }
            }

            // 4) Minimalist Matrix-Sentinel geometric eye/bar emblem in lower half of disc
            const eyeD = Math.hypot(px * 0.72, (py + 0.105) * 1.35);
            const eyeRing =
              smoothstep(0.068, 0.078, eyeD) * (1.0 - smoothstep(0.104, 0.114, eyeD));
            const eyeCore = 1.0 - smoothstep(0.032, 0.042, Math.hypot(px, py + 0.105));
            charcoalAmt = Math.max(charcoalAmt, eyeRing);
            emeraldAmt = Math.max(emeraldAmt, eyeCore);

            // Horizontal tech dash bars flanking center
            if (Math.abs(py + 0.01) < 0.015 && Math.abs(px) > 0.08 && Math.abs(px) < 0.25) {
              charcoalAmt = Math.max(charcoalAmt, 0.9);
            }
          }

          // Composite dark charcoal (#1d2422) and dark Matrix emerald (#0e6b43) ink
          const totalInk = clamp01(Math.max(charcoalAmt, emeraldAmt));
          inkMask[idx] = totalInk;

          if (charcoalAmt > 0.001) {
            r = lerp(r, 29, charcoalAmt);
            g = lerp(g, 36, charcoalAmt);
            b = lerp(b, 34, charcoalAmt);
          }
          if (emeraldAmt > 0.001) {
            r = lerp(r, 14, emeraldAmt);
            g = lerp(g, 114, emeraldAmt);
            b = lerp(b, 70, emeraldAmt);
          }

          out[p] = Math.round(clamp01(r / 255) * 255);
          out[p + 1] = Math.round(clamp01(g / 255) * 255);
          out[p + 2] = Math.round(clamp01(b / 255) * 255);
          out[p + 3] = 255;
          heightMap[idx] = clamp01(h);
        }
      }
    },
    { wrapS: REPEAT, wrapT: CLAMP }
  );

  const metallicRoughness = createPixelTexture(
    W,
    H,
    (out) => {
      for (let y = 0; y < H; y++) {
        const v = (y + 0.5) / H;
        const seam = 1.0 - smoothstep(0.003, 0.012, Math.abs(v - 0.5));
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          const idx = y * W + x;
          const p = idx * 4;
          const grain = fbmTileable(u, v, 24, 2, 7303);
          const ink = inkMask[idx];
          // Matte celluloid ~0.45 roughness, slightly smoother ink (~0.34), slightly rougher seam (~0.56)
          let rough = 0.45 + (grain - 0.5) * 0.08;
          rough = lerp(rough, 0.34, ink);
          rough = lerp(rough, 0.56, seam);

          out[p] = 0;
          out[p + 1] = Math.round(clamp01(rough) * 255);
          out[p + 2] = Math.round(0.01 * 255);
          out[p + 3] = 255;
        }
      }
    },
    { wrapS: REPEAT, wrapT: CLAMP }
  );

  const normal = heightMapToNormalTexture(W, H, heightMap, 0.9, {
    wrapS: REPEAT,
    wrapT: CLAMP,
  });

  return { baseColor, metallicRoughness, normal };
}

export function buildBall() {
  const root = new THREE.Group();
  root.name = 'BallRoot';

  const ballMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'CelluloidBallMat',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(0.45, 0.45),
    }),
    createBallTextures()
  );

  // High-poly smooth sphere (radius = 0.025m, 32x24 segments)
  const sphereGeom = new THREE.SphereGeometry(0.025, 32, 24);
  const ballSphere = new THREE.Mesh(sphereGeom, ballMat);
  ballSphere.name = 'BallSphere';
  root.add(ballSphere);

  const outputPath = path.join(MODELS_DIR, 'ball.glb');
  return exportSceneToGLB(root, outputPath);
}

// ===========================================================================
// Build All 3 Gameplay Props
// ===========================================================================
export function buildAllProps() {
  const t0 = performance.now();
  const tableRes = buildTable();
  const paddleRes = buildPaddle();
  const ballRes = buildBall();
  const elapsedMs = (performance.now() - t0).toFixed(0);

  console.log(`Built 3 gameplay prop GLB models in ${elapsedMs} ms:`);
  for (const res of [tableRes, paddleRes, ballRes]) {
    console.log(
      `  - ${path.basename(res.outputPath)}: ${(res.byteLength / 1024).toFixed(1)} KB | ` +
        `${res.nodeCount} nodes | ${res.meshCount} meshes | ${res.materialCount} mats | ${res.textureCount} textures`
    );
  }
  return [tableRes, paddleRes, ballRes];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAllProps();
}
