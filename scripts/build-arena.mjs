/**
 * Procedural 3D Model Generator: Matrix Industrial Server Cathedral Arena
 * Outputs: public/models/arena_structure.glb
 *
 * Builds the massive dark dystopian cyberpunk industrial server hall surrounding
 * the Sentinel and table tennis table:
 *  - Towering dark weathered steel I-beam & open-lattice girders flanking left/right
 *    (x = ±3.8m, ±6.4m, z = +4.0m..-13.0m, y = 0.0m..11.5m) with wide open vertical
 *    slots so emerald Matrix digital-rain walls blaze straight through.
 *  - 3-tier industrial steel catwalks (left x = -3.7m, right x = +3.7m, deep rear
 *    z = -8.5m at y = 1.05m, 4.1m, 7.2m) with I-beam frames, diagonal under-trusses,
 *    grated steel decks, kickplates, tubular handrails, seamless corner landings,
 *    and caged rear access ladders.
 *  - Warm amber/orange caged industrial work lamps (CatwalkLights) along the lower
 *    catwalk railings (y = 1.15m), shielded under-ledge amber strips, upper pillars
 *    (y = 4.3m), and high gantry corners.
 *  - Overhead suspended ceiling pipe racks & sweeping 3D catenary cable bundles
 *    (OverheadCables) spanning y = 3.8m..9.5m while preserving an unobstructed
 *    playable sightline (x in [-2.2, 2.2], y in [0.7, 3.6], z in [-3.0, 3.5]).
 *  - Wet dark industrial concrete/steel floor (ArenaFloor, 24m x 26m at y = 0.0m)
 *    with procedural wet puddle roughness and bolted seam normal mapping.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  exportSceneToGLB,
  createPixelTexture,
  heightMapToNormalTexture,
  attachPBRTextures,
  fbmTileable,
} from './glb-builder.mjs';
import { inspectGLB } from './verify-models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, '../public/models/arena_structure.glb');

// ---------------------------------------------------------------------------
// Deterministic Math & Geometry Helpers
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

/**
 * Prepare a BufferGeometry for safe merging:
 * - ensures normals & uvs exist
 * - removes inconsistent optional attributes
 * - guarantees indexed representation
 */
function prepGeom(rawGeom, uvScaleU = 1, uvScaleV = 1) {
  const g = rawGeom.clone();
  if (!g.getAttribute('normal')) {
    g.computeVertexNormals();
  }
  const pos = g.getAttribute('position');
  if (!g.getAttribute('uv')) {
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = pos.getX(i) * 0.5;
      uvs[i * 2 + 1] = pos.getY(i) * 0.5 + pos.getZ(i) * 0.5;
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

function mergeSafe(geoms) {
  if (!geoms || geoms.length === 0) {
    throw new Error('mergeSafe called with empty geometry array');
  }
  const prepped = geoms.map((g) => prepGeom(g));
  const merged = mergeGeometries(prepped, false);
  for (const g of prepped) g.dispose();
  if (!merged) {
    throw new Error('mergeGeometries failed: check attribute compatibility');
  }
  return merged;
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

/**
 * Build a rectangular or cylindrical strut connecting local points A and B.
 */
function makeStrut(a, b, radiusOrWidth, heightOrNull = null, radialSegs = 6, uvScale = [1, 1]) {
  const va = new THREE.Vector3(a[0], a[1], a[2]);
  const vb = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = new THREE.Vector3().subVectors(vb, va);
  const len = dir.length();
  if (len < 1e-5) {
    throw new Error(`Zero-length strut between ${a} and ${b}`);
  }
  const mid = new THREE.Vector3().addVectors(va, vb).multiplyScalar(0.5);
  const raw =
    heightOrNull !== null
      ? new THREE.BoxGeometry(radiusOrWidth, len, heightOrNull)
      : new THREE.CylinderGeometry(radiusOrWidth, radiusOrWidth, len, radialSegs, 1, true);

  const g = prepGeom(raw, uvScale[0], uvScale[1] * Math.max(0.5, len * 0.6));
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
 * Create an extruded wide-flange I-beam along the +Y axis (y in [0, length]).
 */
function makeIBeamY(width, depth, flangeThick, webThick, length) {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const hwt = webThick * 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hd);
  shape.lineTo(hw, -hd);
  shape.lineTo(hw, -hd + flangeThick);
  shape.lineTo(hwt, -hd + flangeThick);
  shape.lineTo(hwt, hd - flangeThick);
  shape.lineTo(hw, hd - flangeThick);
  shape.lineTo(hw, hd);
  shape.lineTo(-hw, hd);
  shape.lineTo(-hw, hd - flangeThick);
  shape.lineTo(-hwt, hd - flangeThick);
  shape.lineTo(-hwt, -hd + flangeThick);
  shape.lineTo(-hw, -hd + flangeThick);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geom.rotateX(-Math.PI / 2);
  return prepGeom(geom, 0.75, 0.75);
}

/**
 * Create an extruded C-channel steel beam along the +Z axis (centered at z=0).
 */
function makeCChannelZ(width, height, thick, length, flipX = false) {
  const hw = width * 0.5;
  const hh = height * 0.5;
  const shape = new THREE.Shape();
  if (!flipX) {
    shape.moveTo(-hw, -hh);
    shape.lineTo(hw, -hh);
    shape.lineTo(hw, -hh + thick);
    shape.lineTo(-hw + thick, -hh + thick);
    shape.lineTo(-hw + thick, hh - thick);
    shape.lineTo(hw, hh - thick);
    shape.lineTo(hw, hh);
    shape.lineTo(-hw, hh);
    shape.closePath();
  } else {
    shape.moveTo(hw, -hh);
    shape.lineTo(-hw, -hh);
    shape.lineTo(-hw, -hh + thick);
    shape.lineTo(hw - thick, -hh + thick);
    shape.lineTo(hw - thick, hh - thick);
    shape.lineTo(-hw, hh - thick);
    shape.lineTo(-hw, hh);
    shape.lineTo(hw, hh);
    shape.closePath();
  }

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geom.translate(0, 0, -length * 0.5);
  return prepGeom(geom, 0.7, 0.7);
}

/**
 * Create a right-angled triangular steel gusset bracket (extruded along Z thickness).
 */
function makeGussetPlate(sizeX, sizeY, thickness) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(sizeX, 0);
  shape.lineTo(sizeX, 0.03);
  shape.lineTo(0.03, sizeY);
  shape.lineTo(0, sizeY);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
  });
  geom.translate(0, 0, -thickness * 0.5);
  return prepGeom(geom, 1.2, 1.2);
}

/**
 * Create a watertight solid extruded arched steel hood visor (covers TOP +Y arc, extrudes along +Z).
 */
function makeVisorHoodZ(innerR, outerR, depth, arcSpan = Math.PI * 1.18, segs = 10) {
  const startAng = Math.PI * 0.5 - arcSpan * 0.5;
  const endAng = Math.PI * 0.5 + arcSpan * 0.5;
  const shape = new THREE.Shape();
  for (let i = 0; i <= segs; i++) {
    const a = lerp(startAng, endAng, i / segs);
    const x = Math.cos(a) * outerR;
    const y = Math.sin(a) * outerR;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  for (let i = segs; i >= 0; i--) {
    const a = lerp(startAng, endAng, i / segs);
    shape.lineTo(Math.cos(a) * innerR, Math.sin(a) * innerR);
  }
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 1,
  });
  return prepGeom(geom, 2.0, 2.0);
}

// ---------------------------------------------------------------------------
// 1. Procedural PBR Textures
//    - Dark weathered riveted structural steel (256x256)
//    - Industrial wet concrete / steel-seam floor (256x256)
//    - Industrial catwalk steel bar-grating (128x128)
//    - Corrugated armored cable sheathing (128x128)
// ---------------------------------------------------------------------------
function buildWeatheredSteelTextures() {
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

      const nMacro = fbmTileable(u, v, 4, 4, 101);
      const nMicro = fbmTileable(u * 2, v, 16, 3, 211);
      const streak = fbmTileable(u, v * 0.25, 12, 3, 307);

      // 2x2 riveted steel armor plate seams
      const cellU = (u * 2) % 1;
      const cellV = (v * 2) % 1;
      const distEdge = Math.min(Math.min(cellU, 1 - cellU), Math.min(cellV, 1 - cellV));

      const seamGroove = 1.0 - smoothstep(0.006, 0.022, distEdge);
      const edgeWear =
        smoothstep(0.014, 0.032, distEdge) * (1.0 - smoothstep(0.032, 0.068, distEdge));

      // Raised hemispherical steel rivets arrayed along plate margins
      let rivet = 0;
      const margin = 0.062;
      const rivetCount = 6;
      const checkRivet = (ru, rv) => {
        const d = Math.hypot(cellU - ru, cellV - rv);
        if (d < 0.026) {
          const dome = Math.sqrt(Math.max(0, 1 - (d / 0.026) ** 2));
          if (dome > rivet) rivet = dome;
        }
      };
      for (let r = 0; r < rivetCount; r++) {
        const t = (r + 0.5) / rivetCount;
        checkRivet(t, margin);
        checkRivet(t, 1 - margin);
        checkRivet(margin, t);
        checkRivet(1 - margin, t);
      }

      const rustNoise = fbmTileable(u, v, 6, 4, 419);
      const grime = clamp01(
        seamGroove * 0.85 + Math.max(0, rustNoise - 0.52) * 1.45 + streak * 0.22
      );

      let h = 0.52 + (nMacro - 0.5) * 0.09 + (nMicro - 0.5) * 0.07;
      h -= seamGroove * 0.36;
      h += edgeWear * 0.05;
      h += rivet * 0.34;
      heightMap[idx] = clamp01(h);
      grimeMap[idx] = grime;
      wearMap[idx] = clamp01(edgeWear * 0.8 + rivet * 0.75 + Math.max(0, nMicro - 0.65) * 0.9);
    }
  }

  const baseColor = createPixelTexture(W, H, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const p = idx * 4;
        const n = fbmTileable(x / w, y / h, 8, 3, 521);
        const g = grimeMap[idx];
        const wr = wearMap[idx];

        let r = lerp(31, 46, n);
        let gr = lerp(38, 54, n);
        let b = lerp(42, 60, n);

        // Oxidized grime collecting along joints
        r = lerp(r, 34, g * 0.62);
        gr = lerp(gr, 28, g * 0.72);
        b = lerp(b, 24, g * 0.78);

        // Exposed brushed gunmetal along plate borders & rivet crowns
        r = lerp(r, 80, wr * 0.58);
        gr = lerp(gr, 90, wr * 0.58);
        b = lerp(b, 96, wr * 0.56);

        const grooveDark = smoothstep(0.18, 0.42, heightMap[idx]);
        r *= 0.45 + 0.55 * grooveDark;
        gr *= 0.45 + 0.55 * grooveDark;
        b *= 0.45 + 0.55 * grooveDark;

        out[p] = Math.round(clamp01(r / 255) * 255);
        out[p + 1] = Math.round(clamp01(gr / 255) * 255);
        out[p + 2] = Math.round(clamp01(b / 255) * 255);
        out[p + 3] = 255;
      }
    }
  });

  const metallicRoughness = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const g = grimeMap[i];
      const wr = wearMap[i];
      const roughness = clamp01(0.46 + g * 0.36 - wr * 0.22);
      const metalness = clamp01(0.84 - g * 0.48 + wr * 0.14);
      out[p] = 255;
      out[p + 1] = Math.round(roughness * 255); // G = Roughness
      out[p + 2] = Math.round(metalness * 255); // B = Metalness
      out[p + 3] = 255;
    }
  });

  const normal = heightMapToNormalTexture(W, H, heightMap, 2.8);
  return { baseColor, metallicRoughness, normal };
}

function buildWetFloorTextures() {
  const W = 256;
  const H = 256;
  const heightMap = new Float32Array(W * H);
  const puddleMap = new Float32Array(W * H);
  const metalStripMap = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const idx = y * W + x;

      const nCoarse = fbmTileable(u, v, 3, 4, 701);
      const nMid = fbmTileable(u, v, 10, 4, 809);
      const nFine = fbmTileable(u, v, 28, 3, 919);

      const cellU = (u * 2) % 1;
      const cellV = (v * 2) % 1;
      const dEdge = Math.min(Math.min(cellU, 1 - cellU), Math.min(cellV, 1 - cellV));

      const groove = 1.0 - smoothstep(0.005, 0.017, dEdge);
      const steelBorder =
        smoothstep(0.012, 0.022, dEdge) * (1.0 - smoothstep(0.044, 0.058, dEdge));

      const diagA = Math.abs(Math.sin((u * 48 + v * 48) * Math.PI));
      const diagB = Math.abs(Math.sin((u * 48 - v * 48) * Math.PI));
      const tread = steelBorder * Math.pow(Math.max(diagA, diagB), 4) * 0.14;

      const cornerDist = Math.hypot(Math.min(cellU, 1 - cellU), Math.min(cellV, 1 - cellV));
      const cornerPlate = 1.0 - smoothstep(0.075, 0.095, cornerDist);

      const puddleField = nCoarse * 0.68 + nMid * 0.32;
      const puddle = smoothstep(0.49, 0.59, puddleField) * (1.0 - groove * 0.4);

      let concreteH = 0.5 + (nMid - 0.5) * 0.14 + (nFine - 0.5) * 0.08;
      concreteH = lerp(concreteH, 0.46, puddle * 0.88); // smooth glassy puddle surface
      concreteH -= groove * 0.38;
      concreteH += tread + cornerPlate * 0.09;

      heightMap[idx] = clamp01(concreteH);
      puddleMap[idx] = clamp01(puddle);
      metalStripMap[idx] = clamp01(Math.max(steelBorder, cornerPlate));
    }
  }

  const baseColor = createPixelTexture(W, H, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const p = idx * 4;
        const n = fbmTileable(x / w, y / h, 6, 4, 1031);
        const pud = puddleMap[idx];
        const met = metalStripMap[idx];
        const hVal = heightMap[idx];

        let r = lerp(22, 36, n);
        let g = lerp(27, 43, n);
        let b = lerp(30, 46, n);

        r = lerp(r, 42, met * 0.65);
        g = lerp(g, 50, met * 0.65);
        b = lerp(b, 55, met * 0.62);

        r *= lerp(1.0, 0.54, pud);
        g *= lerp(1.0, 0.62, pud);
        b *= lerp(1.0, 0.60, pud);

        const seamShade = smoothstep(0.16, 0.40, hVal);
        r *= 0.35 + 0.65 * seamShade;
        g *= 0.35 + 0.65 * seamShade;
        b *= 0.35 + 0.65 * seamShade;

        out[p] = Math.round(clamp01(r / 255) * 255);
        out[p + 1] = Math.round(clamp01(g / 255) * 255);
        out[p + 2] = Math.round(clamp01(b / 255) * 255);
        out[p + 3] = 255;
      }
    }
  });

  const metallicRoughness = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const pud = puddleMap[i];
      const met = metalStripMap[i];
      const dampNoise = fbmTileable((i % w) / w, Math.floor(i / w) / h, 10, 3, 1109);

      let roughness = lerp(0.46, 0.72, dampNoise);
      roughness = lerp(roughness, 0.28, met * 0.8);
      roughness = lerp(roughness, 0.07, pud);

      let metalness = lerp(0.12, 0.82, met);
      metalness = lerp(metalness, 0.22, pud * 0.65);

      out[p] = 255;
      out[p + 1] = Math.round(clamp01(roughness) * 255);
      out[p + 2] = Math.round(clamp01(metalness) * 255);
      out[p + 3] = 255;
    }
  });

  const normal = heightMapToNormalTexture(W, H, heightMap, 2.3);
  return { baseColor, metallicRoughness, normal };
}

function buildCatwalkGratingTextures() {
  const W = 128;
  const H = 128;
  const heightMap = new Float32Array(W * H);
  const barMask = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const idx = y * W + x;

      const uBarPhase = (u * 12) % 1;
      const vBarPhase = (v * 6) % 1;
      const uBar = 1.0 - smoothstep(0.13, 0.22, Math.min(uBarPhase, 1 - uBarPhase));
      const vBar = 1.0 - smoothstep(0.09, 0.17, Math.min(vBarPhase, 1 - vBarPhase));

      const edgeU = Math.min(u, 1 - u);
      const edgeV = Math.min(v, 1 - v);
      const borderFrame = 1.0 - smoothstep(0.035, 0.06, Math.min(edgeU, edgeV));

      const bar = clamp01(Math.max(borderFrame, Math.max(uBar, vBar * 0.92)));
      const serration = 0.06 * Math.sin(v * 48 * Math.PI) * uBar;
      const wear = fbmTileable(u, v, 6, 3, 1301);

      barMask[idx] = bar;
      heightMap[idx] = clamp01(0.08 + bar * 0.78 + serration + (wear - 0.5) * 0.06);
    }
  }

  const baseColor = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const bar = barMask[i];
      const n = fbmTileable((i % w) / w, Math.floor(i / w) / h, 8, 3, 1423);

      out[p] = Math.round(lerp(7, lerp(44, 74, n), bar));
      out[p + 1] = Math.round(lerp(10, lerp(50, 82, n), bar));
      out[p + 2] = Math.round(lerp(11, lerp(55, 88, n), bar));
      out[p + 3] = 255;
    }
  });

  const metallicRoughness = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const bar = barMask[i];
      out[p] = 255;
      out[p + 1] = Math.round(lerp(0.92, 0.34, bar) * 255);
      out[p + 2] = Math.round(lerp(0.12, 0.88, bar) * 255);
      out[p + 3] = 255;
    }
  });

  const normal = heightMapToNormalTexture(W, H, heightMap, 3.0);
  return { baseColor, metallicRoughness, normal };
}

function buildCableSheathTextures() {
  const W = 128;
  const H = 128;
  const heightMap = new Float32Array(W * H);

  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const rib = 0.5 + 0.5 * Math.sin(u * 20 * Math.PI * 2);
      const weave = 0.5 + 0.5 * Math.sin((u * 10 + v * 6) * Math.PI * 2);
      const grit = fbmTileable(u, v, 8, 2, 1607);
      heightMap[y * W + x] = clamp01(0.32 + rib * 0.44 + weave * 0.14 + (grit - 0.5) * 0.08);
    }
  }

  const baseColor = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const hv = heightMap[i];
      const c = Math.round(lerp(14, 34, hv));
      out[p] = c;
      out[p + 1] = Math.round(c * 1.08);
      out[p + 2] = Math.round(c * 1.12);
      out[p + 3] = 255;
    }
  });

  const metallicRoughness = createPixelTexture(W, H, (out, w, h) => {
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const hv = heightMap[i];
      out[p] = 255;
      out[p + 1] = Math.round(lerp(0.62, 0.28, hv) * 255);
      out[p + 2] = Math.round(lerp(0.18, 0.48, hv) * 255);
      out[p + 3] = 255;
    }
  });

  const normal = heightMapToNormalTexture(W, H, heightMap, 2.2);
  return { baseColor, metallicRoughness, normal };
}

// ---------------------------------------------------------------------------
// 2. High-Detail Shared Structural Geometries
// ---------------------------------------------------------------------------

/**
 * Inner Hero Column (x = ±3.8m, height = 11.5m):
 * Heavy octagonal cast-steel anchor plinth with 6 stiffener gussets & hex bolts,
 * twin extruded wide-flange I-beam chords paired along Z, open diagonal lattice
 * lacing bars, riveted splice collar plates at catwalk heights, and a vertical
 * conduit pipe with straps & junction box.
 */
function buildInnerColumnGeometry() {
  const parts = [];
  const colHeight = 11.5;

  // 1. Cast-steel anchor plinth (y = 0..0.46)
  const baseSlab = new THREE.BoxGeometry(0.68, 0.14, 0.88);
  parts.push(placeGeom(baseSlab, [0, 0.07, 0], [0, 0, 0], [1, 1, 1], [0.6, 0.2]));
  baseSlab.dispose();

  const plinthMid = new THREE.CylinderGeometry(0.38, 0.46, 0.30, 8);
  parts.push(placeGeom(plinthMid, [0, 0.29, 0], [0, Math.PI / 8, 0], [0.85, 1, 1.05], [1.2, 0.4]));
  plinthMid.dispose();

  const collarRing = new THREE.BoxGeometry(0.56, 0.08, 0.76);
  parts.push(placeGeom(collarRing, [0, 0.46, 0], [0, 0, 0], [1, 1, 1], [0.5, 0.15]));
  collarRing.dispose();

  // Radial triangular stiffener gussets & corner anchor hex bolts
  const gusset = makeGussetPlate(0.16, 0.34, 0.028);
  const boltGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.06, 6);
  for (const [bx, bz] of [
    [-0.27, -0.36],
    [0.27, -0.36],
    [-0.27, 0.36],
    [0.27, 0.36],
  ]) {
    parts.push(placeGeom(boltGeo, [bx, 0.16, bz]));
  }
  parts.push(placeGeom(gusset, [0.16, 0.14, -0.22], [0, 0, 0]));
  parts.push(placeGeom(gusset, [0.16, 0.14, 0.22], [0, 0, 0]));
  parts.push(placeGeom(gusset, [-0.16, 0.14, -0.22], [0, Math.PI, 0]));
  parts.push(placeGeom(gusset, [-0.16, 0.14, 0.22], [0, Math.PI, 0]));
  parts.push(placeGeom(gusset, [0, 0.14, 0.24], [0, -Math.PI / 2, 0]));
  parts.push(placeGeom(gusset, [0, 0.14, -0.24], [0, Math.PI / 2, 0]));
  gusset.dispose();
  boltGeo.dispose();

  // 2. Twin extruded wide-flange I-beam main chords (y = 0.44..11.5)
  const chordLen = colHeight - 0.44;
  const chordGeo = makeIBeamY(0.24, 0.22, 0.032, 0.028, chordLen);
  parts.push(placeGeom(chordGeo, [0, 0.44, -0.21]));
  parts.push(placeGeom(chordGeo, [0, 0.44, 0.21]));
  chordGeo.dispose();

  // 3. Open diagonal zigzag steel lattice lacing connecting the twin I-beams
  const segCount = 12;
  const yStart = 0.65;
  const yEnd = 11.25;
  const dy = (yEnd - yStart) / segCount;
  for (let i = 0; i < segCount; i++) {
    const y0 = yStart + i * dy;
    const y1 = y0 + dy;
    const zA = i % 2 === 0 ? -0.19 : 0.19;
    const zB = -zA;
    parts.push(makeStrut([-0.10, y0, zA], [-0.10, y1, zB], 0.022, 0.048));
    parts.push(makeStrut([0.10, y0, zA], [0.10, y1, zB], 0.022, 0.048));
    if (i % 2 === 0) {
      parts.push(makeStrut([-0.10, y0, -0.20], [-0.10, y0, 0.20], 0.024, 0.055));
      parts.push(makeStrut([0.10, y0, -0.20], [0.10, y0, 0.20], 0.024, 0.055));
    }
  }

  // 4. Heavy splice collar plates & protruding bolt studs at catwalk/roof elevations
  const spliceBox = new THREE.BoxGeometry(0.32, 0.24, 0.72);
  const boltBar = new THREE.BoxGeometry(0.36, 0.032, 0.032);
  for (const cy of [1.05, 4.1, 7.2, 10.45, 11.44]) {
    const hScale = cy > 11.2 ? 0.6 : 1.0;
    parts.push(placeGeom(spliceBox, [0, cy, 0], [0, 0, 0], [1, hScale, 1], [0.4, 0.25]));
    parts.push(placeGeom(boltBar, [0, cy + 0.06 * hScale, -0.26]));
    parts.push(placeGeom(boltBar, [0, cy - 0.06 * hScale, -0.26]));
    parts.push(placeGeom(boltBar, [0, cy + 0.06 * hScale, 0.26]));
    parts.push(placeGeom(boltBar, [0, cy - 0.06 * hScale, 0.26]));
  }
  spliceBox.dispose();
  boltBar.dispose();

  // 5. Vertical steel utility conduit pipe, clamp rings & beveled junction box
  const conduitPipe = new THREE.CylinderGeometry(0.036, 0.036, 10.6, 7, 1, true);
  parts.push(placeGeom(conduitPipe, [0.16, 5.8, 0.33], [0, 0, 0], [1, 1, 1], [0.5, 4.0]));
  conduitPipe.dispose();

  const pipeClamp = new THREE.CylinderGeometry(0.050, 0.050, 0.04, 7);
  for (let y = 1.5; y <= 10.5; y += 2.2) {
    parts.push(placeGeom(pipeClamp, [0.16, y, 0.33]));
  }
  pipeClamp.dispose();

  const jBox = new THREE.BoxGeometry(0.18, 0.34, 0.14);
  const jLid = new THREE.BoxGeometry(0.20, 0.36, 0.03);
  parts.push(placeGeom(jBox, [0.16, 2.25, 0.36]));
  parts.push(placeGeom(jLid, [0.16, 2.25, 0.43]));
  jBox.dispose();
  jLid.dispose();

  return mergeSafe(parts);
}

/**
 * Outer Cathedral Mega-Column / Open Lattice Tower (x = ±6.4m and deep rear z = -13.0m):
 * Monumental 4-chord vertical lattice girder tower (0.70m x 0.70m x 11.5m) with
 * open X-bracing diagonals on all 4 faces so Matrix green light pours through.
 */
function buildOuterLatticeTowerGeometry() {
  const parts = [];
  const totalH = 11.5;
  const half = 0.31;

  const foot1 = new THREE.BoxGeometry(0.96, 0.18, 0.96);
  const foot2 = new THREE.BoxGeometry(0.80, 0.24, 0.80);
  parts.push(placeGeom(foot1, [0, 0.09, 0], [0, 0, 0], [1, 1, 1], [0.8, 0.2]));
  parts.push(placeGeom(foot2, [0, 0.30, 0], [0, 0, 0], [1, 1, 1], [0.7, 0.25]));
  foot1.dispose();
  foot2.dispose();

  const chord = new THREE.BoxGeometry(0.11, totalH - 0.40, 0.11);
  const corners = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  for (const [cx, cz] of corners) {
    parts.push(
      placeGeom(chord, [cx, 0.40 + (totalH - 0.40) * 0.5, cz], [0, 0, 0], [1, 1, 1], [0.25, 5.5])
    );
  }
  chord.dispose();

  const bays = 9;
  const yBase = 0.50;
  const yTop = 11.30;
  const bayH = (yTop - yBase) / bays;
  for (let b = 0; b < bays; b++) {
    const y0 = yBase + b * bayH;
    const y1 = y0 + bayH;
    for (let s = 0; s < 4; s++) {
      const [xA, zA] = corners[s];
      const [xB, zB] = corners[(s + 1) % 4];
      parts.push(makeStrut([xA, y0, zA], [xB, y0, zB], 0.042, 0.042));
      if ((b + s) % 2 === 0) {
        parts.push(makeStrut([xA, y0, zA], [xB, y1, zB], 0.032, 0.032));
      } else {
        parts.push(makeStrut([xB, y0, zB], [xA, y1, zA], 0.032, 0.032));
      }
    }
  }

  const collar = new THREE.BoxGeometry(0.78, 0.22, 0.78);
  for (const cy of [4.1, 7.2, 11.38]) {
    parts.push(placeGeom(collar, [0, cy, 0], [0, 0, 0], [1, 1, 1], [0.7, 0.25]));
  }
  collar.dispose();

  return mergeSafe(parts);
}

/**
 * Modular Industrial Catwalk Bay (bayLen = 2.833m along Z, deckWidth = 1.24m along X).
 * Local origin: walkway centerline x=0, deck top surface y=0, bay center z=0.
 * Inner drop-off rail edge is +X = +0.62m; outer column anchor edge is -X = -0.62m.
 */
function buildCatwalkBayGeometries(bayLen = 2.833, deckWidth = 1.24) {
  const hw = deckWidth * 0.5;
  const hl = bayLen * 0.5;
  const frameParts = [];
  const deckParts = [];
  const railParts = [];

  // 1. Longitudinal extruded C-channel steel deck stringers
  const innerStringer = makeCChannelZ(0.10, 0.20, 0.022, bayLen, true);
  const outerStringer = makeCChannelZ(0.10, 0.20, 0.022, bayLen, false);
  frameParts.push(placeGeom(innerStringer, [hw - 0.05, -0.10, 0]));
  frameParts.push(placeGeom(outerStringer, [-hw + 0.05, -0.10, 0]));
  innerStringer.dispose();
  outerStringer.dispose();

  // 2. Cross-joist floor beams (5 per bay)
  const joist = new THREE.BoxGeometry(deckWidth - 0.14, 0.11, 0.055);
  for (let i = 0; i < 5; i++) {
    const z = lerp(-hl + 0.16, hl - 0.16, i / 4);
    frameParts.push(placeGeom(joist, [0, -0.095, z], [0, 0, 0], [1, 1, 1], [0.6, 0.15]));
  }
  joist.dispose();

  // 3. Underside Warren steel truss web beneath inner edge
  const trussBottomY = -0.52;
  frameParts.push(
    makeStrut([hw - 0.06, trussBottomY, -hl], [hw - 0.06, trussBottomY, hl], 0.044, 0.044)
  );
  const webSegs = 4;
  for (let i = 0; i < webSegs; i++) {
    const z0 = lerp(-hl + 0.08, hl - 0.08, i / webSegs);
    const z1 = lerp(-hl + 0.08, hl - 0.08, (i + 1) / webSegs);
    const zm = (z0 + z1) * 0.5;
    frameParts.push(makeStrut([hw - 0.06, -0.19, z0], [hw - 0.06, trussBottomY, zm], 0.030, 0.030));
    frameParts.push(makeStrut([hw - 0.06, trussBottomY, zm], [hw - 0.06, -0.19, z1], 0.030, 0.030));
  }

  // 4. 45-degree cantilever knee braces angling down to outer column line
  for (const bz of [-hl + 0.18, hl - 0.18]) {
    frameParts.push(makeStrut([hw - 0.08, -0.50, bz], [-hw + 0.08, -0.96, bz], 0.052, 0.062));
    frameParts.push(makeStrut([hw - 0.08, -0.18, bz], [hw - 0.08, -0.52, bz], 0.044, 0.044));
  }

  // 5. Segmented textured steel grating deck plates (3 panels per bay with recessed bevel seams)
  const panelCount = 3;
  const panelLen = (bayLen - 0.06) / panelCount;
  const deckSlab = new THREE.BoxGeometry(deckWidth - 0.10, 0.038, panelLen - 0.016);
  for (let p = 0; p < panelCount; p++) {
    const pz = -hl + 0.03 + (p + 0.5) * panelLen;
    deckParts.push(placeGeom(deckSlab, [0, -0.019, pz], [0, 0, 0], [1, 1, 1], [1.6, 1.3]));
  }
  deckSlab.dispose();

  // 6. Safety Handrail Assembly (inner edge): riveted kickplate + top rail + mid rail + stanchions
  //    Grouped into railGeo so corner landing bays can omit the inner railing cleanly!
  const railX = hw - 0.035;
  const kickPlate = new THREE.BoxGeometry(0.024, 0.14, bayLen - 0.02);
  railParts.push(placeGeom(kickPlate, [hw - 0.015, 0.07, 0], [0, 0, 0], [1, 1, 1], [1.4, 0.25]));
  kickPlate.dispose();

  const topRail = new THREE.CylinderGeometry(0.024, 0.024, bayLen, 7, 1, true);
  const midRail = new THREE.CylinderGeometry(0.018, 0.018, bayLen, 6, 1, true);
  railParts.push(placeGeom(topRail, [railX, 1.02, 0], [Math.PI / 2, 0, 0], [1, 1, 1], [0.4, 2.0]));
  railParts.push(placeGeom(midRail, [railX, 0.54, 0], [Math.PI / 2, 0, 0], [1, 1, 1], [0.4, 2.0]));
  topRail.dispose();
  midRail.dispose();

  const stanchion = new THREE.CylinderGeometry(0.021, 0.021, 1.04, 6);
  const stanchBase = new THREE.BoxGeometry(0.085, 0.03, 0.085);
  const stanchCollar = new THREE.CylinderGeometry(0.033, 0.033, 0.045, 6);
  for (let s = 0; s < 4; s++) {
    const sz = lerp(-hl + 0.14, hl - 0.14, s / 3);
    railParts.push(placeGeom(stanchion, [railX, 0.52, sz]));
    railParts.push(placeGeom(stanchBase, [railX - 0.01, 0.015, sz]));
    railParts.push(placeGeom(stanchCollar, [railX, 1.02, sz]));
    railParts.push(placeGeom(stanchCollar, [railX, 0.54, sz]));
  }
  stanchion.dispose();
  stanchBase.dispose();
  stanchCollar.dispose();

  return {
    frameGeo: mergeSafe(frameParts),
    deckGeo: mergeSafe(deckParts),
    railGeo: mergeSafe(railParts),
  };
}

/**
 * Industrial Caged Vertical Access Ladder (height = 3.05m linking catwalk tiers).
 */
function buildCagedLadderGeometry(height = 3.05) {
  const parts = [];
  const halfW = 0.22;

  const rail = new THREE.BoxGeometry(0.032, height, 0.055);
  parts.push(placeGeom(rail, [-halfW, height * 0.5, 0]));
  parts.push(placeGeom(rail, [halfW, height * 0.5, 0]));
  rail.dispose();

  const rung = new THREE.CylinderGeometry(0.014, 0.014, halfW * 2, 6, 1, true);
  for (let y = 0.22; y < height - 0.08; y += 0.28) {
    parts.push(placeGeom(rung, [0, y, 0], [0, 0, Math.PI / 2]));
  }
  rung.dispose();

  // Safety cage semicircular hoops wrapping around +Z climbing space
  const hoopRadius = 0.36;
  const hoopGeo = new THREE.TorusGeometry(hoopRadius, 0.015, 5, 12, Math.PI * 1.25);
  for (let y = 0.75; y <= height - 0.15; y += 0.72) {
    parts.push(placeGeom(hoopGeo, [0, y, 0.22], [Math.PI / 2, 0, -Math.PI * 0.125]));
  }
  hoopGeo.dispose();

  const strapAngles = [Math.PI * 0.2, Math.PI * 0.5, Math.PI * 0.8];
  const strapGeo = new THREE.BoxGeometry(0.022, height - 0.75, 0.012);
  for (const ang of strapAngles) {
    const sx = Math.cos(ang) * hoopRadius;
    const sz = 0.22 + Math.sin(ang) * hoopRadius;
    parts.push(
      placeGeom(strapGeo, [sx, 0.75 + (height - 0.75) * 0.5, sz], [0, ang - Math.PI / 2, 0])
    );
  }
  strapGeo.dispose();

  return mergeSafe(parts);
}

/**
 * Towering Overhead Cathedral Roof Portal Truss spanning x = -6.4m to +6.4m.
 */
function buildRoofPortalTrussGeometry() {
  const parts = [];
  const halfSpan = 6.4;
  const segs = 12;
  const dx = (halfSpan * 2) / segs;

  const lowerChord = new THREE.BoxGeometry(halfSpan * 2, 0.20, 0.24);
  parts.push(placeGeom(lowerChord, [0, 0.0, 0], [0, 0, 0], [1, 1, 1], [5.0, 0.3]));
  lowerChord.dispose();

  const upperY = (x) => {
    const norm = Math.abs(x) / halfSpan;
    return 1.68 - 0.58 * norm * norm;
  };

  for (let i = 0; i < segs; i++) {
    const x0 = -halfSpan + i * dx;
    const x1 = x0 + dx;
    const y0 = upperY(x0);
    const y1 = upperY(x1);

    parts.push(makeStrut([x0, y0, 0], [x1, y1, 0], 0.16, 0.24));
    if (i > 0) {
      parts.push(makeStrut([x0, 0.0, 0], [x0, y0, 0], 0.08, 0.12));
    }
    if (i < segs / 2) {
      parts.push(makeStrut([x0, 0.0, 0], [x1, y1, 0], 0.068, 0.09));
    } else {
      parts.push(makeStrut([x0, y0, 0], [x1, 0.0, 0], 0.068, 0.09));
    }
  }

  const centerGusset = new THREE.BoxGeometry(0.65, 0.42, 0.30);
  parts.push(placeGeom(centerGusset, [0, 0.04, 0]));
  centerGusset.dispose();

  parts.push(makeStrut([-3.8, -0.95, 0], [-2.85, 0.0, 0], 0.09, 0.14));
  parts.push(makeStrut([3.8, -0.95, 0], [2.85, 0.0, 0], 0.09, 0.14));

  return mergeSafe(parts);
}

/**
 * Side-aisle tie girder linking inner column (x = ±3.8m) to outer cathedral tower (x = ±6.4m).
 */
function buildAisleTieBeamGeometry() {
  const parts = [];
  const span = 2.6;
  const mainBeam = makeIBeamY(0.18, 0.26, 0.028, 0.024, span);
  parts.push(placeGeom(mainBeam, [-span * 0.5, 0, 0], [0, 0, -Math.PI / 2]));
  mainBeam.dispose();

  parts.push(makeStrut([-1.15, -0.58, 0], [-0.45, -0.10, 0], 0.048, 0.056));
  parts.push(makeStrut([1.15, -0.58, 0], [0.45, -0.10, 0], 0.048, 0.056));
  parts.push(makeStrut([-0.52, -0.10, 0], [0.52, -0.10, 0], 0.045, 0.045));

  return mergeSafe(parts);
}

/**
 * Outer Aisle Server Monolith / Cooling Fin Frame (tucked sparsely at x = ±8.35m so
 * wide open vertical slots remain for glowing Matrix digital-rain walls!).
 */
function buildServerMonolithFrameGeometry() {
  const parts = [];
  const h = 10.6;
  const w = 1.15;
  const d = 0.72;

  const post = new THREE.BoxGeometry(0.16, h, d);
  parts.push(placeGeom(post, [-w * 0.5, h * 0.5, 0], [0, 0, 0], [1, 1, 1], [0.4, 4.5]));
  parts.push(placeGeom(post, [w * 0.5, h * 0.5, 0], [0, 0, 0], [1, 1, 1], [0.4, 4.5]));
  post.dispose();

  const louver = new THREE.BoxGeometry(w - 0.12, 0.14, d * 0.84);
  for (let y = 0.65; y < h - 0.4; y += 0.68) {
    parts.push(placeGeom(louver, [0, y, 0], [0.22, 0, 0], [1, 1, 1], [0.8, 0.25]));
  }
  louver.dispose();

  const pipe = new THREE.CylinderGeometry(0.045, 0.045, h - 0.4, 6, 1, true);
  parts.push(placeGeom(pipe, [-w * 0.5 - 0.12, h * 0.5, d * 0.35], [0, 0, 0], [1, 1, 1], [0.4, 4.0]));
  parts.push(placeGeom(pipe, [w * 0.5 + 0.12, h * 0.5, d * 0.35], [0, 0, 0], [1, 1, 1], [0.4, 4.0]));
  pipe.dispose();

  return mergeSafe(parts);
}

// ---------------------------------------------------------------------------
// 3. Caged Industrial Work Lamps (CatwalkLights)
// ---------------------------------------------------------------------------

/**
 * Detailed bunker/shipyard bulkhead industrial work lamp:
 * - housingGeo: heavy cast-steel mounting plate, conduit elbow, solid watertight
 *   top glare-shield visor hood (+Y arc), 2 steel guard rings, and 4 curved wire
 *   guard bars wrapping around the glowing bulb.
 * - emitterGeo: sculpted LatheGeometry ribbed Fresnel amber glass dome (+Z).
 */
function buildCagedWorkLampGeometries() {
  const housingParts = [];

  // 1. Cast-steel octagonal mounting flange & heatsink body
  const backPlate = new THREE.CylinderGeometry(0.115, 0.125, 0.036, 8);
  housingParts.push(placeGeom(backPlate, [0, 0, 0.018], [Math.PI / 2, 0, 0]));
  backPlate.dispose();

  const housingBody = new THREE.CylinderGeometry(0.095, 0.110, 0.065, 8);
  housingParts.push(placeGeom(housingBody, [0, 0, 0.062], [Math.PI / 2, 0, 0]));
  housingBody.dispose();

  // Conduit feed neck & mounting bracket
  const neck = new THREE.CylinderGeometry(0.022, 0.022, 0.12, 6);
  housingParts.push(placeGeom(neck, [0, 0.12, 0.04]));
  neck.dispose();

  const bracket = new THREE.BoxGeometry(0.06, 0.08, 0.09);
  housingParts.push(placeGeom(bracket, [0, 0.17, 0.01]));
  bracket.dispose();

  // 2. Solid watertight crescent glare-shield visor hood cleanly shielding TOP (+Y) half!
  const visor = makeVisorHoodZ(0.116, 0.132, 0.21, Math.PI * 1.18, 10);
  housingParts.push(placeGeom(visor, [0, 0.008, 0.062]));
  visor.dispose();

  // 3. Protective Steel Wire Guard Cage (2 toroidal rings + 2 crossing wire arches)
  const cageRing1 = new THREE.TorusGeometry(0.096, 0.0085, 5, 12);
  const cageRing2 = new THREE.TorusGeometry(0.084, 0.0075, 5, 12);
  housingParts.push(placeGeom(cageRing1, [0, 0, 0.135]));
  housingParts.push(placeGeom(cageRing2, [0, 0, 0.215]));
  cageRing1.dispose();
  cageRing2.dispose();

  for (let i = 0; i < 2; i++) {
    const ang = (i * Math.PI) / 2 + Math.PI / 4;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(ca * 0.098, sa * 0.098, 0.085),
      new THREE.Vector3(ca * 0.100, sa * 0.100, 0.165),
      new THREE.Vector3(ca * 0.082, sa * 0.082, 0.235),
      new THREE.Vector3(ca * 0.032, sa * 0.032, 0.268),
      new THREE.Vector3(-ca * 0.032, -sa * 0.032, 0.268),
      new THREE.Vector3(-ca * 0.082, -sa * 0.082, 0.235),
      new THREE.Vector3(-ca * 0.100, -sa * 0.100, 0.165),
      new THREE.Vector3(-ca * 0.098, -sa * 0.098, 0.085),
    ]);
    const ribTube = new THREE.TubeGeometry(curve, 12, 0.007, 5, false);
    housingParts.push(prepGeom(ribTube));
    ribTube.dispose();
  }

  // 4. Sculpted LatheGeometry ribbed Fresnel amber-orange glass dome
  const lathePts = [
    new THREE.Vector2(0.001, 0.252),
    new THREE.Vector2(0.036, 0.246),
    new THREE.Vector2(0.064, 0.228),
    new THREE.Vector2(0.078, 0.202),
    new THREE.Vector2(0.074, 0.184),
    new THREE.Vector2(0.084, 0.168),
    new THREE.Vector2(0.078, 0.150),
    new THREE.Vector2(0.086, 0.132),
    new THREE.Vector2(0.082, 0.105),
    new THREE.Vector2(0.080, 0.082),
  ];
  const rawBulb = new THREE.LatheGeometry(lathePts, 12);
  const emitterGeo = placeGeom(rawBulb, [0, 0, 0], [Math.PI / 2, 0, 0]);
  rawBulb.dispose();

  return {
    housingGeo: mergeSafe(housingParts),
    emitterGeo,
  };
}

/**
 * Shielded linear industrial amber bulkhead light bar tucked beneath the Tier-1
 * catwalk inner rim so it projects that signature warm orange industrial rim glow.
 */
function buildEdgeStripLampGeometries(length = 1.65) {
  const housingParts = [];

  const topShield = new THREE.BoxGeometry(0.095, 0.022, length + 0.06);
  const backShield = new THREE.BoxGeometry(0.022, 0.075, length + 0.06);
  const endCap = new THREE.BoxGeometry(0.095, 0.075, 0.028);
  housingParts.push(placeGeom(topShield, [0.036, 0.034, 0]));
  housingParts.push(placeGeom(backShield, [0, 0, 0]));
  housingParts.push(placeGeom(endCap, [0.036, 0, -length * 0.5 - 0.016]));
  housingParts.push(placeGeom(endCap, [0.036, 0, length * 0.5 + 0.016]));
  topShield.dispose();
  backShield.dispose();
  endCap.dispose();

  const guardBar = new THREE.BoxGeometry(0.062, 0.062, 0.014);
  for (let i = -3; i <= 3; i++) {
    housingParts.push(placeGeom(guardBar, [0.044, -0.002, i * (length / 7.5)]));
  }
  guardBar.dispose();

  const lens = new THREE.CylinderGeometry(0.024, 0.024, length - 0.02, 7, 1, true);
  const emitterGeo = placeGeom(lens, [0.034, -0.004, 0], [Math.PI / 2, 0, 0]);
  lens.dispose();

  return {
    housingGeo: mergeSafe(housingParts),
    emitterGeo,
  };
}

// ---------------------------------------------------------------------------
// 4. Overhead Ceiling Pipe Racks & Sweeping Catenary Cable Bundles (OverheadCables)
// ---------------------------------------------------------------------------

/**
 * Heavy suspended steel ceiling pipe racks (y = 6.5m..9.5m):
 * Longitudinal coolant/steam mains + shared modular transverse trapeze racks
 * with curved 90-degree sweep elbows feeding into the outer pillars.
 */
function buildOverheadPipeRacksGeometries() {
  const longParts = [];
  const pipeSpecs = [
    { x: -3.25, y: 8.65, r: 0.115 },
    { x: -3.65, y: 8.82, r: 0.088 },
    { x: -4.15, y: 8.55, r: 0.135 },
    { x: -3.45, y: 6.72, r: 0.075 },
    { x: 3.25, y: 8.65, r: 0.115 },
    { x: 3.65, y: 8.82, r: 0.088 },
    { x: 4.15, y: 8.55, r: 0.135 },
    { x: 3.45, y: 6.72, r: 0.075 },
    { x: -1.85, y: 9.05, r: 0.105 },
    { x: 1.85, y: 9.05, r: 0.105 },
    { x: -0.75, y: 9.28, r: 0.082 },
    { x: 0.75, y: 9.28, r: 0.082 },
  ];

  const pipeLen = 16.4;
  const pipeCenterZ = -4.4;
  const flangeZStations = [2.6, -0.4, -3.4, -6.4, -9.4, -12.0];

  for (const ps of pipeSpecs) {
    const cyl = new THREE.CylinderGeometry(ps.r, ps.r, pipeLen, 8, 1, true);
    longParts.push(placeGeom(cyl, [ps.x, ps.y, pipeCenterZ], [Math.PI / 2, 0, 0], [1, 1, 1], [1.0, 7.0]));
    cyl.dispose();

    const flange = new THREE.CylinderGeometry(ps.r * 1.38, ps.r * 1.38, 0.065, 8);
    for (const fz of flangeZStations) {
      longParts.push(placeGeom(flange, [ps.x, ps.y, fz], [Math.PI / 2, 0, 0]));
    }
    flange.dispose();
  }

  // Modular shared transverse trapeze hanger + conduit manifold with curved 90-deg drops
  const trapezeParts = [];
  const bar = new THREE.BoxGeometry(9.2, 0.10, 0.22);
  trapezeParts.push(placeGeom(bar, [0, 8.42, 0], [0, 0, 0], [1, 1, 1], [3.5, 0.2]));
  bar.dispose();

  for (const hx of [-4.2, -2.4, 0, 2.4, 4.2]) {
    trapezeParts.push(makeStrut([hx, 8.42, 0], [hx, 9.85, 0], 0.022, null, 6));
  }

  const crossPipe = new THREE.CylinderGeometry(0.085, 0.085, 8.5, 8, 1, true);
  trapezeParts.push(placeGeom(crossPipe, [0, 6.95, 0], [0, 0, Math.PI / 2], [1, 1, 1], [0.8, 3.8]));
  crossPipe.dispose();

  // Bolted flange collars on transverse pipe
  const crossFlange = new THREE.CylinderGeometry(0.118, 0.118, 0.06, 8);
  for (const fx of [-3.2, -1.1, 1.1, 3.2]) {
    trapezeParts.push(placeGeom(crossFlange, [fx, 6.95, 0], [0, 0, Math.PI / 2]));
  }
  crossFlange.dispose();

  for (const side of [-1, 1]) {
    const elbowCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 4.25, 6.95, 0),
      new THREE.Vector3(side * 4.55, 6.88, 0),
      new THREE.Vector3(side * 4.72, 6.62, 0),
      new THREE.Vector3(side * 4.75, 6.08, 0),
    ]);
    const elbow = new THREE.TubeGeometry(elbowCurve, 8, 0.082, 7, false);
    trapezeParts.push(prepGeom(elbow, 1.0, 0.8));
    elbow.dispose();
  }

  return {
    longPipesGeo: mergeSafe(longParts),
    trapezeRackGeo: mergeSafe(trapezeParts),
  };
}

function makeCatenaryCurve(p0, p1, sag, swayX = 0, swayZ = 0, samples = 9) {
  const pts = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const droop = Math.pow(Math.sin(t * Math.PI), 1.15) * sag;
    const x = lerp(p0[0], p1[0], t) + Math.sin(t * Math.PI) * swayX;
    const y = lerp(p0[1], p1[1], t) - droop;
    const z = lerp(p0[2], p1[2], t) + Math.sin(t * Math.PI) * swayZ;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return new THREE.CatmullRomCurve3(pts);
}

/**
 * Dramatic catenary-draped thick industrial cable bundles hanging across the upper
 * cathedral frame (y = 3.8m..9.0m, z = -0.8m..-11.2m).
 * Returns merged curved cable bundle geometry + instanced clamp transforms (sharing 1 clamp geo!).
 */
function buildHangingCablesData() {
  const cableParts = [];
  const clampInstances = [];

  const cableDefs = [
    // --- Upper Foreground Framing Web (z = -0.8..-2.2, safely >= 4.4m across center) ---
    { a: [-3.9, 6.2, -0.85], b: [3.9, 6.6, -1.15], sag: 1.55, r: 0.056, swayZ: -0.25 },
    { a: [-3.9, 6.0, -0.95], b: [3.9, 6.4, -1.25], sag: 1.48, r: 0.036, swayZ: -0.18 },
    { a: [-4.2, 7.6, -1.05], b: [4.1, 7.2, -1.65], sag: 2.05, r: 0.068, swayZ: 0.15 },
    { a: [-3.8, 7.4, -1.35], b: [3.9, 7.8, -0.95], sag: 1.80, r: 0.042, swayZ: -0.22 },
    { a: [-5.4, 8.6, -0.90], b: [5.2, 8.2, -1.90], sag: 2.35, r: 0.062, swayZ: 0.10 },
    { a: [-3.8, 5.1, -1.10], b: [-1.7, 8.4, -1.75], sag: 1.15, r: 0.048, swayZ: -0.15 },
    { a: [3.8, 5.2, -1.15], b: [1.8, 8.4, -1.85], sag: 1.18, r: 0.048, swayZ: -0.15 },

    // --- Dense Canopy Sweeping Directly Above the Sentinel (z = -2.2..-4.8, y = 4.0..8.9m) ---
    { a: [-3.8, 5.8, -2.35], b: [3.8, 6.1, -2.75], sag: 1.55, r: 0.064, swayZ: -0.30 },
    { a: [-3.8, 5.65, -2.42], b: [3.8, 5.95, -2.82], sag: 1.50, r: 0.034, swayZ: -0.26 },
    { a: [-4.1, 7.2, -2.60], b: [4.2, 6.8, -3.45], sag: 2.20, r: 0.072, swayZ: -0.20 },
    { a: [-4.1, 7.05, -2.68], b: [4.2, 6.65, -3.52], sag: 2.12, r: 0.038, swayZ: -0.16 },
    { a: [-3.9, 6.4, -3.25], b: [3.9, 5.9, -3.90], sag: 1.85, r: 0.058, swayZ: 0.22 },
    { a: [-3.8, 6.2, -3.55], b: [3.8, 6.5, -4.25], sag: 2.05, r: 0.052, swayZ: -0.18 },
    { a: [-5.6, 8.7, -2.80], b: [4.8, 8.4, -4.10], sag: 2.75, r: 0.066, swayZ: 0.14 },
    { a: [-4.6, 8.5, -3.65], b: [5.5, 8.8, -2.55], sag: 2.60, r: 0.054, swayZ: -0.20 },
    { a: [-3.7, 4.95, -2.90], b: [-1.4, 8.5, -3.95], sag: 1.25, r: 0.044, swayZ: 0.12 },
    { a: [3.7, 4.90, -2.95], b: [1.4, 8.5, -4.05], sag: 1.22, r: 0.044, swayZ: 0.12 },
    { a: [-3.8, 5.35, -3.85], b: [3.8, 5.45, -4.45], sag: 1.48, r: 0.046, swayZ: 0.10 },

    // --- Mid-Deep Cathedral Web (z = -4.6..-7.0, dramatic sweeps dipping to y = 3.85m) ---
    { a: [-3.9, 5.9, -4.85], b: [3.9, 5.7, -5.35], sag: 1.85, r: 0.066, swayZ: -0.25 },
    { a: [-3.9, 5.75, -4.92], b: [3.9, 5.55, -5.42], sag: 1.78, r: 0.036, swayZ: -0.20 },
    { a: [-4.3, 7.5, -5.15], b: [4.1, 7.1, -6.10], sag: 2.55, r: 0.070, swayZ: 0.18 },
    { a: [-3.8, 6.3, -5.85], b: [3.8, 6.7, -6.55], sag: 2.25, r: 0.055, swayZ: -0.22 },
    { a: [-5.8, 8.9, -5.20], b: [5.6, 8.5, -6.65], sag: 2.95, r: 0.064, swayZ: 0.15 },
    { a: [-3.8, 5.5, -6.20], b: [3.8, 5.8, -6.95], sag: 1.75, r: 0.048, swayZ: 0.24 },
    { a: [-3.6, 6.9, -4.90], b: [-0.8, 8.5, -6.65], sag: 1.45, r: 0.040, swayZ: -0.15 },
    { a: [3.6, 6.9, -4.95], b: [0.8, 8.5, -6.70], sag: 1.45, r: 0.040, swayZ: -0.15 },

    // --- Flanking Column-to-Column Draped Bundles (outside playable center |x| >= 3.2m) ---
    { a: [-3.55, 6.8, 1.05], b: [-3.55, 6.2, -1.65], sag: 1.35, r: 0.054, swayX: 0.24 },
    { a: [-3.55, 6.4, -1.65], b: [-3.55, 6.6, -4.50], sag: 1.65, r: 0.058, swayX: 0.28 },
    { a: [-3.55, 6.5, -4.50], b: [-3.55, 6.1, -7.30], sag: 1.55, r: 0.052, swayX: 0.25 },
    { a: [3.55, 6.7, 1.05], b: [3.55, 6.1, -1.65], sag: 1.40, r: 0.054, swayX: -0.24 },
    { a: [3.55, 6.3, -1.65], b: [3.55, 6.5, -4.50], sag: 1.62, r: 0.058, swayX: -0.28 },
    { a: [3.55, 6.4, -4.50], b: [3.55, 6.0, -7.30], sag: 1.50, r: 0.052, swayX: -0.25 },

    // --- Deep Cathedral Backdrop Sweeps (z = -7.2..-11.2, framing the rear balcony & Matrix glow) ---
    { a: [-4.2, 7.6, -7.45], b: [4.2, 7.2, -8.35], sag: 2.35, r: 0.068, swayZ: -0.22 },
    { a: [-3.9, 6.2, -8.10], b: [3.9, 6.4, -9.20], sag: 1.95, r: 0.054, swayZ: 0.20 },
    { a: [-5.6, 8.8, -8.80], b: [5.4, 8.6, -10.60], sag: 2.85, r: 0.066, swayZ: -0.18 },
    { a: [-4.1, 7.4, -9.80], b: [4.1, 7.8, -11.10], sag: 2.25, r: 0.058, swayZ: 0.16 },
  ];

  for (let i = 0; i < cableDefs.length; i++) {
    const d = cableDefs[i];
    const curve = makeCatenaryCurve(d.a, d.b, d.sag, d.swayX || 0, d.swayZ || 0, 10);
    const tubularSegs = 16;
    const radialSegs = 6;
    const rawTube = new THREE.TubeGeometry(curve, tubularSegs, d.r, radialSegs, false);
    const len = curve.getLength();
    cableParts.push(prepGeom(rawTube, len * 1.4, 1.0));
    rawTube.dispose();

    // Record shared instanced hose-clamp collar transforms along thicker main bundles
    if (d.r >= 0.054) {
      for (const u of [0.25, 0.5, 0.75]) {
        const pt = curve.getPoint(u);
        const tan = curve.getTangent(u).normalize();
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
        const scaleR = d.r / 0.06;
        clampInstances.push({ pos: pt, quat, scaleR });
      }
    }
  }

  // Single shared ribbed clamp collar geometry instanced across all heavy bundles
  const clampCollarGeo = prepGeom(new THREE.CylinderGeometry(0.080, 0.080, 0.095, 8));

  return {
    cablesGeo: mergeSafe(cableParts),
    clampCollarGeo,
    clampInstances,
  };
}

// ---------------------------------------------------------------------------
// 5. Scene Assembly
// ---------------------------------------------------------------------------
function buildArenaScene() {
  const root = new THREE.Group();
  root.name = 'ArenaRoot';

  // --- Procedural PBR Texture Sets ---
  const steelTex = buildWeatheredSteelTextures();
  const floorTex = buildWetFloorTextures();
  const gratingTex = buildCatwalkGratingTextures();
  const cableTex = buildCableSheathTextures();

  // --- Shared PBR Materials ---
  const steelMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'WeatheredStructuralSteel',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
    }),
    steelTex
  );

  const darkIronMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'DarkCastSteel',
      color: 0xbac4c8,
      roughness: 1.0,
      metalness: 1.0,
    }),
    steelTex
  );

  const floorMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'WetIndustrialFloor',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
    }),
    floorTex
  );

  const gratingMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'CatwalkSteelGrating',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
    }),
    gratingTex
  );

  const cableMat = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'ArmoredCableSheath',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
    }),
    cableTex
  );

  const amberEmitterMat = new THREE.MeshStandardMaterial({
    name: 'AmberWorkLampEmitter',
    color: 0xffb86c,
    emissive: 0xff8020,
    emissiveIntensity: 4.5,
    roughness: 0.16,
    metalness: 0.05,
  });

  // -------------------------------------------------------------------------
  // A. Industrial Wet Floor (ArenaFloor: 24m x 26m at y = 0.0m)
  // -------------------------------------------------------------------------
  const rawFloor = new THREE.PlaneGeometry(24, 26, 8, 8);
  rawFloor.rotateX(-Math.PI / 2);
  const floorGeo = prepGeom(rawFloor, 6.5, 7.0);
  rawFloor.dispose();
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.name = 'ArenaFloor';
  floorMesh.position.set(0, 0.0, -3.0); // x in [-12, +12], z in [-16, +10]
  root.add(floorMesh);

  // Subtle recessed drainage trench grating strips flanking the playing court (x = ±3.05m)
  const drainParts = [];
  const drainStrip = new THREE.BoxGeometry(0.42, 0.016, 19.0);
  drainParts.push(placeGeom(drainStrip, [-3.05, 0.008, -4.5], [0, 0, 0], [1, 1, 1], [1.2, 24.0]));
  drainParts.push(placeGeom(drainStrip, [3.05, 0.008, -4.5], [0, 0, 0], [1, 1, 1], [1.2, 24.0]));
  drainStrip.dispose();
  const drainMesh = new THREE.Mesh(mergeSafe(drainParts), gratingMat);
  drainMesh.name = 'FloorDrainGrates';
  root.add(drainMesh);

  // -------------------------------------------------------------------------
  // B. Towering Structural Columns & Vertical Lattice Girders
  //    x = ±3.8m (inner I-beam lattice columns) & x = ±6.4m (outer mega-towers)
  //    z = +4.0m to -13.0m, y = 0.0m to 11.5m
  // -------------------------------------------------------------------------
  const columnsGroup = new THREE.Group();
  columnsGroup.name = 'StructuralColumns';
  root.add(columnsGroup);

  const innerColGeo = buildInnerColumnGeometry();
  const outerColGeo = buildOuterLatticeTowerGeometry();
  const aisleTieGeo = buildAisleTieBeamGeometry();
  const monolithGeo = buildServerMonolithFrameGeometry();

  const zStations = [4.0, 1.167, -1.667, -4.5, -7.333, -10.167, -13.0];

  for (let i = 0; i < zStations.length; i++) {
    const z = zStations[i];
    for (const side of [-1, 1]) {
      const sideLabel = side < 0 ? 'L' : 'R';

      const innerCol = new THREE.Mesh(innerColGeo, steelMat);
      innerCol.name = `InnerColumn_${sideLabel}_${i}`;
      innerCol.position.set(side * 3.8, 0, z);
      if (side > 0) innerCol.rotation.y = Math.PI;
      columnsGroup.add(innerCol);

      const outerCol = new THREE.Mesh(outerColGeo, darkIronMat);
      outerCol.name = `OuterLatticeTower_${sideLabel}_${i}`;
      outerCol.position.set(side * 6.4, 0, z);
      columnsGroup.add(outerCol);

      for (const ty of [4.1, 7.2, 10.45]) {
        const tie = new THREE.Mesh(aisleTieGeo, darkIronMat);
        tie.name = `AisleTie_${sideLabel}_${i}_${Math.round(ty * 10)}`;
        tie.position.set(side * 5.1, ty, z);
        columnsGroup.add(tie);
      }
    }
  }

  // Deep rear towering vertical lattice girders at z = -13.0m (wide open light slots between!)
  for (const rx of [-2.05, 2.05]) {
    const rearTower = new THREE.Mesh(outerColGeo, darkIronMat);
    rearTower.name = `RearLatticeGirder_${rx < 0 ? 'L' : 'R'}`;
    rearTower.position.set(rx, 0, -13.0);
    columnsGroup.add(rearTower);
  }

  // Outer-aisle deep server monolith frames placed sparsely in alternating Z bays (x = ±8.35m)
  const monolithZ = [2.58, -3.08, -8.75];
  for (let i = 0; i < monolithZ.length; i++) {
    for (const side of [-1, 1]) {
      const mono = new THREE.Mesh(monolithGeo, darkIronMat);
      mono.name = `OuterServerFrame_${side < 0 ? 'L' : 'R'}_${i}`;
      mono.position.set(side * 8.35, 0, monolithZ[i]);
      mono.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      columnsGroup.add(mono);
    }
  }

  // -------------------------------------------------------------------------
  // C. Overhead Vaulted Cathedral Roof Trusses & Longitudinal Steel Purlins
  // -------------------------------------------------------------------------
  const roofGroup = new THREE.Group();
  roofGroup.name = 'RoofStructure';
  root.add(roofGroup);

  const roofTrussGeo = buildRoofPortalTrussGeometry();
  for (let i = 0; i < zStations.length; i++) {
    const truss = new THREE.Mesh(roofTrussGeo, darkIronMat);
    truss.name = `RoofPortalTruss_${i}`;
    truss.position.set(0, 9.8, zStations[i]);
    roofGroup.add(truss);
  }

  const purlinParts = [];
  const purlinBeam = new THREE.BoxGeometry(0.18, 0.24, 17.4);
  for (const px of [-5.8, -3.8, -1.9, 0.0, 1.9, 3.8, 5.8]) {
    const norm = Math.abs(px) / 6.4;
    const py = 9.8 + (1.68 - 0.58 * norm * norm) + 0.14;
    purlinParts.push(placeGeom(purlinBeam, [px, py, -4.5], [0, 0, 0], [1, 1, 1], [0.3, 6.5]));
  }
  purlinBeam.dispose();
  const purlinMesh = new THREE.Mesh(mergeSafe(purlinParts), darkIronMat);
  purlinMesh.name = 'RoofPurlins';
  roofGroup.add(purlinMesh);

  // -------------------------------------------------------------------------
  // D. Multi-Tier Industrial Steel Catwalks (y = 1.05m, 4.1m, 7.2m)
  //    Left: x = -3.7m | Right: x = +3.7m | Deep Rear: z = -8.5m
  //    Seamless U-shaped perimeter with open corner landings & rear access ladders!
  // -------------------------------------------------------------------------
  const catwalksGroup = new THREE.Group();
  catwalksGroup.name = 'Catwalks';
  root.add(catwalksGroup);

  const catwalkBay = buildCatwalkBayGeometries(2.833, 1.24);
  const ladderGeo = buildCagedLadderGeometry(3.05);

  const tiers = [1.05, 4.1, 7.2];
  // 4 side bays running cleanly from z = +4.0m to z = -7.333m + open corner bay at z = -8.5m
  const sideBayCentersZ = [2.583, -0.25, -3.083, -5.917];
  const rearHalfScaleZ = 3.08 / 2.833; // bridges x in [-3.08, +3.08] seamlessly into side decks

  for (let t = 0; t < tiers.length; t++) {
    const ty = tiers[t];
    const tierGroup = new THREE.Group();
    tierGroup.name = `CatwalkTier_${t + 1}`;
    catwalksGroup.add(tierGroup);

    // Left & Right side walkways (4 railed bays + 1 open corner junction landing at z = -8.5m)
    for (const side of [-1, 1]) {
      const sideLabel = side < 0 ? 'L' : 'R';
      for (let b = 0; b < sideBayCentersZ.length; b++) {
        const bayNode = new THREE.Group();
        bayNode.name = `CatwalkBay_${sideLabel}_T${t + 1}_${b}`;
        bayNode.position.set(side * 3.7, ty, sideBayCentersZ[b]);
        if (side > 0) bayNode.rotation.y = Math.PI;
        bayNode.add(
          new THREE.Mesh(catwalkBay.frameGeo, steelMat),
          new THREE.Mesh(catwalkBay.deckGeo, gratingMat),
          new THREE.Mesh(catwalkBay.railGeo, darkIronMat)
        );
        tierGroup.add(bayNode);
      }

      // Open corner landing junction at (x = ±3.7m, z = -8.5m) without inner blocking rail!
      const cornerNode = new THREE.Group();
      cornerNode.name = `CatwalkCorner_${sideLabel}_T${t + 1}`;
      cornerNode.position.set(side * 3.7, ty, -8.5);
      cornerNode.scale.set(1, 1, 0.84); // spans z in [-9.69, -7.31] joining side bay & rear bridge
      if (side > 0) cornerNode.rotation.y = Math.PI;
      cornerNode.add(
        new THREE.Mesh(catwalkBay.frameGeo, steelMat),
        new THREE.Mesh(catwalkBay.deckGeo, gratingMat)
      );
      tierGroup.add(cornerNode);
    }

    // Deep Rear Catwalk Bridge spanning x = -3.08m to +3.08m along z = -8.5m (reusing catwalkBay!)
    for (const side of [-1, 1]) {
      const rearNode = new THREE.Group();
      rearNode.name = `RearCatwalk_${side < 0 ? 'L' : 'R'}_T${t + 1}`;
      rearNode.position.set(side * 1.54, ty, -8.5);
      rearNode.rotation.y = -Math.PI / 2; // local +X (inner railing) faces +Z toward the arena
      rearNode.scale.set(1.04, 1, rearHalfScaleZ);
      rearNode.add(
        new THREE.Mesh(catwalkBay.frameGeo, steelMat),
        new THREE.Mesh(catwalkBay.deckGeo, gratingMat),
        new THREE.Mesh(catwalkBay.railGeo, darkIronMat)
      );
      tierGroup.add(rearNode);
    }
  }

  // Caged vertical access ladders linking Tier 1 -> Tier 2 -> Tier 3 at deep rear bridge
  for (const side of [-1, 1]) {
    for (const baseY of [1.05, 4.1]) {
      const ladder = new THREE.Mesh(ladderGeo, darkIronMat);
      ladder.name = `AccessLadder_${side < 0 ? 'L' : 'R'}_${Math.round(baseY * 10)}`;
      ladder.position.set(side * 2.65, baseY, -7.82);
      catwalksGroup.add(ladder);
    }
  }

  // -------------------------------------------------------------------------
  // E. Warm Amber/Orange Caged Industrial Work Lamps (CatwalkLights)
  // -------------------------------------------------------------------------
  const lightsGroup = new THREE.Group();
  lightsGroup.name = 'CatwalkLights';
  root.add(lightsGroup);

  const workLamp = buildCagedWorkLampGeometries();
  const stripLamp = buildEdgeStripLampGeometries(1.65);

  const addWorkLamp = (name, x, y, z, rotY) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, y, z);
    g.rotation.y = rotY;
    g.add(
      new THREE.Mesh(workLamp.housingGeo, darkIronMat),
      new THREE.Mesh(workLamp.emitterGeo, amberEmitterMat)
    );
    lightsGroup.add(g);
  };

  // 1. Lower Catwalk Railing Lamps (y = 1.15m) along Left & Right Tier-1 balcony edge
  const lowerSideZ = [3.15, 1.15, -0.85, -2.85, -4.85, -6.85];
  for (let i = 0; i < lowerSideZ.length; i++) {
    const lz = lowerSideZ[i];
    addWorkLamp(`WorkLamp_Low_L_${i}`, -3.08, 1.15, lz, Math.PI / 2);
    addWorkLamp(`WorkLamp_Low_R_${i}`, 3.08, 1.15, lz, -Math.PI / 2);
  }

  // Lower Rear Catwalk Balcony Lamps (y = 1.15m, z = -7.85m)
  for (let i = 0; i < 4; i++) {
    const lx = [-2.25, -0.75, 0.75, 2.25][i];
    addWorkLamp(`WorkLamp_Low_Rear_${i}`, lx, 1.15, -7.85, 0);
  }

  // Shielded warm amber under-ledge balcony strips along Tier-1 perimeter (y = 0.96m)
  const stripSideZ = [2.58, -0.25, -3.08, -5.92];
  for (let i = 0; i < stripSideZ.length; i++) {
    const sz = stripSideZ[i];
    for (const side of [-1, 1]) {
      const sg = new THREE.Group();
      sg.name = `CatwalkEdgeStrip_${side < 0 ? 'L' : 'R'}_${i}`;
      sg.position.set(side * 3.07, 0.96, sz);
      if (side > 0) sg.rotation.y = Math.PI;
      sg.add(
        new THREE.Mesh(stripLamp.housingGeo, darkIronMat),
        new THREE.Mesh(stripLamp.emitterGeo, amberEmitterMat)
      );
      lightsGroup.add(sg);
    }
  }
  for (const side of [-1, 1]) {
    const sg = new THREE.Group();
    sg.name = `CatwalkEdgeStrip_Rear_${side < 0 ? 'L' : 'R'}`;
    sg.position.set(side * 1.48, 0.96, -7.85);
    sg.rotation.y = -Math.PI / 2;
    sg.add(
      new THREE.Mesh(stripLamp.housingGeo, darkIronMat),
      new THREE.Mesh(stripLamp.emitterGeo, amberEmitterMat)
    );
    lightsGroup.add(sg);
  }

  // 2. Upper Pillar Caged Work Lamps (y = 4.3m) along Left & Right columns + Rear Tier-2
  const upperPillarZ = [1.167, -1.667, -4.5, -7.333, -10.167];
  for (let i = 0; i < upperPillarZ.length; i++) {
    const pz = upperPillarZ[i];
    addWorkLamp(`WorkLamp_Mid_L_${i}`, -3.55, 4.3, pz, Math.PI / 2);
    addWorkLamp(`WorkLamp_Mid_R_${i}`, 3.55, 4.3, pz, -Math.PI / 2);
  }
  addWorkLamp('WorkLamp_Mid_Rear_L', -1.65, 4.3, -7.85, 0);
  addWorkLamp('WorkLamp_Mid_Rear_R', 1.65, 4.3, -7.85, 0);

  // 3. High Gantry Accent Work Lamps (y = 7.35m)
  addWorkLamp('WorkLamp_High_L_0', -3.55, 7.35, -1.667, Math.PI / 2);
  addWorkLamp('WorkLamp_High_R_0', 3.55, 7.35, -1.667, -Math.PI / 2);
  addWorkLamp('WorkLamp_High_L_1', -3.55, 7.35, -7.333, Math.PI / 2);
  addWorkLamp('WorkLamp_High_R_1', 3.55, 7.35, -7.333, -Math.PI / 2);

  // -------------------------------------------------------------------------
  // F. Overhead Suspended Conduits & Hanging Curved Cable Bundles (OverheadCables)
  // -------------------------------------------------------------------------
  const cablesGroup = new THREE.Group();
  cablesGroup.name = 'OverheadCables';
  root.add(cablesGroup);

  const { longPipesGeo, trapezeRackGeo } = buildOverheadPipeRacksGeometries();
  const longPipesMesh = new THREE.Mesh(longPipesGeo, steelMat);
  longPipesMesh.name = 'CeilingLongitudinalPipes';
  cablesGroup.add(longPipesMesh);

  // Instance shared transverse trapeze racks & curved conduit drops across ceiling depth
  const trapezeZ = [-0.6, -3.1, -5.8, -8.5, -11.2];
  for (let i = 0; i < trapezeZ.length; i++) {
    const rack = new THREE.Mesh(trapezeRackGeo, steelMat);
    rack.name = `CeilingTrapezeRack_${i}`;
    rack.position.set(0, 0, trapezeZ[i]);
    cablesGroup.add(rack);
  }

  const { cablesGeo, clampCollarGeo, clampInstances } = buildHangingCablesData();
  const cableBundlesMesh = new THREE.Mesh(cablesGeo, cableMat);
  cableBundlesMesh.name = 'HangingCableBundles';
  cablesGroup.add(cableBundlesMesh);

  const clampsGroup = new THREE.Group();
  clampsGroup.name = 'CableBundleClamps';
  cablesGroup.add(clampsGroup);
  for (let i = 0; i < clampInstances.length; i++) {
    const ci = clampInstances[i];
    const collar = new THREE.Mesh(clampCollarGeo, darkIronMat);
    collar.position.copy(ci.pos);
    collar.quaternion.copy(ci.quat);
    collar.scale.set(ci.scaleR, 1, ci.scaleR);
    clampsGroup.add(collar);
  }

  return root;
}

// ---------------------------------------------------------------------------
// 6. Comprehensive Geometry Integrity, Bounding Box & Sightline Validation
// ---------------------------------------------------------------------------
function validateSceneGeometry(root) {
  root.updateMatrixWorld(true);

  const worldBox = new THREE.Box3();
  const tmpV = new THREE.Vector3();
  const tmpTriA = new THREE.Vector3();
  const tmpTriB = new THREE.Vector3();
  const tmpTriC = new THREE.Vector3();
  const triBox = new THREE.Box3();

  // Forbidden unobstructed playable sightline volume:
  // x in [-2.2, 2.2], y in [0.7, 3.6], z in [-3.0, 3.5]
  const sightlineBox = new THREE.Box3(
    new THREE.Vector3(-2.2, 0.7, -3.0),
    new THREE.Vector3(2.2, 3.6, 3.5)
  );

  let totalInstancedTris = 0;
  let totalInstancedVerts = 0;
  const sightlineViolations = [];

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const geom = obj.geometry;
    const pos = geom.getAttribute('position');
    const norm = geom.getAttribute('normal');
    const uv = geom.getAttribute('uv');
    const index = geom.getIndex();

    if (!pos || pos.count === 0) {
      throw new Error(`Mesh "${obj.name}" has empty position attribute`);
    }

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`NaN/Inf vertex detected in mesh "${obj.name}" at index ${i}`);
      }
      tmpV.set(x, y, z).applyMatrix4(obj.matrixWorld);
      worldBox.expandByPoint(tmpV);
    }
    if (norm) {
      for (let i = 0; i < norm.count; i++) {
        if (
          !Number.isFinite(norm.getX(i)) ||
          !Number.isFinite(norm.getY(i)) ||
          !Number.isFinite(norm.getZ(i))
        ) {
          throw new Error(`NaN/Inf normal detected in mesh "${obj.name}" at index ${i}`);
        }
      }
    }
    if (uv) {
      for (let i = 0; i < uv.count; i++) {
        if (!Number.isFinite(uv.getX(i)) || !Number.isFinite(uv.getY(i))) {
          throw new Error(`NaN/Inf UV detected in mesh "${obj.name}" at index ${i}`);
        }
      }
    }

    const triCount = index ? index.count / 3 : pos.count / 3;
    totalInstancedTris += triCount;
    totalInstancedVerts += pos.count;

    const meshBox = new THREE.Box3().setFromObject(obj);
    if (meshBox.intersectsBox(sightlineBox)) {
      for (let t = 0; t < triCount; t++) {
        const i0 = index ? index.getX(t * 3) : t * 3;
        const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
        tmpTriA.fromBufferAttribute(pos, i0).applyMatrix4(obj.matrixWorld);
        tmpTriB.fromBufferAttribute(pos, i1).applyMatrix4(obj.matrixWorld);
        tmpTriC.fromBufferAttribute(pos, i2).applyMatrix4(obj.matrixWorld);
        triBox.makeEmpty().expandByPoint(tmpTriA).expandByPoint(tmpTriB).expandByPoint(tmpTriC);
        if (triBox.intersectsBox(sightlineBox)) {
          const tri = new THREE.Triangle(tmpTriA, tmpTriB, tmpTriC);
          if (sightlineBox.intersectsTriangle(tri)) {
            sightlineViolations.push({
              mesh: obj.name || '(unnamed)',
              point: tmpTriA.toArray().map((n) => +n.toFixed(2)),
            });
            break;
          }
        }
      }
    }
  });

  if (sightlineViolations.length > 0) {
    throw new Error(
      `Playable sightline obstructed by: ${JSON.stringify(sightlineViolations)}`
    );
  }

  return {
    worldBox,
    totalInstancedTris: Math.round(totalInstancedTris),
    totalInstancedVerts,
  };
}

// ---------------------------------------------------------------------------
// 7. Execute Build, Export GLB, and Run Full Verification
// ---------------------------------------------------------------------------
const t0 = performance.now();
const arenaRoot = buildArenaScene();
const geomReport = validateSceneGeometry(arenaRoot);
const exportStats = exportSceneToGLB(arenaRoot, OUTPUT_PATH);
const inspectReport = inspectGLB(OUTPUT_PATH);
const elapsedMs = (performance.now() - t0).toFixed(0);

const requiredNodes = ['ArenaRoot', 'ArenaFloor', 'CatwalkLights', 'OverheadCables'];
for (const req of requiredNodes) {
  if (!inspectReport.nodeNames.includes(req)) {
    throw new Error(`Exported GLB missing required node "${req}"`);
  }
}

const minB = geomReport.worldBox.min.toArray().map((n) => +n.toFixed(2));
const maxB = geomReport.worldBox.max.toArray().map((n) => +n.toFixed(2));
const sizeB = geomReport.worldBox
  .getSize(new THREE.Vector3())
  .toArray()
  .map((n) => +n.toFixed(2));

console.log('=== Sentinel Pong: Arena Structure GLB Built & Verified ===');
console.log(`Output:               ${exportStats.outputPath}`);
console.log(`Build time:           ${elapsedMs} ms`);
console.log(`File size:            ${inspectReport.sizeKB} KB (${exportStats.byteLength} bytes)`);
console.log(`Unique mesh tris:     ${inspectReport.triangles} tris (${inspectReport.vertices} verts across ${inspectReport.meshes} unique meshes)`);
console.log(`Total instanced tris: ${geomReport.totalInstancedTris} tris (${geomReport.totalInstancedVerts} verts)`);
console.log(`Scene graph nodes:    ${inspectReport.nodes}`);
console.log(`Materials / Textures: ${inspectReport.materials} mats / ${inspectReport.textures} textures`);
console.log(`Required nodes OK:    ${requiredNodes.join(', ')}`);
console.log(`Playable sightline:   CLEAR (x[-2.2..2.2], y[0.7..3.6], z[-3.0..3.5])`);
console.log(`World bounding box:   min=${JSON.stringify(minB)} max=${JSON.stringify(maxB)} size=${JSON.stringify(sizeB)}`);
