import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * The main-process bundle is `app/background.js`, whatever nextron calls its default.
 *
 * nextron 10 builds `main/main.ts` into `app/main.js`. Genie's main process is
 * `main/background.ts`, and `package.json#main`, the E2E harness and the packaged
 * app all load `app/background.js`. If the entry override stops applying, the build
 * still "succeeds" — webpack just fails to find `main/main.ts`, or emits a file
 * nothing loads — and the app does not start.
 */

const REPO = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);
const nextronConfig = require(path.join(REPO, 'nextron.config.js')) as {
    webpack: (config: Record<string, unknown>, env?: string) => { entry: Record<string, string> };
};

/** The shape nextron 10 hands the hook: one entry, named `main`. */
const nextronDefault = () => ({
    entry: { main: path.join(REPO, 'main', 'main.ts') },
    resolve: { extensions: ['.ts', '.js', '.json'] },
});

describe('nextron main entry', () => {
    it('builds background.ts as `background`, and drops nextron’s default `main` entry', () => {
        const { entry } = nextronConfig.webpack(nextronDefault(), 'production');
        expect(Object.keys(entry).sort()).toEqual(['app-preload', 'background']);
        expect(entry.background).toBe(path.join(REPO, 'main', 'background.ts'));
        expect(fs.existsSync(entry.background!)).toBe(true);
    });

    it('names the bundle the file package.json tells Electron to load', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { main: string };
        const { entry } = nextronConfig.webpack(nextronDefault(), 'production');
        expect(pkg.main).toBe('app/background.js');
        expect(entry).toHaveProperty(path.basename(pkg.main, '.js'));
    });
});
