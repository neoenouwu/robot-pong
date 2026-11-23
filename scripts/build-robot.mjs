/**
 * Procedural Hero 3D Boss Model Builder — Robot (`public/models/robot.glb`)
 *
 * Constructs a high-detail armored octopus-robot:
 * - Sculpted multi-plate overlapping gunmetal carapace (~2.0m W x 0.95m H x 1.75m D)
 *   with bolted dorsal ribs, spine crest, hydraulic vents, shoulder sockets,
 *   mechanical reactor underbelly, and hanging metallic cable tendrils.
 * - Iconic fiery crimson optical sensor cluster: recessed concentric shutter
 *   aperture + glowing central `MainEyeCore` + 10 flanking `SubEyes`.
 * - 7 articulated multi-segment mechanical tentacles (local +Z along spine):
 *   - 16-segment primary paddle arm (`PaddleArm_Seg_00`..`15`) terminating in
 *     4-finger `PaddleClaw` with child `PaddleSocket` oriented for +Z paddle face.
 *   - 6 sweeping 12-segment background tentacles (`BgTentacle_0`..`5`), each with
 *     `BgTentacle_{i}_Seg_00`..`11` and 3-prong `BgTentacle_{i}_Claw`.
 * - Embedded procedural PBR PNG textures (weathered gunmetal armor baseColor,
 *   metallicRoughness [G=roughness, B=metalness], normal; crimson eye iris
 *   baseColor & emissive).
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
const OUTPUT_PATH = path.resolve(__dirname, '../public/models/robot.glb');

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
// Safe Indexed Geometry Utilities & Validation
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

/**
 * Merges an array of BufferGeometries into a single compact indexed BufferGeometry.
 */
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
 * Compact 6-sided raised hex bolt cap (base seated flush on y=0, cap at y=height).
 * Much lighter than full double-capped CylinderGeometry while looking crisp.
 */
function buildHexBoltCap(radius, height) {
  const sides = 6;
  const verts = [];
  const uvs = [];
  const idx = [];

  // Top center vertex (0)
  verts.push(0, height, 0);
  uvs.push(0.5, 0.5);

  // Top bevel ring (1..6) and bottom ring (7..12)
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    verts.push(ca * radius * 0.85, height, sa * radius * 0.85);
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
    // Top cap (CCW looking from +Y -> normal +Y)
    idx.push(0, 1 + next, 1 + i);
    // Side walls (outward normals)
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
 * Builds a closed, solid curved armor plate with finite thickness, outward-verified
 * winding (guaranteed positive signed volume), crisp beveled rim edges, and clean UVs.
 *
 * `insideRef` is a point inside the carapace hull; if `du x dv` points inward toward
 * `insideRef`, the `u` parameter is automatically reversed so outer surface, inner
 * backing, and all 4 rim walls have 100% outward-pointing normals!
 */
function buildThickCurvedPlate(
  uSegs,
  vSegs,
  evalFn,
  thickness = 0.030,
  uvRepeatU = 1.6,
  uvRepeatV = 0.85,
  insideRef = new THREE.Vector3(0, -0.14, -0.05)
) {
  // Auto-detect winding orientation at the center of the plate
  const pC = evalFn(0.5, 0.5);
  const pU = evalFn(0.55, 0.5);
  const pV = evalFn(0.5, 0.55);
  const testCross = new THREE.Vector3().subVectors(pU, pC).cross(new THREE.Vector3().subVectors(pV, pC));
  const outVec = new THREE.Vector3().subVectors(pC, insideRef);
  const flipU = testCross.dot(outVec) < 0;

  const cols = uSegs + 1;
  const rows = vSegs + 1;
  const outerPts = new Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const v = j / vSegs;
    for (let i = 0; i < cols; i++) {
      const uRaw = i / uSegs;
      const u = flipU ? 1 - uRaw : uRaw;
      outerPts[j * cols + i] = evalFn(u, v);
    }
  }

  // Smooth outward vertex normals via finite differences (du x dv guaranteed outward)
  const outerNormals = new Array(cols * rows);
  const du = new THREE.Vector3();
  const dv = new THREE.Vector3();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(uSegs, i + 1);
      const j0 = Math.max(0, j - 1);
      const j1 = Math.min(vSegs, j + 1);
      du.subVectors(outerPts[j * cols + i1], outerPts[j * cols + i0]);
      dv.subVectors(outerPts[j1 * cols + i], outerPts[j0 * cols + i]);
      const n = new THREE.Vector3().crossVectors(du, dv);
      if (n.lengthSq() < 1e-10) {
        n.copy(outerPts[j * cols + i]).sub(insideRef).normalize();
      } else {
        n.normalize();
      }
      outerNormals[j * cols + i] = n;
    }
  }

  const innerPts = new Array(cols * rows);
  for (let k = 0; k < outerPts.length; k++) {
    innerPts[k] = outerPts[k].clone().addScaledVector(outerNormals[k], -thickness);
  }

  const parts = [];

  // 1. Outer curved surface (facing +du x dv = OUTWARD)
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
        uv[k * 2] = u * uvRepeatU;
        uv[k * 2 + 1] = v * uvRepeatV;
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

  // 2. Inner backing surface (reversed winding, facing -n)
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
        uv[k * 2] = u * uvRepeatU;
        uv[k * 2 + 1] = v * uvRepeatV;
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

  // 3. Four outward-facing rim walls (traversing boundary CCW when viewed from +n)
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
      uv[i * 4] = t * 1.4;
      uv[i * 4 + 1] = 0;
      uv[i * 4 + 2] = t * 1.4;
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

  const merged = mergeIndexedGeometries(parts, 'ThickCurvedPlate');
  const vol = computeSignedVolume(merged);
  if (vol <= 0) {
    throw new Error(`ThickCurvedPlate winding check failed! signedVolume=${vol.toFixed(6)}`);
  }
  return merged;
}

/**
 * Builds a +Z-facing curved optical dome lens with crisp planar circular UVs
 * centered at (0.5, 0.5) so concentric iris textures map without polar distortion.
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
// Procedural PBR Textures
// ---------------------------------------------------------------------------
function createGunmetalArmorTextures(size = 512) {
  const heightData = new Float32Array(size * size);
  const vSeams = [0.0, 0.28, 0.5, 0.78];
  const hSeams = [0.0, 0.24, 0.52, 0.76];

  function distToNearest(val, list) {
    let minD = 1.0;
    for (let i = 0; i < list.length; i++) {
      let d = Math.abs(val - list[i]);
      if (d > 0.5) d = 1.0 - d;
      if (d < minD) minD = d;
    }
    return minD;
  }

  const rand = mulberry32(42077);
  const scratches = [];
  for (let i = 0; i < 48; i++) {
    scratches.push({
      x0: rand(),
      y0: rand(),
      angle: (rand() - 0.5) * 0.55 + (i % 3 === 0 ? Math.PI * 0.5 : 0),
      len: 0.04 + rand() * 0.14,
      width: 0.0014 + rand() * 0.0022,
      depth: 0.18 + rand() * 0.26,
    });
  }

  const seamMask = new Float32Array(size * size);
  const rivetMask = new Float32Array(size * size);
  const scratchMask = new Float32Array(size * size);
  const wearMask = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    const dH = distToNearest(v, hSeams);
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = y * size + x;
      const dV = distToNearest(u, vSeams);
      const dSeam = Math.min(dV, dH);

      const brush = fbmTileable(u, v * 0.25, 16, 3, 101) * 0.5 + fbmTileable(u, v, 32, 2, 202) * 0.5;
      const macroNoise = fbmTileable(u, v, 4, 4, 303);
      const finePits = fbmTileable(u, v, 24, 3, 404);

      let h = 0.55 + (brush - 0.5) * 0.08 + (macroNoise - 0.5) * 0.06;
      const groove = 1.0 - smoothstep(0.004, 0.013, dSeam);
      const bevelLip = smoothstep(0.010, 0.017, dSeam) * (1.0 - smoothstep(0.017, 0.028, dSeam));

      h -= groove * 0.46;
      h += bevelLip * 0.09;

      let riv = 0;
      const marginDist = 0.036;
      const nearH = Math.abs(dH - marginDist) < 0.014 && dV > 0.025;
      const nearV = Math.abs(dV - marginDist) < 0.014 && dH > 0.025;
      if (nearH || nearV) {
        const spacing = 1 / 16;
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
        if (rDist < 0.0095) {
          const dome = Math.sqrt(Math.max(0, 1 - (rDist / 0.0075) ** 2));
          const ring = smoothstep(0.0065, 0.008, rDist) * (1 - smoothstep(0.008, 0.0095, rDist));
          riv = dome;
          h += dome * 0.24 - ring * 0.14;
        }
      }

      if (finePits < 0.28) {
        h -= (0.28 - finePits) * 0.35;
      }

      heightData[idx] = clamp(h, 0, 1);
      seamMask[idx] = groove;
      rivetMask[idx] = riv;
      wearMask[idx] = clamp(bevelLip * 0.85 + macroNoise * 0.45, 0, 1);
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
            heightData[idx] = clamp(heightData[idx] - amt * 0.35, 0, 1);
            scratchMask[idx] = Math.max(scratchMask[idx], amt);
          }
        }
      }
    }
  }

  const baseColor = createPixelTexture(size, size, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const idx = y * w + x;
        const n1 = fbmTileable(u, v, 6, 4, 511);
        const n2 = fbmTileable(u, v * 0.35, 18, 3, 619);
        const patina = fbmTileable(u, v, 8, 3, 733);

        let r = 46 + (n1 - 0.5) * 18 + (n2 - 0.5) * 10;
        let g = 53 + (n1 - 0.5) * 20 + (n2 - 0.5) * 10 + Math.max(0, patina - 0.52) * 16;
        let b = 59 + (n1 - 0.5) * 20 + (n2 - 0.5) * 10;

        const edgeWear = wearMask[idx];
        const sc = scratchMask[idx];
        r += edgeWear * 20 + sc * 68;
        g += edgeWear * 23 + sc * 74;
        b += edgeWear * 25 + sc * 80;

        const riv = rivetMask[idx];
        if (riv > 0.01) {
          r = r * (1 - riv) + 118 * riv;
          g = g * (1 - riv) + 126 * riv;
          b = b * (1 - riv) + 134 * riv;
        }

        const seam = seamMask[idx];
        const seamFactor = 1.0 - seam * 0.78;
        r *= seamFactor;
        g *= seamFactor;
        b *= seamFactor;

        const p = idx * 4;
        out[p] = clamp(Math.round(r), 0, 255);
        out[p + 1] = clamp(Math.round(g), 0, 255);
        out[p + 2] = clamp(Math.round(b), 0, 255);
        out[p + 3] = 255;
      }
    }
  });

  // glTF 2.0 MetallicRoughness: G = Roughness, B = Metalness
  const metallicRoughness = createPixelTexture(size, size, (out, w, h) => {
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const idx = y * w + x;
        const smudge = fbmTileable(u, v, 8, 4, 881);
        const micro = fbmTileable(u, v, 24, 2, 919);

        let rough = 0.34 + (smudge - 0.5) * 0.22 + (micro - 0.5) * 0.08;
        let metal = 0.86 + (smudge - 0.5) * 0.08;

        const riv = rivetMask[idx];
        const sc = scratchMask[idx];
        rough -= riv * 0.14 + sc * 0.20 + wearMask[idx] * 0.08;
        metal += riv * 0.10 + sc * 0.12;

        const seam = seamMask[idx];
        rough = rough * (1 - seam) + 0.84 * seam;
        metal = metal * (1 - seam) + 0.28 * seam;

        const p = idx * 4;
        out[p] = 255;
        out[p + 1] = clamp(Math.round(clamp(rough, 0.14, 0.94) * 255), 0, 255); // G = Roughness
        out[p + 2] = clamp(Math.round(clamp(metal, 0.15, 0.98) * 255), 0, 255); // B = Metalness
        out[p + 3] = 255;
      }
    }
  });

  const normal = heightMapToNormalTexture(size, size, heightData, 3.2);
  return { baseColor, metallicRoughness, normal };
}

function createCrimsonEyeTextures(size = 256) {
  const clampOpts = { wrapS: 33071, wrapT: 33071 }; // CLAMP_TO_EDGE

  const baseColor = createPixelTexture(
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

          const filament =
            0.5 +
            0.28 * Math.sin(ang * 24 + r * 9.0) +
            0.22 * Math.cos(ang * 42 - r * 14.0);
          const ring1 = Math.exp(-((r - 0.30) ** 2) / 0.00055);
          const ring2 = Math.exp(-((r - 0.52) ** 2) / 0.00070);
          const ring3 = Math.exp(-((r - 0.72) ** 2) / 0.00080);
          const darkTrack = Math.exp(-((r - 0.62) ** 2) / 0.0014);

          const hotCore = Math.exp(-(r * r) / 0.042);
          const midGlow = Math.exp(-(r * r) / 0.28);
          const edgeFade = 1.0 - smoothstep(0.78, 0.98, r);

          let cr =
            (210 * midGlow +
              75 * filament * midGlow +
              95 * hotCore +
              90 * (ring1 + ring2 * 0.8 + ring3 * 0.5)) *
            edgeFade;
          let cg = (18 * midGlow + 185 * hotCore + 55 * ring1 + 18 * ring2) * edgeFade;
          let cb = (8 * midGlow + 90 * hotCore + 12 * ring1) * edgeFade;

          const trackMul = 1.0 - darkTrack * 0.45;
          cr *= trackMul;
          cg *= trackMul;
          cb *= trackMul;

          out[idx] = clamp(Math.round(cr), 8, 255);
          out[idx + 1] = clamp(Math.round(cg), 2, 255);
          out[idx + 2] = clamp(Math.round(cb), 2, 255);
          out[idx + 3] = 255;
        }
      }
    },
    clampOpts
  );

  const emissive = createPixelTexture(
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

          const filament =
            0.55 +
            0.25 * Math.sin(ang * 24 + r * 8.0) +
            0.20 * Math.cos(ang * 48 - r * 12.0);
          const ring1 = Math.exp(-((r - 0.30) ** 2) / 0.0005);
          const ring2 = Math.exp(-((r - 0.52) ** 2) / 0.00065);
          const ring3 = Math.exp(-((r - 0.72) ** 2) / 0.00075);
          const darkTrack = Math.exp(-((r - 0.62) ** 2) / 0.0013);

          const hotCore = Math.exp(-(r * r) / 0.036);
          const irisGlow = Math.exp(-(r * r) / 0.24);
          const edgeMask = 1.0 - smoothstep(0.75, 0.96, r);

          let er =
            (235 * irisGlow * (0.72 + 0.38 * filament) +
              120 * hotCore +
              120 * ring1 +
              95 * ring2 +
              65 * ring3) *
            edgeMask;
          let eg = (22 * irisGlow + 205 * hotCore + 60 * ring1 + 18 * ring2) * edgeMask;
          let eb = (6 * irisGlow + 110 * hotCore + 10 * ring1) * edgeMask;

          const trackMul = 1.0 - darkTrack * 0.52;
          er *= trackMul;
          eg *= trackMul;
          eb *= trackMul;

          out[idx] = clamp(Math.round(er), 0, 255);
          out[idx + 1] = clamp(Math.round(eg), 0, 255);
          out[idx + 2] = clamp(Math.round(eb), 0, 255);
          out[idx + 3] = 255;
        }
      }
    },
    clampOpts
  );

  return { baseColor, emissive };
}

function createMaterials() {
  const armorTex = createGunmetalArmorTextures(512);
  const eyeTex = createCrimsonEyeTextures(256);

  const armorPrimary = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'RobotGunmetalArmor',
      color: 0xffffff,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(1.35, 1.35),
    }),
    {
      baseColor: armorTex.baseColor,
      metallicRoughness: armorTex.metallicRoughness,
      normal: armorTex.normal,
    }
  );

  const armorDark = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'RobotDarkSubframe',
      color: 0x5c6670,
      roughness: 1.0,
      metalness: 1.0,
      normalScale: new THREE.Vector2(1.15, 1.15),
    }),
    {
      baseColor: armorTex.baseColor,
      metallicRoughness: armorTex.metallicRoughness,
      normal: armorTex.normal,
    }
  );

  const chromeSteel = new THREE.MeshStandardMaterial({
    name: 'RobotHydraulicSteel',
    color: 0x9aa6b4,
    metalness: 0.94,
    roughness: 0.22,
  });

  const darkCable = new THREE.MeshStandardMaterial({
    name: 'RobotBraidedCable',
    color: 0x151a1e,
    metalness: 0.36,
    roughness: 0.56,
  });

  const mainEye = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'RobotMainEyeIris',
      color: 0xffffff,
      roughness: 0.12,
      metalness: 0.08,
      emissive: 0xffffff,
      emissiveIntensity: 4.5,
    }),
    {
      baseColor: eyeTex.baseColor,
      emissive: eyeTex.emissive,
    }
  );

  const subEye = attachPBRTextures(
    new THREE.MeshStandardMaterial({
      name: 'RobotSubEyeIris',
      color: 0xffffff,
      roughness: 0.14,
      metalness: 0.1,
      emissive: 0xffffff,
      emissiveIntensity: 3.8,
    }),
    {
      baseColor: eyeTex.baseColor,
      emissive: eyeTex.emissive,
    }
  );

  const ledCrimson = new THREE.MeshStandardMaterial({
    name: 'RobotCrimsonLED',
    color: 0x3a0505,
    emissive: 0xff1c0e,
    emissiveIntensity: 3.6,
    roughness: 0.22,
    metalness: 0.1,
  });

  return {
    armorPrimary,
    armorDark,
    chromeSteel,
    darkCable,
    mainEye,
    subEye,
    ledCrimson,
  };
}

// ---------------------------------------------------------------------------
// Carapace Shell Surface Parameterization (~2.0m W x 0.95m H x 1.75m D)
// ---------------------------------------------------------------------------
function evalCarapaceHullPoint(uSigned, zNorm, lift = 0) {
  // uSigned in [-1, 1] (left to right), zNorm in [-1, 1] (rear -Z to front +Z)
  // Targets x in [-0.96, +0.96], y in [-0.42, +0.48], z in [-0.90, +0.83]
  const z = -0.04 + zNorm * 0.86; // [-0.90, +0.82]

  const frontRound = Math.pow(
    Math.max(0.001, 1 - Math.max(0, zNorm - 0.14) ** 2 / 0.86 ** 2),
    0.55
  );
  const rearTaper = 1.0 - 0.54 * Math.pow(Math.max(0, -zNorm), 1.45);
  const halfWidth = 0.91 * frontRound * rearTaper + lift * 0.42;

  const angle = uSigned * Math.PI * 0.5;
  const x = Math.sin(angle) * halfWidth;

  const crownProfile =
    0.40 * Math.cos(zNorm * Math.PI * 0.44) * (1.0 - 0.16 * Math.max(0, -zNorm));
  const browDrop = zNorm > 0.56 ? -0.17 * Math.pow((zNorm - 0.56) / 0.44, 1.8) : 0;
  const scowlDip =
    zNorm > 0.65
      ? -0.052 * Math.exp(-(uSigned * uSigned) / 0.08) * ((zNorm - 0.65) / 0.35)
      : 0;
  const keelBump =
    0.028 * Math.exp(-(uSigned * uSigned) / 0.07) * (1.0 - Math.max(0, zNorm - 0.5) * 1.4);

  const archCos = Math.cos(angle);
  const y =
    -0.06 +
    Math.pow(Math.max(0, archCos), 0.72) * (crownProfile + lift) +
    browDrop +
    scowlDip +
    keelBump;

  return new THREE.Vector3(x, y, z);
}

// ---------------------------------------------------------------------------
// Carapace & Optical Sensor Cluster Builder
// ---------------------------------------------------------------------------
function buildCarapace(mats, shoulderSockets) {
  const carapace = new THREE.Group();
  carapace.name = 'Carapace';

  const armorGeoms = [];
  const darkGeoms = [];
  const chromeGeoms = [];
  const cableGeoms = [];
  const ledGeoms = [];

  const boltProto = buildHexBoltCap(0.012, 0.011);

  // 1. Sealed Inner Mechanical Hull Core
  {
    const core = new THREE.SphereGeometry(1, 26, 16);
    const pos = core.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);
      const rearScale = z < 0 ? 1.0 - 0.38 * -z : 1.0 - 0.12 * z * z;
      x *= 0.81 * rearScale;
      y = y >= 0 ? y * 0.37 : y * 0.33 - 0.03;
      z *= 0.79;
      if (z > 0.58 && Math.abs(x) < 0.54 && y > -0.22 && y < 0.22) {
        z = Math.min(z, 0.65 + 0.04 * (1 - (x / 0.54) ** 2));
      }
      pos.setXYZ(i, x, y, z - 0.04);
    }
    core.computeVertexNormals();
    darkGeoms.push(core);
  }

  // 2. Five Overlapping Sculpted Shingled Dorsal Armor Plates (verified outward winding)
  const dorsalTiers = [
    { zMin: 0.42, zMax: 0.98, uSpan: 0.84, lift: 0.038, thick: 0.032, uSegs: 18, vSegs: 6 },
    { zMin: 0.02, zMax: 0.54, uSpan: 0.95, lift: 0.048, thick: 0.034, uSegs: 20, vSegs: 7 },
    { zMin: -0.42, zMax: 0.14, uSpan: 0.94, lift: 0.058, thick: 0.034, uSegs: 20, vSegs: 7 },
    { zMin: -0.78, zMax: -0.30, uSpan: 0.87, lift: 0.046, thick: 0.030, uSegs: 16, vSegs: 6 },
    { zMin: -1.00, zMax: -0.66, uSpan: 0.72, lift: 0.028, thick: 0.026, uSegs: 14, vSegs: 5 },
  ];

  for (const tier of dorsalTiers) {
    const plate = buildThickCurvedPlate(
      tier.uSegs,
      tier.vSegs,
      (u, v) => {
        const uSigned = (u * 2 - 1) * tier.uSpan;
        const zNorm = tier.zMin + v * (tier.zMax - tier.zMin);
        const shingleRamp = (1 - v) * 0.018;
        return evalCarapaceHullPoint(uSigned, zNorm, tier.lift + shingleRamp);
      },
      tier.thick,
      2.0,
      0.85
    );
    armorGeoms.push(plate);
  }

  // 3. Flared Left & Right Lateral Cheek / Wing Armor Shields (2 overlapping plates per side)
  for (const side of [-1, 1]) {
    const cheekPlate = buildThickCurvedPlate(
      10,
      6,
      (u, v) => {
        const zNorm = 0.08 + u * 0.70;
        const p = evalCarapaceHullPoint(side * (0.76 + v * 0.24), zNorm, 0.02);
        p.x += side * (0.032 + v * 0.042 * (1 - u * 0.35));
        p.y -= 0.03 + v * 0.14;
        return p;
      },
      0.026,
      1.2,
      0.7
    );
    armorGeoms.push(cheekPlate);

    const wingPlate = buildThickCurvedPlate(
      12,
      6,
      (u, v) => {
        const zNorm = -0.72 + u * 0.86;
        const p = evalCarapaceHullPoint(side * (0.72 + v * 0.28), zNorm, 0.018);
        p.x += side * (0.038 + v * 0.045 * Math.sin(u * Math.PI));
        p.y -= 0.02 + v * 0.16;
        return p;
      },
      0.026,
      1.4,
      0.75
    );
    armorGeoms.push(wingPlate);
  }

  // 4. Seven Transverse Bolted Dorsal Ribs + Hex Chrome Bolts
  const ribZNorms = [0.68, 0.44, 0.20, -0.04, -0.28, -0.52, -0.74];
  for (let r = 0; r < ribZNorms.length; r++) {
    const zN = ribZNorms[r];
    const span = r === 0 ? 0.70 : r === ribZNorms.length - 1 ? 0.62 : 0.88;
    const pts = [];
    const samples = 13;
    for (let i = 0; i <= samples; i++) {
      const uS = ((i / samples) * 2 - 1) * span;
      pts.push(evalCarapaceHullPoint(uS, zN, 0.064));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const ribRad = r === 0 || r === ribZNorms.length - 1 ? 0.020 : 0.025;
    darkGeoms.push(new THREE.TubeGeometry(curve, 18, ribRad, 7, false));

    for (let b = 1; b < samples; b += 2) {
      const p = pts[b];
      const outward = p.clone().setZ(0).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
      const m = new THREE.Matrix4().compose(
        p.clone().addScaledVector(outward, ribRad * 0.72),
        q,
        new THREE.Vector3(1, 1, 1)
      );
      chromeGeoms.push(transformed(boltProto, m));
    }
  }

  // 5. Central Dorsal Spine Crest (8 interlocking armored vertebrae fins)
  const spineFinShape = new THREE.Shape();
  spineFinShape.moveTo(-0.070, 0);
  spineFinShape.lineTo(0.060, 0);
  spineFinShape.lineTo(0.038, 0.056);
  spineFinShape.lineTo(-0.046, 0.074);
  spineFinShape.closePath();

  const spineFinBase = new THREE.ExtrudeGeometry(spineFinShape, {
    depth: 0.066,
    bevelEnabled: true,
    bevelThickness: 0.010,
    bevelSize: 0.008,
    bevelSegments: 2,
  });
  spineFinBase.translate(0, 0, -0.033);
  spineFinBase.rotateY(Math.PI * 0.5);

  for (let i = 0; i < 8; i++) {
    const zN = 0.60 - i * 0.21;
    const p = evalCarapaceHullPoint(0, zN, 0.052);
    const pFront = evalCarapaceHullPoint(0, zN + 0.04, 0.052);
    const pitch = -Math.atan2(pFront.y - p.y, pFront.z - p.z);
    const scaleFactor = 1.0 - Math.abs(i - 3) * 0.07;
    const m = makeTransform(
      p,
      new THREE.Euler(pitch, 0, 0),
      new THREE.Vector3(scaleFactor, scaleFactor, scaleFactor)
    );
    armorGeoms.push(transformed(spineFinBase, m));

    if (i >= 1 && i <= 5) {
      const pip = new THREE.BoxGeometry(0.022, 0.012, 0.034);
      const pm = makeTransform(
        p.clone().add(new THREE.Vector3(0, 0.028 * scaleFactor, -0.066 * scaleFactor)),
        new THREE.Euler(pitch, 0, 0)
      );
      ledGeoms.push(transformed(pip, pm));
    }
  }

  // 6. Recessed Side Hydraulic Intake Vents / Louvers & Rear Exhaust Manifolds
  const ventHousingGeo = new THREE.BoxGeometry(0.085, 0.13, 0.28);
  const ventLouverGeo = new THREE.BoxGeometry(0.07, 0.013, 0.040);
  for (const side of [-1, 1]) {
    const ventConfigs = [
      { zN: -0.06, uS: 0.85, yaw: side * 0.22 },
      { zN: -0.50, uS: 0.80, yaw: side * 0.42 },
    ];
    for (const vc of ventConfigs) {
      const p = evalCarapaceHullPoint(side * vc.uS, vc.zN, 0.025);
      p.x += side * 0.025;
      const mBase = makeTransform(p, new THREE.Euler(0.06, vc.yaw, -side * 0.35));
      darkGeoms.push(transformed(ventHousingGeo, mBase));
      for (let l = 0; l < 5; l++) {
        const lm = mBase.clone().multiply(
          makeTransform(
            new THREE.Vector3(side * 0.016, 0.01, -0.095 + l * 0.048),
            new THREE.Euler(0.45, 0, 0)
          )
        );
        chromeGeoms.push(transformed(ventLouverGeo, lm));
      }
    }

    const exhaustPos = new THREE.Vector3(side * 0.32, -0.04, -0.81);
    const exhaustRot = new THREE.Euler(Math.PI * 0.5 + 0.12, side * 0.18, 0);
    const outerNozzle = new THREE.CylinderGeometry(0.105, 0.125, 0.20, 14);
    const innerNozzle = new THREE.CylinderGeometry(0.080, 0.088, 0.21, 12);
    armorGeoms.push(transformed(outerNozzle, makeTransform(exhaustPos, exhaustRot)));
    darkGeoms.push(
      transformed(innerNozzle, makeTransform(exhaustPos.clone().add(new THREE.Vector3(0, 0, -0.01)), exhaustRot))
    );
  }

  // 7. Armored Shoulder Socket Collars at all 7 tentacle mount points
  const socketRingPts = [
    new THREE.Vector2(0.088, -0.04),
    new THREE.Vector2(0.140, -0.035),
    new THREE.Vector2(0.156, 0.01),
    new THREE.Vector2(0.146, 0.052),
    new THREE.Vector2(0.120, 0.066),
    new THREE.Vector2(0.092, 0.052),
    new THREE.Vector2(0.088, -0.04),
  ];
  const socketCollarProto = new THREE.LatheGeometry(socketRingPts, 16);
  socketCollarProto.rotateX(Math.PI * 0.5);

  for (const sock of shoulderSockets) {
    const dir = sock.dir.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    const s = sock.scale;
    const m = new THREE.Matrix4().compose(sock.pos, q, new THREE.Vector3(s, s, s));
    armorGeoms.push(transformed(socketCollarProto, m));

    const cup = new THREE.CylinderGeometry(0.098 * s, 0.090 * s, 0.066 * s, 12);
    cup.rotateX(Math.PI * 0.5);
    darkGeoms.push(transformed(cup, m));

    for (let b = 0; b < 6; b++) {
      const a = (b / 6) * Math.PI * 2;
      const localOff = new THREE.Vector3(Math.cos(a) * 0.136 * s, Math.sin(a) * 0.136 * s, 0.052 * s);
      const bm = m.clone().multiply(
        makeTransform(localOff, new THREE.Euler(Math.PI * 0.5, 0, 0), new THREE.Vector3(0.95, 0.95, 0.95))
      );
      chromeGeoms.push(transformed(boltProto, bm));
    }
  }

  // 8. Mechanical Underbelly Reactor Housing (FIXED outward LatheGeometry winding: bottom -> top!)
  {
    const drumPts = [
      new THREE.Vector2(0.001, -0.075),
      new THREE.Vector2(0.13, -0.075),
      new THREE.Vector2(0.16, -0.115),
      new THREE.Vector2(0.26, -0.115),
      new THREE.Vector2(0.28, -0.085),
      new THREE.Vector2(0.33, -0.085),
      new THREE.Vector2(0.37, -0.048),
      new THREE.Vector2(0.35, 0.0),
      new THREE.Vector2(0.001, 0.0),
    ];
    const drum = new THREE.LatheGeometry(drumPts, 20);
    drum.translate(0, -0.30, -0.05);
    darkGeoms.push(drum);

    const ribBar = new THREE.BoxGeometry(0.034, 0.044, 0.22);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const m = makeTransform(
        new THREE.Vector3(Math.sin(a) * 0.24, -0.365, -0.05 + Math.cos(a) * 0.24),
        new THREE.Euler(0, a, 0)
      );
      armorGeoms.push(transformed(ribBar, m));
    }

    const coreRing = new THREE.TorusGeometry(0.14, 0.012, 8, 22);
    coreRing.rotateX(Math.PI * 0.5);
    coreRing.translate(0, -0.395, -0.05);
    ledGeoms.push(coreRing);

    for (const side of [-1, 1]) {
      for (const zOff of [-0.26, 0.22]) {
        const pA = new THREE.Vector3(side * 0.23, -0.33, zOff - 0.05);
        const pB = new THREE.Vector3(side * 0.64, -0.15, zOff + 0.07);
        const diff = new THREE.Vector3().subVectors(pB, pA);
        const len = diff.length();
        const mid = pA.clone().addScaledVector(diff, 0.5);
        const q = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          diff.clone().normalize()
        );

        const sleeve = new THREE.CylinderGeometry(0.024, 0.026, len * 0.54, 8);
        const mSleeve = new THREE.Matrix4().compose(
          pA.clone().addScaledVector(diff, 0.28),
          q,
          new THREE.Vector3(1, 1, 1)
        );
        darkGeoms.push(transformed(sleeve, mSleeve));

        const rod = new THREE.CylinderGeometry(0.013, 0.013, len * 0.96, 8);
        const mRod = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
        chromeGeoms.push(transformed(rod, mRod));
      }
    }
  }

  // 9. Hanging Metallic Underbelly Cable Tendrils & Braided Harnesses (18 sculpted cables, compact drop)
  {
    const rand = mulberry32(9001);
    const tipGeo = new THREE.CylinderGeometry(0.010, 0.006, 0.036, 6);

    // 9 looping underbelly wiring harnesses
    for (let i = 0; i < 9; i++) {
      const a0 = (i / 9) * Math.PI * 2 + (rand() - 0.5) * 0.22;
      const a1 = a0 + 0.55 + rand() * 0.60;
      const r0 = 0.20 + rand() * 0.30;
      const r1 = 0.22 + rand() * 0.34;
      const p0 = new THREE.Vector3(
        Math.cos(a0) * r0,
        -0.27 - rand() * 0.05,
        -0.06 + Math.sin(a0) * r0 * 0.85
      );
      const p3 = new THREE.Vector3(
        Math.cos(a1) * r1,
        -0.26 - rand() * 0.05,
        -0.06 + Math.sin(a1) * r1 * 0.85
      );
      const droop = 0.14 + rand() * 0.16;
      const p1 = p0.clone().lerp(p3, 0.33);
      p1.y -= droop;
      const p2 = p0.clone().lerp(p3, 0.67);
      p2.y -= droop * (0.85 + rand() * 0.25);

      const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3]);
      cableGeoms.push(new THREE.TubeGeometry(curve, 10, 0.010 + rand() * 0.008, 6, false));
    }

    // 9 dangling robot wire tendrils beneath the underbelly (draping down to y ~ -0.68)
    for (let i = 0; i < 9; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const bx = side * (0.10 + rand() * 0.40);
      const bz = -0.46 + rand() * 0.78;
      const by = -0.29 - rand() * 0.05;
      const dropLen = 0.22 + rand() * 0.16;
      const swayX = (rand() - 0.5) * 0.18 + side * 0.05;
      const swayZ = -0.08 - rand() * 0.14;

      const cPts = [
        new THREE.Vector3(bx, by, bz),
        new THREE.Vector3(bx + swayX * 0.4, by - dropLen * 0.36, bz + swayZ * 0.35),
        new THREE.Vector3(bx + swayX * 0.9, by - dropLen * 0.74, bz + swayZ * 0.85),
        new THREE.Vector3(bx + swayX * 0.72, by - dropLen, bz + swayZ * 1.1),
      ];
      const curve = new THREE.CatmullRomCurve3(cPts);
      cableGeoms.push(new THREE.TubeGeometry(curve, 10, 0.0085 + rand() * 0.006, 6, false));

      const endPt = cPts[3];
      const endDir = new THREE.Vector3().subVectors(cPts[3], cPts[2]).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), endDir);
      chromeGeoms.push(transformed(tipGeo, new THREE.Matrix4().compose(endPt, q, new THREE.Vector3(1, 1, 1))));
    }
  }

  // 10. Iconic Glowing Crimson Optical Sensor Cluster (Front Face +Z)
  const mainEyePos = new THREE.Vector3(0, -0.025, 0.745);
  const mainEyeRot = new THREE.Euler(0.08, 0, 0);
  const mainEyeMat4 = makeTransform(mainEyePos, mainEyeRot);

  {
    // Stepped armored cylindrical eye bezel
    const bezelPts = [
      new THREE.Vector2(0.130, -0.072),
      new THREE.Vector2(0.220, -0.072),
      new THREE.Vector2(0.226, -0.020),
      new THREE.Vector2(0.200, 0.032),
      new THREE.Vector2(0.174, 0.044),
      new THREE.Vector2(0.150, 0.032),
      new THREE.Vector2(0.136, 0.005),
      new THREE.Vector2(0.130, -0.072),
    ];
    const bezel = new THREE.LatheGeometry(bezelPts, 24);
    bezel.rotateX(Math.PI * 0.5);
    armorGeoms.push(transformed(bezel, mainEyeMat4));

    const innerRing = new THREE.TorusGeometry(0.153, 0.013, 8, 24);
    innerRing.translate(0, 0, 0.024);
    darkGeoms.push(transformed(innerRing, mainEyeMat4));

    // 8 overlapping mechanical iris shutter blades framing the glowing red core
    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(0.105, -0.026);
    bladeShape.lineTo(0.165, -0.040);
    bladeShape.lineTo(0.162, 0.026);
    bladeShape.lineTo(0.116, 0.040);
    bladeShape.closePath();
    const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, {
      depth: 0.012,
      bevelEnabled: false,
    });
    for (let b = 0; b < 8; b++) {
      const a = (b / 8) * Math.PI * 2;
      const bm = mainEyeMat4
        .clone()
        .multiply(makeTransform(new THREE.Vector3(0, 0, 0.012 + (b % 2) * 0.005), new THREE.Euler(0, 0, a)));
      darkGeoms.push(transformed(bladeGeo, bm));
    }

    // 8 machined chrome bolts around main eye housing
    for (let b = 0; b < 8; b++) {
      const a = (b / 8) * Math.PI * 2 + Math.PI / 8;
      const bm = mainEyeMat4.clone().multiply(
        makeTransform(
          new THREE.Vector3(Math.cos(a) * 0.190, Math.sin(a) * 0.190, 0.032),
          new THREE.Euler(Math.PI * 0.5, 0, 0),
          new THREE.Vector3(1.15, 1.15, 1.15)
        )
      );
      chromeGeoms.push(transformed(boltProto, bm));
    }

    // MainEyeCore: Glowing curved fiery crimson optical lens
    const mainEyeLensGeo = buildOpticalDome(0.140, 0.050, 28, 8);
    const mainEyeMesh = new THREE.Mesh(mainEyeLensGeo, mats.mainEye);
    mainEyeMesh.name = 'MainEyeCore';
    mainEyeMesh.position.copy(mainEyePos).add(new THREE.Vector3(0, -0.002, 0.006));
    mainEyeMesh.rotation.copy(mainEyeRot);
    carapace.add(mainEyeMesh);
  }

  // 10b. 10 Flanking Glowing Crimson Sub-Eyes (`SubEyes` Group)
  const subEyesGroup = new THREE.Group();
  subEyesGroup.name = 'SubEyes';

  const subEyeSpecs = [
    { x: -0.268, y: 0.068, z: 0.705, r: 0.053, yaw: -0.24, pitch: 0.05 },
    { x: 0.268, y: 0.068, z: 0.705, r: 0.053, yaw: 0.24, pitch: 0.05 },
    { x: -0.420, y: 0.092, z: 0.625, r: 0.046, yaw: -0.42, pitch: 0.02 },
    { x: 0.420, y: 0.092, z: 0.625, r: 0.046, yaw: 0.42, pitch: 0.02 },
    { x: -0.570, y: 0.068, z: 0.510, r: 0.039, yaw: -0.62, pitch: 0.04 },
    { x: 0.570, y: 0.068, z: 0.510, r: 0.039, yaw: 0.62, pitch: 0.04 },
    { x: -0.278, y: -0.106, z: 0.685, r: 0.042, yaw: -0.26, pitch: 0.14 },
    { x: 0.278, y: -0.106, z: 0.685, r: 0.042, yaw: 0.26, pitch: 0.14 },
    { x: -0.450, y: -0.090, z: 0.575, r: 0.035, yaw: -0.48, pitch: 0.12 },
    { x: 0.450, y: -0.090, z: 0.575, r: 0.035, yaw: 0.48, pitch: 0.12 },
  ];

  const subBezelPts = [
    new THREE.Vector2(0.88, -1.1),
    new THREE.Vector2(1.42, -1.1),
    new THREE.Vector2(1.46, -0.1),
    new THREE.Vector2(1.28, 0.38),
    new THREE.Vector2(1.06, 0.46),
    new THREE.Vector2(0.92, 0.18),
    new THREE.Vector2(0.88, -1.1),
  ];
  const subBezelGeo = new THREE.LatheGeometry(subBezelPts, 14);
  subBezelGeo.rotateX(Math.PI * 0.5);
  const subDomeGeo = buildOpticalDome(1.0, 0.36, 16, 5);

  for (let i = 0; i < subEyeSpecs.length; i++) {
    const sp = subEyeSpecs[i];
    const mHousing = makeTransform(
      new THREE.Vector3(sp.x, sp.y, sp.z),
      new THREE.Euler(sp.pitch, sp.yaw, 0),
      new THREE.Vector3(sp.r, sp.r, sp.r)
    );
    darkGeoms.push(transformed(subBezelGeo, mHousing));

    const lens = new THREE.Mesh(subDomeGeo, mats.subEye);
    lens.name = `SubEye_${String(i).padStart(2, '0')}`;
    lens.position.set(sp.x, sp.y, sp.z);
    lens.rotation.set(sp.pitch, sp.yaw, 0);
    const fwd = new THREE.Vector3(0, 0, sp.r * 0.16).applyEuler(lens.rotation);
    lens.position.add(fwd);
    lens.scale.setScalar(sp.r * 0.96);
    subEyesGroup.add(lens);
  }
  carapace.add(subEyesGroup);

  // Merge Carapace meshes by material
  const armorMesh = new THREE.Mesh(mergeIndexedGeometries(armorGeoms, 'CarapaceArmor'), mats.armorPrimary);
  armorMesh.name = 'CarapaceArmorPlates';
  carapace.add(armorMesh);

  const darkMesh = new THREE.Mesh(mergeIndexedGeometries(darkGeoms, 'CarapaceChassis'), mats.armorDark);
  darkMesh.name = 'CarapaceChassis';
  carapace.add(darkMesh);

  const chromeMesh = new THREE.Mesh(mergeIndexedGeometries(chromeGeoms, 'CarapaceHardware'), mats.chromeSteel);
  chromeMesh.name = 'CarapaceHardware';
  carapace.add(chromeMesh);

  const cableMesh = new THREE.Mesh(mergeIndexedGeometries(cableGeoms, 'CarapaceUnderbellyCables'), mats.darkCable);
  cableMesh.name = 'CarapaceUnderbellyCables';
  carapace.add(cableMesh);

  const ledMesh = new THREE.Mesh(mergeIndexedGeometries(ledGeoms, 'CarapaceLEDs'), mats.ledCrimson);
  ledMesh.name = 'CarapaceLEDs';
  carapace.add(ledMesh);

  return carapace;
}

// ---------------------------------------------------------------------------
// Articulated Tentacle Segment Archetypes (Local +Z along spine!)
// ---------------------------------------------------------------------------
function createTentacleSegmentArchetype(mats, variant = 'paddle') {
  const R = 0.10;
  const L = 0.125;

  const armorParts = [];
  const darkParts = [];
  const chromeParts = [];
  const ledParts = [];

  // 1. Fluted inner dark bellows/ball-joint spine sleeve
  const sleevePts = [
    new THREE.Vector2(R * 0.62, -L * 0.62),
    new THREE.Vector2(R * 0.76, -L * 0.50),
    new THREE.Vector2(R * 0.70, -L * 0.30),
    new THREE.Vector2(R * 0.78, -L * 0.12),
    new THREE.Vector2(R * 0.72, 0.0),
    new THREE.Vector2(R * 0.78, L * 0.12),
    new THREE.Vector2(R * 0.70, L * 0.30),
    new THREE.Vector2(R * 0.76, L * 0.50),
    new THREE.Vector2(R * 0.62, L * 0.62),
  ];
  const sleeveGeo = new THREE.LatheGeometry(sleevePts, 14);
  sleeveGeo.rotateX(Math.PI * 0.5);
  darkParts.push(sleeveGeo);

  // 2. Sculpted Beveled Outer Armor Collar Ring
  const collarPts =
    variant === 'paddle'
      ? [
          new THREE.Vector2(R * 0.74, -L * 0.44),
          new THREE.Vector2(R * 0.96, -L * 0.38),
          new THREE.Vector2(R * 1.05, -L * 0.24),
          new THREE.Vector2(R * 1.02, -L * 0.10),
          new THREE.Vector2(R * 0.91, -L * 0.05),
          new THREE.Vector2(R * 0.91, L * 0.05),
          new THREE.Vector2(R * 1.02, L * 0.10),
          new THREE.Vector2(R * 1.08, L * 0.26),
          new THREE.Vector2(R * 0.94, L * 0.42),
          new THREE.Vector2(R * 0.74, L * 0.45),
        ]
      : [
          new THREE.Vector2(R * 0.74, -L * 0.42),
          new THREE.Vector2(R * 0.94, -L * 0.32),
          new THREE.Vector2(R * 1.04, -L * 0.14),
          new THREE.Vector2(R * 0.92, 0.0),
          new THREE.Vector2(R * 1.06, L * 0.18),
          new THREE.Vector2(R * 0.92, L * 0.40),
          new THREE.Vector2(R * 0.74, L * 0.44),
        ];
  const collarGeo = new THREE.LatheGeometry(collarPts, 16);
  collarGeo.rotateX(Math.PI * 0.5);
  armorParts.push(collarGeo);

  // 3. Radial Armor Fin Brackets + Hydraulic Side Struts + Compact Micro-Bolts
  const strutCount = variant === 'paddle' ? 4 : 3;
  const finGeo = new THREE.BoxGeometry(R * 0.22, R * 0.24, L * 0.78);
  const pistonRodGeo = new THREE.CylinderGeometry(R * 0.055, R * 0.055, L * 0.92, 6, 1, true);
  pistonRodGeo.rotateX(Math.PI * 0.5);
  const pistonSleeveGeo = new THREE.CylinderGeometry(R * 0.092, R * 0.092, L * 0.46, 6);
  pistonSleeveGeo.rotateX(Math.PI * 0.5);
  const boltGeo = buildHexBoltCap(R * 0.072, R * 0.08);
  const ledGeo = new THREE.BoxGeometry(R * 0.085, R * 0.11, L * 0.18);

  for (let i = 0; i < strutCount; i++) {
    const a = (i / strutCount) * Math.PI * 2 + (variant === 'paddle' ? Math.PI * 0.25 : Math.PI * 0.5);
    const ca = Math.cos(a);
    const sa = Math.sin(a);

    const finM = makeTransform(
      new THREE.Vector3(ca * R * 0.98, sa * R * 0.98, 0),
      new THREE.Euler(0, 0, a)
    );
    armorParts.push(transformed(finGeo, finM));

    const pa = a + Math.PI / strutCount;
    const pca = Math.cos(pa);
    const psa = Math.sin(pa);
    chromeParts.push(transformed(pistonRodGeo, makeTransform(new THREE.Vector3(pca * R * 0.95, psa * R * 0.95, 0))));
    darkParts.push(
      transformed(pistonSleeveGeo, makeTransform(new THREE.Vector3(pca * R * 0.95, psa * R * 0.95, -L * 0.14)))
    );

    const qOut = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(ca, sa, 0)
    );
    for (const zSign of [-1, 1]) {
      const bm = new THREE.Matrix4().compose(
        new THREE.Vector3(ca * R * 1.04, sa * R * 1.04, zSign * L * 0.24),
        qOut,
        new THREE.Vector3(1, 1, 1)
      );
      chromeParts.push(transformed(boltGeo, bm));
    }
  }

  const ledAngles = variant === 'paddle' ? [0, Math.PI, Math.PI * 0.5, -Math.PI * 0.5] : [0, Math.PI];
  for (const la of ledAngles) {
    const lm = makeTransform(
      new THREE.Vector3(Math.cos(la) * R * 1.01, Math.sin(la) * R * 1.01, 0),
      new THREE.Euler(0, 0, la)
    );
    ledParts.push(transformed(ledGeo, lm));
  }

  return {
    refRadius: R,
    refLength: L,
    armorGeo: mergeIndexedGeometries(armorParts, `Tentacle_${variant}_Armor`),
    darkGeo: mergeIndexedGeometries(darkParts, `Tentacle_${variant}_Dark`),
    chromeGeo: mergeIndexedGeometries(chromeParts, `Tentacle_${variant}_Chrome`),
    ledGeo: mergeIndexedGeometries(ledParts, `Tentacle_${variant}_LED`),
    mats,
  };
}

function instantiateSegment(archetype, name, radius, segLength) {
  const seg = new THREE.Group();
  seg.name = name;

  seg.add(
    new THREE.Mesh(archetype.armorGeo, archetype.mats.armorPrimary),
    new THREE.Mesh(archetype.darkGeo, archetype.mats.armorDark),
    new THREE.Mesh(archetype.chromeGeo, archetype.mats.chromeSteel),
    new THREE.Mesh(archetype.ledGeo, archetype.mats.ledCrimson)
  );

  const rScale = radius / archetype.refRadius;
  const zScale = segLength / archetype.refLength;
  seg.scale.set(rScale, rScale, zScale);
  return seg;
}

// ---------------------------------------------------------------------------
// Articulated Multi-Phalanx Mechanical Finger Geometry Helper
// Returns tip position in claw local space for kinematic verification.
// Convention: local +Y points radially OUTWARD; +bendAngle around X curls INWARD (-Y).
// ---------------------------------------------------------------------------
function appendArticulatedFinger(armorParts, darkParts, chromeParts, cfg) {
  const { basePos, baseRotEuler, lengths, bendAngles, radius } = cfg;
  let curMat = makeTransform(basePos, baseRotEuler);

  for (let p = 0; p < lengths.length; p++) {
    const len = lengths[p];
    const r0 = radius * (1.0 - p * 0.22);
    const r1 = radius * (0.86 - p * 0.24);
    const isTip = p === lengths.length - 1;

    curMat = curMat
      .clone()
      .multiply(makeTransform(new THREE.Vector3(0, 0, 0), new THREE.Euler(bendAngles[p], 0, 0)));

    const pin = new THREE.CylinderGeometry(r0 * 0.56, r0 * 0.56, r0 * 2.25, 6);
    pin.rotateZ(Math.PI * 0.5);
    chromeParts.push(transformed(pin, curMat));

    const knuckle = new THREE.SphereGeometry(r0 * 0.90, 8, 6);
    darkParts.push(transformed(knuckle, curMat));

    if (isTip) {
      const talon = new THREE.ConeGeometry(r0 * 0.95, len, 7);
      talon.rotateX(Math.PI * 0.5);
      talon.translate(0, 0, len * 0.5);
      armorParts.push(transformed(talon, curMat));
    } else {
      const link = new THREE.CylinderGeometry(r1, r0, len, 7);
      link.rotateX(Math.PI * 0.5);
      link.translate(0, 0, len * 0.5);
      armorParts.push(transformed(link, curMat));

      const plate = new THREE.BoxGeometry(r0 * 1.45, r0 * 0.65, len * 0.78);
      plate.translate(0, r0 * 0.62, len * 0.5);
      armorParts.push(transformed(plate, curMat));
    }

    curMat = curMat.clone().multiply(makeTransform(new THREE.Vector3(0, 0, len)));
  }

  return new THREE.Vector3().setFromMatrixPosition(curMat);
}

// ---------------------------------------------------------------------------
// Primary 4-Finger Paddle Claw (`PaddleClaw`) + Child `PaddleSocket`
// ---------------------------------------------------------------------------
function buildPaddleClaw(mats, tipPos, tipTangent) {
  const claw = new THREE.Group();
  claw.name = 'PaddleClaw';
  orientObjectAlongSpine(claw, tipPos, tipTangent);

  const armorParts = [];
  const darkParts = [];
  const chromeParts = [];
  const ledParts = [];

  // Heavy Flanged Armored Wrist Cuff
  const cuffPts = [
    new THREE.Vector2(0.056, -0.048),
    new THREE.Vector2(0.084, -0.036),
    new THREE.Vector2(0.094, -0.012),
    new THREE.Vector2(0.082, 0.008),
    new THREE.Vector2(0.098, 0.034),
    new THREE.Vector2(0.092, 0.062),
    new THREE.Vector2(0.068, 0.074),
    new THREE.Vector2(0.048, 0.062),
    new THREE.Vector2(0.048, -0.048),
  ];
  const cuff = new THREE.LatheGeometry(cuffPts, 16);
  cuff.rotateX(Math.PI * 0.5);
  armorParts.push(cuff);

  const palmHub = new THREE.CylinderGeometry(0.056, 0.066, 0.062, 14);
  palmHub.rotateX(Math.PI * 0.5);
  palmHub.translate(0, 0, 0.072);
  darkParts.push(palmHub);

  // Glowing crimson servo wrist accent rings
  const servoRing1 = new THREE.TorusGeometry(0.086, 0.0085, 8, 20);
  servoRing1.translate(0, 0, 0.008);
  ledParts.push(servoRing1);

  const servoRing2 = new THREE.TorusGeometry(0.076, 0.0065, 8, 18);
  servoRing2.translate(0, 0, 0.066);
  ledParts.push(servoRing2);

  // 4 Chrome Hydraulic Wrist Actuators
  const wristPiston = new THREE.CylinderGeometry(0.008, 0.008, 0.095, 6);
  wristPiston.rotateX(Math.PI * 0.5);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    chromeParts.push(
      transformed(wristPiston, makeTransform(new THREE.Vector3(Math.cos(a) * 0.095, Math.sin(a) * 0.095, 0.015)))
    );
  }

  // 4 Articulated Armored Claw Fingers curling horizontally inward around the vertical
  // paddle handle grip volume centered at (0, 0, 0.14):
  // - Left fingers (x < 0): rotZ ~ +PI/2 so local +Y points -X (outward) and curls toward +X (handle!)
  // - Right fingers (x > 0): rotZ ~ -PI/2 so local +Y points +X (outward) and curls toward -X (handle!)
  const fingerConfigs = [
    // Upper-left gripping finger
    {
      basePos: new THREE.Vector3(-0.060, 0.042, 0.066),
      baseRotEuler: new THREE.Euler(0, 0, Math.PI * 0.44),
      lengths: [0.056, 0.052, 0.040],
      bendAngles: [-0.28, 0.66, 0.74],
      radius: 0.017,
    },
    // Lower-left gripping finger
    {
      basePos: new THREE.Vector3(-0.060, -0.042, 0.066),
      baseRotEuler: new THREE.Euler(0, 0, Math.PI * 0.56),
      lengths: [0.056, 0.052, 0.040],
      bendAngles: [-0.28, 0.66, 0.74],
      radius: 0.017,
    },
    // Upper-right gripping finger
    {
      basePos: new THREE.Vector3(0.060, 0.042, 0.066),
      baseRotEuler: new THREE.Euler(0, 0, -Math.PI * 0.44),
      lengths: [0.056, 0.052, 0.040],
      bendAngles: [-0.28, 0.66, 0.74],
      radius: 0.017,
    },
    // Lower-right opposable gripping thumb-talon
    {
      basePos: new THREE.Vector3(0.060, -0.042, 0.066),
      baseRotEuler: new THREE.Euler(0, 0, -Math.PI * 0.56),
      lengths: [0.054, 0.050, 0.040],
      bendAngles: [-0.24, 0.70, 0.78],
      radius: 0.018,
    },
  ];

  const fingerTips = [];
  for (const fc of fingerConfigs) {
    fingerTips.push(appendArticulatedFinger(armorParts, darkParts, chromeParts, fc));
  }

  claw.add(
    new THREE.Mesh(mergeIndexedGeometries(armorParts, 'PaddleClawArmor'), mats.armorPrimary),
    new THREE.Mesh(mergeIndexedGeometries(darkParts, 'PaddleClawDark'), mats.armorDark),
    new THREE.Mesh(mergeIndexedGeometries(chromeParts, 'PaddleClawChrome'), mats.chromeSteel),
    new THREE.Mesh(mergeIndexedGeometries(ledParts, 'PaddleClawLEDs'), mats.ledCrimson)
  );

  // Child empty Object3D `PaddleSocket` inside the claw grip at (0, 0, 0.14)
  // World +Z points directly toward player (+Z), world +Y upright (+Y).
  const paddleSocket = new THREE.Object3D();
  paddleSocket.name = 'PaddleSocket';
  paddleSocket.position.set(0, 0, 0.14);
  paddleSocket.quaternion.copy(claw.quaternion).invert();
  claw.add(paddleSocket);

  return { claw, fingerTips };
}

// ---------------------------------------------------------------------------
// Shared 3-Prong Mechanical Background Tentacle Claw Archetype
// ---------------------------------------------------------------------------
function createBgClawArchetype(mats) {
  const armorParts = [];
  const darkParts = [];
  const chromeParts = [];
  const ledParts = [];

  const cuffPts = [
    new THREE.Vector2(0.036, -0.036),
    new THREE.Vector2(0.058, -0.024),
    new THREE.Vector2(0.064, 0.004),
    new THREE.Vector2(0.056, 0.036),
    new THREE.Vector2(0.044, 0.052),
    new THREE.Vector2(0.030, 0.044),
    new THREE.Vector2(0.030, -0.036),
  ];
  const cuff = new THREE.LatheGeometry(cuffPts, 14);
  cuff.rotateX(Math.PI * 0.5);
  armorParts.push(cuff);

  const core = new THREE.SphereGeometry(0.038, 10, 8);
  core.translate(0, 0, 0.044);
  darkParts.push(core);

  const ledRing = new THREE.TorusGeometry(0.058, 0.006, 6, 16);
  ledRing.translate(0, 0, 0.006);
  ledParts.push(ledRing);

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    appendArticulatedFinger(armorParts, darkParts, chromeParts, {
      basePos: new THREE.Vector3(Math.cos(a) * 0.044, Math.sin(a) * 0.044, 0.046),
      baseRotEuler: new THREE.Euler(0, 0, a - Math.PI * 0.5),
      lengths: [0.056, 0.054, 0.058],
      bendAngles: [-0.48, 0.58, 0.62],
      radius: 0.0145,
    });
  }

  return {
    refRadius: 0.050,
    armorGeo: mergeIndexedGeometries(armorParts, 'BgClawArmor'),
    darkGeo: mergeIndexedGeometries(darkParts, 'BgClawDark'),
    chromeGeo: mergeIndexedGeometries(chromeParts, 'BgClawChrome'),
    ledGeo: mergeIndexedGeometries(ledParts, 'BgClawLED'),
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
    new THREE.Mesh(archetype.chromeGeo, archetype.mats.chromeSteel),
    new THREE.Mesh(archetype.ledGeo, archetype.mats.ledCrimson)
  );
  return claw;
}

// ---------------------------------------------------------------------------
// Tentacle Path Definitions & Builder
// ---------------------------------------------------------------------------
function buildTentacleSegments(parentGroup, namePrefix, curve, segCount, rStart, rEnd, archetype) {
  const totalLen = curve.getLength();
  const segPitch = totalLen / Math.max(1, segCount - 0.35);

  for (let i = 0; i < segCount; i++) {
    const u = segCount === 1 ? 0 : i / (segCount - 1);
    const uCurve = u * 0.965;
    const pos = curve.getPointAt(uCurve);
    const tangent = curve.getTangentAt(uCurve).normalize();

    const radius = rStart + (rEnd - rStart) * Math.pow(u, 0.88);
    const segName = `${namePrefix}_Seg_${String(i).padStart(2, '0')}`;
    const seg = instantiateSegment(archetype, segName, radius, segPitch * 1.04);
    orientObjectAlongSpine(seg, pos, tangent);
    parentGroup.add(seg);
  }
}

function buildRobotModel() {
  const root = new THREE.Group();
  root.name = 'RobotRoot';

  const mats = createMaterials();

  // Primary Paddle-Wielding Tentacle Curve (16 segments, -X shoulder -> (-0.65, -0.78, 1.38))
  const paddleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.70, -0.06, 0.32),
    new THREE.Vector3(-1.12, 0.08, 0.56),
    new THREE.Vector3(-1.16, -0.28, 0.92),
    new THREE.Vector3(-0.82, -0.68, 1.16),
    new THREE.Vector3(-0.65, -0.78, 1.38),
  ]);

  // 6 Sweeping Flanking & Background Tentacles (12 segments each)
  const bgSpecs = [
    {
      // BgTentacle_0: Upper-left looping high overhead
      rStart: 0.118,
      rEnd: 0.046,
      points: [
        new THREE.Vector3(-0.69, 0.13, 0.08),
        new THREE.Vector3(-1.24, 0.68, 0.18),
        new THREE.Vector3(-1.58, 1.04, 0.44),
        new THREE.Vector3(-1.24, 1.18, 0.78),
        new THREE.Vector3(-0.88, 0.92, 1.04),
      ],
    },
    {
      // BgTentacle_1: Right-foreground reaching down toward far-right table corner
      rStart: 0.128,
      rEnd: 0.052,
      points: [
        new THREE.Vector3(0.71, -0.05, 0.32),
        new THREE.Vector3(1.22, 0.10, 0.56),
        new THREE.Vector3(1.42, -0.34, 0.96),
        new THREE.Vector3(1.18, -0.76, 1.32),
        new THREE.Vector3(0.96, -0.90, 1.54),
      ],
    },
    {
      // BgTentacle_2: Left-mid spreading outward
      rStart: 0.114,
      rEnd: 0.044,
      points: [
        new THREE.Vector3(-0.78, -0.08, -0.10),
        new THREE.Vector3(-1.40, -0.02, -0.04),
        new THREE.Vector3(-1.82, -0.26, 0.24),
        new THREE.Vector3(-1.66, -0.58, 0.62),
        new THREE.Vector3(-1.36, -0.66, 0.92),
      ],
    },
    {
      // BgTentacle_3: Right-mid spreading outward & arcing high
      rStart: 0.114,
      rEnd: 0.044,
      points: [
        new THREE.Vector3(0.78, 0.08, -0.06),
        new THREE.Vector3(1.40, 0.44, 0.04),
        new THREE.Vector3(1.86, 0.62, 0.28),
        new THREE.Vector3(1.68, 0.34, 0.68),
        new THREE.Vector3(1.38, 0.04, 0.94),
      ],
    },
    {
      // BgTentacle_4: Rear-left trailing tendril curving back
      rStart: 0.104,
      rEnd: 0.040,
      points: [
        new THREE.Vector3(-0.56, -0.08, -0.52),
        new THREE.Vector3(-1.10, -0.02, -0.88),
        new THREE.Vector3(-1.38, 0.28, -1.24),
        new THREE.Vector3(-1.08, 0.52, -1.52),
        new THREE.Vector3(-0.74, 0.40, -1.66),
      ],
    },
    {
      // BgTentacle_5: Rear-right trailing tendril curving back
      rStart: 0.104,
      rEnd: 0.040,
      points: [
        new THREE.Vector3(0.56, -0.08, -0.52),
        new THREE.Vector3(1.12, -0.16, -0.86),
        new THREE.Vector3(1.46, -0.10, -1.22),
        new THREE.Vector3(1.24, 0.24, -1.50),
        new THREE.Vector3(0.92, 0.46, -1.64),
      ],
    },
  ];

  const shoulderSockets = [
    {
      pos: paddleCurve.getPointAt(0),
      dir: paddleCurve.getTangentAt(0),
      scale: 1.08,
    },
    ...bgSpecs.map((spec) => {
      const c = new THREE.CatmullRomCurve3(spec.points);
      return {
        pos: c.getPointAt(0),
        dir: c.getTangentAt(0),
        scale: spec.rStart / 0.118,
      };
    }),
  ];

  // 1. Carapace + Eyes + Cables + Shoulder Sockets
  const carapace = buildCarapace(mats, shoulderSockets);
  root.add(carapace);

  // 2. Shared Tentacle Segment & Claw Archetypes
  const paddleSegArchetype = createTentacleSegmentArchetype(mats, 'paddle');
  const bgSegArchetype = createTentacleSegmentArchetype(mats, 'bg');
  const bgClawArchetype = createBgClawArchetype(mats);

  // 3. 16-Segment Primary Paddle Arm + 4-Finger PaddleClaw + PaddleSocket
  buildTentacleSegments(root, 'PaddleArm', paddleCurve, 16, 0.135, 0.072, paddleSegArchetype);

  const paddleTipPos = paddleCurve.getPointAt(1.0);
  const paddleTipTangent = paddleCurve.getTangentAt(1.0).normalize();
  const { claw: paddleClaw, fingerTips } = buildPaddleClaw(mats, paddleTipPos, paddleTipTangent);
  root.add(paddleClaw);

  // 4. 6 Flanking/Background Tentacles (`BgTentacle_0`..`5`)
  for (let i = 0; i < bgSpecs.length; i++) {
    const spec = bgSpecs[i];
    const curve = new THREE.CatmullRomCurve3(spec.points);
    const group = new THREE.Group();
    group.name = `BgTentacle_${i}`;

    buildTentacleSegments(group, `BgTentacle_${i}`, curve, 12, spec.rStart, spec.rEnd, bgSegArchetype);

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
// Build, Self-Verify Kinematics/Bounds, and Export GLB
// ---------------------------------------------------------------------------
const t0 = performance.now();
const { root, paddleCurve, bgSpecs, fingerTips } = buildRobotModel();
root.updateMatrixWorld(true);

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

// Verify PaddleClaw & PaddleSocket
const clawObj = root.getObjectByName('PaddleClaw');
const socketObj = root.getObjectByName('PaddleSocket');
const socketWorldQuat = new THREE.Quaternion();
socketObj.getWorldQuaternion(socketWorldQuat);
const socketForward = new THREE.Vector3(0, 0, 1).applyQuaternion(socketWorldQuat);
const socketUp = new THREE.Vector3(0, 1, 0).applyQuaternion(socketWorldQuat);
if (socketForward.dot(new THREE.Vector3(0, 0, 1)) < 0.999 || socketUp.dot(new THREE.Vector3(0, 1, 0)) < 0.999) {
  throw new Error(`PaddleSocket orientation mismatch! fwd=${socketForward.toArray()} up=${socketUp.toArray()}`);
}

// Verify all 16 PaddleArm segments have local +Z aligned with spine tangent
for (let i = 0; i < 16; i++) {
  const seg = root.getObjectByName(`PaddleArm_Seg_${String(i).padStart(2, '0')}`);
  const u = (i / 15) * 0.965;
  const expectedTan = paddleCurve.getTangentAt(u).normalize();
  const actualZ = new THREE.Vector3(0, 0, 1).applyQuaternion(seg.quaternion);
  if (actualZ.dot(expectedTan) < 0.999) {
    throw new Error(`PaddleArm_Seg_${i} +Z axis not aligned with spine tangent!`);
  }
}

// Verify all 72 BgTentacle segments have local +Z aligned with spine tangent
for (let t = 0; t < bgSpecs.length; t++) {
  const curve = new THREE.CatmullRomCurve3(bgSpecs[t].points);
  for (let i = 0; i < 12; i++) {
    const seg = root.getObjectByName(`BgTentacle_${t}_Seg_${String(i).padStart(2, '0')}`);
    const u = (i / 11) * 0.965;
    const expectedTan = curve.getTangentAt(u).normalize();
    const actualZ = new THREE.Vector3(0, 0, 1).applyQuaternion(seg.quaternion);
    if (actualZ.dot(expectedTan) < 0.999) {
      throw new Error(`BgTentacle_${t}_Seg_${i} +Z axis not aligned with spine tangent!`);
    }
  }
}

let renderedTriangles = 0;
root.traverse((obj) => {
  if (obj.isMesh && obj.geometry) {
    const idx = obj.geometry.getIndex();
    renderedTriangles += idx ? idx.count / 3 : obj.geometry.getAttribute('position').count / 3;
  }
});

const result = exportSceneToGLB(root, OUTPUT_PATH);
const elapsedMs = (performance.now() - t0).toFixed(0);

console.log(`Built Robot GLB in ${elapsedMs} ms -> ${result.outputPath}`);
console.log(
  `  Size: ${(result.byteLength / 1024).toFixed(1)} KB | Nodes: ${result.nodeCount} | Unique Meshes: ${result.meshCount} | Materials: ${result.materialCount} | Textures: ${result.textureCount}`
);
console.log(`  Rendered Scene Triangles (instanced): ${Math.round(renderedTriangles)}`);
console.log(
  `  Armored Carapace Dome Bounds: W=${domeSize.x.toFixed(2)}m H=${domeSize.y.toFixed(2)}m D=${domeSize.z.toFixed(2)}m`
);
console.log(
  `  Carapace + Cables Bounds:     W=${carapaceSize.x.toFixed(2)}m H=${carapaceSize.y.toFixed(2)}m D=${carapaceSize.z.toFixed(2)}m (min=[${carapaceBox.min.toArray().map((n) => n.toFixed(2))}], max=[${carapaceBox.max.toArray().map((n) => n.toFixed(2))}])`
);
console.log(
  `  Full Robot Bounds:         W=${fullSize.x.toFixed(2)}m H=${fullSize.y.toFixed(2)}m D=${fullSize.z.toFixed(2)}m`
);
console.log(
  `  PaddleClaw Pos: [${clawObj.position.toArray().map((n) => n.toFixed(3))}] | PaddleSocket Local: [${socketObj.position.toArray().map((n) => n.toFixed(3))}] | Socket World +Z: [${socketForward.toArray().map((n) => n.toFixed(3))}]`
);
console.log(
  `  PaddleClaw 4 Finger Tips (claw local, gripping around [0, 0, 0.14]):`,
  fingerTips.map((v) => `[${v.toArray().map((n) => n.toFixed(3)).join(',')}]`).join('  ')
);
