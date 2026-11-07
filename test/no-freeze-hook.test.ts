import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * THE PRODUCT HAS NO FREEZE PATH (Tynn #386's real-app hang row, scripts/hang-cdp.mjs). The hang is made from OUTSIDE: a
 * busy loop through the window main's inspector, which only a launch with `--inspect` has. Nothing in src/ may read
 * GENIE_E2E (the previous build's behaviour switch, removed: main.ts, session-host.ts), nor offer a channel or a call that
 * freezes, hangs or blocks a process on request — a shipped build would carry it. Comments are not code: a line that is a
 * comment is skipped, a code line with a trailing comment is read up to it.
 */
function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
    });
}
function codeLines(text: string): string[] {
    let block = false;
    const out: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        let line = raw.trim();
        if (block) { if (line.includes('*/')) { block = false; line = line.slice(line.indexOf('*/') + 2).trim(); } else continue; }
        if (line.startsWith('/*')) { if (!line.includes('*/')) { block = true; continue; } line = line.slice(line.indexOf('*/') + 2).trim(); }
        if (line.startsWith('//') || line.startsWith('*')) continue;
        const slash = line.indexOf(' //');
        out.push(slash >= 0 ? line.slice(0, slash) : line);
    }
    return out;
}

const FORBIDDEN: Array<[string, RegExp]> = [
    ['reads GENIE_E2E', /GENIE_E2E/],
    ['a freeze or hang channel', /['"`]genie:[\w:-]*(freeze|hang-now|block-main|busy-wait)[\w:-]*['"`]/i],
    ['blocks its own thread on request', /Atomics\.wait\(/],
];

describe('src/ has no way to freeze a Genie process on request', () => {
    const all = files('src');
    it('CONTROL: the scan reads the real tree (main.ts and the hang watchdog among it)', () => {
        expect(all.some((f) => f.endsWith(join('main', 'main.ts')))).toBe(true);
        expect(all.some((f) => f.endsWith(join('main', 'hang-watchdog.ts')))).toBe(true);
        expect(all.length).toBeGreaterThan(200);
    });
    for (const [what, pattern] of FORBIDDEN) {
        it(`no file ${what}`, () => {
            const hits = all.flatMap((f) => codeLines(readFileSync(f, 'utf8')).filter((l) => pattern.test(l)).map((l) => `${f}: ${l.slice(0, 120)}`));
            expect(hits).toEqual([]);
        });
    }
    it('CONTROL: the comment rule reads code with a trailing comment and skips a comment line', () => {
        expect(codeLines('const a = process.env.GENIE_E2E; // x\n// GENIE_E2E\n * GENIE_E2E\n/* GENIE_E2E */ const b = 1;')).toEqual(['const a = process.env.GENIE_E2E;', 'const b = 1;']);
    });
});
