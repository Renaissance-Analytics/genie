import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectStaticServe } from '../repo-facts';

/**
 * Auto-detect a repo that should be SERVED as a static site rather than run as a
 * dev server (goal item 2). The safe, unambiguous case: a built output dir
 * (dist/build/out) holding index.html, in a repo with NO runnable dev server. A
 * repo you DEVELOP (has a dev/start/serve script) is left to its dev command —
 * serving a build of it is an explicit hostServe choice, not a default.
 */
function tmpRepo(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-detectstatic-'));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return root;
}

describe('detectStaticServe', () => {
    it('picks a built dist/ (index.html) as an SPA when there is no dev server', () => {
        const root = tmpRepo({ 'dist/index.html': '<!doctype html>' });
        expect(detectStaticServe(root)).toEqual({ mode: 'static', root: 'dist', spa: true });
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('recognises build/ and out/ too', () => {
        const b = tmpRepo({ 'build/index.html': 'x' });
        expect(detectStaticServe(b)?.root).toBe('build');
        const o = tmpRepo({ 'out/index.html': 'x' });
        expect(detectStaticServe(o)?.root).toBe('out');
        fs.rmSync(b, { recursive: true, force: true });
        fs.rmSync(o, { recursive: true, force: true });
    });

    it('does NOT auto-pick static for a repo with a dev server — that is a develop-it project', () => {
        const root = tmpRepo({
            'dist/index.html': 'x',
            'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
        });
        // A stale dist/ must never shadow `npm run dev` — serving the build is explicit.
        expect(detectStaticServe(root)).toBeNull();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('is null when there is no built output dir', () => {
        const root = tmpRepo({ 'src/main.ts': 'x', 'index.html': '<!doctype html>' });
        // A bare root index.html is NOT auto-served (it would expose source); only a
        // dedicated build dir counts.
        expect(detectStaticServe(root)).toBeNull();
        fs.rmSync(root, { recursive: true, force: true });
    });
});
