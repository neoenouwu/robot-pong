/**
 * Pure-Node glTF 2.0 Binary (.glb) Exporter & Procedural PBR Texture Toolkit
 *
 * Converts a Three.js Object3D hierarchy (Groups, Meshes, BufferGeometries,
 * MeshStandardMaterials, and procedural RGBA pixel textures) directly into a
 * spec-compliant binary .glb file with embedded PNG textures and preserved
 * named scene-graph nodes for runtime animation.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Pure-JS PNG Encoder (RGBA8 -> standard PNG bytes)
// ---------------------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

export function encodeRGBAtoPNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type None
    rgba.copy
      ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
      : raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Procedural Texture Helpers
// ---------------------------------------------------------------------------
export function createPixelTexture(width, height, paintFn, options = {}) {
  const data = new Uint8Array(width * height * 4);
  paintFn(data, width, height);
  return {
    __proceduralPngTexture: true,
    width,
    height,
    data,
    wrapS: options.wrapS ?? 10497, // REPEAT
    wrapT: options.wrapT ?? 10497, // REPEAT
    magFilter: options.magFilter ?? 9729, // LINEAR
    minFilter: options.minFilter ?? 9987, // LINEAR_MIPMAP_LINEAR
  };
}

/**
 * Convert a single-channel Float32Array heightmap (0..1) to an RGBA tangent-space normal map.
 */
export function heightMapToNormalTexture(width, height, heightData, strength = 2.0, options = {}) {
  return createPixelTexture(
    width,
    height,
    (out, w, h) => {
      const sample = (x, y) => heightData[((y + h) % h) * w + ((x + w) % w)];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (sample(x + 1, y) - sample(x - 1, y)) * strength;
          const dy = (sample(x, y + 1) - sample(x, y - 1)) * strength;
          let nx = -dx;
          let ny = -dy;
          let nz = 1.0;
          const invLen = 1.0 / Math.hypot(nx, ny, nz);
          nx *= invLen;
          ny *= invLen;
          nz *= invLen;
          const idx = (y * w + x) * 4;
          out[idx] = Math.round((nx * 0.5 + 0.5) * 255);
          out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
          out[idx + 3] = 255;
        }
      }
    },
    options
  );
}

/**
 * Deterministic 2D value noise (hash-based) for procedural metal/rubber/wetness textures.
 */
export function hash2D(x, y, seed = 1337) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function smoothNoise2D(x, y, periodX, periodY, seed = 1337) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % periodX) + periodX) % periodX;
  const x1 = (x0 + 1) % periodX;
  const y0 = ((yi % periodY) + periodY) % periodY;
  const y1 = (y0 + 1) % periodY;
  const a = hash2D(x0, y0, seed);
  const b = hash2D(x1, y0, seed);
  const c = hash2D(x0, y1, seed);
  const d = hash2D(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbmTileable(u, v, baseFreq = 8, octaves = 4, seed = 1337) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = baseFreq;
  for (let o = 0; o < octaves; o++) {
    sum += smoothNoise2D(u * freq, v * freq, freq, freq, seed + o * 97) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/**
 * Attach procedural textures to a MeshStandardMaterial so exportSceneToGLB embeds them.
 * Supported keys in textures: baseColor, metallicRoughness, normal, emissive
 */
export function attachPBRTextures(material, textures) {
  material.userData = material.userData || {};
  material.userData.glbTextures = textures;
  return material;
}

// ---------------------------------------------------------------------------
// Core glTF 2.0 Binary Serializer
// ---------------------------------------------------------------------------
function pad4(buf) {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function colorToLinearArray(color, alpha = null) {
  // THREE.Color stores linear RGB internally in modern Three.js when set via hex/css
  const r = Number.isFinite(color.r) ? color.r : 0;
  const g = Number.isFinite(color.g) ? color.g : 0;
  const b = Number.isFinite(color.b) ? color.b : 0;
  return alpha === null ? [r, g, b] : [r, g, b, alpha];
}

export function exportSceneToGLB(rootObject, outputPath) {
  rootObject.updateMatrixWorld(true);

  const binChunks = [];
  let binOffset = 0;

  const bufferViews = [];
  const accessors = [];
  const images = [];
  const samplers = [];
  const textures = [];
  const materials = [];
  const meshes = [];
  const nodes = [];
  const extensionsUsed = new Set();

  const textureCache = new Map();
  const materialCache = new Map();
  const geometryCache = new Map();

  function appendBinary(buffer, target = undefined) {
    // Ensure 4-byte alignment at start
    const padStart = (4 - (binOffset % 4)) % 4;
    if (padStart > 0) {
      binChunks.push(Buffer.alloc(padStart));
      binOffset += padStart;
    }
    const byteOffset = binOffset;
    const byteLength = buffer.length;
    binChunks.push(buffer);
    binOffset += byteLength;

    const bv = {
      buffer: 0,
      byteOffset,
      byteLength,
    };
    if (target !== undefined) bv.target = target;
    const idx = bufferViews.length;
    bufferViews.push(bv);
    return idx;
  }

  function addTexture(procTex) {
    if (!procTex || !procTex.__proceduralPngTexture) return undefined;
    if (textureCache.has(procTex)) return textureCache.get(procTex);

    const pngBuf = encodeRGBAtoPNG(procTex.width, procTex.height, procTex.data);
    const bvIdx = appendBinary(pngBuf);
    const imgIdx = images.length;
    images.push({
      bufferView: bvIdx,
      mimeType: 'image/png',
    });

    const samplerIdx = samplers.length;
    samplers.push({
      magFilter: procTex.magFilter ?? 9729,
      minFilter: procTex.minFilter ?? 9987,
      wrapS: procTex.wrapS ?? 10497,
      wrapT: procTex.wrapT ?? 10497,
    });

    const texIdx = textures.length;
    textures.push({
      sampler: samplerIdx,
      source: imgIdx,
    });

    textureCache.set(procTex, texIdx);
    return texIdx;
  }

  function addMaterial(mat) {
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.6, metalness: 0.2 });
    }
    if (materialCache.has(mat)) return materialCache.get(mat);

    const pbr = {
      baseColorFactor: colorToLinearArray(
        mat.color ?? new THREE.Color(0xffffff),
        mat.transparent ? (mat.opacity ?? 1.0) : 1.0
      ),
      metallicFactor: mat.metalness !== undefined ? mat.metalness : 0.0,
      roughnessFactor: mat.roughness !== undefined ? mat.roughness : 0.7,
    };

    const gltfMat = {
      name: mat.name || `Material_${materials.length}`,
      pbrMetallicRoughness: pbr,
    };

    const glbTex = mat.userData?.glbTextures;
    if (glbTex) {
      if (glbTex.baseColor) {
        const idx = addTexture(glbTex.baseColor);
        if (idx !== undefined) pbr.baseColorTexture = { index: idx };
      }
      if (glbTex.metallicRoughness) {
        const idx = addTexture(glbTex.metallicRoughness);
        if (idx !== undefined) pbr.metallicRoughnessTexture = { index: idx };
      }
      if (glbTex.normal) {
        const idx = addTexture(glbTex.normal);
        if (idx !== undefined) {
          gltfMat.normalTexture = {
            index: idx,
            scale: mat.normalScale ? mat.normalScale.x : 1.0,
          };
        }
      }
      if (glbTex.emissive) {
        const idx = addTexture(glbTex.emissive);
        if (idx !== undefined) gltfMat.emissiveTexture = { index: idx };
      }
    }

    if (mat.emissive) {
      const eArr = colorToLinearArray(mat.emissive);
      const intensity = mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 1.0;
      if (eArr[0] > 0 || eArr[1] > 0 || eArr[2] > 0 || gltfMat.emissiveTexture) {
        if (intensity > 1.0) {
          gltfMat.emissiveFactor = eArr;
          gltfMat.extensions = gltfMat.extensions || {};
          gltfMat.extensions.KHR_materials_emissive_strength = {
            emissiveStrength: intensity,
          };
          extensionsUsed.add('KHR_materials_emissive_strength');
        } else {
          gltfMat.emissiveFactor = [
            eArr[0] * intensity,
            eArr[1] * intensity,
            eArr[2] * intensity,
          ];
        }
      }
    }

    if (mat.transparent || (mat.opacity !== undefined && mat.opacity < 1.0)) {
      gltfMat.alphaMode = 'BLEND';
    } else if (mat.alphaTest && mat.alphaTest > 0) {
      gltfMat.alphaMode = 'MASK';
      gltfMat.alphaCutoff = mat.alphaTest;
    }

    if (mat.side === THREE.DoubleSide) {
      gltfMat.doubleSided = true;
    }

    const idx = materials.length;
    materials.push(gltfMat);
    materialCache.set(mat, idx);
    return idx;
  }

  function addAccessorFromAttribute(attr, type, componentType, target, computeMinMax = false) {
    let typed;
    if (componentType === 5126) {
      typed = attr.array instanceof Float32Array ? attr.array : new Float32Array(attr.array);
    } else if (componentType === 5125) {
      typed = attr.array instanceof Uint32Array ? attr.array : new Uint32Array(attr.array);
    } else if (componentType === 5123) {
      typed = attr.array instanceof Uint16Array ? attr.array : new Uint16Array(attr.array);
    } else {
      throw new Error(`Unsupported componentType ${componentType}`);
    }

    const rawBuf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const bvIdx = appendBinary(rawBuf, target);

    const acc = {
      bufferView: bvIdx,
      componentType,
      count: attr.count,
      type,
    };

    if (computeMinMax) {
      const itemSize = attr.itemSize;
      const min = new Array(itemSize).fill(Infinity);
      const max = new Array(itemSize).fill(-Infinity);
      for (let i = 0; i < attr.count; i++) {
        for (let k = 0; k < itemSize; k++) {
          const val = typed[i * itemSize + k];
          if (val < min[k]) min[k] = val;
          if (val > max[k]) max[k] = val;
        }
      }
      acc.min = min;
      acc.max = max;
    }

    const idx = accessors.length;
    accessors.push(acc);
    return idx;
  }

  function addMesh(meshObj) {
    const geom = meshObj.geometry;
    const mat = Array.isArray(meshObj.material) ? meshObj.material[0] : meshObj.material;
    const cacheKey = `${geom.uuid}_${mat ? mat.uuid : 'default'}`;
    if (geometryCache.has(cacheKey)) return geometryCache.get(cacheKey);

    if (!geom.getAttribute('normal')) {
      geom.computeVertexNormals();
    }

    const posAttr = geom.getAttribute('position');
    const normAttr = geom.getAttribute('normal');
    const uvAttr = geom.getAttribute('uv');
    const colorAttr = geom.getAttribute('color');

    if (!posAttr || posAttr.count === 0) {
      throw new Error(`Mesh "${meshObj.name}" has empty position attribute`);
    }

    const attributes = {
      POSITION: addAccessorFromAttribute(posAttr, 'VEC3', 5126, 34962, true),
    };
    if (normAttr) {
      attributes.NORMAL = addAccessorFromAttribute(normAttr, 'VEC3', 5126, 34962, false);
    }
    if (uvAttr) {
      attributes.TEXCOORD_0 = addAccessorFromAttribute(uvAttr, 'VEC2', 5126, 34962, false);
    }
    if (colorAttr) {
      const vecType = colorAttr.itemSize === 4 ? 'VEC4' : 'VEC3';
      attributes.COLOR_0 = addAccessorFromAttribute(colorAttr, vecType, 5126, 34962, false);
    }

    const primitive = {
      attributes,
      material: addMaterial(mat),
      mode: 4, // TRIANGLES
    };

    const indexAttr = geom.getIndex();
    if (indexAttr) {
      const useUint32 = posAttr.count > 65535;
      primitive.indices = addAccessorFromAttribute(
        indexAttr,
        'SCALAR',
        useUint32 ? 5125 : 5123,
        34963,
        false
      );
    }

    const meshIdx = meshes.length;
    meshes.push({
      name: meshObj.name || `Mesh_${meshIdx}`,
      primitives: [primitive],
    });
    geometryCache.set(cacheKey, meshIdx);
    return meshIdx;
  }

  function visitNode(obj) {
    const nodeIdx = nodes.length;
    const node = {};
    if (obj.name) node.name = obj.name;

    const p = obj.position;
    if (p.x !== 0 || p.y !== 0 || p.z !== 0) {
      node.translation = [p.x, p.y, p.z];
    }

    const q = obj.quaternion;
    if (q.x !== 0 || q.y !== 0 || q.z !== 0 || q.w !== 1) {
      node.rotation = [q.x, q.y, q.z, q.w];
    }

    const s = obj.scale;
    if (s.x !== 1 || s.y !== 1 || s.z !== 1) {
      node.scale = [s.x, s.y, s.z];
    }

    if (obj.isMesh && obj.geometry) {
      node.mesh = addMesh(obj);
    }

    nodes.push(node);

    const childIndices = [];
    for (const child of obj.children) {
      if (child.isLight || child.isCamera) continue;
      childIndices.push(visitNode(child));
    }
    if (childIndices.length > 0) {
      node.children = childIndices;
    }

    return nodeIdx;
  }

  const rootNodeIdx = visitNode(rootObject);

  // Pad final binary buffer to 4 bytes
  const finalBin = pad4(Buffer.concat(binChunks));

  const gltf = {
    asset: {
      version: '2.0',
      generator: 'RobotPong Procedural 3D GLB Builder',
    },
    scene: 0,
    scenes: [{ name: rootObject.name || 'Scene', nodes: [rootNodeIdx] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: finalBin.length }],
  };

  if (textures.length > 0) gltf.textures = textures;
  if (images.length > 0) gltf.images = images;
  if (samplers.length > 0) gltf.samplers = samplers;
  if (extensionsUsed.size > 0) gltf.extensionsUsed = Array.from(extensionsUsed);

  let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad > 0) {
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]); // space padding per glTF spec
  }

  const totalLength = 12 + 8 + jsonBuf.length + 8 + finalBin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4); // version 2
  header.writeUInt32LE(totalLength, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(finalBin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"

  const glb = Buffer.concat([header, jsonHeader, jsonBuf, binHeader, finalBin]);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, glb);

  return {
    outputPath,
    byteLength: glb.length,
    nodeCount: nodes.length,
    meshCount: meshes.length,
    materialCount: materials.length,
    textureCount: textures.length,
  };
}

export { srgbToLinear };
