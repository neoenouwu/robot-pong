/**
 * Procedural 1:1 Artwork-Faithful Hero 3D Boss Model Builder — Sentinel Reference
 * Output: `public/models/sentinel_reference.glb`
 *
 * Engineered to match the reference Sentinel Pong artwork with 1:1 silhouette & detail fidelity:
 * - Taller, fuller rounded beetle-skull patchwork carapace (~1.95m W x 1.05m H x 1.75m D)
 *   built from 45+ individually beveled dark charred-iron overlapping hull tiles, staggered
 *   patchwork seam straps, recessed mechanical under-ribs, forged bolts, cavernous craggy
 *   mechanical jaw/chin undercarriage, and a dense vertical "beard" of 32 hanging wires,
 *   rigid metallic antennae, and drooping cable tendrils (0.55m–0.88m).
 * - Iconic asymmetric Matrix crimson optical constellation: deeply recessed `MainEyeCore`
 *   (~0.24m aperture) inside a dark stepped gunmetal camera-barrel bezel with fiery pure
 *   crimson-red halo + blinding white-crimson core + 16 asymmetric `SubEyes` across the
 *   left/right brow-cheeks and recessed dark ventral chin pipes.
 * - Ultra-dense, heavy interlocking centipede-armor tentacles (zero air gaps) with sculpted
 *   segmented faceted outer armor rings, recessed transverse vertebra grooves, hydraulic side
 *   linkages, forged knuckle clamps, and subtle tiny recessed pinpoint crimson diodes:
 *   - 16-segment thick primary paddle arm (`PaddleArm_Seg_00`..`15`, r=0.165m -> 0.105m)
 *     terminating in a bulky sculpted 4-fingered armored industrial gauntlet `PaddleClaw` + `PaddleSocket`.
 *   - 8 sweeping Medusa-like background tentacles (`BgTentacle_0`..`7`, 12–14 segments each +
 *     `BgTentacle_{i}_Claw`), including the soaring upper-left overhead coil, curved S-arc
 *     foreground-right diagonal arm, flanking catwalk arcs, and outward-sweeping canopy tendrils.
 * - High-detail procedural PBR PNG textures (512x512 charred patchwork iron/oily gunmetal +
 *   256x256 pure fiery crimson camera-optic iris).
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
} from './glb-builder.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, '../public/models/sentinel_reference.glb');

// ---------------------------------------------------------------------------
// Deterministic PRNG & Math Helpers
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Safe Indexed Geometry Utilities & Winding Verification
// ---------------------------------------------------------------------------
function ensureValidAttributes(geom, label = 'Geometry') {
  const pos = geom.getAttribute('position');
  if (!pos || pos.count === 0) {
    throw new Error(`${label}: missing or empty position attribute`);
  }
  if (!geom.getAttribute('normal')) {
    geom.computeVertexNormals();
  }
  const norm = geom.getAttribute('normal');
  if (!geom.getAttribute('uv')) {
    const uvs = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uvs[i * 2] = pos.getX(i) * 0.5 + 0.5;
      uvs[i * 2 + 1] = pos.getZ(i) * 0.5 + 0.5;
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }
  const uv = geom.getAttribute('uv');

  for (let i = 0; i < pos.array.length; i++) {
    if (!Number.isFinite(pos.array[i])) {
      throw new Error(`${label}: non-finite position at index ${i}`);
    }
  }
  for (let i = 0; i < norm.count; i++) {
    const nx = norm.getX(i);
    const ny = norm.getY(i);
    const nz = norm.getZ(i);
    const len = Math.hypot(nx, ny, nz);
    if (!Number.isFinite(len) || len < 1e-6) {
      norm.setXYZ(i, 0, 1, 0);
    } else if (Math.abs(len - 1) > 1e-3) {
      norm.setXYZ(i, nx / len, ny / len, nz / len);
    }
  }
  for (let i = 0; i < uv.array.length; i++) {
    if (!Number.isFinite(uv.array[i])) {
      uv.array[i] = 0;
    }
  }
  return geom;
}

function computeSignedVolume(geom) {
  const pos = geom.getAttribute('position');
  const idx = geom.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let vol6 = 0;

  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      cross.crossVectors(b, c);
      vol6 += a.dot(cross);
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      cross.crossVectors(b, c);
      vol6 += a.dot(cross);
    }
  }
  return vol6 / 6;
}

function mergeIndexedGeometries(geoms, label = 'Merged') {
  const valid = geoms.filter(Boolean).map((g, idx) => ensureValidAttributes(g, `${label}[${idx}]`));
  if (valid.length === 0) {
    throw new Error(`${label}: no geometries to merge`);
  }

  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of valid) {
    const pos = g.getAttribute('position');
    totalVerts += pos.count;
    const idx = g.getIndex();
    totalIndices += idx ? idx.count : pos.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices =
    totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

  let vOff = 0;
  let iOff = 0;
  for (const g of valid) {
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const count = pos.count;

    for (let i = 0; i < count; i++) {
      const p3 = (vOff + i) * 3;
      const u2 = (vOff + i) * 2;
      positions[p3] = pos.getX(i);
      positions[p3 + 1] = pos.getY(i);
      positions[p3 + 2] = pos.getZ(i);
      normals[p3] = norm.getX(i);
      normals[p3 + 1] = norm.getY(i);
      normals[p3 + 2] = norm.getZ(i);
      uvs[u2] = uv.getX(i);
      uvs[u2 + 1] = uv.getY(i);
    }

    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices[iOff + i] = idx.getX(i) + vOff;
      }
      iOff += idx.count;
    } else {
      for (let i = 0; i < count; i++) {
        indices[iOff + i] = i + vOff;
      }
      iOff += count;
    }
    vOff += count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return ensureValidAttributes(out, label);
}

function transformed(geom, matrix) {
  const g = geom.clone();
  g.applyMatrix4(matrix);
  return g;
}

function makeTransform(pos, rotEuler, scale) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (rotEuler) q.setFromEuler(rotEuler);
  const p = pos || new THREE.Vector3();
  const s = scale || new THREE.Vector3(1, 1, 1);
  m.compose(p, q, s);
  return m;
}

/**
 * Compact 6-sided raised machined hex bolt cap (base flush on y=0, top at y=height).
 */
function buildHexBoltCap(radius, height) {
  const sides = 6;
  const verts = [];
  const uvs = [];
  const idx = [];

  verts.push(0, height, 0);
  uvs.push(0.5, 0.5);

  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    verts.push(ca * radius * 0.84, height, sa * radius * 0.84);
    uvs.push(0.5 + ca * 0.4, 0.5 + sa * 0.4);
  }
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    verts.push(ca * radius, 0, sa * radius);
    uvs.push(0.5 + ca * 0.5, 0.5 + sa * 0.5);
  }

  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    idx.push(0, 1 + next, 1 + i);
    const t0 = 1 + i;
    const t1 = 1 + next;
    const b0 = 1 + sides + i;
    const b1 = 1 + sides + next;
    idx.push(t0, t1, b1, t0, b1, b0);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return ensureValidAttributes(g, 'HexBoltCap');
}

/**
 * Builds a closed, solid beveled curved armor tile with finite thickness, chamfered
 * outer rim edges (catching bright oily metallic highlights), and verified positive signed volume.
 */
function buildBeveledCurvedTile(
  uSegs,
  vSegs,
  evalFn,
  thickness = 0.032,
  bevelDrop = 0.0085,
  uvOffsetU = 0,
  uvOffsetV = 0,
  uvRepeatU = 0.85,
  uvRepeatV = 0.72,
  insideRef = new THREE.Vector3(0, -0.18, -0.05)
) {
  const pC = evalFn(0.5, 0.5);
  const pU = evalFn(0.55, 0.5);
  const pV = evalFn(0.5, 0.55);
  const testCross = new THREE.Vector3()
    .subVectors(pU, pC)
    .cross(new THREE.Vector3().subVectors(pV, pC));
  const outVec = new THREE.Vector3().subVectors(pC, insideRef);
  const flipU = testCross.dot(outVec) < 0;

  const cols = uSegs + 1;
  const rows = vSegs + 1;
  const basePts = new Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const v = j / vSegs;
    for (let i = 0; i < cols; i++) {
      const uRaw = i / uSegs;
      const u = flipU ? 1 - uRaw : uRaw;
      basePts[j * cols + i] = evalFn(u, v);
    }
  }

  const normals = new Array(cols * rows);
  const du = new THREE.Vector3();
  const dv = new THREE.Vector3();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(uSegs, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(vSegs, j + 1);
      du.subVectors(basePts[j * cols + i1], basePts[j * cols + i0]);
      dv.subVectors(basePts[j1 * cols + i], basePts[j0 * cols + i]);
      const n = new THREE.Vector3().crossVectors(du, dv);
      if (n.lengthSq() < 1e-10) {
        n.copy(basePts[j * cols + i]).sub(insideRef).normalize();
      } else {
        n.normalize();
      }
      normals[j * cols + i] = n;
    }
  }

  const outerPts = new Array(cols * rows);
  const innerPts = new Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const onEdgeV = j === 0 || j === vSegs;
    for (let i = 0; i < cols; i++) {
      const onEdgeU = i === 0 || i === uSegs;
      const k = j * cols + i;
      const edgeDrop = onEdgeU && onEdgeV ? bevelDrop * 1.25 : onEdgeU || onEdgeV ? bevelDrop : 0;
      outerPts[k] = basePts[k].clone().addScaledVector(normals[k], -edgeDrop);
      innerPts[k] = basePts[k].clone().addScaledVector(normals[k], -thickness);
    }
  }

  const parts = [];

  // 1. Outer armored face
  {
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    const idx = [];
    for (let j = 0; j < rows; j++) {
      const v = j / vSegs;
      for (let i = 0; i < cols; i++) {
        const u = i / uSegs;
        const k = j * cols + i;
        const p = outerPts[k];
        pos[k * 3] = p.x;
        pos[k * 3 + 1] = p.y;
        pos[k * 3 + 2] = p.z;
        uv[k * 2] = uvOffsetU + u * uvRepeatU;
        uv[k * 2 + 1] = uvOffsetV + v * uvRepeatV;
      }
    }
    for (let j = 0; j < vSegs; j++) {
      for (let i = 0; i < uSegs; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        idx.push(a, b, d, a, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
  }

  // 2. Inner backing face
  {
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    const idx = [];
    for (let j = 0; j < rows; j++) {
      const v = j / vSegs;
      for (let i = 0; i < cols; i++) {
        const u = i / uSegs;
        const k = j * cols + i;
        const p = innerPts[k];
        pos[k * 3] = p.x;
        pos[k * 3 + 1] = p.y;
        pos[k * 3 + 2] = p.z;
        uv[k * 2] = uvOffsetU + u * uvRepeatU;
        uv[k * 2 + 1] = uvOffsetV + v * uvRepeatV;
      }
    }
    for (let j = 0; j < vSegs; j++) {
      for (let i = 0; i < uSegs; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        idx.push(a, d, b, a, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
  }

  // 3. Four outward-facing rim walls
  function buildRimStrip(outerSeq, innerSeq) {
    const n = outerSeq.length;
    const pos = new Float32Array(n * 2 * 3);
    const uv = new Float32Array(n * 2 * 2);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const po = outerSeq[i];
      const pi = innerSeq[i];
      pos[i * 6] = po.x;
      pos[i * 6 + 1] = po.y;
      pos[i * 6 + 2] = po.z;
      pos[i * 6 + 3] = pi.x;
      pos[i * 6 + 4] = pi.y;
      pos[i * 6 + 5] = pi.z;
      uv[i * 4] = t * 1.1;
      uv[i * 4 + 1] = 0.02;
      uv[i * 4 + 2] = t * 1.1;
      uv[i * 4 + 3] = 0.14;
    }
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      idx.push(a, b, d, a, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  const frontO = [], frontI = [];
  const backO = [], backI = [];
  for (let i = 0; i < cols; i++) {
    frontO.push(outerPts[i]);
    frontI.push(innerPts[i]);
    backO.push(outerPts[vSegs * cols + (cols - 1 - i)]);
    backI.push(innerPts[vSegs * cols + (cols - 1 - i)]);
  }
  const leftO = [], leftI = [];
  const rightO = [], rightI = [];
  for (let j = 0; j < rows; j++) {
    rightO.push(outerPts[j * cols + uSegs]);
    rightI.push(innerPts[j * cols + uSegs]);
    leftO.push(outerPts[(rows - 1 - j) * cols]);
    leftI.push(innerPts[(rows - 1 - j) * cols]);
  }
  parts.push(
    buildRimStrip(frontO, frontI),
    buildRimStrip(rightO, rightI),
    buildRimStrip(backO, backI),
    buildRimStrip(leftO, leftI)
  );

  const merged = mergeIndexedGeometries(parts, 'BeveledCurvedTile');
  const vol = computeSignedVolume(merged);
  if (vol <= 0) {
    throw new Error(`BeveledCurvedTile winding check failed! signedVolume=${vol.toFixed(6)}`);
  }
  return merged;
}

/**
 * Builds a +Z-facing curved optical dome lens with crisp planar circular UVs
 * centered at (0.5, 0.5) so concentric crimson iris textures map without polar distortion.
 */
function buildOpticalDome(radius, domeDepth, radialSegs = 28, ringSegs = 8) {
  const verts = [];
  const norms = [];
  const uvs = [];
  const indices = [];

  verts.push(0, 0, domeDepth);
  norms.push(0, 0, 1);
  uvs.push(0.5, 0.5);

  for (let r = 1; r <= ringSegs; r++) {
    const frac = r / ringSegs;
    const rad = radius * frac;
    const z = domeDepth * Math.cos(frac * Math.PI * 0.5);
    const slope = ((domeDepth * Math.PI * 0.5) / radius) * Math.sin(frac * Math.PI * 0.5);

    for (let s = 0; s < radialSegs; s++) {
      const a = (s / radialSegs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      verts.push(rad * ca, rad * sa, z);

      const nx = slope * ca;
      const ny = slope * sa;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      norms.push(nx * inv, ny * inv, nz * inv);

      uvs.push(0.5 + 0.5 * frac * ca, 0.5 + 0.5 * frac * sa);
    }
  }

  for (let s = 0; s < radialSegs; s++) {
    const next = (s + 1) % radialSegs;
    indices.push(0, 1 + s, 1 + next);
  }
  for (let r = 1; r < ringSegs; r++) {
    const row0 = 1 + (r - 1) * radialSegs;
    const row1 = 1 + r * radialSegs;
    for (let s = 0; s < radialSegs; s++) {
      const next = (s + 1) % radialSegs;
      indices.push(row0 + s, row1 + s, row1 + next);
      indices.push(row0 + s, row1 + next, row0 + next);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return ensureValidAttributes(g, 'OpticalDome');
}

/**
 * Closed beveled trapezoidal armor block (oriented along +Z, centered on X=0, sitting on Y=0..height).
 */
function buildBeveledArmorPlateBox(widthRear, widthFront, height, length, bevel = 0.008) {
  const shape = new THREE.Shape();
  const hwR = widthRear * 0.5;
  const hwF = widthFront * 0.5;
  const hl = length * 0.5;
  shape.moveTo(-hwR, -hl);
  shape.lineTo(hwR, -hl);
  shape.lineTo(hwF, hl);
  shape.lineTo(-hwF, hl);
  shape.closePath();

  const extrudeDepth = Math.max(0.002, height - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: extrudeDepth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.85,
    bevelSegments: 1,
  });
  g.rotateX(Math.PI * 0.5);
  g.translate(0, height - bevel, 0);
  // Normalize ExtrudeGeometry world-unit UVs so charred-iron PBR texture maps crisply across small armor plates
  const uv = g.getAttribute('uv');
  if (uv) {
    const uvScale = 1.0 / Math.max(0.08, Math.max(widthRear, length) * 2.4);
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * uvScale + 0.17, uv.getY(i) * uvScale + 0.29);
    }
  }
  g.computeVertexNormals();
  return ensureValidAttributes(g, 'BeveledArmorPlateBox');
}

/**
 * Aligns an Object3D at `pos` with its local +Z axis strictly pointing along `tangent`.
 */
function orientObjectAlongSpine(obj, pos, tangent, preferredUp = new THREE.Vector3(0, 1, 0)) {
  const zAxis = tangent.clone().normalize();
  let up = preferredUp.clone();
  if (Math.abs(zAxis.dot(up)) > 0.96) {
    up.set(0, 0, -1);
    if (Math.abs(zAxis.dot(up)) > 0.96) up.set(1, 0, 0);
  }
  const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const rotMat = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);

  obj.position.copy(pos);
  obj.quaternion.setFromRotationMatrix(rotMat);
}

// ---------------------------------------------------------------------------
// High-Detail Procedural PBR Textures
// ---------------------------------------------------------------------------
function createCharredIronArmorTextures(size = 512) {
  const heightData = new Float32Array(size * size);

  // Asymmetric patchwork hull seam grid (staggered forged dark iron plates)
  const hSeams = [0.0, 0.22, 0.49, 0.74];
  const vSeamsByRow = [
    [0.0, 0.31, 0.64],
    [0.14, 0.48, 0.82],
    [0.04, 0.37, 0.71],
    [0.18, 0.54, 0.88],
  ];

  function distToNearest(val, list) {
    let minD = 1.0;
    for (let i = 0; i < list.length; i++) {
      let d = Math.abs(val - list[i]);
      if (d > 0.5) d = 1.0 - d;
      if (d < minD) minD = d;
    }
    return minD;
  }

  function rowIndexForV(v) {
    for (let r = 0; r < hSeams.length; r++) {
      const next = r + 1 < hSeams.length ? hSeams[r + 1] : 1.0;
      if (v >= hSeams[r] && v < next) return r;
    }
    return 0;
  }

  const rand = mulberry32(88421);
  const scratches = [];
  for (let i = 0; i < 68; i++) {
    scratches.push({
      x0: rand(),
      y0: rand(),
      angle: (rand() - 0.5) * 0.68 + (i % 3 === 0 ? Math.PI * 0.5 : 0),
      len: 0.03 + rand() * 0.14,
      width: 0.0012 + rand() * 0.0020,
      depth: 0.22 + rand() * 0.30,
    });
  }

  const seamMask = new Float32Array(size * size);
  const weldMask = new Float32Array(size * size);
  const rivetMask = new Float32Array(size * size);
  const scratchMask = new Float32Array(size * size);
  const edgeWearMask = new Float32Array(size * size);
  const tileTint = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const rowIdx = rowIndexForV(v);
    const vSeams = vSeamsByRow[rowIdx];
    const dH = distToNearest(v, hSeams);

    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const dV = distToNearest(u, vSeams);
      const dSeam = Math.min(dV, dH);

      let colIdx = 0;
      for (let c = 0; c < vSeams.length; c++) {
        if (u >= vSeams[c]) colIdx = c;
      }
      const tileHash = ((rowIdx * 17 + colIdx * 31 + 7) % 11) / 11;
      tileTint[idx] = tileHash;

      const brush = fbmTileable(u, v * 0.3, 18, 3, 131) * 0.55 + fbmTileable(u, v, 36, 2, 233) * 0.45;
      const hammered = fbmTileable(u, v, 10, 4, 349);
      const finePits = fbmTileable(u, v, 28, 3, 467);

      let h = 0.56 + (brush - 0.5) * 0.07 + (hammered - 0.5) * 0.09 + (tileHash - 0.5) * 0.04;

      const groove = 1.0 - smoothstep(0.0035, 0.0115, dSeam);
      const bevelLip =
        smoothstep(0.009, 0.0155, dSeam) * (1.0 - smoothstep(0.0155, 0.026, dSeam));

      const weldWave = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 48 + hammered * 5.0);
      const weld = (1.0 - smoothstep(0.008, 0.016, dH)) * smoothstep(0.004, 0.009, dH) * weldWave;

      h -= groove * 0.52;
      h += bevelLip * 0.11 + weld * 0.075;

      let riv = 0;
      const marginDist = 0.032;
      const nearH = Math.abs(dH - marginDist) < 0.012 && dV > 0.024;
      const nearV = Math.abs(dV - marginDist) < 0.012 && dH > 0.024;
      if (nearH || nearV) {
        const spacing = 1 / 18;
        let rx = 1;
        let ry = 1;
        if (nearH) {
          rx = (((u % spacing) + spacing) % spacing) - spacing * 0.5;
          ry = dH - marginDist;
        } else {
          rx = dV - marginDist;
          ry = (((v % spacing) + spacing) % spacing) - spacing * 0.5;
        }
        const rDist = Math.hypot(rx, ry);
        if (rDist < 0.0086) {
          const dome = Math.sqrt(Math.max(0, 1 - (rDist / 0.0068) ** 2));
          const ring =
            smoothstep(0.0058, 0.0072, rDist) * (1.0 - smoothstep(0.0072, 0.0086, rDist));
          riv = dome;
          h += dome * 0.28 - ring * 0.16;
        }
      }

      if (finePits < 0.27) {
        h -= (0.27 - finePits) * 0.42;
      }

      heightData[idx] = clamp(h, 0, 1);
      seamMask[idx] = groove;
      weldMask[idx] = weld;
      rivetMask[idx] = riv;
      edgeWearMask[idx] = clamp(bevelLip * 0.90 + weld * 0.45 + hammered * 0.24, 0, 1);
    }
  }

  for (const sc of scratches) {
    const steps = Math.ceil(sc.len * size * 1.5);
    const dx = Math.cos(sc.angle) * sc.len;
    const dy = Math.sin(sc.angle) * sc.len;
    const radPx = Math.max(1, Math.ceil(sc.width * size));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const fade = Math.sin(t * Math.PI);
      const cx = Math.floor(((((sc.x0 + dx * t) % 1) + 1) % 1) * size);
      const cy = Math.floor(((((sc.y0 + dy * t) % 1) + 1) % 1) * size);
      for (let oy = -radPx; oy <= radPx; oy++) {
        for (let ox = -radPx; ox <= radPx; ox++) {
          const d = Math.hypot(ox, oy) / radPx;
          if (d <= 1) {
            const px = (cx + ox + size) % size;
            const py = (cy + oy + size) % size;
            const idx = py * size + px;
            const amt = (1 - d) * fade * sc.depth;
            heightData[idx] = clamp(heightData[idx] - amt * 0.38, 0, 1);
            scratchMask[idx] = Math.max(scratchMask[idx], amt);
          }
        }
      }
    }
  }

  // BaseColor (sRGB): Dark charred weathered iron (#24282b) with oil grime & crisp metallic edge wear
  const baseColor = createPixelTexture(size, size, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const idx = y * w + x;
        const oilGrime = fbmTileable(u, v, 6, 4, 577);
        const streak = fbmTileable(u * 0.6, v * 1.6, 12, 3, 661);
        const patina = fbmTileable(u, v, 8, 3, 743);
        const tTone = (tileTint[idx] - 0.5) * 14;

        let r = 36 + tTone + (oilGrime - 0.5) * 16 + (streak - 0.5) * 9;
        let g = 40 + tTone + (oilGrime - 0.5) * 18 + (streak - 0.5) * 9 + Math.max(0, patina - 0.54) * 11;
        let b = 43 + tTone + (oilGrime - 0.5) * 17 + (streak - 0.5) * 9;

        if (oilGrime < 0.38) {
          const grimeMul = 1.0 - (0.38 - oilGrime) * 1.18;
          r *= grimeMul;
          g *= grimeMul;
          b *= grimeMul;
        }

        const ew = edgeWearMask[idx];
        const sc = scratchMask[idx];
        const wd = weldMask[idx];
        r += ew * 27 + sc * 82 + wd * 17;
        g += ew * 31 + sc * 90 + wd * 20;
        b += ew * 33 + sc * 94 + wd * 21;

        const riv = rivetMask[idx];
        if (riv > 0.01) {
          r = r * (1 - riv) + 96 * riv;
          g = g * (1 - riv) + 104 * riv;
          b = b * (1 - riv) + 109 * riv;
        }

        const seam = seamMask[idx];
        const seamFactor = 1.0 - seam * 0.86;
        r *= seamFactor;
        g *= seamFactor;
        b *= seamFactor;

        const p = idx * 4;
        out[p] = clamp(Math.round(r), 5, 255);
        out[p + 1] = clamp(Math.round(g), 6, 255);
        out[p + 2] = clamp(Math.round(b), 7, 255);
        out[p + 3] = 255;
      }
    }
  });

  // glTF 2.0 MetallicRoughness: G = Roughness (0.24..0.58 oily weathered iron), B = Metalness (0.85..0.96)
  const metallicRoughness = createPixelTexture(size, size, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const idx = y * w + x;
        const oilSlick = fbmTileable(u, v, 7, 4, 887);
        const micro = fbmTileable(u, v, 26, 2, 953);

        let rough = 0.40 + (oilSlick - 0.5) * 0.28 + (micro - 0.5) * 0.09;
        let metal = 0.90 + (oilSlick - 0.5) * 0.09;

        const riv = rivetMask[idx];
        const sc = scratchMask[idx];
        const ew = edgeWearMask[idx];
        rough -= riv * 0.13 + sc * 0.20 + ew * 0.11;
        metal += riv * 0.06 + sc * 0.06 + ew * 0.04;

        const seam = seamMask[idx];
        rough = rough * (1 - seam) + 0.86 * seam;
        metal = metal * (1 - seam) + 0.30 * seam;

        const p = idx * 4;
        out[p] = 255;
        out[p + 1] = clamp(Math.round(clamp(rough, 0.22, 0.90) * 255), 0, 255); // G = Roughness
        out[p + 2] = clamp(Math.round(clamp(metal, 0.24, 0.98) * 255), 0, 255); // B = Metalness
        out[p + 3] = 255;
      }
    }
  });

  const normal = heightMapToNormalTexture(size, size, heightData, 3.8);
  return { baseColor, metallicRoughness, normal };
}

/**
 * Pure fiery Matrix Crimson Camera-Optic Iris (deep molten crimson outer halo +
 * blazing white-crimson pinpoint lens center — zero yellow/orange muddiness!).
 */
function createCrimsonOpticTextures(size = 256) {
  const clampOpts = { wrapS: 33071, wrapT: 33071 }; // CLAMP_TO_EDGE

  const paintOptic = (isEmissive) =>
    createPixelTexture(
      size,
      size,
      (out, w, h) => {
        for (let y = 0; y < h; y++) {
          const ny = ((y + 0.5) / h) * 2 - 1;
          for (let x = 0; x < w; x++) {
            const nx = ((x + 0.5) / w) * 2 - 1;
            const r = Math.hypot(nx, ny);
            const ang = Math.atan2(ny, nx);
            const idx = (y * w + x) * 4;

            const radialGrain =
              0.60 +
              0.22 * Math.sin(ang * 20 + r * 7.5) +
              0.18 * Math.cos(ang * 38 - r * 11.0);
            const lensRing1 = Math.exp(-((r - 0.36) ** 2) / 0.00060);
            const lensRing2 = Math.exp(-((r - 0.60) ** 2) / 0.00085);
            const darkGroove = Math.exp(-((r - 0.74) ** 2) / 0.0017);

            // Searing pinpoint white-pink-crimson center + pure molten blood-crimson outer halo
            const pinpointCore = Math.exp(-(r * r) / 0.020);
            const hotInner = Math.exp(-(r * r) / 0.090);
            const moltenHalo = Math.exp(-(r * r) / 0.34);
            const rimMask = 1.0 - smoothstep(0.76, 0.97, r);

            let cr =
              ((isEmissive ? 245 : 225) * moltenHalo * (0.78 + 0.28 * radialGrain) +
                140 * hotInner +
                115 * pinpointCore +
                88 * lensRing1 +
                58 * lensRing2) *
              rimMask;
            // Keep green very low outside pinpointCore so halo stays pure fiery Matrix crimson!
            let cg = (4 * moltenHalo + 14 * hotInner + 225 * pinpointCore + 12 * lensRing1) * rimMask;
            let cb = (8 * moltenHalo + 24 * hotInner + 218 * pinpointCore + 14 * lensRing1) * rimMask;

            const grooveMul = 1.0 - darkGroove * (isEmissive ? 0.50 : 0.45);
            cr *= grooveMul;
            cg *= grooveMul;
            cb *= grooveMul;

            const minVal = isEmissive ? 0 : 8;
            out[idx] = clamp(Math.round(cr), minVal, 255);
            out[idx + 1] = clamp(Math.round(cg), isEmissive ? 0 : 2, 255);
            out[idx + 2] = clamp(Math.round(cb), isEmissive ? 0 : 3, 255);
            out[idx + 3] = 255;
          }
        }
      },
      clampOpts
    );

  return { baseColor: paintOptic(false), emissive: paintOptic(true) };
}

function createMaterials() {
  const armorTex = createCharredIronArmorTextures(512);
  const eyeTex = createCrimsonOpticTextures(256);

  // Primary charred patchwork iron carapace & armored vertebra outer shells
  const armorPrimary = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'SentinelCharredIronArmor',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(1.45, 1.45),
    }),
    {
      baseColor: armorTex.baseColor,
      metallicRoughness: armorTex.metallicRoughness,
      normal: armorTex.normal,
    }
  );

  // Darker matte-gunmetal camera barrels, cavernous mechanical chin/underbelly & flex bellows
  const armorDark = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'SentinelDarkSubchassis',
      color: 0x484e53,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(1.2, 1.2),
    }),
    {
      baseColor: armorTex.baseColor,
      metallicRoughness: armorTex.metallicRoughness,
      normal: armorTex.normal,
    }
  );

  // Forged oiled dark-steel rivets, hydraulic rods, knuckle hinge pins & wire ferrules
  const machinedSteel = new THREE.MeshStandardMaterial({
    name: 'SentinelMachinedSteel',
    color: 0x677077,
    metalness: 0.94,
    roughness: 0.28,
  });

  // Dark matte-metallic hanging wires, rigid antennae & braided underbelly hoses
  const darkTendrilWire = new THREE.MeshStandardMaterial({
    name: 'SentinelHangingWireMetal',
    color: 0x15191b,
    metalness: 0.54,
    roughness: 0.45,
  });

  // Blazing central main eye lens (molten pure crimson halo + blinding white-crimson pinpoint core)
  const mainEye = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'SentinelMainEyeOptic',
      color: 0xffffff,
      roughness: 0.08,
      metalness: 0.06,
      emissive: 0xffffff,
      emissiveIntensity: 5.0,
    }),
    {
      baseColor: eyeTex.baseColor,
      emissive: eyeTex.emissive,
    }
  );

  // Asymmetric flanking crimson camera-lens sub-eyes
  const subEye = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'SentinelSubEyeOptic',
      color: 0xffffff,
      roughness: 0.10,
      metalness: 0.08,
      emissive: 0xffffff,
      emissiveIntensity: 4.3,
    }),
    {
      baseColor: eyeTex.baseColor,
      emissive: eyeTex.emissive,
    }
  );

  // Dynamic threat-phase reactive crimson aperture ring & recessed ventral chin pinpoint sensors
  // (emissive.r > 0.4, emissive.g < 0.35 -> automatically pulsed by SentinelController!)
  const crimsonPulseSensor = new THREE.MeshStandardMaterial({
    name: 'SentinelCrimsonPulseSensor',
    color: 0x260205,
    emissive: 0xff0d18,
    emissiveIntensity: 2.8,
    roughness: 0.16,
    metalness: 0.10,
  });

  // Subtle recessed pinpoint crimson LED indicator diodes on armored tentacle vertebrae
  // (linear r ≈ 0.31 < 0.4 so they stay subtle & authentic instead of overpowering the silhouette!)
  const tentacleDiode = new THREE.MeshStandardMaterial({
    name: 'SentinelTentaclePinpointDiode',
    color: 0x220204,
    emissive: 0x980a10,
    emissiveIntensity: 2.8,
    roughness: 0.18,
    metalness: 0.12,
  });

  return {
    armorPrimary,
    armorDark,
    machinedSteel,
    darkTendrilWire,
    mainEye,
    subEye,
    crimsonPulseSensor,
    tentacleDiode,
  };
}

// ---------------------------------------------------------------------------
// Taller, Fuller Rounded Beetle-Dome Carapace Surface Parameterization
// Targets: ~1.95m W (X), ~1.05m H (Y, dome + deep mechanical belly), ~1.75m D (Z)
// ---------------------------------------------------------------------------
function evalBeetleDomePoint(theta, phi, lift = 0) {
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta); // +1 front (+Z), -1 rear (-Z)

  // Compact ~1.95m width and ~1.75m depth with full rounded beetle-skull curve
  const rearTaper = cosT < 0 ? 1.0 - 0.15 * Math.pow(-cosT, 1.45) : 1.0;
  const frontFullness = cosT > 0 ? 1.0 + 0.035 * Math.pow(cosT, 1.5) * sinP : 1.0;
  const rimFlare = 0.034 * smoothstep(0.35 * Math.PI, 0.51 * Math.PI, phi);

  const rx = 0.892 * rearTaper + rimFlare + lift;
  const rzFront = 0.79 * frontFullness + rimFlare * 0.78 + lift;
  const rzRear = 0.81 + rimFlare * 0.58 + lift;
  const rz = cosT >= 0 ? rzFront : rzRear;

  const rHoriz = Math.pow(Math.max(0, sinP), 0.90);
  const x = sinT * rHoriz * rx;
  const z = -0.04 + cosT * rHoriz * rz;

  // Taller bulbous hemispherical crown (~+0.60m apex above midline) with smooth rounded top arch
  const domeHeight = 0.565 + lift * 0.92;
  const rearSlope = cosT < 0 ? -0.042 * Math.pow(-cosT, 1.4) * sinP : 0;
  // Subtle lateral skirt droop along sides, while keeping front brow cleanly arched ABOVE the eyes!
  const sideSkirtDrop =
    -0.088 * Math.pow(Math.abs(sinT), 1.65) * smoothstep(0.35 * Math.PI, 0.53 * Math.PI, phi);
  const frontVisorArch =
    cosT > 0.35
      ? 0.042 * Math.pow((cosT - 0.35) / 0.65, 1.4) * smoothstep(0.36 * Math.PI, 0.52 * Math.PI, phi)
      : 0;

  const y =
    0.035 +
    Math.pow(Math.max(0, cosP), 0.82) * domeHeight +
    rearSlope +
    sideSkirtDrop +
    frontVisorArch;

  return new THREE.Vector3(x, y, z);
}

// ---------------------------------------------------------------------------
// Carapace, Patchwork Armor, Deep Craggy Jaw/Underbelly, Hanging Beard & Eyes
// ---------------------------------------------------------------------------
function buildCarapace(mats, shoulderSockets) {
  const carapace = new THREE.Group();
  carapace.name = 'Carapace';

  const armorGeoms = [];
  const darkGeoms = [];
  const steelGeoms = [];
  const wireGeoms = [];
  const pulseGeoms = [];

  const boltProto = buildHexBoltCap(0.0085, 0.008);
  const rand = mulberry32(20499);

  // 1. Sealed Sculpted Dark Inner Skull & Lower Mechanical Chassis Core
  {
    const innerHull = new THREE.SphereGeometry(1, 28, 18);
    const pos = innerHull.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);

      const rearScale = z < 0 ? 1.0 - 0.16 * -z : 1.0;
      if (y >= 0) {
        x *= 0.84 * rearScale;
        y = 0.03 + Math.pow(y, 0.84) * 0.53;
        z = -0.04 + z * (z >= 0 ? 0.74 : 0.77);
      } else {
        // Deep mechanical chin & cavernous lower belly housing (y down to -0.42)
        const taper = 1.0 - 0.36 * Math.pow(-y, 1.25);
        x *= 0.80 * rearScale * taper;
        y = 0.02 + y * 0.41;
        z = -0.04 + z * (z >= 0 ? 0.72 : 0.74) * taper;
      }

      // Recessed dark optical visor bay on front face
      if (z > 0.52 && Math.abs(x) < 0.62 && y > -0.25 && y < 0.18) {
        const bayFactor = 1.0 - Math.min(1, (x / 0.64) ** 2);
        z = Math.min(z, 0.625 + 0.055 * bayFactor);
      }
      pos.setXYZ(i, x, y, z);
    }
    innerHull.computeVertexNormals();
    darkGeoms.push(innerHull);
  }

  // 2. Patchwork Beetle-Dome Armor Plates (45+ individually beveled overlapping iron tiles!)
  // 2a. Rounded Hemispherical Octagonal Crown Cap (smooth dome apex, zero flat plateau!)
  {
    const crownPts = [
      new THREE.Vector2(0.001, 0.535),
      new THREE.Vector2(0.285, 0.535),
      new THREE.Vector2(0.320, 0.556),
      new THREE.Vector2(0.270, 0.582),
      new THREE.Vector2(0.185, 0.602),
      new THREE.Vector2(0.095, 0.614),
      new THREE.Vector2(0.001, 0.618),
    ];
    const crownCap = new THREE.LatheGeometry(crownPts, 8);
    crownCap.scale(1.04, 1.0, 0.94);
    crownCap.translate(0, 0, -0.04);
    crownCap.rotateY(Math.PI / 8);
    armorGeoms.push(crownCap);

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const p = evalBeetleDomePoint(a, 0.115 * Math.PI, 0.016);
      const out = p.clone().sub(new THREE.Vector3(0, -0.18, -0.04)).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
      steelGeoms.push(transformed(boltProto, new THREE.Matrix4().compose(p, q, new THREE.Vector3(1.05, 1.05, 1.05))));
    }
  }

  // 2b. Four Concentric Staggered Patchwork Armor Tile Rings (40 thick curved beveled tiles)
  const tileRings = [
    { count: 8, phi0: 0.122 * Math.PI, phi1: 0.244 * Math.PI, phase: 0.0, gap: 0.024, lift: 0.014, thick: 0.028 },
    { count: 10, phi0: 0.232 * Math.PI, phi1: 0.348 * Math.PI, phase: 0.18, gap: 0.022, lift: 0.022, thick: 0.030 },
    { count: 12, phi0: 0.336 * Math.PI, phi1: 0.436 * Math.PI, phase: 0.08, gap: 0.020, lift: 0.029, thick: 0.032 },
    { count: 10, phi0: 0.426 * Math.PI, phi1: 0.518 * Math.PI, phase: 0.0, gap: 0.022, lift: 0.034, thick: 0.034 },
  ];

  for (let rIdx = 0; rIdx < tileRings.length; rIdx++) {
    const ring = tileRings[rIdx];
    const dTheta = (Math.PI * 2) / ring.count;

    for (let k = 0; k < ring.count; k++) {
      const tStart = -Math.PI + (k + ring.phase) * dTheta + ring.gap * 0.5;
      const tEnd = -Math.PI + (k + 1 + ring.phase) * dTheta - ring.gap * 0.5;
      const tMid = (tStart + tEnd) * 0.5;
      const absFrontAngle = Math.abs(Math.atan2(Math.sin(tMid), Math.cos(tMid)));

      // Carve a crisp overhanging arched brow visor ABOVE MainEyeCore and upper SubEyes so zero lenses clip!
      let phiEnd = ring.phi1;
      if (rIdx === 3 && absFrontAngle < 0.85) {
        const visorLift = smoothstep(0.85, 0.0, absFrontAngle) * 0.072 * Math.PI;
        phiEnd = ring.phi1 - visorLift;
      }

      const stepJitter = (rand() - 0.45) * 0.011;
      const tileLift = ring.lift + stepJitter;
      const shingleTilt = 0.010;

      const tile = buildBeveledCurvedTile(
        5,
        4,
        (u, v) => {
          const theta = tStart + u * (tEnd - tStart);
          const phi = ring.phi0 + v * (phiEnd - ring.phi0);
          return evalBeetleDomePoint(theta, phi, tileLift + v * shingleTilt);
        },
        ring.thick,
        0.0085,
        rand() * 0.6,
        rand() * 0.6,
        0.78,
        0.66
      );
      armorGeoms.push(tile);

      for (const [bu, bv] of [
        [0.18, 0.22],
        [0.82, 0.78],
      ]) {
        const thetaB = tStart + bu * (tEnd - tStart);
        const phiB = ring.phi0 + bv * (phiEnd - ring.phi0);
        const pb = evalBeetleDomePoint(thetaB, phiB, tileLift + bv * shingleTilt + 0.001);
        const out = pb.clone().sub(new THREE.Vector3(0, -0.18, -0.04)).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
        steelGeoms.push(transformed(boltProto, new THREE.Matrix4().compose(pb, q, new THREE.Vector3(1, 1, 1))));
      }
    }
  }

  // 2c. 14 Asymmetric Overlapping Welded Patch Plates & Flush Structural Splice Plates
  const patchSpecs = [
    { t0: -0.62, t1: -0.16, p0: 0.22, p1: 0.34, lift: 0.039 },
    { t0: 0.14, t1: 0.56, p0: 0.19, p1: 0.31, lift: 0.038 },
    { t0: 0.60, t1: 1.04, p0: 0.29, p1: 0.40, lift: 0.043 },
    { t0: -1.10, t1: -0.66, p0: 0.31, p1: 0.42, lift: 0.042 },
    { t0: -0.26, t1: 0.26, p0: 0.14, p1: 0.24, lift: 0.034 },
    { t0: 1.16, t1: 1.62, p0: 0.24, p1: 0.36, lift: 0.040 },
    { t0: -1.66, t1: -1.20, p0: 0.23, p1: 0.35, lift: 0.040 },
    { t0: 1.76, t1: 2.26, p0: 0.28, p1: 0.41, lift: 0.041 },
    { t0: -2.30, t1: -1.78, p0: 0.27, p1: 0.40, lift: 0.041 },
    { t0: 2.42, t1: 2.94, p0: 0.20, p1: 0.33, lift: 0.036 },
    { t0: -2.94, t1: -2.42, p0: 0.20, p1: 0.33, lift: 0.036 },
    { t0: -0.44, t1: 0.44, p0: 0.31, p1: 0.39, lift: 0.045 }, // Arched brow forehead shield cleanly ABOVE eyes!
    { t0: 0.88, t1: 1.38, p0: 0.41, p1: 0.49, lift: 0.046 },
    { t0: -1.40, t1: -0.88, p0: 0.41, p1: 0.49, lift: 0.046 },
  ];
  for (const ps of patchSpecs) {
    const patch = buildBeveledCurvedTile(
      4,
      3,
      (u, v) =>
        evalBeetleDomePoint(
          ps.t0 + u * (ps.t1 - ps.t0),
          (ps.p0 + v * (ps.p1 - ps.p0)) * Math.PI,
          ps.lift
        ),
      0.022,
      0.0065,
      rand(),
      rand(),
      0.55,
      0.48
    );
    armorGeoms.push(patch);
  }

  // 2d. Recessed Structural Under-Seam Channels (tucked deep inside plate seams, NOT floating hoops!)
  for (const ribPhi of [0.238 * Math.PI, 0.342 * Math.PI, 0.432 * Math.PI]) {
    const pts = [];
    const segs = 28;
    for (let i = 0; i <= segs; i++) {
      const th = (i / segs) * Math.PI * 2;
      pts.push(evalBeetleDomePoint(th, ribPhi, 0.006));
    }
    const curve = new THREE.CatmullRomCurve3(pts, true);
    darkGeoms.push(new THREE.TubeGeometry(curve, 32, 0.015, 6, true));
  }

  // 2e. Low-Profile Rear Occipital Armored Spine Plates + Side Louver Intake Vents
  const occipGeo = buildBeveledArmorPlateBox(0.105, 0.082, 0.038, 0.135, 0.009);
  for (let i = 0; i < 5; i++) {
    const phi = (0.14 + i * 0.075) * Math.PI;
    const p = evalBeetleDomePoint(Math.PI, phi, 0.034);
    const out = p.clone().sub(new THREE.Vector3(0, -0.12, -0.04)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
    armorGeoms.push(transformed(occipGeo, new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1))));
  }

  const louverFrame = new THREE.BoxGeometry(0.075, 0.115, 0.22);
  const louverSlat = new THREE.BoxGeometry(0.064, 0.011, 0.034);
  for (const side of [-1, 1]) {
    for (const th of [1.45, 2.15]) {
      const p = evalBeetleDomePoint(side * th, 0.45 * Math.PI, 0.008);
      const mBase = makeTransform(p, new THREE.Euler(0.05, side * (th - Math.PI * 0.5), -side * 0.36));
      darkGeoms.push(transformed(louverFrame, mBase));
      for (let l = 0; l < 4; l++) {
        const lm = mBase.clone().multiply(
          makeTransform(new THREE.Vector3(side * 0.012, 0.01, -0.070 + l * 0.046), new THREE.Euler(0.42, 0, 0))
        );
        steelGeoms.push(transformed(louverSlat, lm));
      }
    }
  }

  // 3. Deep Cavernous Mechanical Underbelly, Craggy Armored Jaw Cage & Hydraulic Manifolds
  {
    const skirtPts = [
      new THREE.Vector2(0.38, -0.44),
      new THREE.Vector2(0.50, -0.40),
      new THREE.Vector2(0.60, -0.31),
      new THREE.Vector2(0.72, -0.21),
      new THREE.Vector2(0.80, -0.09),
      new THREE.Vector2(0.76, -0.01),
      new THREE.Vector2(0.38, -0.01),
      new THREE.Vector2(0.38, -0.44),
    ];
    const bellyCasing = new THREE.LatheGeometry(skirtPts, 18);
    bellyCasing.scale(1.02, 1.0, 0.90);
    bellyCasing.translate(0, 0, -0.04);
    darkGeoms.push(bellyCasing);

    // Central deep ventral reactor core drum
    const corePts = [
      new THREE.Vector2(0.001, -0.455),
      new THREE.Vector2(0.16, -0.455),
      new THREE.Vector2(0.22, -0.425),
      new THREE.Vector2(0.30, -0.425),
      new THREE.Vector2(0.34, -0.37),
      new THREE.Vector2(0.40, -0.33),
      new THREE.Vector2(0.42, -0.25),
      new THREE.Vector2(0.001, -0.25),
    ];
    const ventralCore = new THREE.LatheGeometry(corePts, 16);
    ventralCore.translate(0, 0, -0.04);
    darkGeoms.push(ventralCore);

    // 14 heavy dark curved vertical mechanical jaw/belly ribs
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ribPts = [
        new THREE.Vector3(sa * 0.76, -0.04, -0.04 + ca * 0.68),
        new THREE.Vector3(sa * 0.68, -0.21, -0.04 + ca * 0.61),
        new THREE.Vector3(sa * 0.45, -0.36, -0.04 + ca * 0.41),
        new THREE.Vector3(sa * 0.20, -0.43, -0.04 + ca * 0.19),
      ];
      const ribCurve = new THREE.CatmullRomCurve3(ribPts);
      armorGeoms.push(new THREE.TubeGeometry(ribCurve, 8, 0.023, 6, false));
    }

    // Craggy Layered Armored Front Chin / Jaw Shields hugging steeply downward under the jaw
    const jawPlateGeo = buildBeveledArmorPlateBox(0.115, 0.072, 0.026, 0.165, 0.006);
    for (const side of [-1, 1]) {
      for (let j = 0; j < 3; j++) {
        const ang = side * (0.28 + j * 0.34);
        const rad = 0.58 - j * 0.02;
        const p = new THREE.Vector3(Math.sin(ang) * rad, -0.27 - (2 - j) * 0.022, -0.02 + Math.cos(ang) * rad);
        const m = makeTransform(p, new THREE.Euler(1.18, ang, -side * 0.10));
        armorGeoms.push(transformed(jawPlateGeo, m));
      }
    }

    // Dark recessed irregular vertical chin pipes & dark gunmetal manifold sleeves (NO bright picket fence!)
    const cRand = mulberry32(41123);
    const chinCollarGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.028, 7);
    for (let i = 0; i < 14; i++) {
      const u = (i / 13) * 2 - 1;
      const x = u * 0.38 + (cRand() - 0.5) * 0.025;
      const z = 0.57 - Math.abs(u) * 0.14 + (cRand() - 0.5) * 0.06;
      const hPipe = 0.22 + cRand() * 0.16;
      const y = -0.24 - (1 - Math.abs(u)) * 0.05 - cRand() * 0.04;
      const rPipe = 0.011 + cRand() * 0.011;
      const pipeGeo = new THREE.CylinderGeometry(rPipe, rPipe * 0.88, hPipe, 6);
      const m = makeTransform(
        new THREE.Vector3(x, y, z),
        new THREE.Euler(0.14 + (cRand() - 0.5) * 0.12, 0, -u * 0.16 + (cRand() - 0.5) * 0.08)
      );
      darkGeoms.push(transformed(pipeGeo, m));
      if (i % 2 === 0) {
        darkGeoms.push(
          transformed(chinCollarGeo, m.clone().multiply(makeTransform(new THREE.Vector3(0, 0.03, 0))))
        );
      }
    }

    // 8 Diagonal Hydraulic Braces under the mechanical belly
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const pA = new THREE.Vector3(Math.sin(a) * 0.22, -0.40, -0.04 + Math.cos(a) * 0.20);
      const pB = new THREE.Vector3(Math.sin(a) * 0.65, -0.13, -0.04 + Math.cos(a) * 0.58);
      const diff = new THREE.Vector3().subVectors(pB, pA);
      const len = diff.length();
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        diff.clone().normalize()
      );
      const sleeve = new THREE.CylinderGeometry(0.022, 0.024, len * 0.54, 7);
      darkGeoms.push(
        transformed(sleeve, new THREE.Matrix4().compose(pA.clone().addScaledVector(diff, 0.28), q, new THREE.Vector3(1, 1, 1)))
      );
      const rod = new THREE.CylinderGeometry(0.011, 0.011, len * 0.94, 7);
      steelGeoms.push(
        transformed(rod, new THREE.Matrix4().compose(pA.clone().addScaledVector(diff, 0.50), q, new THREE.Vector3(1, 1, 1)))
      );
    }
  }

  // 4. Heavy Bolted Shoulder Socket Collars at ALL 9 Tentacle Mount Points (1 Paddle Arm + 8 Bg)
  {
    const socketPts = [
      new THREE.Vector2(0.095, -0.05),
      new THREE.Vector2(0.148, -0.042),
      new THREE.Vector2(0.164, 0.008),
      new THREE.Vector2(0.152, 0.054),
      new THREE.Vector2(0.125, 0.068),
      new THREE.Vector2(0.096, 0.052),
      new THREE.Vector2(0.095, -0.05),
    ];
    const socketProto = new THREE.LatheGeometry(socketPts, 14);
    socketProto.rotateX(Math.PI * 0.5);

    for (const sock of shoulderSockets) {
      const dir = sock.dir.clone().normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      const s = sock.scale;
      const m = new THREE.Matrix4().compose(sock.pos, q, new THREE.Vector3(s, s, s));
      armorGeoms.push(transformed(socketProto, m));

      const cup = new THREE.CylinderGeometry(0.100 * s, 0.092 * s, 0.068 * s, 10);
      cup.rotateX(Math.PI * 0.5);
      darkGeoms.push(transformed(cup, m));

      for (let b = 0; b < 6; b++) {
        const a = (b / 6) * Math.PI * 2;
        const bm = m.clone().multiply(
          makeTransform(
            new THREE.Vector3(Math.cos(a) * 0.142 * s, Math.sin(a) * 0.142 * s, 0.054 * s),
            new THREE.Euler(Math.PI * 0.5, 0, 0),
            new THREE.Vector3(0.95, 0.95, 0.95)
          )
        );
        steelGeoms.push(transformed(boltProto, bm));
      }
    }
  }

  // 5. Dense Vertical "Beard" of 32 Hanging Wires, Rigid Antennae & Drooping Tendrils (0.55m–0.86m!)
  {
    const bRand = mulberry32(77315);
    const ferruleGeo = new THREE.CylinderGeometry(0.0095, 0.0095, 0.024, 6);
    const tipGeo = new THREE.ConeGeometry(0.007, 0.036, 6);
    tipGeo.rotateX(Math.PI);

    // 5a. 14 Slender Drooping Vertical Hanging Tendrils & Wires (reaching y ~ -1.18, clear of table!)
    for (let i = 0; i < 14; i++) {
      const frac = i / 13;
      const angle = (frac - 0.5) * Math.PI * 1.45 + (bRand() - 0.5) * 0.25;
      const rad = 0.07 + bRand() * 0.33;
      const bx = Math.sin(angle) * rad;
      const bz = 0.04 + Math.cos(angle) * rad * 0.85;
      const by = -0.33 - bRand() * 0.08;

      const centerBoost = 1.0 - clamp(Math.abs(bx) / 0.42, 0, 1) * 0.34;
      const dropLen = (0.55 + bRand() * 0.32) * centerBoost;
      const kinkX = (bRand() - 0.5) * 0.085;
      const kinkZ = (bRand() - 0.5) * 0.085;

      const pts = [
        new THREE.Vector3(bx, by, bz),
        new THREE.Vector3(bx + kinkX * 0.45, by - dropLen * 0.33, bz + kinkZ * 0.4),
        new THREE.Vector3(bx + kinkX * 0.95, by - dropLen * 0.68, bz + kinkZ * 0.85),
        new THREE.Vector3(bx + kinkX * 0.65, by - dropLen, bz + kinkZ * 0.72),
      ];
      const curve = new THREE.CatmullRomCurve3(pts);
      const wireRad = 0.0048 + bRand() * 0.0048;
      wireGeoms.push(new THREE.TubeGeometry(curve, 10, wireRad, 5, false));

      const midPt = curve.getPointAt(0.55);
      steelGeoms.push(
        transformed(ferruleGeo, makeTransform(midPt, new THREE.Euler(0, 0, 0), new THREE.Vector3(0.8, 0.8, 0.8)))
      );
      const endPt = pts[3];
      const endDir = new THREE.Vector3().subVectors(pts[3], pts[2]).normalize();
      const qTip = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), endDir);
      steelGeoms.push(transformed(tipGeo, new THREE.Matrix4().compose(endPt, qTip, new THREE.Vector3(0.8, 0.9, 0.8))));
    }

    // 5b. 10 Rigid Vertical Metallic Sensor Antennae / Hanging Needles clustered beneath chin
    for (let i = 0; i < 10; i++) {
      const bx = (i / 9 - 0.5) * 0.44 + (bRand() - 0.5) * 0.04;
      const bz = 0.14 + (bRand() - 0.5) * 0.36;
      const by = -0.35 - bRand() * 0.07;
      const dropLen = 0.55 + bRand() * 0.28;
      const leanX = (bRand() - 0.5) * 0.05;
      const leanZ = (bRand() - 0.5) * 0.04;

      const rodRad = 0.0040 + bRand() * 0.0036;
      const rod = new THREE.CylinderGeometry(rodRad * 1.25, rodRad * 0.65, dropLen, 5);
      const m = makeTransform(
        new THREE.Vector3(bx + leanX * 0.5, by - dropLen * 0.5, bz + leanZ * 0.5),
        new THREE.Euler(leanZ, 0, -leanX)
      );
      wireGeoms.push(transformed(rod, m));

      const collarPos = new THREE.Vector3(bx + leanX * 0.25, by - dropLen * 0.28, bz + leanZ * 0.25);
      steelGeoms.push(
        transformed(ferruleGeo, makeTransform(collarPos, new THREE.Euler(leanZ, 0, -leanX), new THREE.Vector3(0.7, 1.25, 0.7)))
      );
    }

    // 5c. 8 Tightly Looping Braided Underbelly Hydraulic Hoses
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2 + (bRand() - 0.5) * 0.22;
      const a1 = a0 + 0.58 + bRand() * 0.55;
      const r0 = 0.20 + bRand() * 0.26;
      const r1 = 0.22 + bRand() * 0.28;
      const p0 = new THREE.Vector3(Math.sin(a0) * r0, -0.31 - bRand() * 0.06, -0.02 + Math.cos(a0) * r0 * 0.85);
      const p3 = new THREE.Vector3(Math.sin(a1) * r1, -0.30 - bRand() * 0.06, -0.02 + Math.cos(a1) * r1 * 0.85);
      const droop = 0.18 + bRand() * 0.22;
      const p1 = p0.clone().lerp(p3, 0.33);
      p1.y -= droop;
      const p2 = p0.clone().lerp(p3, 0.67);
      p2.y -= droop * (0.85 + bRand() * 0.26);

      const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3]);
      wireGeoms.push(new THREE.TubeGeometry(curve, 10, 0.008 + bRand() * 0.0055, 5, false));
    }
  }

  // 6. Iconic Clustered Matrix Crimson Eye Array (Front Face +Z)
  // 6a. MainEyeCore: Deeply recessed ~0.24m aperture diameter optic in bolted camera-barrel bezel
  const mainEyePos = new THREE.Vector3(0, -0.028, 0.728);
  const mainEyeRot = new THREE.Euler(0.07, 0, 0);
  const mainEyeMat4 = makeTransform(mainEyePos, mainEyeRot);

  {
    // Deep stepped matte-gunmetal camera-barrel bezel (inner aperture diameter ~0.24m!)
    const barrelPts = [
      new THREE.Vector2(0.118, -0.100),
      new THREE.Vector2(0.186, -0.100),
      new THREE.Vector2(0.192, -0.032),
      new THREE.Vector2(0.178, 0.022),
      new THREE.Vector2(0.156, 0.048),
      new THREE.Vector2(0.132, 0.052),
      new THREE.Vector2(0.120, 0.030),
      new THREE.Vector2(0.116, -0.020),
      new THREE.Vector2(0.118, -0.100),
    ];
    const barrel = new THREE.LatheGeometry(barrelPts, 28);
    barrel.rotateX(Math.PI * 0.5);
    darkGeoms.push(transformed(barrel, mainEyeMat4));

    // Outer bolted armored camera shroud collar
    const shroudRing = new THREE.TorusGeometry(0.168, 0.017, 8, 24);
    shroudRing.translate(0, 0, 0.010);
    armorGeoms.push(transformed(shroudRing, mainEyeMat4));

    // 10 recessed dark aperture fins tucked cleanly behind the camera lip (no occlusion!)
    const finShape = new THREE.Shape();
    finShape.moveTo(0.120, -0.018);
    finShape.lineTo(0.150, -0.028);
    finShape.lineTo(0.148, 0.020);
    finShape.lineTo(0.122, 0.028);
    finShape.closePath();
    const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.010, bevelEnabled: false });
    for (let b = 0; b < 10; b++) {
      const a = (b / 10) * Math.PI * 2;
      const bm = mainEyeMat4
        .clone()
        .multiply(makeTransform(new THREE.Vector3(0, 0, 0.002 + (b % 2) * 0.004), new THREE.Euler(0, 0, a)));
      darkGeoms.push(transformed(finGeo, bm));
    }

    // 10 forged bolts around the camera barrel flange
    for (let b = 0; b < 10; b++) {
      const a = (b / 10) * Math.PI * 2 + Math.PI / 10;
      const bm = mainEyeMat4.clone().multiply(
        makeTransform(
          new THREE.Vector3(Math.cos(a) * 0.166, Math.sin(a) * 0.166, 0.026),
          new THREE.Euler(Math.PI * 0.5, 0, 0),
          new THREE.Vector3(1.05, 1.05, 1.05)
        )
      );
      steelGeoms.push(transformed(boltProto, bm));
    }

    // Uninterrupted thin recessed inner crimson glow ring tucked cleanly around optic rim
    const pulseHalo = new THREE.TorusGeometry(0.118, 0.0045, 8, 28);
    pulseHalo.translate(0, 0, -0.004);
    pulseGeoms.push(transformed(pulseHalo, mainEyeMat4));

    // MainEyeCore: Glowing curved molten crimson-white optical dome (~0.24m diameter!)
    const mainEyeLensGeo = buildOpticalDome(0.120, 0.044, 32, 10);
    const mainEyeMesh = new THREE.Mesh(mainEyeLensGeo, mats.mainEye);
    mainEyeMesh.name = 'MainEyeCore';
    mainEyeMesh.position.copy(mainEyePos).add(new THREE.Vector3(0, -0.001, -0.006));
    mainEyeMesh.rotation.copy(mainEyeRot);
    carapace.add(mainEyeMesh);
  }

  // 6b. Asymmetric Matrix Eye Constellation (`SubEyes` Group — 16 lenses matching reference photo!)
  const subEyesGroup = new THREE.Group();
  subEyesGroup.name = 'SubEyes';

  const subEyeSpecs = [
    // Left brow/cheek: 2 medium bright crimson round lenses + tight inner micro-sensor + outboard + 2 lower pips
    { x: -0.335, y: 0.022, z: 0.648, r: 0.050, yaw: -0.31, pitch: 0.05, chin: false },
    { x: -0.502, y: 0.016, z: 0.548, r: 0.040, yaw: -0.50, pitch: 0.06, chin: false },
    { x: -0.198, y: -0.024, z: 0.708, r: 0.023, yaw: -0.16, pitch: 0.08, chin: false },
    { x: -0.650, y: -0.005, z: 0.420, r: 0.026, yaw: -0.72, pitch: 0.07, chin: false },
    { x: -0.248, y: -0.152, z: 0.660, r: 0.024, yaw: -0.24, pitch: 0.16, chin: false },
    { x: -0.398, y: -0.122, z: 0.585, r: 0.021, yaw: -0.40, pitch: 0.14, chin: false },

    // Right brow/cheek: 2 prominent bright crimson lenses (inner larger & slightly lowered!) + tight upper + outboard + 2 lower pips
    { x: 0.298, y: -0.052, z: 0.664, r: 0.056, yaw: 0.27, pitch: 0.10, chin: false },
    { x: 0.474, y: -0.074, z: 0.562, r: 0.043, yaw: 0.46, pitch: 0.11, chin: false },
    { x: 0.204, y: 0.044, z: 0.706, r: 0.022, yaw: 0.18, pitch: 0.03, chin: false },
    { x: 0.630, y: -0.038, z: 0.436, r: 0.028, yaw: 0.68, pitch: 0.09, chin: false },
    { x: 0.212, y: -0.175, z: 0.666, r: 0.023, yaw: 0.19, pitch: 0.18, chin: false },
    { x: 0.376, y: -0.186, z: 0.592, r: 0.020, yaw: 0.36, pitch: 0.18, chin: false },

    // Ventral Chin Grill: 4 tiny dim-crimson pinpoint micro-LED sensors nestled deep inside dark chin pipes!
    { x: -0.112, y: -0.236, z: 0.625, r: 0.010, yaw: -0.12, pitch: 0.22, chin: true },
    { x: -0.036, y: -0.274, z: 0.602, r: 0.009, yaw: -0.04, pitch: 0.25, chin: true },
    { x: 0.044, y: -0.266, z: 0.608, r: 0.0095, yaw: 0.05, pitch: 0.24, chin: true },
    { x: 0.120, y: -0.226, z: 0.622, r: 0.010, yaw: 0.14, pitch: 0.22, chin: true },
  ];

  const subBarrelPts = [
    new THREE.Vector2(0.86, -1.35),
    new THREE.Vector2(1.48, -1.35),
    new THREE.Vector2(1.52, -0.08),
    new THREE.Vector2(1.34, 0.42),
    new THREE.Vector2(1.10, 0.52),
    new THREE.Vector2(0.92, 0.20),
    new THREE.Vector2(0.86, -1.35),
  ];
  const subBarrelGeo = new THREE.LatheGeometry(subBarrelPts, 16);
  subBarrelGeo.rotateX(Math.PI * 0.5);
  const subDomeGeo = buildOpticalDome(0.98, 0.34, 16, 6);

  for (let i = 0; i < subEyeSpecs.length; i++) {
    const sp = subEyeSpecs[i];
    const mHousing = makeTransform(
      new THREE.Vector3(sp.x, sp.y, sp.z),
      new THREE.Euler(sp.pitch, sp.yaw, 0),
      new THREE.Vector3(sp.r, sp.r, sp.r)
    );
    darkGeoms.push(transformed(subBarrelGeo, mHousing));

    const lensMat = sp.chin ? mats.crimsonPulseSensor : mats.subEye;
    const lens = new THREE.Mesh(subDomeGeo, lensMat);
    lens.name = `SubEye_${String(i).padStart(2, '0')}`;
    lens.position.set(sp.x, sp.y, sp.z);
    lens.rotation.set(sp.pitch, sp.yaw, 0);
    const fwd = new THREE.Vector3(0, 0, sp.r * 0.04).applyEuler(lens.rotation);
    lens.position.add(fwd);
    lens.scale.setScalar(sp.r * 0.94);
    subEyesGroup.add(lens);
  }
  carapace.add(subEyesGroup);

  const armorMesh = new THREE.Mesh(mergeIndexedGeometries(armorGeoms, 'CarapaceArmor'), mats.armorPrimary);
  armorMesh.name = 'CarapaceArmorPlates';
  carapace.add(armorMesh);

  const darkMesh = new THREE.Mesh(mergeIndexedGeometries(darkGeoms, 'CarapaceChassis'), mats.armorDark);
  darkMesh.name = 'CarapaceChassis';
  carapace.add(darkMesh);

  const steelMesh = new THREE.Mesh(mergeIndexedGeometries(steelGeoms, 'CarapaceHardware'), mats.machinedSteel);
  steelMesh.name = 'CarapaceHardware';
  carapace.add(steelMesh);

  const wireMesh = new THREE.Mesh(mergeIndexedGeometries(wireGeoms, 'CarapaceHangingBeard'), mats.darkTendrilWire);
  wireMesh.name = 'CarapaceHangingBeard';
  carapace.add(wireMesh);

  const pulseMesh = new THREE.Mesh(mergeIndexedGeometries(pulseGeoms, 'CarapaceEyePulseHalo'), mats.crimsonPulseSensor);
  pulseMesh.name = 'CarapaceEyePulseHalo';
  carapace.add(pulseMesh);

  return carapace;
}

// ---------------------------------------------------------------------------
// Ultra-Dense Interlocking Centipede-Armor Tentacle Vertebra Archetype (Local +Z!)
// ---------------------------------------------------------------------------
function createCentipedeVertebraArchetype(mats, variant = 'paddle', includeDiode = true) {
  const R = 0.10;
  const L = 0.12;

  const armorParts = [];
  const darkParts = [];
  const steelParts = [];
  const diodeParts = [];

  // 1. Extended Ribbed Dark Flexible Spine Core (z in [-0.78L, +0.78L]) — zero air gaps even under steep bends!
  const corePts = [
    new THREE.Vector2(R * 0.64, -L * 0.78),
    new THREE.Vector2(R * 0.80, -L * 0.66),
    new THREE.Vector2(R * 0.72, -L * 0.48),
    new THREE.Vector2(R * 0.84, -L * 0.30),
    new THREE.Vector2(R * 0.74, -L * 0.12),
    new THREE.Vector2(R * 0.85, 0.0),
    new THREE.Vector2(R * 0.74, L * 0.12),
    new THREE.Vector2(R * 0.84, L * 0.30),
    new THREE.Vector2(R * 0.72, L * 0.48),
    new THREE.Vector2(R * 0.80, L * 0.66),
    new THREE.Vector2(R * 0.64, L * 0.78),
  ];
  const coreGeo = new THREE.LatheGeometry(corePts, 12);
  coreGeo.rotateX(Math.PI * 0.5);
  darkParts.push(coreGeo);

  // 2. Heavy Sculpted Segmented Centipede Collar Ring (crisp transverse armor articulation!)
  // Rear flares wider (1.10R) with sharp dark midline groove and tapered front lip (0.94R) to nest inside next ring!
  const cuffPts = [
    new THREE.Vector2(R * 0.78, -L * 0.50),
    new THREE.Vector2(R * 1.04, -L * 0.44),
    new THREE.Vector2(R * 1.11, -L * 0.24),
    new THREE.Vector2(R * 1.03, -L * 0.08),
    new THREE.Vector2(R * 0.88, -L * 0.03),
    new THREE.Vector2(R * 0.88, L * 0.03),
    new THREE.Vector2(R * 1.04, L * 0.10),
    new THREE.Vector2(R * 1.07, L * 0.30),
    new THREE.Vector2(R * 0.94, L * 0.46),
    new THREE.Vector2(R * 0.78, L * 0.50),
  ];
  // 10 radial segments gives heavy rounded-faceted centipede ring profile (not boxy square!)
  const cuffGeo = new THREE.LatheGeometry(cuffPts, 10);
  cuffGeo.rotateX(Math.PI * 0.5);
  armorParts.push(cuffGeo);

  // 3. Six Shingled Beveled Armored Carapace Scales wrapping the vertebra circumference!
  // Shorter axial length (L*0.66) leaves crisp shadowed centipede ring grooves between every vertebra!
  const scaleCount = 6;
  const scaleGeo = buildBeveledArmorPlateBox(
    R * 0.58,
    R * 0.50,
    R * 0.21,
    L * 0.66,
    R * 0.038
  );
  const knuckleGeo = new THREE.BoxGeometry(R * 0.20, R * 0.22, L * 0.44);
  const pistonRodGeo = new THREE.CylinderGeometry(R * 0.044, R * 0.044, L * 1.12, 6, 1, true);
  pistonRodGeo.rotateX(Math.PI * 0.5);
  const pistonSleeveGeo = new THREE.CylinderGeometry(R * 0.076, R * 0.076, L * 0.48, 6);
  pistonSleeveGeo.rotateX(Math.PI * 0.5);
  const boltGeo = buildHexBoltCap(R * 0.056, R * 0.062);

  for (let i = 0; i < scaleCount; i++) {
    const a = (i / scaleCount) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);

    const qOut = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(ca, sa, 0)
    );
    const mScale = new THREE.Matrix4().compose(
      new THREE.Vector3(ca * R * 0.96, sa * R * 0.96, -L * 0.02),
      qOut,
      new THREE.Vector3(1, 1, 1)
    );
    armorParts.push(transformed(scaleGeo, mScale));

    // Machined hex rivet seated on each armored scale
    steelParts.push(
      transformed(
        boltGeo,
        new THREE.Matrix4().compose(new THREE.Vector3(ca * R * 1.15, sa * R * 1.15, -L * 0.14), qOut, new THREE.Vector3(1, 1, 1))
      )
    );

    // Side knuckle blocks & hydraulic linkage pistons tucked between scales
    const ka = a + Math.PI / scaleCount;
    const kca = Math.cos(ka);
    const ksa = Math.sin(ka);
    if (i % 2 === 0 || variant === 'paddle') {
      darkParts.push(
        transformed(
          knuckleGeo,
          makeTransform(new THREE.Vector3(kca * R * 0.98, ksa * R * 0.98, 0), new THREE.Euler(0, 0, ka))
        )
      );
    }
    if ((variant === 'paddle' && i % 2 === 0) || (variant !== 'paddle' && (i === 0 || i === 3))) {
      steelParts.push(
        transformed(pistonRodGeo, makeTransform(new THREE.Vector3(kca * R * 1.01, ksa * R * 1.01, 0)))
      );
      darkParts.push(
        transformed(
          pistonSleeveGeo,
          makeTransform(new THREE.Vector3(kca * R * 1.01, ksa * R * 1.01, -L * 0.16))
        )
      );
    }
  }

  // 4. Subtle Tiny Recessed Pinpoint Crimson Indicator Diodes (sparse & small — authentic to photo!)
  if (includeDiode) {
    const portHousingGeo = new THREE.CylinderGeometry(R * 0.088, R * 0.105, R * 0.09, 8);
    const diodeDotGeo = new THREE.CylinderGeometry(R * 0.048, R * 0.048, R * 0.055, 8);
    const diodeAngles = variant === 'paddle' ? [0, Math.PI] : [0];

    for (const da of diodeAngles) {
      const ca = Math.cos(da);
      const sa = Math.sin(da);
      const qOut = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(ca, sa, 0)
      );
      darkParts.push(
        transformed(
          portHousingGeo,
          new THREE.Matrix4().compose(new THREE.Vector3(ca * R * 1.13, sa * R * 1.13, 0.04 * L), qOut, new THREE.Vector3(1, 1, 1))
        )
      );
      diodeParts.push(
        transformed(
          diodeDotGeo,
          new THREE.Matrix4().compose(new THREE.Vector3(ca * R * 1.155, sa * R * 1.155, 0.04 * L), qOut, new THREE.Vector3(1, 1, 1))
        )
      );
    }
  }

  return {
    refRadius: R,
    refLength: L,
    armorGeo: mergeIndexedGeometries(armorParts, `Centipede_${variant}_Armor`),
    darkGeo: mergeIndexedGeometries(darkParts, `Centipede_${variant}_Dark`),
    steelGeo: mergeIndexedGeometries(steelParts, `Centipede_${variant}_Steel`),
    diodeGeo: diodeParts.length > 0 ? mergeIndexedGeometries(diodeParts, `Centipede_${variant}_Diode`) : null,
    mats,
  };
}

function instantiateSegment(archetype, name, radius, segLength) {
  const seg = new THREE.Group();
  seg.name = name;

  seg.add(
    new THREE.Mesh(archetype.armorGeo, archetype.mats.armorPrimary),
    new THREE.Mesh(archetype.darkGeo, archetype.mats.armorDark),
    new THREE.Mesh(archetype.steelGeo, archetype.mats.machinedSteel)
  );
  if (archetype.diodeGeo) {
    seg.add(new THREE.Mesh(archetype.diodeGeo, archetype.mats.tentacleDiode));
  }

  const rScale = radius / archetype.refRadius;
  const zScale = segLength / archetype.refLength;
  seg.scale.set(rScale, rScale, zScale);
  return seg;
}

// ---------------------------------------------------------------------------
// Bulky Articulated Armored Gauntlet Finger Helper
// ---------------------------------------------------------------------------
function appendGauntletFinger(armorParts, darkParts, steelParts, cfg) {
  const { basePos, baseRotEuler, lengths, bendAngles, radius, isClawProng = false } = cfg;
  let curMat = makeTransform(basePos, baseRotEuler);

  for (let p = 0; p < lengths.length; p++) {
    const len = lengths[p];
    const r0 = radius * (1.0 - p * 0.16);
    const r1 = radius * (0.90 - p * 0.18);
    const isTip = p === lengths.length - 1;

    curMat = curMat
      .clone()
      .multiply(makeTransform(new THREE.Vector3(0, 0, 0), new THREE.Euler(bendAngles[p], 0, 0)));

    const drum = new THREE.CylinderGeometry(r0 * 1.06, r0 * 1.06, r0 * 1.75, 8);
    drum.rotateZ(Math.PI * 0.5);
    darkParts.push(transformed(drum, curMat));

    const pin = new THREE.CylinderGeometry(r0 * 0.54, r0 * 0.54, r0 * 2.35, 6);
    pin.rotateZ(Math.PI * 0.5);
    steelParts.push(transformed(pin, curMat));

    if (isTip && isClawProng) {
      const tipBox = buildBeveledArmorPlateBox(r0 * 1.55, r0 * 0.50, r0 * 1.35, len, r0 * 0.20);
      tipBox.translate(0, -r0 * 0.52, len * 0.5);
      armorParts.push(transformed(tipBox, curMat));
    } else {
      const innerLink = new THREE.CylinderGeometry(r1 * 0.92, r0 * 0.96, len, 8);
      innerLink.rotateX(Math.PI * 0.5);
      innerLink.translate(0, 0, len * 0.5);
      darkParts.push(transformed(innerLink, curMat));

      const shield = buildBeveledArmorPlateBox(
        r0 * 2.05,
        isTip ? r0 * 1.48 : r0 * 1.88,
        r0 * 1.15,
        len * (isTip ? 0.94 : 0.88),
        r0 * 0.22
      );
      shield.translate(0, r0 * 0.10, len * 0.5);
      armorParts.push(transformed(shield, curMat));

      if (!isTip) {
        const strut = new THREE.CylinderGeometry(r0 * 0.22, r0 * 0.22, len * 0.82, 5);
        strut.rotateX(Math.PI * 0.5);
        for (const s of [-1, 1]) {
          const sm = curMat.clone().multiply(makeTransform(new THREE.Vector3(s * r0 * 0.96, -r0 * 0.10, len * 0.5)));
          steelParts.push(transformed(strut, sm));
        }
      }
    }

    curMat = curMat.clone().multiply(makeTransform(new THREE.Vector3(0, 0, len)));
  }

  return new THREE.Vector3().setFromMatrixPosition(curMat);
}

// ---------------------------------------------------------------------------
// Heavy Bulky Sculpted 4-Fingered Industrial Gauntlet `PaddleClaw` + `PaddleSocket`
// ---------------------------------------------------------------------------
function buildPaddleClaw(mats, tipPos, tipTangent) {
  const claw = new THREE.Group();
  claw.name = 'PaddleClaw';
  orientObjectAlongSpine(claw, tipPos, tipTangent);

  const armorParts = [];
  const darkParts = [];
  const steelParts = [];
  const diodeParts = [];

  // 1. Bulky Faceted Armored Forearm / Wrist Gauntlet Cuff
  const cuffPts = [
    new THREE.Vector2(0.068, -0.095),
    new THREE.Vector2(0.106, -0.080),
    new THREE.Vector2(0.120, -0.044),
    new THREE.Vector2(0.105, -0.012),
    new THREE.Vector2(0.122, 0.024),
    new THREE.Vector2(0.118, 0.066),
    new THREE.Vector2(0.092, 0.086),
    new THREE.Vector2(0.064, 0.074),
    new THREE.Vector2(0.064, -0.095),
  ];
  const cuff = new THREE.LatheGeometry(cuffPts, 10);
  cuff.rotateX(Math.PI * 0.5);
  armorParts.push(cuff);

  // 6 Heavy Beveled Wrist-Guard Armor Plates & Hex Bolts wrapping the forearm gauntlet
  const wristPlate = buildBeveledArmorPlateBox(0.066, 0.058, 0.025, 0.128, 0.006);
  const boltGeo = buildHexBoltCap(0.008, 0.0075);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const qOut = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(ca, sa, 0)
    );
    armorParts.push(
      transformed(
        wristPlate,
        new THREE.Matrix4().compose(new THREE.Vector3(ca * 0.098, sa * 0.098, 0.004), qOut, new THREE.Vector3(1, 1, 1))
      )
    );
    steelParts.push(
      transformed(
        boltGeo,
        new THREE.Matrix4().compose(new THREE.Vector3(ca * 0.121, sa * 0.121, 0.036), qOut, new THREE.Vector3(1, 1, 1))
      )
    );
  }

  // Sculpted Beveled Mechanical Palm Chassis & Armored Back-of-Hand Knuckle Guard (no bare cube!)
  const palmCore = new THREE.CylinderGeometry(0.076, 0.092, 0.070, 8);
  palmCore.rotateX(Math.PI * 0.5);
  palmCore.scale(1.02, 1.08, 1.0);
  palmCore.translate(0, 0, 0.078);
  darkParts.push(palmCore);

  // Heavy beveled dorsal hand-back armor shield wrapping the left/back of the gauntlet
  const backHandShield = buildBeveledArmorPlateBox(0.135, 0.112, 0.034, 0.092, 0.008);
  backHandShield.rotateZ(Math.PI * 0.5);
  backHandShield.translate(-0.068, 0, 0.082);
  armorParts.push(backHandShield);

  // Heavy beveled thumb-side metacarpal armor guard (+X)
  const thumbGuard = buildBeveledArmorPlateBox(0.092, 0.074, 0.028, 0.082, 0.007);
  thumbGuard.rotateZ(-Math.PI * 0.5);
  thumbGuard.translate(0.068, 0.006, 0.076);
  armorParts.push(thumbGuard);

  // Upper & lower beveled knuckle-bridge plates closing the palm silhouette
  const bridgePlate = buildBeveledArmorPlateBox(0.118, 0.094, 0.022, 0.072, 0.006);
  armorParts.push(transformed(bridgePlate, makeTransform(new THREE.Vector3(0, 0.068, 0.078))));
  armorParts.push(transformed(bridgePlate, makeTransform(new THREE.Vector3(0, -0.068, 0.078), new THREE.Euler(0, 0, Math.PI))));

  // 4 Machined Steel Hydraulic Wrist Actuators
  const wristPiston = new THREE.CylinderGeometry(0.0095, 0.0095, 0.138, 6);
  wristPiston.rotateX(Math.PI * 0.5);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    steelParts.push(
      transformed(wristPiston, makeTransform(new THREE.Vector3(Math.cos(a) * 0.110, Math.sin(a) * 0.110, -0.004)))
    );
  }

  // Subtle recessed pinpoint crimson status diode on dorsal wrist
  const diodeDot = new THREE.CylinderGeometry(0.0065, 0.0065, 0.007, 8);
  const qL = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0));
  diodeParts.push(
    transformed(diodeDot, new THREE.Matrix4().compose(new THREE.Vector3(-0.122, 0, -0.024), qL, new THREE.Vector3(1, 1, 1)))
  );

  // 2. 4 Heavy Multi-Plated Industrial Gauntlet Fingers curling tightly around (0, 0, 0.14)!
  const fingerConfigs = [
    {
      basePos: new THREE.Vector3(-0.068, 0.052, 0.078),
      baseRotEuler: new THREE.Euler(0, 0, Math.PI * 0.45),
      lengths: [0.054, 0.052, 0.042],
      bendAngles: [-0.22, 0.70, 0.80],
      radius: 0.020,
    },
    {
      basePos: new THREE.Vector3(-0.070, 0.0, 0.080),
      baseRotEuler: new THREE.Euler(0, 0, Math.PI * 0.50),
      lengths: [0.056, 0.054, 0.044],
      bendAngles: [-0.20, 0.70, 0.80],
      radius: 0.021,
    },
    {
      basePos: new THREE.Vector3(-0.068, -0.052, 0.078),
      baseRotEuler: new THREE.Euler(0, 0, Math.PI * 0.55),
      lengths: [0.054, 0.052, 0.042],
      bendAngles: [-0.22, 0.70, 0.80],
      radius: 0.020,
    },
    {
      basePos: new THREE.Vector3(0.068, 0.008, 0.076),
      baseRotEuler: new THREE.Euler(0, 0, -Math.PI * 0.50),
      lengths: [0.058, 0.054, 0.046],
      bendAngles: [-0.20, 0.72, 0.82],
      radius: 0.024,
    },
  ];

  const fingerTips = [];
  for (const fc of fingerConfigs) {
    fingerTips.push(appendGauntletFinger(armorParts, darkParts, steelParts, fc));
  }

  claw.add(
    new THREE.Mesh(mergeIndexedGeometries(armorParts, 'PaddleClawArmor'), mats.armorPrimary),
    new THREE.Mesh(mergeIndexedGeometries(darkParts, 'PaddleClawDark'), mats.armorDark),
    new THREE.Mesh(mergeIndexedGeometries(steelParts, 'PaddleClawSteel'), mats.machinedSteel),
    new THREE.Mesh(mergeIndexedGeometries(diodeParts, 'PaddleClawDiode'), mats.tentacleDiode)
  );

  // Child empty Object3D `PaddleSocket` inside the gauntlet grip at (0, 0, 0.14)
  // World +Z points strictly toward player (+Z), world +Y strictly upright (+Y).
  const paddleSocket = new THREE.Object3D();
  paddleSocket.name = 'PaddleSocket';
  paddleSocket.position.set(0, 0, 0.14);
  paddleSocket.quaternion.copy(claw.quaternion).invert();
  claw.add(paddleSocket);

  return { claw, fingerTips };
}

// ---------------------------------------------------------------------------
// Shared Heavy Industrial 3-Prong Background Tentacle Claw Archetype
// ---------------------------------------------------------------------------
function createBgClawArchetype(mats) {
  const armorParts = [];
  const darkParts = [];
  const steelParts = [];
  const diodeParts = [];

  const cuffPts = [
    new THREE.Vector2(0.042, -0.050),
    new THREE.Vector2(0.068, -0.036),
    new THREE.Vector2(0.076, 0.004),
    new THREE.Vector2(0.068, 0.042),
    new THREE.Vector2(0.052, 0.060),
    new THREE.Vector2(0.034, 0.050),
    new THREE.Vector2(0.034, -0.050),
  ];
  const cuff = new THREE.LatheGeometry(cuffPts, 10);
  cuff.rotateX(Math.PI * 0.5);
  armorParts.push(cuff);

  const hub = new THREE.SphereGeometry(0.044, 10, 8);
  hub.translate(0, 0, 0.052);
  darkParts.push(hub);

  const dot = new THREE.CylinderGeometry(0.007, 0.007, 0.007, 8);
  dot.rotateX(Math.PI * 0.5);
  dot.translate(0, 0, 0.094);
  diodeParts.push(dot);

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    appendGauntletFinger(armorParts, darkParts, steelParts, {
      basePos: new THREE.Vector3(Math.cos(a) * 0.048, Math.sin(a) * 0.048, 0.054),
      baseRotEuler: new THREE.Euler(0, 0, a - Math.PI * 0.5),
      lengths: [0.056, 0.052, 0.058],
      bendAngles: [-0.42, 0.54, 0.58],
      radius: 0.0155,
      isClawProng: true,
    });
  }

  return {
    refRadius: 0.062,
    armorGeo: mergeIndexedGeometries(armorParts, 'BgClawArmor'),
    darkGeo: mergeIndexedGeometries(darkParts, 'BgClawDark'),
    steelGeo: mergeIndexedGeometries(steelParts, 'BgClawSteel'),
    diodeGeo: mergeIndexedGeometries(diodeParts, 'BgClawDiode'),
    mats,
  };
}

function instantiateBgClaw(archetype, name, pos, tangent, wristRadius) {
  const claw = new THREE.Group();
  claw.name = name;
  orientObjectAlongSpine(claw, pos, tangent);
  const s = wristRadius / archetype.refRadius;
  claw.scale.set(s, s, s);
  claw.add(
    new THREE.Mesh(archetype.armorGeo, archetype.mats.armorPrimary),
    new THREE.Mesh(archetype.darkGeo, archetype.mats.armorDark),
    new THREE.Mesh(archetype.steelGeo, archetype.mats.machinedSteel),
    new THREE.Mesh(archetype.diodeGeo, archetype.mats.tentacleDiode)
  );
  return claw;
}

// ---------------------------------------------------------------------------
// Dense Interlocking Tentacle Spline Builder (alternates subtle diode segments!)
// ---------------------------------------------------------------------------
function buildTentacleSegments(
  parentGroup,
  namePrefix,
  curve,
  segCount,
  rStart,
  rEnd,
  archetypeWithDiode,
  archetypePlain,
  overlapFactor = 1.15
) {
  const totalLen = curve.getLength();
  const segPitch = totalLen / Math.max(1, segCount - 0.5);

  for (let i = 0; i < segCount; i++) {
    const u = segCount === 1 ? 0 : i / (segCount - 1);
    const uCurve = u * 0.968;
    const pos = curve.getPointAt(uCurve);
    const tangent = curve.getTangentAt(uCurve).normalize();

    const radius = rStart + (rEnd - rStart) * Math.pow(u, 0.85);
    const segName = `${namePrefix}_Seg_${String(i).padStart(2, '0')}`;
    // Sparse authentic red pinpoint diodes on alternating vertebrae (not repetitive polka-dots!)
    const arch = i % 2 === 1 ? archetypeWithDiode : archetypePlain;
    const seg = instantiateSegment(arch, segName, radius, segPitch * overlapFactor);
    orientObjectAlongSpine(seg, pos, tangent);
    parentGroup.add(seg);
  }
}

// ---------------------------------------------------------------------------
// Complete 1:1 Reference Sentinel Assembly
// ---------------------------------------------------------------------------
function buildSentinelReferenceModel() {
  const root = new THREE.Group();
  root.name = 'SentinelRoot';

  const mats = createMaterials();

  // Primary Thick Paddle Arm (16 segments, r=0.165m -> 0.105m)
  // Arches dramatically from upper-left carapace in a heavy coiled arc toward (-0.62, -0.78, 1.38)
  const paddleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.68, -0.04, 0.22),
    new THREE.Vector3(-1.32, 0.20, 0.52),
    new THREE.Vector3(-1.36, -0.30, 0.92),
    new THREE.Vector3(-0.96, -0.68, 1.18),
    new THREE.Vector3(-0.62, -0.78, 1.38),
  ]);

  // 8 Sweeping Medusa-Like Background Tentacles (`BgTentacle_0`..`7`, 12–14 segments each)
  const bgSpecs = [
    {
      // BgTentacle_0: Upper-Left Overhead Coil — thick massive coil soaring HIGH UP into left ceiling cables!
      segCount: 14,
      rStart: 0.152,
      rEnd: 0.088,
      points: [
        new THREE.Vector3(-0.62, 0.14, 0.04),
        new THREE.Vector3(-1.34, 0.58, 0.34),
        new THREE.Vector3(-1.66, 1.14, 0.62),
        new THREE.Vector3(-1.74, 1.62, 0.72),
        new THREE.Vector3(-1.62, 2.02, 0.66),
      ],
    },
    {
      // BgTentacle_1: Foreground-Right Sweeping Arm — bold organic S-arc diagonally down-right toward near-right table corner!
      segCount: 14,
      rStart: 0.156,
      rEnd: 0.094,
      points: [
        new THREE.Vector3(0.54, -0.18, 0.22),
        new THREE.Vector3(0.88, -0.34, 0.52),
        new THREE.Vector3(0.98, -0.76, 0.94),
        new THREE.Vector3(1.18, -1.08, 1.32),
        new THREE.Vector3(1.42, -1.24, 1.60),
      ],
    },
    {
      // BgTentacle_2: Mid-Left Sweeping Arm — sweeping outward and down toward left catwalk pillars
      segCount: 14,
      rStart: 0.130,
      rEnd: 0.064,
      points: [
        new THREE.Vector3(-0.72, -0.12, -0.08),
        new THREE.Vector3(-1.42, -0.18, 0.02),
        new THREE.Vector3(-1.90, -0.48, 0.22),
        new THREE.Vector3(-2.12, -0.82, 0.42),
        new THREE.Vector3(-1.98, -1.08, 0.62),
      ],
    },
    {
      // BgTentacle_3: Mid-Right Wide Arc — sweeping wide right toward right industrial girders & green light columns
      segCount: 14,
      rStart: 0.130,
      rEnd: 0.064,
      points: [
        new THREE.Vector3(0.72, -0.06, -0.06),
        new THREE.Vector3(1.46, -0.14, -0.02),
        new THREE.Vector3(2.02, -0.34, 0.12),
        new THREE.Vector3(2.36, -0.64, 0.26),
        new THREE.Vector3(2.44, -0.96, 0.44),
      ],
    },
    {
      // BgTentacle_4: Lower-Center-Left Flanking Tendril — curving downward/back behind table into misty depth
      segCount: 12,
      rStart: 0.112,
      rEnd: 0.054,
      points: [
        new THREE.Vector3(-0.40, -0.26, -0.22),
        new THREE.Vector3(-0.74, -0.60, -0.34),
        new THREE.Vector3(-0.86, -0.96, -0.52),
        new THREE.Vector3(-0.64, -1.16, -0.78),
        new THREE.Vector3(-0.32, -1.20, -1.02),
      ],
    },
    {
      // BgTentacle_5: Lower-Center-Right Flanking Tendril — curving downward/back behind table into misty depth
      segCount: 12,
      rStart: 0.112,
      rEnd: 0.054,
      points: [
        new THREE.Vector3(0.40, -0.26, -0.22),
        new THREE.Vector3(0.72, -0.58, -0.32),
        new THREE.Vector3(0.82, -0.94, -0.50),
        new THREE.Vector3(0.62, -1.14, -0.76),
        new THREE.Vector3(0.30, -1.18, -1.00),
      ],
    },
    {
      // BgTentacle_6: Upper-Rear-Left Canopy Tendril — graceful sweeping S-arc rising high into left-rear green light columns!
      segCount: 12,
      rStart: 0.118,
      rEnd: 0.058,
      points: [
        new THREE.Vector3(-0.54, 0.12, -0.40),
        new THREE.Vector3(-1.04, 0.36, -0.58),
        new THREE.Vector3(-1.26, 0.92, -0.74),
        new THREE.Vector3(-1.18, 1.48, -0.84),
        new THREE.Vector3(-1.44, 1.94, -0.92),
      ],
    },
    {
      // BgTentacle_7: Upper-Rear-Right Canopy Tendril — graceful sweeping S-arc rising high into right-rear green light columns!
      segCount: 12,
      rStart: 0.118,
      rEnd: 0.058,
      points: [
        new THREE.Vector3(0.54, 0.12, -0.40),
        new THREE.Vector3(1.08, 0.32, -0.56),
        new THREE.Vector3(1.36, 0.88, -0.70),
        new THREE.Vector3(1.32, 1.44, -0.80),
        new THREE.Vector3(1.62, 1.90, -0.88),
      ],
    },
  ];

  // Collect shoulder socket transforms for all 9 tentacles (1 paddle arm + 8 background tentacles)
  const shoulderSockets = [
    {
      pos: paddleCurve.getPointAt(0),
      dir: paddleCurve.getTangentAt(0),
      scale: 1.18,
    },
    ...bgSpecs.map((spec) => {
      const c = new THREE.CatmullRomCurve3(spec.points);
      return {
        pos: c.getPointAt(0),
        dir: c.getTangentAt(0),
        scale: spec.rStart / 0.132,
      };
    }),
  ];

  // 1. Patchwork Beetle-Dome Carapace + Asymmetric Eye Cluster + Hanging Wire Beard
  const carapace = buildCarapace(mats, shoulderSockets);
  root.add(carapace);

  // 2. Shared Interlocking Centipede Vertebra & Claw Archetypes (with & without pinpoint diode for sparse realism)
  const paddleSegDiode = createCentipedeVertebraArchetype(mats, 'paddle', true);
  const paddleSegPlain = createCentipedeVertebraArchetype(mats, 'paddle', false);
  const bgSegDiode = createCentipedeVertebraArchetype(mats, 'bg', true);
  const bgSegPlain = createCentipedeVertebraArchetype(mats, 'bg', false);
  const bgClawArchetype = createBgClawArchetype(mats);

  // 3. 16-Segment Thick Primary Paddle Arm (`PaddleArm_Seg_00`..`15` direct children of SentinelRoot)
  buildTentacleSegments(
    root,
    'PaddleArm',
    paddleCurve,
    16,
    0.165,
    0.105,
    paddleSegDiode,
    paddleSegPlain,
    1.18
  );

  const paddleTipPos = paddleCurve.getPointAt(1.0);
  const paddleTipTangent = paddleCurve.getTangentAt(1.0).normalize();
  const { claw: paddleClaw, fingerTips } = buildPaddleClaw(mats, paddleTipPos, paddleTipTangent);
  root.add(paddleClaw);

  // 4. 8 Sweeping Background Tentacles (`BgTentacle_0`..`7` direct children of SentinelRoot at identity)
  for (let i = 0; i < bgSpecs.length; i++) {
    const spec = bgSpecs[i];
    const curve = new THREE.CatmullRomCurve3(spec.points);
    const group = new THREE.Group();
    group.name = `BgTentacle_${i}`;

    buildTentacleSegments(
      group,
      `BgTentacle_${i}`,
      curve,
      spec.segCount,
      spec.rStart,
      spec.rEnd,
      bgSegDiode,
      bgSegPlain,
      1.16
    );

    const claw = instantiateBgClaw(
      bgClawArchetype,
      `BgTentacle_${i}_Claw`,
      curve.getPointAt(1.0),
      curve.getTangentAt(1.0).normalize(),
      spec.rEnd
    );
    group.add(claw);
    root.add(group);
  }

  return { root, paddleCurve, bgSpecs, fingerTips };
}

// ---------------------------------------------------------------------------
// Build, Rigorous Kinematic & Geometric Self-Verification, and Export GLB
// ---------------------------------------------------------------------------
const t0 = performance.now();
const { root, paddleCurve, bgSpecs, fingerTips } = buildSentinelReferenceModel();
root.updateMatrixWorld(true);

// 1. Verify exact parent-child hierarchy & required node names
const requiredDirectChildren = [
  'Carapace',
  'PaddleClaw',
  ...Array.from({ length: 16 }, (_, i) => `PaddleArm_Seg_${String(i).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, i) => `BgTentacle_${i}`),
];
const directChildNames = new Set(root.children.map((c) => c.name));
for (const name of requiredDirectChildren) {
  if (!directChildNames.has(name)) {
    throw new Error(`Hierarchy error: "${name}" must be a direct child of SentinelRoot!`);
  }
}

for (let t = 0; t < 8; t++) {
  const grp = root.getObjectByName(`BgTentacle_${t}`);
  if (
    grp.position.lengthSq() > 1e-10 ||
    Math.abs(grp.quaternion.w - 1) > 1e-6 ||
    grp.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-6
  ) {
    throw new Error(`BgTentacle_${t} must have identity transform (0,0,0)!`);
  }
}

// 2. Verify PaddleClaw & PaddleSocket
const clawObj = root.getObjectByName('PaddleClaw');
const socketObj = root.getObjectByName('PaddleSocket');
if (!socketObj || socketObj.parent !== clawObj) {
  throw new Error('PaddleSocket must be a direct child of PaddleClaw!');
}
if (socketObj.position.distanceTo(new THREE.Vector3(0, 0, 0.14)) > 1e-6) {
  throw new Error(`PaddleSocket local position must be (0,0,0.14), got ${socketObj.position.toArray()}`);
}
const socketWorldQuat = new THREE.Quaternion();
socketObj.getWorldQuaternion(socketWorldQuat);
const socketForward = new THREE.Vector3(0, 0, 1).applyQuaternion(socketWorldQuat);
const socketUp = new THREE.Vector3(0, 1, 0).applyQuaternion(socketWorldQuat);
if (socketForward.dot(new THREE.Vector3(0, 0, 1)) < 0.999 || socketUp.dot(new THREE.Vector3(0, 1, 0)) < 0.999) {
  throw new Error(`PaddleSocket orientation mismatch! fwd=${socketForward.toArray()} up=${socketUp.toArray()}`);
}

// 3. Verify +Z spine alignment (dot > 0.999) on all 16 PaddleArm segments & all BgTentacle segments
let minAlignDot = 1.0;
for (let i = 0; i < 16; i++) {
  const seg = root.getObjectByName(`PaddleArm_Seg_${String(i).padStart(2, '0')}`);
  const u = (i / 15) * 0.968;
  const expectedTan = paddleCurve.getTangentAt(u).normalize();
  const actualZ = new THREE.Vector3(0, 0, 1).applyQuaternion(seg.quaternion);
  const dot = actualZ.dot(expectedTan);
  if (dot < minAlignDot) minAlignDot = dot;
  if (dot < 0.999) {
    throw new Error(`PaddleArm_Seg_${i} +Z axis not aligned with spine tangent! dot=${dot.toFixed(6)}`);
  }
}

for (let t = 0; t < bgSpecs.length; t++) {
  const spec = bgSpecs[t];
  const curve = new THREE.CatmullRomCurve3(spec.points);
  for (let i = 0; i < spec.segCount; i++) {
    const seg = root.getObjectByName(`BgTentacle_${t}_Seg_${String(i).padStart(2, '0')}`);
    if (!seg) throw new Error(`Missing BgTentacle_${t}_Seg_${String(i).padStart(2, '0')}`);
    const u = (i / (spec.segCount - 1)) * 0.968;
    const expectedTan = curve.getTangentAt(u).normalize();
    const actualZ = new THREE.Vector3(0, 0, 1).applyQuaternion(seg.quaternion);
    const dot = actualZ.dot(expectedTan);
    if (dot < minAlignDot) minAlignDot = dot;
    if (dot < 0.999) {
      throw new Error(`BgTentacle_${t}_Seg_${i} +Z axis not aligned with spine tangent! dot=${dot.toFixed(6)}`);
    }
  }
}

// 4. Verify zero NaN/Infinity floats and positive outward normals across all geometries
let renderedTriangles = 0;
let nanFloatCount = 0;
let zeroNormalCount = 0;
root.traverse((obj) => {
  if (obj.isMesh && obj.geometry) {
    const g = obj.geometry;
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    for (let i = 0; i < pos.array.length; i++) {
      if (!Number.isFinite(pos.array[i])) nanFloatCount++;
    }
    if (norm) {
      for (let i = 0; i < norm.count; i++) {
        const len = Math.hypot(norm.getX(i), norm.getY(i), norm.getZ(i));
        if (!Number.isFinite(len) || len < 0.5) zeroNormalCount++;
      }
    }
    const idx = g.getIndex();
    renderedTriangles += idx ? idx.count / 3 : pos.count / 3;
  }
});
if (nanFloatCount > 0 || zeroNormalCount > 0) {
  throw new Error(`Geometry integrity error: nanFloats=${nanFloatCount}, zeroNormals=${zeroNormalCount}`);
}

// 5. Compute exact bounding boxes
const carapaceObj = root.getObjectByName('Carapace');
const carapaceArmorOnly = root.getObjectByName('CarapaceArmorPlates');
const carapaceChassisOnly = root.getObjectByName('CarapaceChassis');
const domeBox = new THREE.Box3()
  .setFromObject(carapaceArmorOnly)
  .union(new THREE.Box3().setFromObject(carapaceChassisOnly));
const domeSize = domeBox.getSize(new THREE.Vector3());
const carapaceBox = new THREE.Box3().setFromObject(carapaceObj);
const carapaceSize = carapaceBox.getSize(new THREE.Vector3());
const fullBox = new THREE.Box3().setFromObject(root);
const fullSize = fullBox.getSize(new THREE.Vector3());

// 6. Export GLB
const result = exportSceneToGLB(root, OUTPUT_PATH);
const elapsedMs = (performance.now() - t0).toFixed(0);

console.log(`Built Reference Sentinel GLB in ${elapsedMs} ms -> ${result.outputPath}`);
console.log(
  `  Size: ${(result.byteLength / 1024).toFixed(1)} KB | Nodes: ${result.nodeCount} | Unique Meshes: ${result.meshCount} | Materials: ${result.materialCount} | Textures: ${result.textureCount}`
);
console.log(`  Rendered Scene Triangles (instanced): ${Math.round(renderedTriangles)}`);
console.log(
  `  Min Spine +Z Alignment Dot: ${minAlignDot.toFixed(6)} | NaN Floats: ${nanFloatCount} | Bad Normals: ${zeroNormalCount}`
);
console.log(
  `  Carapace Dome + Chassis Bounds: W=${domeSize.x.toFixed(2)}m H=${domeSize.y.toFixed(2)}m D=${domeSize.z.toFixed(2)}m (min=[${domeBox.min.toArray().map((n) => n.toFixed(2))}], max=[${domeBox.max.toArray().map((n) => n.toFixed(2))}])`
);
console.log(
  `  Carapace + Hanging Beard Bounds: W=${carapaceSize.x.toFixed(2)}m H=${carapaceSize.y.toFixed(2)}m D=${carapaceSize.z.toFixed(2)}m (min=[${carapaceBox.min.toArray().map((n) => n.toFixed(2))}], max=[${carapaceBox.max.toArray().map((n) => n.toFixed(2))}])`
);
console.log(
  `  Full Sentinel Bounds:           W=${fullSize.x.toFixed(2)}m H=${fullSize.y.toFixed(2)}m D=${fullSize.z.toFixed(2)}m (min=[${fullBox.min.toArray().map((n) => n.toFixed(2))}], max=[${fullBox.max.toArray().map((n) => n.toFixed(2))}])`
);
console.log(
  `  PaddleClaw Pos: [${clawObj.position.toArray().map((n) => n.toFixed(3))}] | PaddleSocket Local: [${socketObj.position.toArray().map((n) => n.toFixed(3))}] | Socket World +Z: [${socketForward.toArray().map((n) => n.toFixed(3))}]`
);
console.log(
  `  PaddleClaw 4 Finger Tips (claw local, gripping around [0, 0, 0.14]):`,
  fingerTips.map((v) => `[${v.toArray().map((n) => n.toFixed(3)).join(',')}]`).join('  ')
);
