export interface ModelInspectResult {
  file: string;
  sizeKB: number;
  nodes: number;
  meshes: number;
  materials: number;
  textures: number;
  vertices: number;
  triangles: number;
  nodeNames: string[];
}
export function inspectGLB(filePath: string): ModelInspectResult;
export function verifyAllModels(modelsDir?: string): ModelInspectResult[];
