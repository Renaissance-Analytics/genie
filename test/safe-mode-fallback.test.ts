import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SafeModeView } from '../src/core/safe-mode.js';
import { WindowSafeMode, type LinkSafeMode } from '../src/main/window-safe-mode.js';

/**
 * SAFE MODE AS THE WINDOW HAS IT (Tynn #386): genie-host's, read over the link. The window has no safe mode of its own,
 * because it runs nothing of its own: a window whose host cannot start says so and stops (Tynn #415). What this file
 * covered besides, the window running agents, flows and sites itself when no host could start (its own wake, compose's
 * own flows and sites under safe mode), was deleted in the host split's P6-4 (Tynn #1036): nothing reached it.
 * genie-host's gates are safe-mode-gates.test.ts's.
 */

// ─── the state, read by the window from the host ─────────────────────────────────────────────────────────────────────────

describe('the window reads genie-host’s safe mode', () => {
    it('the host’s view, the host’s Leave, and what the host says next', async () => {
        const hostView: SafeModeView = { active: true, at: 9, cause: 'unknown', crashLoop: false, agents: [], processes: [], sites: [] };
        let left = 0;
        let tell: (view: SafeModeView) => void = () => {};
        const link: LinkSafeMode = { safeModeView: () => hostView, leaveSafeMode: async () => { left += 1; return { ok: true }; }, onSafeMode: (l) => { tell = l; return () => {}; } };
        const mode = WindowSafeMode.open({ link });
        expect(mode.active()).toBe(true);
        expect(mode.view()).toBe(hostView);
        expect(await mode.leave()).toEqual({ ok: true });
        expect(left).toBe(1);
        const told: boolean[] = [];
        mode.onChange((v) => told.push(v.active));
        tell({ ...hostView, active: false });
        expect(told).toEqual([false]);
    });

    it('CONTROL: a host not yet heard is not safe mode', () => {
        const link: LinkSafeMode = { safeModeView: () => null, leaveSafeMode: async () => ({ ok: true }), onSafeMode: () => () => {} };
        expect(WindowSafeMode.open({ link }).active()).toBe(false);
    });
});

// ─── main.ts: the boot restore asks genie-host's safe mode ─────────────────────────────────────────────────────────────

describe('main.ts reads genie-host’s safe mode', () => {
    const main = readFileSync(resolve('src/main/main.ts'), 'utf8');
    const code = main.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

    it('opens it from the link, after the link is known and before the tools are built', () => {
        const opened = code.indexOf('WindowSafeMode.open({ link: agentEngineLink.client })');
        expect(opened).toBeGreaterThan(code.indexOf('agentEngineLink = await connectAgentEngine('));
        // The window composes nothing (Tynn #955): the first thing after it is the tools.
        expect(opened).toBeLessThan(code.indexOf('withActionSignal(allGenieTools(genieToolDeps({'));
    });

    it('the boot restore reads it; the window wakes no agent (the mail wake is genie-host’s, Tynn #896 2b-3) and composes nothing (Tynn #955)', () => {
        expect(code).toMatch(/restoreAfterRelaunch\(\{\s*safeMode: windowSafeNow,/);
        expect(code).not.toMatch(/windowWake\(/);
        expect(code).not.toMatch(/composeWindowServices\(/);
    });

    it('the window never writes the marker: it is the host’s', () => {
        expect(code).not.toContain('endCleanly');
        expect(code).not.toContain('writeCleanExit');
    });
});
