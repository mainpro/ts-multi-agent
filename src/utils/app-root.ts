import { existsSync } from 'fs';
import { resolve } from 'path';

let _resourceRoot: string | null = null;

/**
 * Returns the root directory for static resources.
 *
 * Dist mode (node dist/index.js): __dirname = dist/, resources copied there by build script
 *   → .env exists in __dirname → return __dirname
 *
 * Dev mode (bun run src/index.ts): __dirname = src/, resources at project root
 *   → .env NOT in __dirname → fallback to process.cwd()
 */
export function getResourceRoot(): string {
  if (_resourceRoot) return _resourceRoot;

  const selfDir = __dirname;
  if (existsSync(resolve(selfDir, '.env'))) {
    _resourceRoot = selfDir;
  } else {
    _resourceRoot = process.cwd();
  }

  return _resourceRoot;
}

/**
 * Resolve a resource path relative to the application resource root.
 * Usage: resolveResource('.env'), resolveResource('skills'), resolveResource('public')
 */
export function resolveResource(...paths: string[]): string {
  return resolve(getResourceRoot(), ...paths);
}
