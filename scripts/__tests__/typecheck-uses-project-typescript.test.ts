import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The typecheck runs the TypeScript this project declares — not whichever `tsc`
 * npm happened to link last.
 *
 * nextron 10 depends on TypeScript 6 (as `typescript6` → `@typescript/old`) for its
 * own build, and that package also ships a `tsc` bin. With both hoisted, the bare
 * `tsc` in `node_modules/.bin` is whichever npm linked last: on the machine where
 * this was found it was TypeScript 6, while `package.json` asked for 7. A typecheck
 * on the wrong major passes or fails for reasons unrelated to the code, and nothing
 * says which compiler ran. So the scripts name the project's own entry point, and
 * CI runs the scripts rather than restating them.
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
