import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The typecheck runs the TypeScript this project declares — not whichever `tsc`
 * npm happened to link last.
 *
 * How this was found: nextron 10 depended on TypeScript 6 (as `typescript6` →
 * `@typescript/old`) for its own build, and that package also ships a `tsc` bin. With
 * both hoisted, the bare `tsc` in `node_modules/.bin` was whichever npm linked last —
 * on the machine where this surfaced, TypeScript 6, while `package.json` asked for 7.
 * A typecheck on the wrong major passes or fails for reasons unrelated to the code,
 * and nothing says which compiler ran.
 *
 * **That particular second compiler is gone** — nextron went with the move off Next
 * (Tynn #449), and `typescript6` left the lockfile with it. The guard stays because the
 * hazard is structural, not nextron's: any dependency may ship a `tsc`, and `.bin`
 * resolution is link order, which no error message mentions. Naming the compiler by
 * path costs nothing and the failure it prevents is invisible.
 */

const REPO = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
};
const TREES = ['main', 'renderer', 'e2e'];
const PROJECT_TSC = 'node node_modules/typescript/bin/tsc';

describe('typecheck compiler', () => {
    it.each(TREES)('typecheck:%s runs the project TypeScript by path, not a bare tsc', (tree) => {
        expect(pkg.scripts[`typecheck:${tree}`]).toBe(`${PROJECT_TSC} --noEmit -p ${tree}/tsconfig.json`);
    });

    it('resolves that path to the TypeScript major package.json declares', () => {
        const installed = JSON.parse(
            fs.readFileSync(path.join(REPO, 'node_modules/typescript/package.json'), 'utf8'),
        ) as { version: string };
        const declaredMajor = pkg.devDependencies.typescript!.replace(/^[^\d]*/, '').split('.')[0];
        expect(installed.version.split('.')[0]).toBe(declaredMajor);
    });

    it('CI runs those scripts rather than its own tsc command', () => {
        const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
        for (const tree of TREES) expect(ci).toContain(`run: npm run typecheck:${tree}`);
        expect(ci).not.toMatch(/^\s*run:\s*npx tsc\b/m);
    });
});
