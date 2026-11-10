// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALIVE_FILE, SAFE_MODE_FILE } from '../src/core/safe-mode.js';
import { crashReportHost, type CrashReportDeps } from '../src/main/crash-report-host.js';
import { SafeMode } from '../src/main/safe-mode-host.js';
import { CrashReport, type CrashReportPort } from '../src/renderer/components/SafeModeBanner.js';

/*
 * TYNN #598 (the owner, beta.60 on Windows). His note, "agents were paused due to rate limit and I shut down genie completely
 * then restarted my computer", could never be sent: the cleaned note never came back, so every Send refused the same words.
 * And the computer's restart had been called a crash, with safe mode.
 */

const NOTE = 'agents were paused due to rate limit and I shut down genie completely then restarted my computer';
const SAFE = { active: true, at: 1, cause: 'it ended without a trace', crashLoop: false, agents: [], processes: [], sites: [] };

function host(posted: Array<Record<string, unknown>>) {
    const deps: CrashReportDeps = {
        view: () => SAFE,
        agents: () => [],
        // The owner's envelope holds a repo named `genie`: one of the names Genie keeps out of a report.
        workspaceNames: () => ['tynn.ai', 'genie'],
        genieVersion: '2.0.0-beta.60', os: 'win32', arch: 'x64', tynnHost: 'https://tynn.test',
        identity: async () => ({ workstationId: 'ws_1' }),
        authHeader: async () => 'Bearer x',
        fetch: async (_url, init) => { posted.push(JSON.parse(init.body) as Record<string, unknown>); return { status: 200, json: async () => ({ ok: true, issueUrl: 'https://github.test/1' }) }; },
    };
    return crashReportHost(deps);
}

describe('a note redaction changes', () => {
    it('comes back cleaned, and says which word it took out and why', async () => {
        const posted: Array<Record<string, unknown>> = [];
        const reports = host(posted);
        const answer = await reports.send(reports.draft().text, NOTE) as { ok: false; reason: string; cleanedNotes?: string };
        expect(answer.ok).toBe(false);
        expect(answer.cleanedNotes).toBe('agents were paused due to rate limit and I shut down [workspace] completely then restarted my computer');
        expect(answer.reason).toContain('“genie”');
        expect(answer.reason).toMatch(/workspace/i);
        expect(posted).toEqual([]);
    });

    it('the second Send, with what came back, is sent', async () => {
        const posted: Array<Record<string, unknown>> = [];
        const reports = host(posted);
        const text = reports.draft().text;
        const first = await reports.send(text, NOTE) as { cleanedNotes: string };
        expect(await reports.send(text, first.cleanedNotes)).toEqual({ ok: true, issueUrl: 'https://github.test/1' });
        expect(posted).toHaveLength(1);
    });

    it('the report itself is left alone when only the note changed (CONTROL)', async () => {
        const reports = host([]);
        const text = reports.draft().text;
        const answer = await reports.send(text, NOTE) as { cleaned?: string };
        expect(answer.cleaned === undefined || answer.cleaned === text).toBe(true);
    });
});

describe('the report box', () => {
    const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean };
    let el: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; el = document.createElement('div'); document.body.appendChild(el); root = createRoot(el); });
    afterEach(() => { act(() => root.unmount()); el.remove(); });

    async function opened(port: CrashReportPort) {
        act(() => root.render(<CrashReport port={port} />));
        await act(async () => { (el.querySelector('[data-action="crash-report-open"]') as HTMLButtonElement).click(); await Promise.resolve(); });
        const notes = el.querySelector('[data-crash-report-notes]') as HTMLTextAreaElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            set.call(notes, NOTE);
            notes.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return { send: () => el.querySelector('[data-action="crash-report-send"]') as HTMLButtonElement, notes: () => el.querySelector('[data-crash-report-notes]') as HTMLTextAreaElement };
    }

    it('a cleaned note is put in the note box, and the button still says Send', async () => {
        const sent: string[] = [];
        const port: CrashReportPort = {
            draft: async () => ({ text: 'Kind: lost' }),
            send: async (_t, notes) => { sent.push(notes); return { ok: false, reason: 'Genie took out “genie” (a workspace name).', cleanedNotes: 'cleaned note' } as never; },
            copy: async () => true,
        };
        const box = await opened(port);
        await act(async () => { box.send().click(); await Promise.resolve(); await Promise.resolve(); });
        expect(box.notes().value).toBe('cleaned note');
        expect(box.send().textContent).toBe('Send');
        expect(el.textContent).toContain('“genie”');
    });

    it('a send that really failed offers Retry (CONTROL)', async () => {
        const port: CrashReportPort = { draft: async () => ({ text: 'Kind: lost' }), send: async () => ({ ok: false, reason: 'Tynn could not be reached: offline' }), copy: async () => true };
        const box = await opened(port);
        await act(async () => { box.send().click(); await Promise.resolve(); await Promise.resolve(); });
        expect(box.send().textContent).toBe('Retry');
    });
});

describe('a computer that went down is not a crash', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const HOUR = 3_600_000;
    const T = Date.UTC(2026, 10, 10, 18, 0);
    /** A run that was beating at T and was never ended by Genie: no clean-exit marker. */
    function lastRun(): string {
        const dir = mkdtempSync(join(tmpdir(), 'safe-598-')); dirs.push(dir);
        writeFileSync(join(dir, SAFE_MODE_FILE), JSON.stringify({ uncleanEnds: [], kept: false }));
        writeFileSync(join(dir, ALIVE_FILE), JSON.stringify({ at: T, pid: 7, agents: ['agent_a'] }));
        return dir;
    }

    it('its last sign of life was before this machine booted, and it left no trace: no safe mode', () => {
        const mode = SafeMode.open(lastRun(), { now: () => T + HOUR, machineBootedAt: () => T + 5 * 60_000, cause: () => 'it ended without a trace' } as never);
        expect(mode.view().active).toBe(false);
    });

    it('the same end with the machine up all along is still a crash (CONTROL)', () => {
        const mode = SafeMode.open(lastRun(), { now: () => T + HOUR, machineBootedAt: () => T - 24 * HOUR, cause: () => 'it ended without a trace' } as never);
        expect(mode.view().active).toBe(true);
    });

    it('a run that left a crash record before the machine went down is still a crash (CONTROL)', () => {
        const mode = SafeMode.open(lastRun(), { now: () => T + HOUR, machineBootedAt: () => T + 5 * 60_000, cause: () => 'it stopped responding' } as never);
        expect(mode.view()).toMatchObject({ active: true, cause: 'it stopped responding' });
    });
});
