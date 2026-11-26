import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_WAIT_SHOW_AFTER_MS, HostWait, hostWaitWords, type HostWaitView } from '../src/main/host-wait-window.js';
import { readStartupProgress, startupProgressFile, writeStartupProgress } from '../src/main/startup-updates-file.js';
import { HostWaitScreen } from '../src/renderer/components/HostWaitScreen.js';

/**
 * THE START'S UPDATES, SHOWN TO ANY WINDOW (Tynn #1067). genie-host serves no window while it applies due updates, so the
 * window that waits for it reads what it is doing from a small file in Genie's runtime folder (written by the host, removed
 * when it is done) and the wait says it: which update, how long so far, and that agents, sites and processes start after.
 */

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'genie-startup-updates-')); dirs.push(d); return d; };

describe('the progress file', () => {
    it('written, read back, and removed when the host clears it', () => {
        const runtime = tmp();
        writeStartupProgress(runtime, { step: 'Updating Claude Code 2.1.0 → 2.2.0', startedAt: 1_000, limitMs: 180_000 });
        expect(readStartupProgress(runtime, 5_000)).toEqual({ step: 'Updating Claude Code 2.1.0 → 2.2.0', startedAt: 1_000, limitMs: 180_000 });
        writeStartupProgress(runtime, null);
        expect(readStartupProgress(runtime, 5_000)).toBeNull();
    });

    it('none, unreadable, or older than its own limit (a host that died mid-update) → null', () => {
        const runtime = tmp();
        expect(readStartupProgress(runtime, 1)).toBeNull();
        writeFileSync(startupProgressFile(runtime), '{not json');
        expect(readStartupProgress(runtime, 1)).toBeNull();
        writeStartupProgress(runtime, { step: 'x', startedAt: 1_000, limitMs: 10_000 });
        expect(readStartupProgress(runtime, 1_000 + 10_000 + 60_000 + 1)).toBeNull();
    });
});

describe('the wait says it', () => {
    it('words: the step, the time so far, what waits for it and the limit', () => {
        expect(hostWaitWords(42_000, { step: 'Updating Claude Code 2.1.0 → 2.2.0', startedAt: 0, limitMs: 180_000 })).toEqual({
            title: 'Updating Genie’s tools before it starts…',
            detail: 'Updating Claude Code 2.1.0 → 2.2.0. 42 s so far. Agents, sites and processes start when it is done (at most 3 min).',
        });
        // CONTROL: no update running → the plain start words, unchanged.
        expect(hostWaitWords(42_000, null).title).toBe('Starting Genie’s host…');
    });

    it('HostWait reads the host’s progress at each tick and shows it; the screen renders the step', () => {
        const views: HostWaitView[] = [];
        let progress: { step: string; startedAt: number; limitMs: number } | null = null;
        const wait = new HostWait({ open: (v) => views.push(v), update: (v) => views.push(v), close: () => {} }, undefined, { startup: () => progress });
        wait.progress(HOST_WAIT_SHOW_AFTER_MS);
        progress = { step: 'Applying PHP security updates', startedAt: 0, limitMs: 180_000 };
        wait.progress(5_000);
        progress = null;
        wait.progress(6_000);
        expect(views.map((v) => v.title)).toEqual(['Starting Genie’s host…', 'Updating Genie’s tools before it starts…', 'Starting Genie’s host…']);
        const html = renderToStaticMarkup(<HostWaitScreen view={views[1]!} onAction={() => {}} />);
        expect(html).toContain('Applying PHP security updates');
        expect(html).toContain('data-host-wait-updates=""');
    });
});
