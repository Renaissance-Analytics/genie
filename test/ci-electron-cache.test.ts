import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * ELECTRON'S DOWNLOAD, CACHED (Tynn #540). GitHub answered 504 Gateway Timeout on the Electron v45.0.0 download during
 * `npm ci` in four runs in a row (genie#1723 run 42475461064 and its re-run, genie#1720 run 42477747777 and its re-run):
 * every Electron job failed before any code ran, every PR blocked. Every ci.yml job that runs `npm ci` and downloads
 * Electron restores Electron's download cache FIRST, so a run downloads it only when its version is new.
 *
 * Comments are stripped by line first: a step named in a comment is not a step.
 */
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

/** Each job's text, by its id (two-space indent under `jobs:`). */
function jobs(text: string): Map<string, string> {
    const out = new Map<string, string>();
    const body = text.slice(text.indexOf('\njobs:'));
    const heads = [...body.matchAll(/\n {2}([a-z0-9-]+):\n/g)];
    heads.forEach((m, i) => out.set(m[1]!, body.slice(m.index!, heads[i + 1]?.index ?? body.length)));
    return out;
}

describe('every job that installs Electron restores its download cache first', () => {
    const all = jobs(ci);
    // A job that skips Electron's binary (ELECTRON_SKIP_BINARY_DOWNLOAD) downloads nothing.
    const installing = [...all].filter(([, t]) => /- run: npm ci\b/.test(t) && !/ELECTRON_SKIP_BINARY_DOWNLOAD: '1'/.test(t));

    it('CONTROL: the jobs are read, the real-window ones among them', () => {
        expect(installing.map(([id]) => id)).toEqual(expect.arrayContaining(['test', 'smoke', 'smoke-windows', 'test-windows']));
        expect([...all.keys()]).toContain('host-plain-node');
    });

    it.each(installing.map(([id]) => [id]))('%s: the Electron cache is restored before npm ci, on both OSes\' paths, keyed by OS and lockfile', (id) => {
        const job = all.get(id)!;
        const cache = job.search(/uses: actions\/cache@v4[\s\S]{0,400}?electron/);
        expect(cache, `${id} restores no Electron cache`).toBeGreaterThan(-1);
        expect(cache, `${id} restores it after npm ci`).toBeLessThan(job.search(/- run: npm ci\b/));
        const step = job.slice(cache, cache + 600);
        expect(step).toMatch(/~\/\.cache\/electron/);
        expect(step).toMatch(/~\/AppData\/Local\/electron\/Cache/);
        expect(step).toMatch(/key: electron-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/);
        expect(step).toMatch(/restore-keys: \|?\s*electron-\$\{\{ runner\.os \}\}-/);
    });
});
