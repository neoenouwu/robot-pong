/**
 * Resolves a root-style asset path ('/models/table.glb') against the base URL the app is
 * served from, so one build works at a domain root, under a sub-path (e.g. a GitHub Pages
 * project site at /<repo>/), and in dev.
 */
export function assetUrl(path: string, base: string = import.meta.env.BASE_URL): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${path.replace(/^\/+/, '')}`;
}
