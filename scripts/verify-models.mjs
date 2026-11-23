/**
 * Structural GLB 2.0 Validator
 * Verifies every constructed .glb file under public/models/ conforms to the
 * glTF 2.0 binary container specification, has valid geometry & textures, and
 * contains required named animation nodes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.resolve(__dirname, '../public/models');

export function inspectGLB(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 20) throw new Error(`${filePath}: file too small`);

  const magic = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  const declaredLen = buf.readUInt32LE(8);
  if (magic !== 0x46546c67) throw new Error(`${filePath}: bad GLB magic`);
  if (version !== 2) throw new Error(`${filePath}: unsupported glTF version ${version}`);
  if (declaredLen !== buf.length) {
    throw new Error(`${filePath}: declared length ${declaredLen} !== actual ${buf.length}`);
  }

  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a) throw new Error(`${filePath}: first chunk is not JSON`);

  const jsonStr = buf.subarray(20, 20 + jsonLen).toString('utf8');
  const gltf = JSON.parse(jsonStr);

  const binOffset = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binOffset);
  const binType = buf.readUInt32LE(binOffset + 4);
  if (binType !== 0x004e4942) throw new Error(`${filePath}: second chunk is not BIN`);
  if (binOffset + 8 + binLen !== buf.length) {
    throw new Error(`${filePath}: BIN chunk size mismatch`);
  }

  // Count triangles across all mesh primitives
  let triangles = 0;
  let vertices = 0;
  for (const mesh of gltf.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      if (!posAcc) throw new Error(`${filePath}: primitive missing POSITION accessor`);
      vertices += posAcc.count;
      if (prim.indices !== undefined) {
        triangles += gltf.accessors[prim.indices].count / 3;
      } else {
        triangles += posAcc.count / 3;
      }
    }
  }

  const nodeNames = (gltf.nodes || []).map((n) => n.name).filter(Boolean);
  return {
    file: path.basename(filePath),
    sizeKB: +(buf.length / 1024).toFixed(1),
    nodes: gltf.nodes?.length ?? 0,
    meshes: gltf.meshes?.length ?? 0,
    materials: gltf.materials?.length ?? 0,
    textures: gltf.textures?.length ?? 0,
    vertices,
    triangles: Math.round(triangles),
    nodeNames,
    gltf,
  };
}

export const REQUIRED_MODELS = {
  'robot.glb': {
    minTriangles: 4000,
    requiredNodes: [
      'RobotRoot',
      'Carapace',
      'MainEyeCore',
      'PaddleArm_Seg_00',
      'PaddleArm_Seg_11',
      'PaddleClaw',
      'PaddleSocket',
    ],
  },
  'robot_reference.glb': {
    minTriangles: 8000,
    requiredNodes: [
      'RobotRoot',
      'Carapace',
      'MainEyeCore',
      'SubEyes',
      'PaddleArm_Seg_00',
      'PaddleArm_Seg_15',
      'PaddleClaw',
      'PaddleSocket',
      'BgTentacle_0',
      'BgTentacle_7',
    ],
  },
  'table.glb': {
    minTriangles: 800,
    requiredNodes: ['TableRoot', 'TableTop', 'NetMesh'],
  },
  'paddle.glb': {
    minTriangles: 400,
    requiredNodes: ['PaddleRoot', 'BladeRed', 'BladeBlack', 'Handle'],
  },
  'ball.glb': {
    minTriangles: 300,
    requiredNodes: ['BallRoot', 'BallSphere'],
  },
  'arena_structure.glb': {
    minTriangles: 2000,
    requiredNodes: ['ArenaRoot'],
  },
  'cityscape_expansion.glb': {
    minTriangles: 8000,
    requiredNodes: ['CityscapeRoot', 'CityTowers', 'SkyBridges', 'MegaCables', 'CityAbyss'],
  },
};

export function verifyAllModels(modelsDir = MODELS_DIR) {
  const results = [];
  for (const [filename, spec] of Object.entries(REQUIRED_MODELS)) {
    const fullPath = path.join(modelsDir, filename);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Missing required 3D model: ${fullPath}`);
    }
    const info = inspectGLB(fullPath);
    if (info.triangles < spec.minTriangles) {
      throw new Error(
        `${filename}: triangle count ${info.triangles} below minimum ${spec.minTriangles}`
      );
    }
    for (const reqNode of spec.requiredNodes) {
      if (!info.nodeNames.includes(reqNode)) {
        throw new Error(`${filename}: missing required named node "${reqNode}"`);
      }
    }
    results.push(info);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = verifyAllModels();
    console.log('All 3D GLB models verified successfully:');
    for (const r of report) {
      console.log(
        `  - ${r.file}: ${r.sizeKB} KB | ${r.triangles} tris | ${r.nodes} nodes | ${r.materials} mats | ${r.textures} textures`
      );
    }
  } catch (err) {
    console.error('Model verification failed:', err.message);
    process.exit(1);
  }
}
