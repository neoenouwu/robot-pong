/**
 * Procedural 3D Model Generator: Stage 2 Matrix Machine Cityscape Expansion
 * Outputs: public/models/cityscape_expansion.glb
 *
 * Constructs the colossal expanding cyberpunk Machine City megastructure framing
 * and towering beyond the Stage 1 indoor server cathedral (`arena_structure.glb`):
 *
 *   CRITICAL SPATIAL CONTRACT (100% Unobstructed Stage 1 Keep-Out Volume):
 *     NO vertex, triangle, or mesh AABB intersects:
 *       x in [-9.0, +9.0], z in [-14.0, +6.0], y in [-0.5, 11.8]
 *
 * Architectural Assemblies under root Group `CityscapeRoot`:
 *   1. `CityTowers`  — 4 distinct multi-tiered cyberpunk skyscraper archetypes
 *      flanking left (x = -12..-34m), right (x = +12..+34m), and rear skyline
 *      (z = -18..-54m, x = -28..+28m), stepping 22m..44m tall down to y = -6m,
 *      preserving a dramatic central vertical vista channel (x in [-5.5, +5.5]
 *      open to z = -34m, culminated by colossal stepped monolith towers at
 *      z = -38..-54m). Features chamfered armor shafts, external exo-buttress
 *      ribs, cantilevered utility pods, antenna crowns, vertical recessed
 *      glowing emerald Matrix server-window light bands, and warm amber lower
 *      industrial light ledges.
 *   2. `SkyBridges`  — Multi-level open steel cross-truss skybridges, elevated
 *      pipe viaducts, and mega-gantries spanning across the canyon at
 *      z = -17.5m, -26.5m, -36.0m, -45.0m at y = 7.5m, 13.5m, 19.5m, 26.0m
 *      (plus lateral side-canyon bridges outside |x| > 11m), with haunched
 *      under-arches, under-slung cable trays, and warm amber edge warning beacons.
 *   3. `MegaCables`  — Colossal sweeping catenary TubeGeometry power arteries,
 *      multi-strand cable bundles, diagonal power conduits, and flanged steel
 *      clamp collars arcing across the upper chasm (y = 12.5..28.5m,
 *      z = -14.5..-42m).
 *   4. `CityAbyss`   — Terraced lower industrial canyon sub-decks, gantry
 *      ledges, cooling exhaust stacks, and warm amber/orange industrial work-bay
 *      light rows outside the Stage 1 floor (z = -15..-56m and |x| > 10.5m,
 *      stepped from y = -0.3m down to y = -5.5m).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  exportSceneToGLB,
  createPixelTexture,
  heightMapToNormalTexture,
  attachPBRTextures,
  fbmTileable,
  hash2D,
} from './glb-builder.mjs';
import { inspectGLB } from './verify-models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, '../public/models/cityscape_expansion.glb');

// Stage 1 keep-out volume (strictly enforced for every vertex, triangle, and mesh AABB)
const KEEP_OUT_BOX = new THREE.Box3(
  new THREE.Vector3(-9.0, -0.5, -14.0),
  new THREE.Vector3(9.0, 11.8, 6.0)
);

// Open central vertical vista corridor down to z = -34m for CityTowers
const VISTA_CHANNEL_BOX = new THREE.Box3(
  new THREE.Vector3(-5.5, 0.0, -34.0),
  new THREE.Vector3(5.5, 46.0, 0.0)
);

// ---------------------------------------------------------------------------
// 1. Deterministic Math & Geometry Helpers
// ---------------------------------------------------------------------------
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function prepGeom(rawGeom, uvScaleU = 1, uvScaleV = 1) {
  const g = rawGeom.clone();
  if (!g.getAttribute('normal')) {
    g.computeVertexNormals();
  }
  const pos = g.getAttribute('position');
  if (!g.getAttribute('uv')) {
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = pos.getX(i) * 0.25 + pos.getZ(i) * 0.25;
      uvs[i * 2 + 1] = pos.getY(i) * 0.25;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  if (uvScaleU !== 1 || uvScaleV !== 1) {
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * uvScaleU, uv.getY(i) * uvScaleV);
    }
    uv.needsUpdate = true;
  }
  for (const attrName of Object.keys(g.attributes)) {
    if (attrName !== 'position' && attrName !== 'normal' && attrName !== 'uv') {
      g.deleteAttribute(attrName);
    }
  }
  if (!g.getIndex()) {
    const count = pos.count;
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

/**
 * Merge geometries cleanly and weld identical (position, normal, uv) vertices
 * to eliminate unindexed ExtrudeGeometry bloat while preserving 100% of hard edges.
 */
function mergeSafe(geoms) {
  if (!geoms || geoms.length === 0) {
    throw new Error('mergeSafe called with empty geometry array');
  }
  const prepped = geoms.map((g) => prepGeom(g));
  const merged = mergeGeometries(prepped, false);
  for (const g of prepped) g.dispose();
  if (!merged) {
    throw new Error('mergeGeometries failed: incompatible geometry attributes');
  }
  const welded = mergeVertices(merged, 1e-4);
  merged.dispose();
  return welded;
}

function placeGeom(geom, pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], uvScale = [1, 1]) {
  const g = prepGeom(geom, uvScale[0], uvScale[1]);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
  m.compose(
    new THREE.Vector3(pos[0], pos[1], pos[2]),
    q,
    new THREE.Vector3(scale[0], scale[1], scale[2])
  );
  g.applyMatrix4(m);
  return g;
}

function addBox(list, size, pos, rot = [0, 0, 0], uvScale = [1, 1]) {
  const raw = new THREE.BoxGeometry(size[0], size[1], size[2]);
  list.push(placeGeom(raw, pos, rot, [1, 1, 1], uvScale));
  raw.dispose();
}

function addCyl(list, rTop, rBot, h, segs, pos, rot = [0, 0, 0], uvScale = [1, 1]) {
  const raw = new THREE.CylinderGeometry(rTop, rBot, h, segs, 1, false);
  list.push(placeGeom(raw, pos, rot, [1, 1, 1], uvScale));
  raw.dispose();
}

function makeStrut(a, b, widthOrR, depthOrNull = null, radialSegs = 6, uvScale = [1, 1]) {
  const va = new THREE.Vector3(a[0], a[1], a[2]);
  const vb = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = new THREE.Vector3().subVectors(vb, va);
  const len = dir.length();
  if (len < 1e-5) {
    throw new Error(`Zero-length strut between ${a} and ${b}`);
  }
  const mid = new THREE.Vector3().addVectors(va, vb).multiplyScalar(0.5);
  const raw =
    depthOrNull !== null
      ? new THREE.BoxGeometry(widthOrR, len, depthOrNull)
      : new THREE.CylinderGeometry(widthOrR, widthOrR, len, radialSegs, 1, false);
  const g = prepGeom(raw, uvScale[0], uvScale[1] * Math.max(0.4, len * 0.25));
  raw.dispose();
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize()
  );
  const mat = new THREE.Matrix4().compose(mid, quat, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(mat);
  return g;
}

/**
 * Chamfered rectangular prism extruded vertically from y = y0 to y = y0 + height.
 */
function makeChamferedShaft(width, depth, chamfer, height, y0 = 0, uvScale = [0.22, 0.22]) {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const c = Math.min(chamfer, hw * 0.45, hd * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-hw + c, -hd);
  shape.lineTo(hw - c, -hd);
  shape.lineTo(hw, -hd + c);
  shape.lineTo(hw, hd - c);
  shape.lineTo(hw - c, hd);
  shape.lineTo(-hw + c, hd);
  shape.lineTo(-hw, hd - c);
  shape.lineTo(-hw, -hd + c);
  shape.closePath();

  const raw = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1,
  });
  raw.rotateX(-Math.PI / 2);
  raw.translate(0, y0, 0);
  const g = prepGeom(raw, uvScale[0], uvScale[1]);
  raw.dispose();
  return g;
}

/**
 * Compact crisp wide-flange I-beam along +Y from y = 0 to length (built from 3
 * sharp-edged flange/web sections so vertex count stays ultra-lean).
 */
function makeIBeamY(width, depth, flangeThick, webThick, length) {
  const parts = [];
  const halfD = depth * 0.5;
  const cy = length * 0.5;
  addBox(parts, [width, length, flangeThick], [0, cy, halfD - flangeThick * 0.5], [0, 0, 0], [0.3, length * 0.14]);
  addBox(parts, [width, length, flangeThick], [0, cy, -halfD + flangeThick * 0.5], [0, 0, 0], [0.3, length * 0.14]);
  addBox(parts, [webThick, length, depth - flangeThick * 2], [0, cy, 0], [0, 0, 0], [0.3, length * 0.14]);
  return mergeSafe(parts);
}

/**
 * Tapered structural buttress fin extruded along Z thickness.
 * Extends in +X from x = 0..baseOut and +Y from y = 0..height.
 */
function makeButtressFin(baseOut, topOut, height, thickness) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(baseOut, 0);
  shape.lineTo(baseOut, height * 0.16);
  shape.lineTo(topOut, height);
  shape.lineTo(0, height);
  shape.closePath();

  const raw = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  raw.translate(0, 0, -thickness * 0.5);
  const g = prepGeom(raw, 0.35, 0.35);
  raw.dispose();
  return g;
}

/**
 * Flanged octagonal industrial condenser collar/drum via LatheGeometry.
 */
function makeCondenserRing(innerR, outerR, height, sides = 8) {
  const pts = [
    new THREE.Vector2(innerR, 0),
    new THREE.Vector2(outerR * 0.94, 0),
    new THREE.Vector2(outerR, height * 0.16),
    new THREE.Vector2(outerR, height * 0.84),
    new THREE.Vector2(outerR * 0.94, height),
    new THREE.Vector2(innerR, height),
  ];
  const raw = new THREE.LatheGeometry(pts, sides);
  const g = prepGeom(raw, 1.5, 0.8);
  raw.dispose();
  return g;
}

// ---------------------------------------------------------------------------
// 2. Procedural PBR Textures (256x256 megastructure steel & Matrix windows,
//    plus compact 128x128 warm amber work-bays & armored cable sheathing)
// ---------------------------------------------------------------------------

/**
 * Texture Set 1 (256x256): Dark industrial megastructure steel cladding
 * Vertical fluted skyscraper ribs, horizontal floor deck seam ledges, rivets,
 * rain streaks, and weathered metallic highlights.
 */
function buildMegaSteelTextures() {
  const W = 256;
  const H = 256;
  const heightMap = new Float32Array(W * H);
  const grimeMap = new Float32Array(W * H);
  const wearMap = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const idx = y * W + x;

      const nMacro = fbmTileable(u, v, 4, 4, 1409);
      const nFine = fbmTileable(u, v, 16, 3, 1523);
      const rainStreak = fbmTileable(u * 4.0, v * 0.5, 8, 3, 1601);

      // 8 vertical fluted skyscraper cladding ribs across U
      const ribPhase = (u * 8) % 1;
      const ribDist = Math.min(ribPhase, 1 - ribPhase);
      const vGroove = 1.0 - smoothstep(0.02, 0.075, ribDist);
      const ribCrown = smoothstep(0.06, 0.14, ribDist) * (1.0 - smoothstep(0.32, 0.44, ribDist));

      // 4 horizontal floor-deck structural seam ledges across V
      const floorPhase = (v * 4) % 1;
      const hSeamDist = Math.min(floorPhase, 1 - floorPhase);
      const hGroove = 1.0 - smoothstep(0.015, 0.055, hSeamDist);
      const corniceLip =
        smoothstep(0.045, 0.085, floorPhase) * (1.0 - smoothstep(0.085, 0.16, floorPhase));

      // Recessed ventilation louvers in mid-story bands
      const louverBand =
        smoothstep(0.42, 0.46, floorPhase) * (1.0 - smoothstep(0.70, 0.74, floorPhase));
      const louverSlat = louverBand * (0.5 + 0.5 * Math.sin(v * 64 * Math.PI * 2));

      // Rivet rows along horizontal structural deck beams
      let rivet = 0;
      const rivetRowDist = Math.abs(floorPhase - 0.115);
      if (rivetRowDist < 0.025) {
        const ru = ((u * 32) % 1) - 0.5;
        const rv = (floorPhase - 0.115) * 8.0;
        const d = Math.hypot(ru, rv);
        if (d < 0.24) {
          rivet = Math.sqrt(Math.max(0, 1 - (d / 0.24) ** 2));
        }
      }

      const grime = clamp01(
        hGroove * 0.78 +
          vGroove * 0.52 +
          Math.max(0, rainStreak - 0.45) * 0.75 +
          Math.max(0, nMacro - 0.52) * 0.85
      );
      const wear = clamp01(
        corniceLip * 0.85 + ribCrown * 0.35 + rivet * 0.7 + Math.max(0, nFine - 0.65) * 0.6
      );

      let h = 0.52 + (nMacro - 0.5) * 0.07 + (nFine - 0.5) * 0.05;
      h += ribCrown * 0.14 + corniceLip * 0.16 + rivet * 0.22;
      h -= vGroove * 0.30 + hGroove * 0.38 + louverSlat * 0.08;
      heightMap[idx] = clamp01(h);
      grimeMap[idx] = grime;
      wearMap[idx] = wear;
    }
  }

  const baseColor = createPixelTexture(W, H, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const p = idx * 4;
        const n = fbmTileable(x / w, y / h, 6, 3, 1733);
        const g = grimeMap[idx];
        const wr = wearMap[idx];
        const hv = heightMap[idx];

        let r = lerp(24, 38, n);
        let gr = lerp(31, 48, n);
        let b = lerp(34, 52, n);

        r = lerp(r, 17, g * 0.68);
        gr = lerp(gr, 20, g * 0.65);
        b = lerp(b, 19, g * 0.72);

        r = lerp(r, 68, wr * 0.55);
        gr = lerp(gr, 84, wr * 0.58);
        b = lerp(b, 86, wr * 0.55);

        const ao = 0.42 + 0.58 * smoothstep(0.16, 0.48, hv);
        out[p] = Math.round(clamp01((r * ao) / 255) * 255);
        out[p + 1] = Math.round(clamp01((gr * ao) / 255) * 255);
        out[p + 2] = Math.round(clamp01((b * ao) / 255) * 255);
        out[p + 3] = 255;
      }
    }
  });

  const metallicRoughness = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const g = grimeMap[i];
      const wr = wearMap[i];
      const roughness = clamp01(0.46 + g * 0.34 - wr * 0.20);
      const metalness = clamp01(0.86 - g * 0.44 + wr * 0.12);
      out[p] = 255;
      out[p + 1] = Math.round(roughness * 255); // G = Roughness
      out[p + 2] = Math.round(metalness * 255); // B = Metalness
      out[p + 3] = 255;
    }
  });

  const normal = heightMapToNormalTexture(W, H, heightMap, 3.0);
  return { baseColor, metallicRoughness, normal };
}

/**
 * Texture Set 2 (256x256): Glowing emerald Matrix server-window facade
 * Crisp pixelated vertical code/server-rack light bands in vivid emerald #1aff7a
 * segmented by dark horizontal structural mullions and vertical dividers.
 */
function buildMatrixWindowTextures() {
  const W = 256;
  const H = 256;
  const COLS = 32;
  const ROWS = 64;

  const colIntensity = new Float32Array(COLS);
  const colPhase = new Float32Array(COLS);
  const colDensity = new Float32Array(COLS);
  for (let c = 0; c < COLS; c++) {
    const bandGroup = c % 8;
    const isMajorDivider = bandGroup === 0 || bandGroup === 7;
    const rnd = hash2D(c, 17, 2903);
    colIntensity[c] = isMajorDivider ? 0.15 : 0.48 + rnd * 0.52;
    colPhase[c] = hash2D(c, 53, 3011);
    colDensity[c] = 0.42 + hash2D(c, 91, 3109) * 0.48;
  }

  const baseColor = createPixelTexture(W, H, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const floorMod = y % 32;
      const isFloorBeam = floorMod < 4 || floorMod >= 30;
      for (let x = 0; x < w; x++) {
        const colMod = x % 32;
        const isMullion = colMod < 3 || colMod >= 30 || x % 8 === 0;
        const p = (y * w + x) * 4;
        if (isFloorBeam || isMullion) {
          out[p] = 10;
          out[p + 1] = 15;
          out[p + 2] = 14;
        } else {
          out[p] = 6;
          out[p + 1] = 30;
          out[p + 2] = 18;
        }
        out[p + 3] = 255;
      }
    }
  });

  const emissive = createPixelTexture(W, H, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const row = Math.floor(y / (h / ROWS));
      const inCellY = y % (h / ROWS);
      const floorMod = y % 32;
      const isMajorFloor = floorMod < 4 || floorMod === 31;
      const isSubTransom = floorMod === 16;

      for (let x = 0; x < w; x++) {
        const col = Math.floor(x / (w / COLS));
        const inCellX = x % (w / COLS);
        const colMod = x % 32;
        const isMajorCol = colMod < 3 || colMod === 31;
        const isSubMullion = inCellX === 0 || inCellX === 7;
        const p = (y * w + x) * 4;

        if (isMajorFloor || isMajorCol) {
          out[p] = 0;
          out[p + 1] = 0;
          out[p + 2] = 0;
          out[p + 3] = 255;
          continue;
        }

        const streamPos = (row / ROWS + colPhase[col]) % 1.0;
        const trailA = Math.pow(1.0 - ((streamPos * 2.0) % 1.0), 2.0);
        const trailB = Math.pow(1.0 - ((streamPos * 3.0 + 0.37) % 1.0), 2.6) * 0.76;
        const trail = Math.max(trailA, trailB);

        const cellRand = hash2D(col, row, 4219);
        const glyphPixel = hash2D(x >> 1, y >> 1, 5107);
        const cellLit = cellRand < colDensity[col] ? 1.0 : 0.22;

        const padX = isSubMullion ? 0.14 : 1.0;
        const padY = inCellY === 0 ? 0.28 : 1.0;
        const transomDim = isSubTransom ? 0.22 : 1.0;

        let lum =
          colIntensity[col] *
          (0.20 + 0.80 * trail) *
          cellLit *
          (0.58 + 0.42 * glyphPixel) *
          padX *
          padY *
          transomDim;

        const isHead = trail > 0.86 && cellRand < 0.52 && !isSubMullion && inCellY > 0;
        if (isHead) lum = Math.min(1.0, lum * 1.45 + 0.35);

        lum = clamp01(lum);
        const r = Math.round(clamp01(lum * 0.10 + (isHead ? 0.62 * lum : 0)) * 255);
        const g = Math.round(clamp01(Math.pow(lum, 0.84) * 1.0) * 255);
        const b = Math.round(clamp01(lum * 0.48 + (isHead ? 0.38 * lum : 0)) * 255);

        out[p] = r;
        out[p + 1] = g;
        out[p + 2] = b;
        out[p + 3] = 255;
      }
    }
  });

  return { baseColor, emissive };
}

/**
 * Texture Set 3 (128x128): Warm amber/orange industrial lower-tier work-bay windows
 */
function buildAmberBayTextures() {
  const W = 128;
  const H = 128;

  const baseColor = createPixelTexture(W, H, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const vy = y % 32;
      const isBarY = vy < 5 || vy >= 28;
      for (let x = 0; x < w; x++) {
        const vx = x % 16;
        const isBarX = vx < 3 || vx >= 14;
        const p = (y * w + x) * 4;
        if (isBarX || isBarY) {
          out[p] = 18;
          out[p + 1] = 16;
          out[p + 2] = 15;
        } else {
          out[p] = 88;
          out[p + 1] = 46;
          out[p + 2] = 18;
        }
        out[p + 3] = 255;
      }
    }
  });

  const emissive = createPixelTexture(W, H, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const bayRow = Math.floor(y / 32);
      const vy = y % 32;
      const isBarY = vy < 5 || vy >= 28;
      const vertGrad = 1.0 - Math.abs((vy - 16) / 13) * 0.42;
      for (let x = 0; x < w; x++) {
        const bayCol = Math.floor(x / 16);
        const vx = x % 16;
        const isBarX = vx < 3 || vx >= 14;
        const p = (y * w + x) * 4;

        if (isBarX || isBarY) {
          out[p] = 0;
          out[p + 1] = 0;
          out[p + 2] = 0;
          out[p + 3] = 255;
          continue;
        }

        const bayRnd = hash2D(bayCol, bayRow, 6199);
        const bayActive = bayRnd > 0.20 ? 0.50 + 0.50 * bayRnd : 0.12;
        const horizGrad = 1.0 - Math.abs((vx - 8.5) / 6.5) * 0.28;
        const lum = clamp01(bayActive * vertGrad * horizGrad);

        out[p] = Math.round(clamp01(lum * 1.0) * 255);
        out[p + 1] = Math.round(clamp01(lum * (0.48 + 0.24 * lum)) * 255);
        out[p + 2] = Math.round(clamp01(lum * (0.11 + 0.14 * lum * lum)) * 255);
        out[p + 3] = 255;
      }
    }
  });

  return { baseColor, emissive };
}

/**
 * Texture Set 4 (128x128): Corrugated armored mega-cable sheathing
 */
function buildMegaCableTextures() {
  const W = 128;
  const H = 128;
  const heightMap = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const ring = 0.5 + 0.5 * Math.sin(u * 28 * Math.PI * 2);
      const braid = 0.5 + 0.5 * Math.sin((u * 14 + v * 12) * Math.PI * 2);
      const n = fbmTileable(u, v, 8, 3, 7309);
      heightMap[y * W + x] = clamp01(0.32 + ring * 0.44 + braid * 0.12 + (n - 0.5) * 0.14);
    }
  }

  const baseColor = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const hv = heightMap[i];
      const shade = 0.55 + 0.45 * hv;
      out[p] = Math.round(24 * shade);
      out[p + 1] = Math.round(29 * shade);
      out[p + 2] = Math.round(31 * shade);
      out[p + 3] = 255;
    }
  });

  const metallicRoughness = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const hv = heightMap[i];
      out[p] = 255;
      out[p + 1] = Math.round(lerp(0.68, 0.34, hv) * 255); // G = Roughness
      out[p + 2] = Math.round(lerp(0.30, 0.72, hv) * 255); // B = Metalness
      out[p + 3] = 255;
    }
  });

  const normal = heightMapToNormalTexture(W, H, heightMap, 2.6);
  return { baseColor, metallicRoughness, normal };
}

function createCityMaterials() {
  const steelTex = buildMegaSteelTextures();
  const matrixTex = buildMatrixWindowTextures();
  const amberBayTex = buildAmberBayTextures();
  const cableTex = buildMegaCableTextures();

  const megaSteelMat = new THREE.MeshStandardMaterial({
    name: 'MegaSteelCladding',
    color: 0xffffff,
    roughness: 1.0,
    metalness: 1.0,
  });
  attachPBRTextures(megaSteelMat, steelTex);

  const darkFrameMat = new THREE.MeshStandardMaterial({
    name: 'DarkStructuralFrame',
    color: 0x6c7a82,
    roughness: 1.0,
    metalness: 1.0,
  });
  attachPBRTextures(darkFrameMat, steelTex);

  const abyssDeckMat = new THREE.MeshStandardMaterial({
    name: 'AbyssIndustrialDeck',
    color: 0x5c6a72,
    roughness: 1.0,
    metalness: 1.0,
  });
  attachPBRTextures(abyssDeckMat, steelTex);

  const matrixWindowMat = new THREE.MeshStandardMaterial({
    name: 'MatrixServerWindows',
    color: 0xffffff,
    roughness: 0.22,
    metalness: 0.65,
    emissive: 0xffffff,
    emissiveIntensity: 3.2,
  });
  attachPBRTextures(matrixWindowMat, matrixTex);

  const matrixWindowAltMat = new THREE.MeshStandardMaterial({
    name: 'MatrixServerWindowsAlt',
    color: 0xffffff,
    roughness: 0.24,
    metalness: 0.62,
    emissive: 0xd4ffea,
    emissiveIntensity: 2.85,
  });
  attachPBRTextures(matrixWindowAltMat, matrixTex);

  const amberBayMat = new THREE.MeshStandardMaterial({
    name: 'AmberIndustrialBays',
    color: 0xffffff,
    roughness: 0.28,
    metalness: 0.35,
    emissive: 0xffffff,
    emissiveIntensity: 3.6,
  });
  attachPBRTextures(amberBayMat, amberBayTex);

  const amberLedgeMat = new THREE.MeshStandardMaterial({
    name: 'AmberIndustrialLedge',
    color: 0xffb366,
    roughness: 0.24,
    metalness: 0.2,
    emissive: 0xff7b1c,
    emissiveIntensity: 4.0,
  });

  const amberBeaconMat = new THREE.MeshStandardMaterial({
    name: 'AmberWarningBeacon',
    color: 0xffc87a,
    roughness: 0.2,
    metalness: 0.15,
    emissive: 0xff8424,
    emissiveIntensity: 4.2,
  });

  const megaCableMat = new THREE.MeshStandardMaterial({
    name: 'MegaCableSheath',
    color: 0xffffff,
    roughness: 1.0,
    metalness: 1.0,
  });
  attachPBRTextures(megaCableMat, cableTex);

  return {
    megaSteelMat,
    darkFrameMat,
    abyssDeckMat,
    matrixWindowMat,
    matrixWindowAltMat,
    amberBayMat,
    amberLedgeMat,
    amberBeaconMat,
    megaCableMat,
  };
}

// ---------------------------------------------------------------------------
// 3. Skyscraper Archetype Builders (`CityTowers`)
//    Canonical local height ~33..35.4m, placed at world y = -6.0 and Y-scaled
//    so skyscraper silhouettes step dramatically from 22m up to 44m.
// ---------------------------------------------------------------------------

function instantiateArchetype(name, arch, mats, pos, scale = [1, 1, 1], yaw = 0, useAltMatrix = false) {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(pos[0], pos[1], pos[2]);
  g.rotation.y = yaw;
  g.scale.set(scale[0], scale[1], scale[2]);

  if (arch.steelGeo) {
    const m = new THREE.Mesh(arch.steelGeo, mats.megaSteelMat);
    m.name = `${name}_Steel`;
    g.add(m);
  }
  if (arch.frameGeo) {
    const m = new THREE.Mesh(arch.frameGeo, mats.darkFrameMat);
    m.name = `${name}_Frame`;
    g.add(m);
  }
  if (arch.matrixGeo) {
    const m = new THREE.Mesh(arch.matrixGeo, useAltMatrix ? mats.matrixWindowAltMat : mats.matrixWindowMat);
    m.name = `${name}_Matrix`;
    g.add(m);
  }
  if (arch.amberBayGeo) {
    const m = new THREE.Mesh(arch.amberBayGeo, mats.amberBayMat);
    m.name = `${name}_AmberBay`;
    g.add(m);
  }
  if (arch.amberLedgeGeo) {
    const m = new THREE.Mesh(arch.amberLedgeGeo, mats.amberLedgeMat);
    m.name = `${name}_AmberLedge`;
    g.add(m);
  }
  return g;
}

/**
 * Archetype A: CathedralServerSpire (Stepped Matrix Server Monolith)
 */
function buildArchetypeCathedralSpire() {
  const steel = [];
  const frame = [];
  const matrix = [];
  const amberBay = [];
  const amberLedge = [];

  steel.push(makeChamferedShaft(5.4, 5.4, 0.65, 7.6, 0.0, [0.22, 0.22]));
  steel.push(makeChamferedShaft(4.5, 4.5, 0.55, 14.6, 7.6, [0.22, 0.24]));
  steel.push(makeChamferedShaft(3.4, 3.4, 0.42, 6.4, 22.2, [0.22, 0.24]));
  steel.push(makeChamferedShaft(2.2, 2.2, 0.30, 1.8, 28.6, [0.25, 0.25]));

  // Heavy base buttress fins
  const finGeo = makeButtressFin(0.95, 0.25, 8.2, 0.42);
  for (let i = 0; i < 4; i++) {
    const ang = (i * Math.PI) / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (const offset of [-1.45, 1.45]) {
      frame.push(placeGeom(finGeo, [c * 2.4 - s * offset, 0.0, s * 2.4 + c * offset], [0, -ang, 0]));
    }
  }
  finGeo.dispose();

  // External vertical wide-flange I-beam exo-ribs
  const ribMain = makeIBeamY(0.36, 0.44, 0.08, 0.11, 21.8);
  const ribUpper = makeIBeamY(0.28, 0.34, 0.07, 0.09, 6.6);
  for (let side = 0; side < 4; side++) {
    const ang = (side * Math.PI) / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (const off of [-1.65, 0.0, 1.65]) {
      frame.push(placeGeom(ribMain, [c * 2.38 - s * off, 0.6, s * 2.38 + c * off], [0, -ang, 0]));
    }
    for (const off of [-1.15, 1.15]) {
      frame.push(placeGeom(ribUpper, [c * 1.82 - s * off, 22.0, s * 1.82 + c * off], [0, -ang, 0]));
    }
  }
  ribMain.dispose();
  ribUpper.dispose();

  // Horizontal structural collar rings & cornice ledges
  for (const [cy, w, h] of [
    [7.5, 5.9, 0.55],
    [12.2, 5.15, 0.42],
    [16.8, 5.15, 0.42],
    [22.1, 5.05, 0.56],
    [25.6, 3.95, 0.38],
    [28.5, 3.85, 0.48],
  ]) {
    frame.push(makeChamferedShaft(w, w, 0.55, h, cy, [0.3, 0.3]));
  }

  // Diagonal external X-braces across mid structural bands
  for (let side = 0; side < 4; side++) {
    const ang = (side * Math.PI) / 2;
    const tx = (lx, ly, lz) => [
      Math.cos(ang) * lx - Math.sin(ang) * lz,
      ly,
      Math.sin(ang) * lx + Math.cos(ang) * lz,
    ];
    for (const yBase of [7.9, 12.6, 17.2]) {
      frame.push(makeStrut(tx(2.42, yBase, -1.65), tx(2.42, yBase + 4.1, 0.0), 0.12, 0.12));
      frame.push(makeStrut(tx(2.42, yBase + 4.1, -1.65), tx(2.42, yBase, 0.0), 0.12, 0.12));
      frame.push(makeStrut(tx(2.42, yBase, 0.0), tx(2.42, yBase + 4.1, 1.65), 0.12, 0.12));
      frame.push(makeStrut(tx(2.42, yBase + 4.1, 0.0), tx(2.42, yBase, 1.65), 0.12, 0.12));
    }
  }

  // Cantilevered industrial utility pods + diagonal support struts + vertical coolant pipes
  for (let side = 0; side < 4; side++) {
    const ang = (side * Math.PI) / 2;
    const py = side % 2 === 0 ? 14.3 : 19.2;
    const cx = Math.cos(ang) * 2.68;
    const cz = Math.sin(ang) * 2.68;
    addBox(steel, [0.95, 2.2, 2.1], [cx, py, cz], [0, -ang, 0], [0.5, 0.6]);
    addBox(frame, [1.12, 0.24, 2.28], [cx, py + 1.18, cz], [0, -ang, 0], [0.5, 0.5]);
    const tx = (lx, ly, lz) => [
      Math.cos(ang) * lx - Math.sin(ang) * lz,
      ly,
      Math.sin(ang) * lx + Math.cos(ang) * lz,
    ];
    for (const off of [-0.75, 0.75]) {
      frame.push(makeStrut(tx(2.25, py - 2.0, off), tx(3.05, py - 1.05, off), 0.14, 0.14));
    }
    const pxPipe = Math.cos(ang) * 2.52 - Math.sin(ang) * 1.32;
    const pzPipe = Math.sin(ang) * 2.52 + Math.cos(ang) * 1.32;
    addCyl(frame, 0.13, 0.13, 19.5, 6, [pxPipe, 12.0, pzPipe], [0, 0, 0], [1, 3]);
  }

  // Recessed vertical glowing emerald Matrix data-window strips on all 4 faces
  for (let side = 0; side < 4; side++) {
    const ang = (side * Math.PI) / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    for (const off of [-0.82, 0.82]) {
      addBox(matrix, [0.09, 13.7, 1.24], [c * 2.28 - s * off, 15.05, s * 2.28 + c * off], [0, -ang, 0], [0.55, 2.6]);
    }
    addBox(matrix, [0.09, 5.5, 1.95], [c * 1.72, 25.55, s * 1.72], [0, -ang, 0], [0.75, 1.25]);
  }

  // Lower-tier warm amber industrial bay panels & horizontal warm light ledges
  for (let side = 0; side < 4; side++) {
    const ang = (side * Math.PI) / 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    addBox(amberBay, [0.10, 2.1, 3.6], [c * 2.72, 5.95, s * 2.72], [0, -ang, 0], [1.4, 0.65]);
    addBox(amberLedge, [0.16, 0.22, 4.4], [c * 2.86, 7.36, s * 2.86], [0, -ang, 0]);
    addBox(amberLedge, [0.14, 0.18, 3.5], [c * 2.52, 12.06, s * 2.52], [0, -ang, 0]);
  }

  // Rooftop industrial condenser collar + antenna crown
  const collar = makeCondenserRing(1.0, 1.58, 1.15, 8);
  frame.push(placeGeom(collar, [0, 29.2, 0]));
  collar.dispose();
  addCyl(frame, 0.08, 0.26, 3.8, 6, [0, 31.1, 0]);
  for (const [ax, az, ah] of [
    [-0.95, -0.95, 2.6],
    [0.95, -0.95, 2.1],
    [-0.95, 0.95, 2.1],
    [0.95, 0.95, 2.8],
  ]) {
    addCyl(frame, 0.05, 0.11, ah, 6, [ax, 29.4 + ah * 0.5, az]);
    addBox(amberLedge, [0.22, 0.22, 0.22], [ax, 29.45 + ah, az]);
  }
  addBox(amberLedge, [0.28, 0.28, 0.28], [0, 33.05, 0]);

  return {
    steelGeo: mergeSafe(steel),
    frameGeo: mergeSafe(frame),
    matrixGeo: mergeSafe(matrix),
    amberBayGeo: mergeSafe(amberBay),
    amberLedgeGeo: mergeSafe(amberLedge),
    maxHalfX: 3.35,
    maxHalfZ: 3.35,
  };
}

/**
 * Archetype B: TwinFinDataTower (Split-Blade Matrix Server Megatower)
 */
function buildArchetypeTwinFinTower() {
  const steel = [];
  const frame = [];
  const matrix = [];
  const amberBay = [];
  const amberLedge = [];

  steel.push(makeChamferedShaft(5.8, 4.8, 0.55, 7.2, 0.0, [0.22, 0.22]));

  for (const sx of [-1.72, 1.72]) {
    steel.push(placeGeom(makeChamferedShaft(1.95, 4.5, 0.32, 22.0, 7.2, [0.2, 0.25]), [sx, 0, 0]));
    steel.push(placeGeom(makeChamferedShaft(1.55, 3.4, 0.25, 2.4, 29.2, [0.2, 0.25]), [sx, 0, 0]));
  }

  // Central recessed Matrix server core glowing between the twin blades
  addBox(steel, [1.52, 20.6, 2.95], [0, 17.5, 0], [0, 0, 0], [0.2, 0.3]);
  addBox(matrix, [1.56, 20.4, 0.10], [0, 17.5, 1.54], [0, 0, 0], [0.7, 3.5]);
  addBox(matrix, [1.56, 20.4, 0.10], [0, 17.5, -1.54], [0, 0, 0], [0.7, 3.5]);

  for (const sx of [-1, 1]) {
    const faceX = sx * 2.72;
    addBox(matrix, [0.10, 19.6, 1.32], [faceX, 17.6, -1.05], [0, 0, 0], [0.5, 3.4]);
    addBox(matrix, [0.10, 19.6, 1.32], [faceX, 17.6, 1.05], [0, 0, 0], [0.5, 3.4]);
    for (const sz of [-1, 1]) {
      addBox(matrix, [0.85, 19.4, 0.10], [sx * 1.72, 17.6, sz * 2.28], [0, 0, 0], [0.35, 3.4]);
    }
  }

  // External vertical exo-ribs & triple coolant riser bundles
  const ribTall = makeIBeamY(0.32, 0.42, 0.08, 0.10, 22.8);
  for (const sx of [-1, 1]) {
    for (const zOff of [-1.95, 0.0, 1.95]) {
      frame.push(placeGeom(ribTall, [sx * 2.82, 6.8, zOff], [0, 0, 0]));
    }
    for (const sz of [-1, 1]) {
      frame.push(placeGeom(ribTall, [sx * 0.92, 6.8, sz * 2.34], [0, Math.PI / 2, 0]));
      frame.push(placeGeom(ribTall, [sx * 2.46, 6.8, sz * 2.34], [0, Math.PI / 2, 0]));
    }
    for (const pz of [-0.42, 0.0, 0.42]) {
      addCyl(frame, 0.11, 0.11, 23.0, 6, [sx * 3.04, 15.8, pz]);
    }
  }
  ribTall.dispose();

  // 5 Multi-level steel cross-gantry bridges spanning the central slot
  for (const gy of [9.6, 14.2, 18.8, 23.4, 27.8]) {
    for (const sz of [-1, 1]) {
      addBox(frame, [3.1, 0.36, 0.34], [0, gy, sz * 2.15], [0, 0, 0], [0.8, 0.3]);
      addBox(frame, [3.1, 0.24, 0.28], [0, gy + 1.15, sz * 2.15], [0, 0, 0], [0.8, 0.3]);
      frame.push(makeStrut([-1.1, gy, sz * 2.15], [0.0, gy + 1.15, sz * 2.15], 0.10, 0.10));
      frame.push(makeStrut([0.0, gy + 1.15, sz * 2.15], [1.1, gy, sz * 2.15], 0.10, 0.10));
    }
    addBox(frame, [2.9, 0.24, 4.35], [0, gy - 0.1, 0], [0, 0, 0], [0.7, 0.7]);
    if (gy < 19.0) {
      addBox(amberLedge, [1.85, 0.16, 0.14], [0, gy - 0.28, 2.24]);
      addBox(amberLedge, [1.85, 0.16, 0.14], [0, gy - 0.28, -2.24]);
    }
  }

  // Cantilevered industrial maintenance balconies with railings
  for (const by of [7.3, 15.2, 23.1]) {
    for (const sx of [-1, 1]) {
      addBox(frame, [0.72, 0.26, 4.7], [sx * 2.95, by, 0], [0, 0, 0], [0.4, 1.0]);
      addBox(frame, [0.08, 0.08, 4.65], [sx * 3.24, by + 0.85, 0]);
      for (const pz of [-2.1, -0.7, 0.7, 2.1]) {
        addBox(frame, [0.08, 0.85, 0.08], [sx * 3.24, by + 0.44, pz]);
        frame.push(makeStrut([sx * 2.65, by - 0.95, pz], [sx * 3.24, by - 0.1, pz], 0.10, 0.10));
      }
    }
  }

  // Lower podium warm amber industrial bays & work-light ledges
  for (const sz of [-1, 1]) {
    addBox(amberBay, [4.6, 2.2, 0.10], [0, 5.5, sz * 2.43], [0, 0, 0], [1.6, 0.7]);
    addBox(amberLedge, [5.4, 0.22, 0.16], [0, 7.12, sz * 2.52]);
  }
  for (const sx of [-1, 1]) {
    addBox(amberBay, [0.10, 2.2, 3.6], [sx * 2.93, 5.5, 0], [0, 0, 0], [1.3, 0.7]);
    addBox(amberLedge, [0.16, 0.22, 4.4], [sx * 3.02, 7.12, 0]);
  }

  // Asymmetric rooftop crane-gantry & comms mast crown
  addBox(frame, [4.6, 0.42, 1.2], [0, 31.5, 0], [0, 0, 0], [1.2, 0.3]);
  frame.push(makeStrut([-1.7, 31.6, 0], [0, 32.8, 0], 0.12, 0.12));
  frame.push(makeStrut([1.7, 31.6, 0], [0, 32.8, 0], 0.12, 0.12));
  addCyl(frame, 0.06, 0.16, 3.2, 6, [-1.6, 32.4, 0.7]);
  addCyl(frame, 0.06, 0.14, 2.5, 6, [1.6, 32.0, -0.7]);
  addBox(amberLedge, [0.26, 0.26, 0.26], [-1.6, 34.05, 0.7]);
  addBox(amberLedge, [0.24, 0.24, 0.24], [1.6, 33.3, -0.7]);

  return {
    steelGeo: mergeSafe(steel),
    frameGeo: mergeSafe(frame),
    matrixGeo: mergeSafe(matrix),
    amberBayGeo: mergeSafe(amberBay),
    amberLedgeGeo: mergeSafe(amberLedge),
    maxHalfX: 3.35,
    maxHalfZ: 2.65,
  };
}

/**
 * Archetype C: HexReactorCitadel (Octagonal Industrial Condenser Megapylon)
 */
function buildArchetypeReactorCitadel() {
  const steel = [];
  const frame = [];
  const matrix = [];
  const amberBay = [];
  const amberLedge = [];

  addCyl(steel, 2.75, 3.05, 7.6, 8, [0, 3.8, 0], [0, Math.PI / 8, 0], [2.4, 0.9]);
  addCyl(steel, 2.35, 2.48, 16.2, 8, [0, 15.7, 0], [0, Math.PI / 8, 0], [2.2, 2.1]);
  addCyl(steel, 1.75, 1.95, 5.8, 8, [0, 26.7, 0], [0, Math.PI / 8, 0], [1.8, 0.9]);

  // Stacked LatheGeometry octagonal condenser collars
  const ringWide = makeCondenserRing(2.2, 2.95, 1.35, 8);
  const ringMid = makeCondenserRing(1.9, 2.68, 1.10, 8);
  const ringTop = makeCondenserRing(1.3, 2.18, 1.05, 8);
  for (const yR of [7.2, 13.0, 18.8]) {
    frame.push(placeGeom(ringWide, [0, yR, 0], [0, Math.PI / 8, 0]));
  }
  for (const yR of [10.3, 16.1, 21.8]) {
    frame.push(placeGeom(ringMid, [0, yR, 0], [0, Math.PI / 8, 0]));
  }
  frame.push(placeGeom(ringTop, [0, 24.4, 0], [0, Math.PI / 8, 0]));
  frame.push(placeGeom(ringTop, [0, 28.6, 0], [0, Math.PI / 8, 0]));
  ringWide.dispose();
  ringMid.dispose();
  ringTop.dispose();

  // 4 Massive radial pylon fins & vertical conduit manifolds
  const pylonFin = makeButtressFin(1.15, 0.48, 24.0, 0.56);
  for (let i = 0; i < 4; i++) {
    const ang = (i * Math.PI) / 2 + Math.PI / 4;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    frame.push(placeGeom(pylonFin, [c * 2.05, 0.0, s * 2.05], [0, -ang, 0]));
    const px = c * 2.72;
    const pz = s * 2.72;
    addCyl(frame, 0.14, 0.14, 24.5, 6, [px - s * 0.42, 12.8, pz + c * 0.42]);
    addCyl(frame, 0.14, 0.14, 24.5, 6, [px + s * 0.42, 12.8, pz - c * 0.42]);
  }
  pylonFin.dispose();

  // 8 Tall vertical glowing emerald Matrix light-column bays
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const isCardinal = i % 2 === 0;
    const dist = isCardinal ? 2.38 : 2.34;
    const stripW = isCardinal ? 1.15 : 0.72;
    addBox(matrix, [0.10, 15.6, stripW], [c * dist, 15.8, s * dist], [0, -ang, 0], [0.45, 2.9]);
    if (isCardinal) {
      addBox(matrix, [0.10, 5.1, 0.92], [c * 1.84, 26.7, s * 1.84], [0, -ang, 0], [0.4, 1.1]);
    }
  }

  // Lower industrial work-gallery bays & warm amber ring ledges
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    addBox(amberBay, [0.10, 1.95, 1.55], [c * 2.86, 5.75, s * 2.86], [0, -ang, 0], [0.85, 0.65]);
    addBox(amberLedge, [0.16, 0.22, 1.85], [c * 2.98, 7.12, s * 2.98], [0, -ang, 0]);
    if (i % 2 === 0) {
      addBox(amberLedge, [0.15, 0.18, 1.65], [c * 2.75, 12.9, s * 2.75], [0, -ang, 0]);
    }
  }

  // Twin industrial exhaust stacks & transmission mast
  for (const sx of [-0.72, 0.72]) {
    addCyl(steel, 0.34, 0.44, 3.2, 8, [sx, 31.1, 0]);
    addCyl(frame, 0.44, 0.44, 0.25, 8, [sx, 32.6, 0]);
  }
  addCyl(frame, 0.06, 0.14, 3.8, 6, [0, 31.6, 0.85]);
  addBox(amberLedge, [0.26, 0.26, 0.26], [0, 33.55, 0.85]);

  return {
    steelGeo: mergeSafe(steel),
    frameGeo: mergeSafe(frame),
    matrixGeo: mergeSafe(matrix),
    amberBayGeo: mergeSafe(amberBay),
    amberLedgeGeo: mergeSafe(amberLedge),
    maxHalfX: 3.3,
    maxHalfZ: 3.3,
  };
}

/**
 * Archetype D: ColossalSteppedZiggurat (Rear Skyline Megastructure Monolith)
 */
function buildArchetypeSteppedZiggurat() {
  const steel = [];
  const frame = [];
  const matrix = [];
  const amberBay = [];
  const amberLedge = [];

  steel.push(makeChamferedShaft(7.6, 5.8, 0.75, 8.2, 0.0, [0.18, 0.20]));
  steel.push(makeChamferedShaft(6.2, 4.8, 0.62, 11.6, 8.2, [0.20, 0.22]));
  steel.push(makeChamferedShaft(4.4, 3.8, 0.48, 8.8, 19.8, [0.22, 0.24]));
  steel.push(makeChamferedShaft(2.8, 2.6, 0.32, 3.2, 28.6, [0.24, 0.24]));

  // Twin side shoulder towers rising along the flanks
  for (const sx of [-2.85, 2.85]) {
    steel.push(placeGeom(makeChamferedShaft(1.65, 3.8, 0.28, 13.8, 8.2, [0.22, 0.24]), [sx, 0, 0]));
    addCyl(frame, 0.06, 0.16, 3.0, 6, [sx, 23.5, 0]);
    addBox(amberLedge, [0.24, 0.24, 0.24], [sx, 25.05, 0]);
  }

  // Giant angled mega-buttresses
  const megaFin = makeButtressFin(1.15, 0.30, 11.5, 0.52);
  for (const sx of [-1, 1]) {
    frame.push(placeGeom(megaFin, [sx * 3.1, 0.0, -1.6], [0, sx > 0 ? 0 : Math.PI, 0]));
    frame.push(placeGeom(megaFin, [sx * 3.1, 0.0, 1.6], [0, sx > 0 ? 0 : Math.PI, 0]));
  }
  for (const sz of [-1, 1]) {
    for (const bx of [-2.4, 0.0, 2.4]) {
      frame.push(placeGeom(megaFin, [bx, 0.0, sz * 2.4], [0, sz > 0 ? -Math.PI / 2 : Math.PI / 2, 0]));
    }
  }
  megaFin.dispose();

  // External vertical exo-columns
  const ribMega = makeIBeamY(0.38, 0.48, 0.09, 0.12, 20.2);
  const ribTop = makeIBeamY(0.30, 0.38, 0.08, 0.10, 9.2);
  for (const sz of [-1, 1]) {
    for (const bx of [-2.35, -0.82, 0.82, 2.35]) {
      frame.push(placeGeom(ribMega, [bx, 8.0, sz * 2.52], [0, Math.PI / 2, 0]));
    }
    for (const bx of [-1.45, 0.0, 1.45]) {
      frame.push(placeGeom(ribTop, [bx, 19.6, sz * 2.02], [0, Math.PI / 2, 0]));
    }
  }
  ribMega.dispose();
  ribTop.dispose();

  // Terraced cornice collars & horizontal truss galleries
  for (const [cy, w, d, h] of [
    [8.1, 8.1, 6.2, 0.65],
    [14.2, 6.8, 5.2, 0.50],
    [19.7, 6.6, 5.1, 0.62],
    [24.2, 4.9, 4.2, 0.44],
    [28.5, 4.8, 4.1, 0.55],
  ]) {
    frame.push(makeChamferedShaft(w, d, 0.65, h, cy, [0.25, 0.25]));
  }

  for (const sz of [-1, 1]) {
    for (const gy of [9.0, 14.9]) {
      for (let i = -2; i < 2; i++) {
        const x0 = i * 1.4;
        const x1 = (i + 1) * 1.4;
        frame.push(makeStrut([x0, gy, sz * 2.58], [x1, gy + 4.4, sz * 2.58], 0.12, 0.12));
        frame.push(makeStrut([x0, gy + 4.4, sz * 2.58], [x1, gy, sz * 2.58], 0.12, 0.12));
      }
    }
  }

  // Triple towering vertical glowing emerald Matrix data-window curtains (starting low at y = 8.6!)
  for (const sz of [-1, 1]) {
    for (const bx of [-1.58, 0.0, 1.58]) {
      addBox(matrix, [1.26, 10.8, 0.10], [bx, 14.2, sz * 2.45], [0, 0, 0], [0.55, 2.3]);
    }
    for (const bx of [-0.74, 0.74]) {
      addBox(matrix, [1.14, 7.8, 0.10], [bx, 24.4, sz * 1.94], [0, 0, 0], [0.5, 1.7]);
    }
    addBox(matrix, [1.45, 2.7, 0.10], [0, 30.2, sz * 1.34], [0, 0, 0], [0.6, 0.7]);
  }
  for (const sx of [-1, 1]) {
    addBox(matrix, [0.10, 13.0, 2.25], [sx * 3.70, 15.2, 0], [0, 0, 0], [0.85, 2.6]);
    addBox(matrix, [0.10, 7.8, 2.15], [sx * 2.24, 24.4, 0], [0, 0, 0], [0.8, 1.6]);
  }

  // Dramatic warm amber industrial work-light rows framing lower & mid terraces
  for (const sz of [-1, 1]) {
    addBox(amberBay, [6.4, 2.6, 0.10], [0, 5.8, sz * 2.94], [0, 0, 0], [2.2, 0.8]);
    addBox(amberLedge, [7.3, 0.26, 0.18], [0, 7.95, sz * 3.04]);
    addBox(amberLedge, [5.8, 0.22, 0.16], [0, 14.05, sz * 2.62]);
    addBox(amberLedge, [4.2, 0.20, 0.16], [0, 19.55, sz * 2.58]);
  }
  for (const sx of [-1, 1]) {
    addBox(amberBay, [0.10, 2.6, 4.4], [sx * 3.84, 5.8, 0], [0, 0, 0], [1.6, 0.8]);
    addBox(amberLedge, [0.18, 0.26, 5.2], [sx * 3.94, 7.95, 0]);
  }

  // Multi-spire braced truss antenna crown
  for (const [cx, cz] of [
    [-0.9, -0.8],
    [0.9, -0.8],
    [-0.9, 0.8],
    [0.9, 0.8],
  ]) {
    frame.push(makeStrut([cx, 31.8, cz], [cx * 0.28, 34.4, cz * 0.28], 0.11, 0.11));
  }
  addCyl(frame, 0.06, 0.18, 3.6, 6, [0, 33.6, 0]);
  addBox(amberLedge, [0.32, 0.32, 0.32], [0, 35.45, 0]);

  return {
    steelGeo: mergeSafe(steel),
    frameGeo: mergeSafe(frame),
    matrixGeo: mergeSafe(matrix),
    amberBayGeo: mergeSafe(amberBay),
    amberLedgeGeo: mergeSafe(amberLedge),
    maxHalfX: 4.15,
    maxHalfZ: 3.35,
  };
}

function buildCityTowersGroup(mats) {
  const group = new THREE.Group();
  group.name = 'CityTowers';

  const archetypes = [
    buildArchetypeCathedralSpire(),
    buildArchetypeTwinFinTower(),
    buildArchetypeReactorCitadel(),
    buildArchetypeSteppedZiggurat(),
  ];

  const towerSpecs = [
    // --- LEFT CANYON FLANK (x in [-13.5..-33.5], z in [-5..-51]) ---
    { id: 'L_In_01', arch: 1, x: -13.8, z: -5.2, topY: 25.5, sx: 0.96, sz: 0.98, yaw: 0 },
    { id: 'L_In_02', arch: 0, x: -14.2, z: -13.2, topY: 29.5, sx: 1.02, sz: 1.02, yaw: Math.PI / 2 },
    { id: 'L_In_03', arch: 2, x: -13.9, z: -21.2, topY: 33.5, sx: 1.04, sz: 1.04, yaw: 0 },
    { id: 'L_In_04', arch: 1, x: -14.5, z: -29.4, topY: 36.5, sx: 1.08, sz: 1.10, yaw: Math.PI },
    { id: 'L_In_05', arch: 0, x: -15.0, z: -38.0, topY: 39.5, sx: 1.12, sz: 1.12, yaw: Math.PI / 2 },
    { id: 'L_In_06', arch: 3, x: -16.8, z: -47.5, topY: 42.0, sx: 1.06, sz: 1.08, yaw: 0 },

    { id: 'L_Mid_01', arch: 2, x: -21.8, z: -8.6, topY: 28.5, sx: 1.08, sz: 1.08, yaw: Math.PI / 2 },
    { id: 'L_Mid_02', arch: 1, x: -22.5, z: -17.4, topY: 34.0, sx: 1.12, sz: 1.12, yaw: 0 },
    { id: 'L_Mid_03', arch: 3, x: -23.5, z: -26.8, topY: 38.5, sx: 1.05, sz: 1.08, yaw: Math.PI / 2 },
    { id: 'L_Mid_04', arch: 0, x: -23.0, z: -36.5, topY: 41.0, sx: 1.16, sz: 1.16, yaw: Math.PI },
    { id: 'L_Mid_05', arch: 2, x: -25.0, z: -46.5, topY: 43.0, sx: 1.18, sz: 1.18, yaw: 0 },

    { id: 'L_Out_01', arch: 0, x: -30.5, z: -12.0, topY: 32.5, sx: 1.18, sz: 1.18, yaw: 0 },
    { id: 'L_Out_02', arch: 3, x: -31.8, z: -23.5, topY: 37.5, sx: 1.12, sz: 1.12, yaw: Math.PI / 2 },
    { id: 'L_Out_03', arch: 1, x: -31.5, z: -35.0, topY: 41.5, sx: 1.20, sz: 1.20, yaw: Math.PI },
    { id: 'L_Out_04', arch: 3, x: -32.0, z: -49.0, topY: 44.0, sx: 1.15, sz: 1.15, yaw: 0 },

    // --- RIGHT CANYON FLANK (x in [+13.5..+33.5], z in [-5..-51]) ---
    { id: 'R_In_01', arch: 0, x: 13.8, z: -5.0, topY: 24.5, sx: 0.96, sz: 0.96, yaw: Math.PI },
    { id: 'R_In_02', arch: 1, x: 14.1, z: -12.8, topY: 30.5, sx: 1.02, sz: 1.04, yaw: Math.PI },
    { id: 'R_In_03', arch: 0, x: 14.0, z: -20.8, topY: 32.5, sx: 1.05, sz: 1.05, yaw: -Math.PI / 2 },
    { id: 'R_In_04', arch: 2, x: 14.4, z: -29.0, topY: 37.0, sx: 1.08, sz: 1.08, yaw: 0 },
    { id: 'R_In_05', arch: 1, x: 14.8, z: -37.5, topY: 40.0, sx: 1.10, sz: 1.12, yaw: 0 },
    { id: 'R_In_06', arch: 3, x: 16.8, z: -47.0, topY: 42.5, sx: 1.06, sz: 1.08, yaw: Math.PI },

    { id: 'R_Mid_01', arch: 1, x: 21.8, z: -9.2, topY: 29.0, sx: 1.08, sz: 1.08, yaw: Math.PI },
    { id: 'R_Mid_02', arch: 2, x: 22.6, z: -18.0, topY: 35.0, sx: 1.12, sz: 1.12, yaw: 0 },
    { id: 'R_Mid_03', arch: 0, x: 23.0, z: -27.2, topY: 38.0, sx: 1.14, sz: 1.14, yaw: Math.PI / 2 },
    { id: 'R_Mid_04', arch: 3, x: 23.5, z: -36.8, topY: 41.5, sx: 1.08, sz: 1.08, yaw: -Math.PI / 2 },
    { id: 'R_Mid_05', arch: 0, x: 25.0, z: -46.8, topY: 43.2, sx: 1.18, sz: 1.18, yaw: 0 },

    { id: 'R_Out_01', arch: 2, x: 30.5, z: -11.8, topY: 33.0, sx: 1.18, sz: 1.18, yaw: 0 },
    { id: 'R_Out_02', arch: 1, x: 31.6, z: -23.0, topY: 38.0, sx: 1.20, sz: 1.20, yaw: Math.PI },
    { id: 'R_Out_03', arch: 3, x: 31.8, z: -34.5, topY: 41.8, sx: 1.14, sz: 1.14, yaw: -Math.PI / 2 },
    { id: 'R_Out_04', arch: 3, x: 32.0, z: -48.8, topY: 44.0, sx: 1.15, sz: 1.15, yaw: Math.PI },

    // --- REAR CANYON VISTA FRAMING TOWERS (central vista x in [-5.5..+5.5] open to z = -34m) ---
    { id: 'Rear_Flank_L1', arch: 1, x: -9.8, z: -20.5, topY: 28.0, sx: 0.96, sz: 0.96, yaw: 0 },
    { id: 'Rear_Flank_R1', arch: 0, x: 9.8, z: -20.8, topY: 29.0, sx: 0.96, sz: 0.96, yaw: Math.PI / 2 },
    { id: 'Rear_Flank_L2', arch: 2, x: -9.7, z: -28.8, topY: 33.5, sx: 1.00, sz: 1.00, yaw: 0 },
    { id: 'Rear_Flank_R2', arch: 1, x: 9.7, z: -28.5, topY: 34.5, sx: 1.00, sz: 1.00, yaw: Math.PI },

    // --- COLOSSAL STEPPED MONOLITH SKYLINE CULMINATING THE CENTRAL VISTA (z = -38..-53m) ---
    { id: 'Vista_Gate_L', arch: 3, x: -8.6, z: -39.8, topY: 40.5, sx: 1.02, sz: 1.02, yaw: 0 },
    { id: 'Vista_Gate_R', arch: 3, x: 8.6, z: -40.2, topY: 41.2, sx: 1.02, sz: 1.02, yaw: Math.PI },
    { id: 'Vista_Step_L', arch: 0, x: -5.4, z: -44.8, topY: 38.0, sx: 1.04, sz: 1.04, yaw: 0 },
    { id: 'Vista_Step_R', arch: 1, x: 5.5, z: -45.2, topY: 39.2, sx: 1.04, sz: 1.04, yaw: Math.PI },
    { id: 'Vista_Citadel_Center', arch: 3, x: 0.0, z: -51.5, topY: 44.0, sx: 1.24, sz: 1.18, yaw: 0 },
    { id: 'Rear_Horiz_L1', arch: 2, x: -11.5, z: -52.0, topY: 42.5, sx: 1.14, sz: 1.14, yaw: 0 },
    { id: 'Rear_Horiz_R1', arch: 2, x: 11.5, z: -52.0, topY: 42.8, sx: 1.14, sz: 1.14, yaw: Math.PI },
    { id: 'Rear_Horiz_L2', arch: 1, x: -22.0, z: -52.8, topY: 41.0, sx: 1.18, sz: 1.18, yaw: 0 },
    { id: 'Rear_Horiz_R2', arch: 0, x: 22.0, z: -52.8, topY: 41.5, sx: 1.18, sz: 1.18, yaw: Math.PI / 2 },
  ];

  const baseY = -6.0;
  for (let i = 0; i < towerSpecs.length; i++) {
    const t = towerSpecs[i];
    const arch = archetypes[t.arch];
    const canonicalH = t.arch === 3 ? 35.4 : t.arch === 1 ? 34.0 : 33.2;
    const sy = (t.topY - baseY) / canonicalH;
    const useAlt = i % 3 === 1;
    group.add(
      instantiateArchetype(
        `Tower_${t.id}`,
        arch,
        mats,
        [t.x, baseY, t.z],
        [t.sx, sy, t.sz],
        t.yaw,
        useAlt
      )
    );
  }

  return group;
}

// ---------------------------------------------------------------------------
// 4. Multi-Level Elevated Skybridges, Viaducts & Mega-Gantries (`SkyBridges`)
//    Pre-assembled multi-bay 18m & 12m span archetypes (keeps WebGL draw calls
//    super lean while preserving crisp 45-degree engineered truss geometry!).
// ---------------------------------------------------------------------------

/**
 * Multi-bay Open-Truss Steel Skybridge Span Archetype (length = bayCount * 6m)
 * Features bold wide-flange steel chords, monumental 3m Pratt X-bracing bays,
 * angled under-haunch arch brackets, under-slung cable trays + conduit pipes,
 * and hooded warm amber edge warning beacons.
 */
function buildTrussSpanArchetype(bayCount = 2) {
  const frame = [];
  const steel = [];
  const beacon = [];

  const bayLen = 6.0;
  const totalLen = bayCount * bayLen;
  const halfTot = totalLen * 0.5;
  const halfZ = 0.98;
  const trussH = 1.62;

  // Continuous ribbed steel floor deck & longitudinal wide chords
  addBox(steel, [totalLen, 0.24, 1.92], [0, 0.0, 0], [0, 0, 0], [bayCount * 1.6, 0.6]);
  for (const sz of [-1, 1]) {
    addBox(frame, [totalLen, 0.28, 0.24], [0, 0.04, sz * halfZ], [0, 0, 0], [bayCount * 1.8, 0.3]);
    addBox(frame, [totalLen, 0.26, 0.24], [0, trussH, sz * halfZ], [0, 0, 0], [bayCount * 1.8, 0.3]);
    addBox(frame, [totalLen, 0.09, 0.09], [0, 0.82, sz * (halfZ + 0.04)]);
  }

  // Continuous under-slung cable tray & twin heavy industrial conduit pipes
  addBox(steel, [totalLen, 0.16, 0.96], [0, -0.80, 0], [0, 0, 0], [bayCount * 1.4, 0.35]);
  for (const pz of [-0.26, 0.26]) {
    addCyl(frame, 0.11, 0.11, totalLen, 6, [0, -0.58, pz], [0, 0, Math.PI / 2]);
  }

  // Per-bay bold 3m truss panels, portal frames, and warm amber warning beacons
  for (let b = 0; b < bayCount; b++) {
    const cx = -halfTot + (b + 0.5) * bayLen;
    const xStart = cx - bayLen * 0.5;
    for (const sz of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const x0 = xStart + k * 3.0;
        const x1 = x0 + 3.0;
        frame.push(makeStrut([x0, 0.04, sz * halfZ], [x0, trussH, sz * halfZ], 0.15, 0.15));
        frame.push(makeStrut([x0, 0.04, sz * halfZ], [x1, trussH, sz * halfZ], 0.12, 0.12));
        frame.push(makeStrut([x0, trussH, sz * halfZ], [x1, 0.04, sz * halfZ], 0.12, 0.12));
      }
      // Hooded warm amber edge warning beacons
      for (const bx of [cx - 1.5, cx + 1.5]) {
        addBox(frame, [0.48, 0.13, 0.26], [bx, 0.28, sz * (halfZ + 0.17)]);
        addBox(beacon, [0.40, 0.19, 0.15], [bx, 0.13, sz * (halfZ + 0.19)]);
      }
    }

    // Overhead portals, under-joists, cable hangers & top X wind-bracing
    for (const xPos of [xStart, cx]) {
      addBox(frame, [0.20, 0.20, 2.12], [xPos, trussH, 0]);
      addBox(frame, [0.20, 0.26, 2.08], [xPos, -0.18, 0]);
      for (const sz of [-0.48, 0.48]) {
        frame.push(makeStrut([xPos, -0.18, sz], [xPos, -0.84, sz], 0.09, 0.09));
      }
    }
    frame.push(makeStrut([xStart, trussH, -halfZ], [cx, trussH, halfZ], 0.09, 0.09));
    frame.push(makeStrut([xStart, trussH, halfZ], [cx, trussH, -halfZ], 0.09, 0.09));
    frame.push(makeStrut([cx, trussH, -halfZ], [xStart + bayLen, trussH, halfZ], 0.09, 0.09));
    frame.push(makeStrut([cx, trussH, halfZ], [xStart + bayLen, trussH, -halfZ], 0.09, 0.09));
  }

  // Closing end verticals & monumental diagonal under-haunch arch brackets
  for (const sz of [-1, 1]) {
    frame.push(makeStrut([halfTot, 0.04, sz * halfZ], [halfTot, trussH, sz * halfZ], 0.16, 0.16));
    frame.push(makeStrut([-halfTot, -1.95, sz * halfZ], [-halfTot + 2.8, -0.12, sz * halfZ], 0.18, 0.18));
    frame.push(makeStrut([halfTot, -1.95, sz * halfZ], [halfTot - 2.8, -0.12, sz * halfZ], 0.18, 0.18));
  }
  addBox(frame, [0.20, 0.20, 2.12], [halfTot, trussH, 0]);
  addBox(frame, [0.20, 0.26, 2.08], [halfTot, -0.18, 0]);

  return {
    steelGeo: mergeSafe(steel),
    frameGeo: mergeSafe(frame),
    beaconGeo: mergeSafe(beacon),
    spanLen: totalLen,
  };
}

/**
 * Multi-bay Elevated Industrial Pipe Viaduct Span Archetype (length = bayCount * 6m)
 * Twin monumental pressurized steel pipelines cradled inside a heavy triangular
 * space-truss with upper maintenance catwalk and warm amber navigation beacons.
 */
function buildPipeViaductSpanArchetype(bayCount = 2) {
  const frame = [];
  const steel = [];
  const beacon = [];

  const bayLen = 6.0;
  const totalLen = bayCount * bayLen;
  const halfTot = totalLen * 0.5;

  // Continuous giant pressurized steel pipelines & keel beam
  for (const pz of [-0.58, 0.58]) {
    addCyl(steel, 0.44, 0.44, totalLen, 10, [0, 0.0, pz], [0, 0, Math.PI / 2], [1.0, bayCount * 1.6]);
  }
  addBox(frame, [totalLen, 0.28, 0.28], [0, -1.40, 0]);
  addBox(steel, [totalLen, 0.16, 1.50], [0, 0.76, 0], [0, 0, 0], [bayCount * 1.4, 0.5]);
  for (const sz of [-1, 1]) {
    addBox(frame, [totalLen, 0.09, 0.09], [0, 1.54, sz * 0.80]);
  }

  for (let b = 0; b < bayCount; b++) {
    const cx = -halfTot + (b + 0.5) * bayLen;
    const xStart = cx - bayLen * 0.5;
    for (let k = 0; k < 2; k++) {
      const xPos = xStart + k * 3.0;
      const xNext = xPos + 3.0;
      for (const pz of [-0.58, 0.58]) {
        addCyl(frame, 0.53, 0.53, 0.22, 10, [xPos, 0.0, pz], [0, 0, Math.PI / 2]);
      }
      addBox(frame, [0.26, 0.26, 2.32], [xPos, -0.58, 0]);
      addBox(frame, [0.24, 0.22, 2.24], [xPos, 0.65, 0]);
      for (const sz of [-1, 1]) {
        frame.push(makeStrut([xPos, 0.65, sz * 1.10], [xPos, -0.58, sz * 1.10], 0.14, 0.14));
        frame.push(makeStrut([xPos, -0.58, sz * 1.10], [xPos, -1.40, 0], 0.15, 0.15));
        frame.push(makeStrut([xPos, -0.58, sz * 1.10], [xNext, -1.40, 0], 0.11, 0.11));
        addBox(frame, [0.09, 0.82, 0.09], [xPos, 1.16, sz * 0.80]);
      }
    }
    // Warm amber side beacons along pipe cradle
    for (const sz of [-1, 1]) {
      addBox(frame, [0.50, 0.15, 0.24], [cx, -0.34, sz * 1.22]);
      addBox(beacon, [0.42, 0.20, 0.15], [cx, -0.49, sz * 1.24]);
    }
  }

  addBox(frame, [0.26, 0.26, 2.32], [halfTot, -0.58, 0]);
  addBox(frame, [0.24, 0.22, 2.24], [halfTot, 0.65, 0]);
  for (const sz of [-1, 1]) {
    frame.push(makeStrut([halfTot, 0.65, sz * 1.10], [halfTot, -0.58, sz * 1.10], 0.14, 0.14));
    frame.push(makeStrut([halfTot, -0.58, sz * 1.10], [halfTot, -1.40, 0], 0.15, 0.15));
  }

  return {
    steelGeo: mergeSafe(steel),
    frameGeo: mergeSafe(frame),
    beaconGeo: mergeSafe(beacon),
    spanLen: totalLen,
  };
}

function addBridgeSegments(parent, name, arch, mats, centerX, y, z, segmentCount, scaleX = 1.0) {
  const spanGroup = new THREE.Group();
  spanGroup.name = name;
  spanGroup.position.set(centerX, y, z);
  parent.add(spanGroup);

  const step = arch.spanLen * scaleX;
  const startX = -((segmentCount - 1) * step) * 0.5;
  for (let s = 0; s < segmentCount; s++) {
    const seg = new THREE.Group();
    seg.name = `${name}_Seg_${s}`;
    seg.position.set(startX + s * step, 0, 0);
    seg.scale.set(scaleX, 1, 1);

    const mSteel = new THREE.Mesh(arch.steelGeo, mats.megaSteelMat);
    mSteel.name = `${name}_Seg_${s}_Steel`;
    seg.add(mSteel);

    const mFrame = new THREE.Mesh(arch.frameGeo, mats.darkFrameMat);
    mFrame.name = `${name}_Seg_${s}_Frame`;
    seg.add(mFrame);

    const mBeacon = new THREE.Mesh(arch.beaconGeo, mats.amberBeaconMat);
    mBeacon.name = `${name}_Seg_${s}_Beacon`;
    seg.add(mBeacon);

    spanGroup.add(seg);
  }
}

function buildSkyBridgesGroup(mats) {
  const group = new THREE.Group();
  group.name = 'SkyBridges';

  // Only 2 shared 12m span archetypes -> ultra-compact GLB & low WebGL draw calls!
  const truss12 = buildTrussSpanArchetype(2);
  const viaduct12 = buildPipeViaductSpanArchetype(2);

  // Primary cross-canyon skybridges & elevated pipe viaducts (all strictly z <= -17.5m!)
  const crossSpans = [
    // z = -17.5m (36m total span = 3 x 12m)
    { name: 'Bridge_Z17_Low', arch: truss12, y: 7.5, z: -17.5, segs: 3, sx: 1.0 },
    { name: 'Bridge_Z17_Mid', arch: viaduct12, y: 13.5, z: -17.5, segs: 3, sx: 1.0 },

    // z = -26.5m (48m total span = 4 x 12m)
    { name: 'Bridge_Z26_Low', arch: viaduct12, y: 7.8, z: -26.5, segs: 4, sx: 1.0 },
    { name: 'Bridge_Z26_Mid', arch: truss12, y: 13.8, z: -26.5, segs: 4, sx: 1.0 },
    { name: 'Bridge_Z26_High', arch: truss12, y: 19.5, z: -26.5, segs: 4, sx: 1.0 },

    // z = -36.0m (54m total span = 4 x 13.5m)
    { name: 'Bridge_Z36_Low', arch: truss12, y: 8.4, z: -36.0, segs: 4, sx: 1.125 },
    { name: 'Bridge_Z36_Mid', arch: viaduct12, y: 14.2, z: -36.0, segs: 4, sx: 1.125 },
    { name: 'Bridge_Z36_High', arch: truss12, y: 20.0, z: -36.0, segs: 4, sx: 1.125 },
    { name: 'Bridge_Z36_Crown', arch: viaduct12, y: 26.0, z: -36.0, segs: 4, sx: 1.125 },

    // z = -45.0m (60m total span = 4 x 15m)
    { name: 'Bridge_Z45_Mid', arch: truss12, y: 13.5, z: -45.0, segs: 4, sx: 1.25 },
    { name: 'Bridge_Z45_High', arch: viaduct12, y: 19.8, z: -45.0, segs: 4, sx: 1.25 },
    { name: 'Bridge_Z45_Crown', arch: truss12, y: 26.4, z: -45.0, segs: 4, sx: 1.25 },
  ];

  for (const s of crossSpans) {
    addBridgeSegments(group, s.name, s.arch, mats, 0, s.y, s.z, s.segs, s.sx);
  }

  // Lateral flank bridges tying inner & mid skyscraper canyons (strictly |x| >= 12.2m!)
  const flankSpans = [
    { name: 'FlankBridge_L1_Low', arch: truss12, x: -18.4, y: 8.2, z: -10.0 },
    { name: 'FlankBridge_L1_High', arch: viaduct12, x: -18.4, y: 16.5, z: -10.0 },
    { name: 'FlankBridge_L2_Mid', arch: truss12, x: -18.6, y: 12.0, z: -22.5 },
    { name: 'FlankBridge_L2_Top', arch: viaduct12, x: -18.6, y: 22.5, z: -22.5 },
    { name: 'FlankBridge_R1_Low', arch: truss12, x: 18.4, y: 8.2, z: -10.0 },
    { name: 'FlankBridge_R1_High', arch: viaduct12, x: 18.4, y: 16.5, z: -10.0 },
    { name: 'FlankBridge_R2_Mid', arch: truss12, x: 18.6, y: 12.0, z: -22.5 },
    { name: 'FlankBridge_R2_Top', arch: viaduct12, x: 18.6, y: 22.5, z: -22.5 },
  ];

  for (const f of flankSpans) {
    addBridgeSegments(group, f.name, f.arch, mats, f.x, f.y, f.z, 1, 1.0);
  }

  return group;
}

// ---------------------------------------------------------------------------
// 5. Colossal Sweeping Overhead Power Arteries (`MegaCables`)
//    All points strictly within y in [12.5..28.5m] and z in [-14.5..-42m],
//    doubly clear of the Stage 1 keep-out box!
// ---------------------------------------------------------------------------

function buildCableBundleArchetype(span, sag, mainR, subCount, twistTurns, seed) {
  const cableParts = [];
  const clampParts = [];
  const steps = 16;

  const makeCatenaryPts = (yOff, zOff, sagMult, twistPhase) => {
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = t * 2 - 1;
      const x = u * (span * 0.5);
      const sagCurve = (1 - u * u) * sag * sagMult;
      const twistAng = t * Math.PI * 2 * twistTurns + twistPhase;
      const radialEnv = 0.25 + 0.75 * Math.sin(t * Math.PI);
      const y =
        -sagCurve +
        yOff * radialEnv +
        Math.sin(twistAng) * mainR * 1.15 * (twistPhase >= 0 ? 1 : 0);
      const z = zOff * radialEnv + Math.cos(twistAng) * mainR * 1.15 * (twistPhase >= 0 ? 1 : 0);
      pts.push(new THREE.Vector3(x, y, z));
    }
    return pts;
  };

  const mainCurve = new THREE.CatmullRomCurve3(makeCatenaryPts(0, 0, 1.0, -1));
  const mainTube = new THREE.TubeGeometry(mainCurve, 26, mainR, 8, false);
  cableParts.push(prepGeom(mainTube, span * 0.6, 1.0));
  mainTube.dispose();

  for (let s = 0; s < subCount; s++) {
    const rndA = hash2D(s, seed, 8111);
    const rndB = hash2D(s + 7, seed, 8221);
    const subR = mainR * (0.38 + rndA * 0.24);
    const sagMult = 1.05 + rndB * 0.22;
    const zOff = (s % 2 === 0 ? 1 : -1) * (mainR * 1.45 + rndA * 0.25);
    const yOff = -mainR * (1.2 + s * 0.45);
    const subCurve = new THREE.CatmullRomCurve3(
      makeCatenaryPts(yOff, zOff, sagMult, s * 2.1 + seed * 0.4)
    );
    const subTube = new THREE.TubeGeometry(subCurve, 22, subR, 6, false);
    cableParts.push(prepGeom(subTube, span * 0.7, 1.0));
    subTube.dispose();
  }

  const clampCount = 6;
  const rawCollar = new THREE.CylinderGeometry(mainR * 1.65, mainR * 1.65, 0.34, 8);
  const upVec = new THREE.Vector3(0, 1, 0);
  for (let c = 1; c <= clampCount; c++) {
    const t = c / (clampCount + 1);
    const pt = mainCurve.getPoint(t);
    const tan = mainCurve.getTangent(t).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(upVec, tan);
    const g = prepGeom(rawCollar, 1.0, 1.0);
    g.applyMatrix4(new THREE.Matrix4().compose(pt, quat, new THREE.Vector3(1, 1, 1)));
    clampParts.push(g);
  }
  rawCollar.dispose();

  return {
    cableGeo: mergeSafe(cableParts),
    clampGeo: mergeSafe(clampParts),
  };
}

function buildMegaCablesGroup(mats) {
  const group = new THREE.Group();
  group.name = 'MegaCables';

  const archHeavyWide = buildCableBundleArchetype(34.0, 4.4, 0.30, 3, 1.5, 11);
  const archMidDeepSag = buildCableBundleArchetype(28.0, 5.6, 0.24, 3, 2.0, 23);
  const archUpperSweep = buildCableBundleArchetype(42.0, 4.8, 0.28, 2, 1.2, 37);
  const archLateralDrape = buildCableBundleArchetype(16.0, 2.6, 0.19, 2, 1.0, 53);

  const addCableInstance = (name, arch, pos, rot = [0, 0, 0], scale = [1, 1, 1]) => {
    const node = new THREE.Group();
    node.name = name;
    node.position.set(pos[0], pos[1], pos[2]);
    node.rotation.set(rot[0], rot[1], rot[2]);
    node.scale.set(scale[0], scale[1], scale[2]);

    const mCable = new THREE.Mesh(arch.cableGeo, mats.megaCableMat);
    mCable.name = `${name}_Bundle`;
    node.add(mCable);

    const mClamp = new THREE.Mesh(arch.clampGeo, mats.darkFrameMat);
    mClamp.name = `${name}_Clamps`;
    node.add(mClamp);

    group.add(node);
  };

  // Cross-canyon sweeping power arteries
  const crossArteries = [
    { name: 'Artery_Cross_01', arch: archMidDeepSag, pos: [0.0, 19.6, -15.8], rot: [0, 0.03, 0], scale: [1.02, 0.92, 1.0] },
    { name: 'Artery_Cross_02', arch: archHeavyWide, pos: [0.0, 22.8, -16.6], rot: [0, -0.02, 0], scale: [0.98, 1.0, 1.0] },
    { name: 'Artery_Cross_03', arch: archUpperSweep, pos: [0.0, 26.8, -18.2], rot: [0, 0.04, 0], scale: [0.95, 1.05, 1.0] },
    { name: 'Artery_Cross_04', arch: archMidDeepSag, pos: [0.5, 20.5, -21.2], rot: [0, -0.05, 0], scale: [1.10, 0.95, 1.0] },
    { name: 'Artery_Cross_05', arch: archHeavyWide, pos: [-0.5, 24.4, -23.0], rot: [0, 0.03, 0], scale: [1.12, 1.02, 1.0] },
    { name: 'Artery_Cross_06', arch: archUpperSweep, pos: [0.0, 28.0, -25.0], rot: [0, -0.02, 0], scale: [1.08, 1.08, 1.0] },
    { name: 'Artery_Cross_07', arch: archMidDeepSag, pos: [0.0, 21.8, -28.8], rot: [0, 0.04, 0], scale: [1.18, 0.96, 1.0] },
    { name: 'Artery_Cross_08', arch: archHeavyWide, pos: [0.0, 25.5, -31.5], rot: [0, -0.03, 0], scale: [1.22, 1.04, 1.0] },
    { name: 'Artery_Cross_09', arch: archUpperSweep, pos: [0.0, 28.2, -34.5], rot: [0, 0.02, 0], scale: [1.18, 1.0, 1.0] },
    { name: 'Artery_Cross_10', arch: archHeavyWide, pos: [0.0, 24.0, -38.5], rot: [0, -0.04, 0], scale: [1.28, 1.05, 1.0] },
    { name: 'Artery_Cross_11', arch: archUpperSweep, pos: [0.0, 27.6, -41.0], rot: [0, 0.02, 0], scale: [1.25, 1.02, 1.0] },
  ];
  for (const a of crossArteries) {
    addCableInstance(a.name, a.arch, a.pos, a.rot, a.scale);
  }

  // Sweeping diagonal conduit arteries crossing obliquely across the upper chasm
  const diagArteries = [
    { name: 'Artery_Diag_01', arch: archHeavyWide, pos: [0.0, 23.6, -22.5], rot: [0, 0.30, 0.07], scale: [1.05, 1.0, 1.0] },
    { name: 'Artery_Diag_02', arch: archHeavyWide, pos: [0.0, 24.2, -23.2], rot: [0, -0.30, -0.06], scale: [1.05, 0.95, 1.0] },
    { name: 'Artery_Diag_03', arch: archMidDeepSag, pos: [0.0, 21.2, -26.0], rot: [0, 0.34, -0.05], scale: [1.12, 0.90, 1.0] },
    { name: 'Artery_Diag_04', arch: archMidDeepSag, pos: [0.0, 21.6, -26.8], rot: [0, -0.34, 0.06], scale: [1.12, 0.90, 1.0] },
    { name: 'Artery_Diag_05', arch: archUpperSweep, pos: [0.0, 27.2, -31.0], rot: [0, 0.28, 0.05], scale: [1.08, 1.0, 1.0] },
    { name: 'Artery_Diag_06', arch: archUpperSweep, pos: [0.0, 27.6, -31.8], rot: [0, -0.28, -0.05], scale: [1.08, 1.0, 1.0] },
    { name: 'Artery_Diag_07', arch: archHeavyWide, pos: [0.0, 23.2, -35.5], rot: [0, 0.25, -0.04], scale: [1.18, 0.95, 1.0] },
    { name: 'Artery_Diag_08', arch: archHeavyWide, pos: [0.0, 23.8, -36.2], rot: [0, -0.25, 0.04], scale: [1.18, 0.95, 1.0] },
  ];
  for (const d of diagArteries) {
    addCableInstance(d.name, d.arch, d.pos, d.rot, d.scale);
  }

  // Side-canyon longitudinal power feeders
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'L' : 'R';
    addCableInstance(`Artery_Side_${tag}1`, archLateralDrape, [side * 15.2, 18.2, -22.5], [0, Math.PI / 2, 0]);
    addCableInstance(`Artery_Side_${tag}2`, archLateralDrape, [side * 16.0, 23.8, -24.0], [0, Math.PI / 2, 0], [1.15, 1.05, 1.0]);
    addCableInstance(`Artery_Side_${tag}3`, archLateralDrape, [side * 16.5, 20.5, -35.5], [0, Math.PI / 2, 0], [1.1, 1.0, 1.0]);
    addCableInstance(`Artery_Side_${tag}4`, archLateralDrape, [side * 22.8, 25.0, -28.0], [0, Math.PI / 2, 0], [1.25, 1.1, 1.0]);
  }

  return group;
}

// ---------------------------------------------------------------------------
// 6. Lower Industrial Canyon Decks & Distant Amber City Glow (`CityAbyss`)
//    Double-wide 20m industrial terrace deck archetypes + cooling bay units +
//    24m deep abyss pit-light floor panels -> super rich & ultra-low draw calls!
// ---------------------------------------------------------------------------

/**
 * Shared Archetype: Double-Wide Industrial Canyon Terrace Module (20m x 7.6m)
 * Features ribbed deck plating, longitudinal I-beams, braced canyon piers,
 * edge parapet railings, and warm amber edge floor light rows.
 */
function buildTerraceDeckArchetype() {
  const deck = [];
  const frame = [];
  const amberLedge = [];

  const W = 20.0;
  const D = 7.6;
  const hd = D * 0.5;

  addBox(deck, [W, 0.36, D], [0, -0.18, 0], [0, 0, 0], [4.6, 1.8]);
  for (let rx = -9.0; rx <= 9.01; rx += 2.0) {
    addBox(frame, [0.20, 0.08, D - 0.3], [rx, 0.04, 0], [0, 0, 0], [0.2, 1.8]);
  }
  for (const gz of [-3.1, 0.0, 3.1]) {
    addBox(frame, [W, 0.54, 0.34], [0, -0.60, gz], [0, 0, 0], [4.4, 0.3]);
  }
  for (const px of [-8.2, 0.0, 8.2]) {
    for (const pz of [-2.8, 2.8]) {
      addBox(frame, [0.58, 4.2, 0.58], [px, -2.4, pz], [0, 0, 0], [0.4, 1.4]);
    }
    frame.push(makeStrut([px, -0.6, -2.8], [px, -3.6, 2.8], 0.14, 0.14));
    frame.push(makeStrut([px, -3.6, -2.8], [px, -0.6, 2.8], 0.14, 0.14));
  }

  // Front canyon-edge parapet curb, railing & glowing warm amber industrial strip row
  addBox(frame, [W, 0.24, 0.26], [0, 0.12, hd - 0.14]);
  addBox(frame, [W, 0.08, 0.08], [0, 1.02, hd - 0.14]);
  for (let px = -9.5; px <= 9.51; px += 1.9) {
    addBox(frame, [0.09, 0.96, 0.09], [px, 0.54, hd - 0.14]);
  }
  for (const lx of [-7.5, -3.75, 0.0, 3.75, 7.5]) {
    addBox(frame, [2.65, 0.12, 0.24], [lx, 0.08, hd + 0.06]);
    addBox(amberLedge, [2.40, 0.22, 0.12], [lx, -0.06, hd + 0.08]);
  }

  return {
    deckGeo: mergeSafe(deck),
    frameGeo: mergeSafe(frame),
    amberLedgeGeo: mergeSafe(amberLedge),
  };
}

/**
 * Shared Archetype: Industrial Cooling Stack & Warm Amber Work-Bay Gallery Unit
 */
function buildCoolingBayArchetype() {
  const steel = [];
  const frame = [];
  const amberBay = [];
  const amberLedge = [];

  steel.push(makeChamferedShaft(7.4, 3.8, 0.35, 2.35, 0.0, [0.4, 0.4]));
  addBox(frame, [7.85, 0.24, 4.35], [0, 2.42, 0.10], [0, 0, 0], [1.4, 0.6]);

  for (let mx = -3.2; mx <= 3.21; mx += 1.6) {
    addBox(frame, [0.22, 2.4, 0.28], [mx, 1.2, 1.92]);
    addBox(frame, [0.22, 2.4, 0.28], [mx, 1.2, -1.92]);
  }

  for (const sx of [-2.1, -0.5]) {
    addCyl(steel, 0.54, 0.66, 2.5, 10, [sx, 3.6, -0.45], [0, 0, 0], [1.4, 0.9]);
    addCyl(frame, 0.72, 0.72, 0.22, 10, [sx, 4.78, -0.45]);
    addCyl(frame, 0.70, 0.70, 0.18, 10, [sx, 3.45, -0.45]);
  }

  addCyl(steel, 0.62, 0.62, 2.9, 10, [1.85, 3.15, -0.2], [0, 0, Math.PI / 2], [1.0, 1.2]);
  for (const tx of [0.95, 2.75]) {
    addBox(frame, [0.22, 0.75, 1.05], [tx, 2.72, -0.2]);
    addCyl(frame, 0.68, 0.68, 0.14, 10, [tx, 3.15, -0.2], [0, 0, Math.PI / 2]);
  }

  addBox(amberBay, [6.4, 1.52, 0.10], [0, 1.25, 1.94], [0, 0, 0], [2.4, 0.6]);
  addBox(amberBay, [6.4, 1.52, 0.10], [0, 1.25, -1.94], [0, 0, 0], [2.4, 0.6]);
  for (const lx of [-2.4, 0.0, 2.4]) {
    addBox(amberLedge, [1.45, 0.19, 0.16], [lx, 2.22, 2.10]);
  }

  return {
    steelGeo: mergeSafe(steel),
    frameGeo: mergeSafe(frame),
    amberBayGeo: mergeSafe(amberBay),
    amberLedgeGeo: mergeSafe(amberLedge),
  };
}

/**
 * Shared Archetype: Wide Deep Abyss Pit-Light Floor Grid Slab (22m x 10m)
 */
function buildAbyssFloorTileArchetype() {
  const deck = [];
  const frame = [];
  const amberLedge = [];

  addBox(deck, [22.0, 0.40, 10.0], [0, -0.20, 0], [0, 0, 0], [4.6, 2.2]);
  for (const rx of [-10.8, -5.4, 0.0, 5.4, 10.8]) {
    addBox(frame, [0.34, 0.24, 10.0], [rx, 0.08, 0]);
  }
  for (const rz of [-4.8, 0.0, 4.8]) {
    addBox(frame, [22.0, 0.24, 0.34], [0, 0.08, rz]);
  }
  for (const gx of [-8.1, -2.7, 2.7, 8.1]) {
    for (const gz of [-2.4, 2.4]) {
      addBox(amberLedge, [2.6, 0.10, 0.58], [gx, 0.04, gz]);
    }
  }

  return {
    deckGeo: mergeSafe(deck),
    frameGeo: mergeSafe(frame),
    amberLedgeGeo: mergeSafe(amberLedge),
  };
}

function buildCityAbyssGroup(mats) {
  const group = new THREE.Group();
  group.name = 'CityAbyss';

  const terraceArch = buildTerraceDeckArchetype();
  const coolingArch = buildCoolingBayArchetype();
  const floorTileArch = buildAbyssFloorTileArchetype();

  const addTerrace = (name, pos, yaw = 0, scale = [1, 1, 1]) => {
    const node = new THREE.Group();
    node.name = name;
    node.position.set(pos[0], pos[1], pos[2]);
    node.rotation.y = yaw;
    node.scale.set(scale[0], scale[1], scale[2]);

    const mDeck = new THREE.Mesh(terraceArch.deckGeo, mats.abyssDeckMat);
    mDeck.name = `${name}_Deck`;
    node.add(mDeck);

    const mFrame = new THREE.Mesh(terraceArch.frameGeo, mats.darkFrameMat);
    mFrame.name = `${name}_Frame`;
    node.add(mFrame);

    const mAmber = new THREE.Mesh(terraceArch.amberLedgeGeo, mats.amberLedgeMat);
    mAmber.name = `${name}_Amber`;
    node.add(mAmber);

    group.add(node);
  };

  const addCoolingBay = (name, pos, yaw = 0, scale = [1, 1, 1]) => {
    const node = new THREE.Group();
    node.name = name;
    node.position.set(pos[0], pos[1], pos[2]);
    node.rotation.y = yaw;
    node.scale.set(scale[0], scale[1], scale[2]);

    const mSteel = new THREE.Mesh(coolingArch.steelGeo, mats.megaSteelMat);
    mSteel.name = `${name}_Steel`;
    node.add(mSteel);

    const mFrame = new THREE.Mesh(coolingArch.frameGeo, mats.darkFrameMat);
    mFrame.name = `${name}_Frame`;
    node.add(mFrame);

    const mBay = new THREE.Mesh(coolingArch.amberBayGeo, mats.amberBayMat);
    mBay.name = `${name}_AmberBay`;
    node.add(mBay);

    const mLedge = new THREE.Mesh(coolingArch.amberLedgeGeo, mats.amberBeaconMat);
    mLedge.name = `${name}_AmberLedge`;
    node.add(mLedge);

    group.add(node);
  };

  const addAbyssFloor = (name, pos, yaw = 0, scale = [1, 1, 1]) => {
    const node = new THREE.Group();
    node.name = name;
    node.position.set(pos[0], pos[1], pos[2]);
    node.rotation.y = yaw;
    node.scale.set(scale[0], scale[1], scale[2]);

    const mDeck = new THREE.Mesh(floorTileArch.deckGeo, mats.abyssDeckMat);
    mDeck.name = `${name}_Deck`;
    node.add(mDeck);

    const mFrame = new THREE.Mesh(floorTileArch.frameGeo, mats.darkFrameMat);
    mFrame.name = `${name}_Frame`;
    node.add(mFrame);

    const mAmber = new THREE.Mesh(floorTileArch.amberLedgeGeo, mats.amberLedgeMat);
    mAmber.name = `${name}_Amber`;
    node.add(mAmber);

    group.add(node);
  };

  // 1) Rear Canyon Stepped Industrial Terraces (3 double-wide 20m modules per tier -> 60m wide!)
  //    Strictly maxZ <= -14.8m!
  const rearTerraceTiers = [
    { tag: 'T1', z: -18.9, y: -0.35, xs: [-21.0, 0.0, 21.0] },
    { tag: 'T2', z: -27.4, y: -1.85, xs: [-22.0, 0.0, 22.0] },
    { tag: 'T3', z: -36.2, y: -3.25, xs: [-22.0, 0.0, 22.0] },
    { tag: 'T4', z: -45.4, y: -4.45, xs: [-22.0, 0.0, 22.0] },
  ];
  for (const tier of rearTerraceTiers) {
    for (let i = 0; i < tier.xs.length; i++) {
      addTerrace(`AbyssDeck_Rear_${tier.tag}_${i}`, [tier.xs[i], tier.y, tier.z], 0, [1.04, 1.0, 1.0]);
    }
  }

  // 2) Warm Amber Industrial Cooling Bays & Work-Light Rows perched on the rear terraces
  const rearCoolingSpecs = [
    { name: 'Bay_R1_L', pos: [-14.2, -0.35, -19.2], yaw: 0.12 },
    { name: 'Bay_R1_C', pos: [0.0, -0.35, -19.8], yaw: 0.0 },
    { name: 'Bay_R1_R', pos: [14.2, -0.35, -19.2], yaw: -0.12 },
    { name: 'Bay_R2_L2', pos: [-19.0, -1.85, -27.6], yaw: 0.08 },
    { name: 'Bay_R2_L1', pos: [-6.5, -1.85, -27.9], yaw: 0.04 },
    { name: 'Bay_R2_R1', pos: [6.5, -1.85, -27.9], yaw: -0.04 },
    { name: 'Bay_R2_R2', pos: [19.0, -1.85, -27.6], yaw: -0.08 },
    { name: 'Bay_R3_L', pos: [-13.5, -3.25, -36.4], yaw: 0.0 },
    { name: 'Bay_R3_C', pos: [0.0, -3.25, -36.6], yaw: 0.0 },
    { name: 'Bay_R3_R', pos: [13.5, -3.25, -36.4], yaw: 0.0 },
    { name: 'Bay_R4_L', pos: [-11.0, -4.45, -45.6], yaw: 0.0 },
    { name: 'Bay_R4_C', pos: [0.0, -4.45, -45.6], yaw: 0.0 },
    { name: 'Bay_R4_R', pos: [11.0, -4.45, -45.6], yaw: 0.0 },
  ];
  for (const b of rearCoolingSpecs) {
    addCoolingBay(b.name, b.pos, b.yaw, [1.0, 1.0, 1.0]);
  }

  // 3) Flanking Side-Canyon Lower Industrial Decks & Warm Amber Work-Bay Ledges (|x| >= 11.2m!)
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'L' : 'R';
    const yaw = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    addTerrace(`AbyssDeck_Side_${tag}_In`, [side * 15.3, -0.65, -7.8], yaw, [1.02, 1.0, 1.0]);
    addTerrace(`AbyssDeck_Side_${tag}_Out`, [side * 24.8, -2.85, -9.5], yaw, [1.15, 1.0, 1.0]);

    addCoolingBay(`Bay_Side_${tag}1`, [side * 16.5, -0.65, -3.0], yaw, [0.95, 0.95, 0.95]);
    addCoolingBay(`Bay_Side_${tag}2`, [side * 16.5, -0.65, -12.6], yaw, [0.95, 0.95, 0.95]);
    addCoolingBay(`Bay_Side_${tag}3`, [side * 25.6, -2.85, -7.0], yaw, [1.05, 1.05, 1.05]);
  }

  // 4) Deep Sub-Abyss Industrial Pit-Light Floor Grid (y = -5.5m)
  for (const [rzIdx, rz] of [-20.5, -31.0, -41.5, -51.5].entries()) {
    for (const [rxIdx, rx] of [-22.5, 0.0, 22.5].entries()) {
      addAbyssFloor(`AbyssPit_Rear_${rzIdx}_${rxIdx}`, [rx, -5.5, rz], 0, [1.04, 1.0, 1.04]);
    }
  }
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'L' : 'R';
    addAbyssFloor(`AbyssPit_Side_${tag}_In`, [side * 16.2, -5.4, -7.2], Math.PI / 2, [1.02, 1.0, 1.0]);
    addAbyssFloor(`AbyssPit_Side_${tag}_Out`, [side * 27.2, -5.5, -7.2], Math.PI / 2, [1.02, 1.0, 1.0]);
  }

  return group;
}

// ---------------------------------------------------------------------------
// 7. Assemble Full Stage 2 Matrix Machine Cityscape
// ---------------------------------------------------------------------------
function buildCityscapeScene() {
  const root = new THREE.Group();
  root.name = 'CityscapeRoot';

  const mats = createCityMaterials();

  root.add(buildCityTowersGroup(mats));
  root.add(buildSkyBridgesGroup(mats));
  root.add(buildMegaCablesGroup(mats));
  root.add(buildCityAbyssGroup(mats));

  return root;
}

// ---------------------------------------------------------------------------
// 8. Exhaustive Geometry Integrity, Keep-Out Contract & Vista Validation
// ---------------------------------------------------------------------------
function validateCityscape(root) {
  root.updateMatrixWorld(true);

  const worldBox = new THREE.Box3();
  const groupBoxes = new Map();
  const groupStats = new Map();

  const tmpV = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const triBox = new THREE.Box3();

  let totalInstancedTris = 0;
  let totalInstancedVerts = 0;
  let totalMeshInstances = 0;
  const aabbViolations = [];
  const vertexViolations = [];
  const triViolations = [];
  const vistaViolations = [];

  for (const child of root.children) {
    groupBoxes.set(child.name, new THREE.Box3());
    groupStats.set(child.name, { meshes: 0, tris: 0 });
  }

  const findTopSection = (obj) => {
    let cur = obj;
    while (cur.parent && cur.parent !== root) {
      cur = cur.parent;
    }
    return cur.name || 'Other';
  };

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    totalMeshInstances++;

    const geom = obj.geometry;
    const pos = geom.getAttribute('position');
    const norm = geom.getAttribute('normal');
    const uv = geom.getAttribute('uv');
    const index = geom.getIndex();

    if (!pos || pos.count === 0) {
      throw new Error(`Mesh "${obj.name}" has empty position attribute`);
    }

    const sectionName = findTopSection(obj);
    const secBox = groupBoxes.get(sectionName);
    const secStat = groupStats.get(sectionName);

    const meshWorldBox = new THREE.Box3();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`NaN/Inf position in mesh "${obj.name}" at vertex ${i}`);
      }
      tmpV.set(x, y, z).applyMatrix4(obj.matrixWorld);
      worldBox.expandByPoint(tmpV);
      meshWorldBox.expandByPoint(tmpV);
      if (secBox) secBox.expandByPoint(tmpV);

      if (KEEP_OUT_BOX.containsPoint(tmpV)) {
        if (vertexViolations.length < 10) {
          vertexViolations.push({
            mesh: obj.name,
            point: tmpV.toArray().map((n) => +n.toFixed(2)),
          });
        }
      }
    }

    if (norm) {
      for (let i = 0; i < norm.count; i++) {
        if (
          !Number.isFinite(norm.getX(i)) ||
          !Number.isFinite(norm.getY(i)) ||
          !Number.isFinite(norm.getZ(i))
        ) {
          throw new Error(`NaN/Inf normal in mesh "${obj.name}" at index ${i}`);
        }
      }
    }

    if (uv) {
      for (let i = 0; i < uv.count; i++) {
        if (!Number.isFinite(uv.getX(i)) || !Number.isFinite(uv.getY(i))) {
          throw new Error(`NaN/Inf UV in mesh "${obj.name}" at index ${i}`);
        }
      }
    }

    if (index) {
      for (let i = 0; i < index.count; i++) {
        const idx = index.getX(i);
        if (idx < 0 || idx >= pos.count) {
          throw new Error(`Out-of-range index ${idx} in mesh "${obj.name}"`);
        }
      }
    }

    const triCount = Math.round(index ? index.count / 3 : pos.count / 3);
    totalInstancedTris += triCount;
    totalInstancedVerts += pos.count;
    if (secStat) {
      secStat.meshes++;
      secStat.tris += triCount;
    }

    if (meshWorldBox.intersectsBox(KEEP_OUT_BOX)) {
      aabbViolations.push({
        mesh: obj.name,
        min: meshWorldBox.min.toArray().map((n) => +n.toFixed(2)),
        max: meshWorldBox.max.toArray().map((n) => +n.toFixed(2)),
      });

      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        tmpA.fromBufferAttribute(pos, i0).applyMatrix4(obj.matrixWorld);
        tmpB.fromBufferAttribute(pos, i1).applyMatrix4(obj.matrixWorld);
        tmpC.fromBufferAttribute(pos, i2).applyMatrix4(obj.matrixWorld);
        triBox.makeEmpty().expandByPoint(tmpA).expandByPoint(tmpB).expandByPoint(tmpC);
        if (triBox.intersectsBox(KEEP_OUT_BOX)) {
          if (KEEP_OUT_BOX.intersectsTriangle(new THREE.Triangle(tmpA, tmpB, tmpC))) {
            triViolations.push({
              mesh: obj.name,
              a: tmpA.toArray().map((n) => +n.toFixed(2)),
            });
            break;
          }
        }
      }
    }

    if (sectionName === 'CityTowers' && meshWorldBox.intersectsBox(VISTA_CHANNEL_BOX)) {
      vistaViolations.push({
        mesh: obj.name,
        min: meshWorldBox.min.toArray().map((n) => +n.toFixed(2)),
        max: meshWorldBox.max.toArray().map((n) => +n.toFixed(2)),
      });
    }
  });

  if (vertexViolations.length > 0 || triViolations.length > 0 || aabbViolations.length > 0) {
    throw new Error(
      `Stage 1 keep-out box VIOLATED! aabb=${JSON.stringify(aabbViolations.slice(0, 6))} verts=${JSON.stringify(vertexViolations.slice(0, 6))} tris=${JSON.stringify(triViolations.slice(0, 6))}`
    );
  }

  if (vistaViolations.length > 0) {
    throw new Error(
      `Central vista channel (x[-5.5..5.5], z[-34..0]) obstructed by CityTowers: ${JSON.stringify(vistaViolations.slice(0, 6))}`
    );
  }

  return {
    worldBox,
    groupBoxes,
    groupStats,
    totalInstancedTris,
    totalInstancedVerts,
    totalMeshInstances,
  };
}

// ---------------------------------------------------------------------------
// 9. Execute Build, Export GLB, and Run Full Verification Suite
// ---------------------------------------------------------------------------
const t0 = performance.now();
const cityscapeRoot = buildCityscapeScene();
const geomReport = validateCityscape(cityscapeRoot);
const exportStats = exportSceneToGLB(cityscapeRoot, OUTPUT_PATH);
const inspectReport = inspectGLB(OUTPUT_PATH);
const elapsedMs = (performance.now() - t0).toFixed(0);

const REQUIRED_NODES = ['CityscapeRoot', 'CityTowers', 'SkyBridges', 'MegaCables', 'CityAbyss'];
for (const req of REQUIRED_NODES) {
  if (!inspectReport.nodeNames.includes(req)) {
    throw new Error(`Exported GLB missing required named node "${req}"`);
  }
}

if (inspectReport.sizeKB >= 1536) {
  throw new Error(`GLB size ${inspectReport.sizeKB} KB exceeds 1.5 MB budget`);
}
if (inspectReport.triangles < 12000) {
  throw new Error(`Unique mesh triangle count ${inspectReport.triangles} below 12,000 target`);
}
if (geomReport.totalInstancedTris < 100000) {
  throw new Error(`Instanced triangle count ${geomReport.totalInstancedTris} below 100,000 target`);
}

const fmtBox = (b) => ({
  min: b.min.toArray().map((n) => +n.toFixed(2)),
  max: b.max.toArray().map((n) => +n.toFixed(2)),
});

console.log('=== Robot Pong: Stage 2 Matrix Cityscape Expansion GLB Built & Verified ===');
console.log(`Output:               ${exportStats.outputPath}`);
console.log(`Build time:           ${elapsedMs} ms`);
console.log(`File size:            ${inspectReport.sizeKB} KB (${exportStats.byteLength} bytes)`);
console.log(
  `Unique mesh tris:     ${inspectReport.triangles} tris (${inspectReport.vertices} verts across ${inspectReport.meshes} unique meshes)`
);
console.log(
  `Total instanced tris: ${geomReport.totalInstancedTris} tris (${geomReport.totalInstancedVerts} verts across ${geomReport.totalMeshInstances} mesh instances)`
);
console.log(`Scene graph nodes:    ${inspectReport.nodes}`);
console.log(`Materials / Textures: ${inspectReport.materials} mats / ${inspectReport.textures} textures`);
console.log(`Required nodes OK:    ${REQUIRED_NODES.join(', ')}`);
console.log(`Stage 1 keep-out box: 0 vertices / 0 tris / 0 mesh AABBs in x[-9..9], z[-14..6], y[-0.5..11.8]`);
console.log(`Central vista clear:  0 CityTowers in x[-5.5..5.5], z[-34..0]`);
console.log(`World bounding box:   ${JSON.stringify(fmtBox(geomReport.worldBox))}`);
for (const [name, box] of geomReport.groupBoxes.entries()) {
  const st = geomReport.groupStats.get(name);
  console.log(
    `  - ${name.padEnd(12)}: ${String(st.tris).padStart(7)} inst tris | ${String(st.meshes).padStart(3)} meshes | ${JSON.stringify(fmtBox(box))}`
  );
}
