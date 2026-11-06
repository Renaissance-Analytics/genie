import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SafeModeView } from '../src/core/safe-mode.js';

/**
 * A CRASH REPORT THE PERSON CHOOSES TO SEND (Tynn #386 part 4; spec .ai/plans/genie-crash-safe-mode-reporting-spec.md §4).
 * Never automatic. Genie builds it from the crash record and the run's facts, REDACTS it, and shows the person the exact
 * text before anything is sent (Tynn redacts again on its side). Content: Genie version, OS and arch, uptime; the crash
 * kind; stall statistics and the top stack signatures (function names and app-relative modules, no user paths); memory
 * samples; agent count and providers; ledger sizes in buckets. Never workspace or agent names, paths outside the app,
 * URLs, tokens, message or tool content, or email.
 *
 * Loaded by a computed path ON PURPOSE: before the module exists these are red by assertion, not by an import error.
 */
const MODULE = '../src/core/crash-report.js';
const mod: Record<string, unknown> = await import(/* @vite-ignore */ MODULE).catch(() => ({}));
const fn = <T,>(name: string): T => { expect(mod[name], `${name} in core/crash-report.ts`).toBeTypeOf('function'); return mod[name] as T; };

const view: SafeModeView = { active: true, at: Date.UTC(2026, 10, 6, 5, 12), cause: 'hang', crashLoop: false, agents: ['agent_1', 'agent_2'], processes: [{ id: 'p1', name: 'moonbeam queue worker' }], sites: [{ id: 's1', name: 'moonbeam.gen' }] };
const facts = {
    view,
    genieVersion: '2.0.0-beta.60',
    os: 'linux',
    arch: 'x64',
    uptimeMs: 3 * 3600_000 + 120_000,
    providers: ['claude', 'claude', 'codex'],
    ledgerBytes: [12_000, 3_500_000, 900_000_000],
    stall: { count: 4, worstMs: 31_000, stacks: ['at drawLane (/home/wish/.local/genie/resources/app.asar/dist/renderer/WorkspaceDashboard.js:120:8)', 'at Object.<anonymous> (C:\\Users\\wish\\AppData\\Local\\Programs\\Genie\\resources\\app.asar\\dist\\main\\main.js:3:4)'] },
    memoryMb: [410, 980, 2_300],
};
const SECRETS = { workspaceNames: ['Moonbeam Ledger', 'moonbeam'], agentNames: ['atlas', 'kai'] };

describe('the report Genie builds', () => {
    it('says what the spec lists — version, os/arch, uptime, kind, agents by count and provider, ledger buckets, stalls, memory', () => {
        const text = fn<(f: unknown) => string>('crashReportText')(facts);
        for (const want of ['2.0.0-beta.60', 'linux', 'x64', '3h 2m', 'hang', '3 agents', 'claude ×2', 'codex ×1', '4 stalls', '31 s', '2300 MB']) expect(text).toContain(want);
        // Ledger sizes in buckets, never exact.
        expect(text).toMatch(/<1 MB/);
        expect(text).toMatch(/>100 MB/);
        expect(text).not.toContain('900000000');
    });

    it('stack signatures are function names and APP-relative modules — no user paths, no line numbers', () => {
        const text = fn<(f: unknown) => string>('crashReportText')(facts);
        expect(text).toContain('drawLane (dist/renderer/WorkspaceDashboard.js)');
        expect(text).toContain('dist/main/main.js');
        expect(text).not.toMatch(/\/home\/|C:\\Users|AppData|:120:8/);
    });

    it('never names what was running: no agent ids, process or site names', () => {
        const text = fn<(f: unknown) => string>('crashReportText')(facts);
        for (const leak of ['agent_1', 'moonbeam queue worker', 'moonbeam.gen']) expect(text).not.toContain(leak);
    });
});

describe('redaction: the SAME rules as Tynn (test/fixtures/crash-redaction.json, tynn.ai has the same file)', () => {
    const rules = JSON.parse(readFileSync('test/fixtures/crash-redaction.json', 'utf8')) as { workspaceNames: string[]; rows: Array<{ name: string; input: string; expected: string }> };
    const ctx = { workspaceNames: rules.workspaceNames, agentNames: [] };
    it.each(rules.rows.map((r) => [r.name, r] as const))('%s', (_, row) => {
        const redact = fn<(t: string, c: unknown) => string>('redactCrashText');
        const once = redact(row.input, ctx);
        expect(once).toBe(row.expected);
        // Genie redacts, then Tynn does: a second pass changes nothing.
        expect(redact(once, ctx)).toBe(once);
    });

    it('Genie also knows its agents’ names: [agent] (Tynn does not; the name never leaves)', () => {
        expect(fn<(t: string, c: unknown) => string>('redactCrashText')('atlas was running', SECRETS)).toBe('[agent] was running');
    });
});

describe('a crash record full of private names gives a report with none of them', () => {
    // cut 3's CrashRecord (src/core/crash-record.ts on next/hang-watchdog): what the PUBLIC report may take, and what not.
    const record = {
        kind: 'hang', at: '2026-11-06T05:12:00.000Z', windowPid: 4242, lastBeatAt: '2026-11-06T05:11:30.000Z',
        lifecycle: ['agent maipa started in AlphaR', 'route genie://AlphaR/maipa/dashboard', 'opened C:/_Projects/_clients/Chip/notes.md'],
        stalls: [{ at: '2026-11-06T05:11:00.000Z', ms: 31_000, route: 'genie://AlphaR/maipa/dashboard', stack: 'drawLane (dist/renderer/WorkspaceDashboard.js)' }, { at: 'x', ms: 2_000, route: 'genie://AlphaR/kai/chat', stack: 'drawLane (dist/renderer/WorkspaceDashboard.js)' }],
        memory: [{ at: 'a', windowMb: 410, hostMb: 300 }, { at: 'b', windowMb: 2_300, hostMb: 320 }],
        agents: [{ name: 'maipa', lastTool: 'Read /home/wish/AlphaR/secret.md', lastToolBytes: 5_000_000 }, { name: 'kai', lastTool: null, lastToolBytes: null }],
        header: { schema: 1, version: '2.0.0-beta.60', build: 'abc', os: 'linux', osRelease: '6.12', arch: 'x64', uptimeS: 7_320 },
    };
    it('kind, header, stall stats per signature, bucketed memory and tool sizes, the agent COUNT — and no names, routes or lifecycle', () => {
        const fromRecord = fn<(r: unknown, base: unknown) => unknown>('factsFromRecord');
        const facts = fromRecord(record, { view, providers: ['claude', 'codex'] });
        const text = fn<(t: string, c: unknown) => string>('redactCrashText')(fn<(f: unknown) => string>('crashReportText')(facts), { workspaceNames: ['AlphaR'], agentNames: ['maipa', 'kai'] });
        for (const want of ['hang', '2.0.0-beta.60', 'linux', 'x64', '2h 2m', '2 agents', 'drawLane (dist/renderer/WorkspaceDashboard.js)', '2 stalls', '31 s']) expect(text).toContain(want);
        expect(text).toMatch(/1-10 MB/); // the last tool's size, bucketed
        expect(text).toMatch(/2-4 GB|1-2 GB|>2 GB/); // memory, bucketed
        for (const leak of ['maipa', 'AlphaR', 'genie://', 'kai', 'Chip', '/home/', 'secret.md', 'Read ']) expect(text).not.toContain(leak);
    });
    it('an exit: its reason and code, and its error only redacted', () => {
        const fromRecord = fn<(r: unknown, base: unknown) => unknown>('factsFromRecord');
        const facts = fromRecord({ kind: 'exit', at: 'x', pid: 1, reason: 'uncaught exception', code: 1, rssMb: 900, agents: ['maipa'], error: 'ENOENT: /home/wish/AlphaR/x.json' }, { view, providers: ['claude'] });
        const text = fn<(t: string, c: unknown) => string>('redactCrashText')(fn<(f: unknown) => string>('crashReportText')(facts), { workspaceNames: ['AlphaR'], agentNames: ['maipa'] });
        expect(text).toContain('uncaught exception');
        expect(text).toContain('code 1');
        expect(text).toContain('ENOENT: [path]');
        for (const leak of ['maipa', 'AlphaR', '/home/']) expect(text).not.toContain(leak);
    });
});

describe('what is sent is what the person saw', () => {
    it('an edit that is already clean is sent as written', () => {
        const check = fn<(t: string, c: unknown) => { ok: boolean; text: string }>('checkBeforeSend');
        expect(check('Genie hung after I opened the dashboard', SECRETS)).toEqual({ ok: true, text: 'Genie hung after I opened the dashboard' });
    });
    it('an edit that adds a private detail is NOT sent: the cleaned text comes back to be looked at again', () => {
        const check = fn<(t: string, c: unknown) => { ok: boolean; text: string; reason?: string }>('checkBeforeSend');
        const r = check('it broke in /home/wish/secret and mailed wish@impact.do', SECRETS);
        expect(r.ok).toBe(false);
        expect(r.text).toBe('it broke in [path] and mailed [email]');
        expect(r.reason).toMatch(/removed/i);
    });
});
