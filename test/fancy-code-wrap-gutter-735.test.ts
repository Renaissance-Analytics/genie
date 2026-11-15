import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A wrapped line keeps ONE gutter number in <CodeEditor wordWrap> (Tynn #735). The fix is in @particle-academy/fancy-code
 * 0.17.1; it exports no gutter helper, so the contract Genie relies on is the pin itself, and that the installed build
 * carries the fix's gutter handles.
 */
const MIN = [0, 17, 1];

function atLeast(version: string, min: number[]): boolean {
    const parts = version.split('.').map((p) => Number.parseInt(p, 10));
    for (let i = 0; i < min.length; i++) {
        if ((parts[i] ?? 0) !== min[i]!) return (parts[i] ?? 0) > min[i]!;
    }
    return true;
}

describe('fancy-code keeps one gutter number per wrapped line', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> };

    it('package.json pins an exact fancy-code >= 0.17.1', () => {
        const pinned = pkg.dependencies['@particle-academy/fancy-code'];
        expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
        expect(atLeast(pinned!, MIN)).toBe(true);
    });

    it('the lockfile resolves that same version', () => {
        expect(lock.packages['node_modules/@particle-academy/fancy-code']?.version).toBe(pkg.dependencies['@particle-academy/fancy-code']);
    });

    it('the version comparison rejects 0.15.1 and 0.17.0 (control)', () => {
        expect(atLeast('0.15.1', MIN)).toBe(false);
        expect(atLeast('0.17.0', MIN)).toBe(false);
        expect(atLeast('0.17.1', MIN)).toBe(true);
    });

    it('the installed build carries the wrapped-gutter handles', () => {
        const dist = readFileSync('node_modules/@particle-academy/fancy-code/dist/index.js', 'utf8');
        expect(dist).toContain('data-fancy-code-gutter-line');
    });
});
