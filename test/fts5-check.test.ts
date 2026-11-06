import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FTS5_NODE_FLOOR, fts5Refusal } from '../src/main/fts5-check.js';

/**
 * GENIE-HOST NEEDS FTS5, AND SAYS SO BEFORE IT BINDS (P10.1b). On Node 22.13–22.15 `node:sqlite` has no FTS5, and the
 * knowledge store's table cannot be made. The host refuses at boot, naming the Node it found and the one it needs —
 * under plain Node and Electron alike — instead of dying later in its stores. The probe is a seam, so no old Node is
 * needed to see the refusal.
 */

const noFts5 = () => { throw new Error('no such module: fts5'); };

describe('fts5Refusal', () => {
    it('no FTS5: refused, naming the Node found and the one required', () => {
        const why = fts5Refusal(noFts5, 'v22.13.0');
        expect(why).toContain('v22.13.0');
        expect(why).toContain(`Node ${FTS5_NODE_FLOOR} or later`);
        expect(why).toMatch(/FTS5/);
        expect(why).toContain('no such module: fts5');
    });

    it('CONTROL: with FTS5, no refusal', () => {
        expect(fts5Refusal(() => {}, 'v22.16.0')).toBeNull();
    });

    it('CONTROL: the real probe on this runner (Node 22 latest) finds FTS5', () => {
        expect(fts5Refusal()).toBeNull();
    });

    it('the floor is the measured one', () => {
        expect(FTS5_NODE_FLOOR).toBe('22.16.0');
    });
});

describe('genie-host.ts', () => {
    // Comments stripped by line.
    const src = readFileSync('src/main/genie-host.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

    it('checks FTS5 first in main(), and exits in words before the endpoint is bound', () => {
        const check = src.search(/const noFts5 = fts5Refusal\(\);\s*if \(noFts5 !== null\) \{\s*say\(noFts5\);\s*lifecycleLog\(`host refused: \$\{noFts5\}`\);\s*process\.exit\(1\);\s*\}/);
        expect(check).toBeGreaterThan(src.indexOf('async function main(): Promise<void> {'));
        expect(check).toBeLessThan(src.indexOf('const server: Server = createServer();'));
        expect(check).toBeLessThan(src.indexOf('await listenOnce(server, endpoint)'));
    });
});
