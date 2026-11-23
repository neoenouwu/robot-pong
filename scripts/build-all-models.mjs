import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAllModels } from './verify-models.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generators = [
  'build-sentinel.mjs',
  'build-sentinel-reference.mjs',
  'build-props.mjs',
  'build-arena.mjs',
];

for (const script of generators) {
  console.log(`Running ${script}...`);
  execFileSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit' });
}

const report = verifyAllModels();
console.log('\nVerified all constructed GLB models:');
for (const r of report) {
  console.log(
    `  [OK] ${r.file}: ${r.sizeKB} KB | ${r.triangles} tris | ${r.nodes} nodes | ${r.textures} textures`
  );
}
