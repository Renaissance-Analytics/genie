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
        for (const want of ['2.0.0-beta.60', 'linux', 'x64', '3h 2m', 'hang', '2 agents', 'claude ×2', 'codex ×1', '4 stalls', '31 s', '2300 MB']) expect(text).toContain(want);
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

describe('redaction, per class (the client’s pass; Tynn redacts again)', () => {
    const redact = (t: string) => fn<(t: string, c: unknown) => string>('redactCrashText')(t, SECRETS);
    it.each([
        ['a Linux home path', '/home/wish/projects/x', '[home]'],
        ['a macOS home path', '/Users/wish/projects/x', '[home]'],
        ['a Windows home path', 'C:\\Users\\wish\\Documents\\x', '[home]'],
        ['an email', 'wish@impact.do', '[email]'],
        ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '[secret]'],
        ['an API key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', '[secret]'],
        ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', '[secret]'],
        ['a .gen site', 'https://shop.gen/admin', '[private-host]'],
        ['a private address', 'http://192.168.1.20:8080/x', '[private-host]'],
        ['a tailnet host', 'alphar.tail1234.ts.net', '[private-host]'],
        ['a URL', 'https://example.com/some/page', '[url]'],
        ['a workspace name', 'the Moonbeam Ledger crashed', '[workspace]'],
        ['an agent name', 'atlas was running', '[agent]'],
    ])('%s', (_, leak, placeholder) => {
        const out = redact(`before ${leak} after`);
        expect(out).not.toContain(leak.split(' ').find((w) => w.length > 4) ?? leak);
        expect(out).toContain(placeholder);
        expect(out.startsWith('before ')).toBe(true);
    });

    it('control: ordinary words and app-relative paths are left alone', () => {
        expect(redact('drawLane (dist/renderer/WorkspaceDashboard.js) 4 stalls')).toBe('drawLane (dist/renderer/WorkspaceDashboard.js) 4 stalls');
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
        expect(r.text).toBe('it broke in [home]/secret and mailed [email]');
        expect(r.reason).toMatch(/removed/i);
    });
});
