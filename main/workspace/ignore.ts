/**
 * Shared ignore sets for filesystem walks. Lifted out of `analyse.ts` so
 * both the envelope analyser and the Code View file tree (`main/files/ipc.ts`)
 * skip the same noise (.git, node_modules, editor metadata, regenerable
 * build output) without duplicating the lists.
 */

/** Never descend into / list these by name. */
export const SKIP_NAMES = new Set([
    '.git',
    '.DS_Store',
    'Thumbs.db',
    'node_modules',
    '.idea',
    '.vscode',
]);

/**
 * Regenerable build/dependency output. The analyser leaves these as
 * "codebase" (toolchain recreates them); the file tree hides them so the
 * editor surface isn't drowned in dist/ and vendor/ noise.
 */
export const REGENERABLE_NAMES = new Set([
    'node_modules',
    'vendor',
    'dist',
    'build',
    'out',
    'target',
    '.next',
    '.nuxt',
    '.turbo',
    '.cache',
    '__pycache__',
    '.venv',
    'venv',
    'coverage',
]);
