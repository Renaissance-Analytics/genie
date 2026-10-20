import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { RateLimitGate } from '../src/core/rate-limit-gate.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * A HELD LOGIN, SEEN FROM THE TRAY (Tynn #794, story #287). Genie lives in the tray behind thirty windows; when the
 * provider's limit holds every agent on a login, the tray says so — the same words as the Dashboard and the Agent view
 * (core/limit-words.ts) — and offers Resume now, which opens the login at once. Nothing is shown when nothing is held.
 */
vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() }, Tray: vi.fn(), nativeImage: { createFromBuffer: vi.fn() } }));

const MIN = 60_000;
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const handlers = () => ({ onOpen: vi.fn(), onSettings: vi.fn(), onCheckUpdates: vi.fn(), onQuit: vi.fn(), onResumeLimit: vi.fn() });

describe('the tray menu', () => {
    it('a held login: its line, then Resume now for it, above the four verbs — and Resume asks for THAT provider', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const h = handlers();
        const menu = trayMenuTemplate(h, [{ provider: 'claude', words: 'rate limit · resumes 14:31' }]);
        expect(menu.map((m) => m.label ?? m.type)).toEqual(['Claude: rate limit · resumes 14:31', 'Resume Claude now', 'separator', 'Open Genie', 'Settings…', 'Check for updates', 'Quit Genie']);
        expect(menu[0]!.enabled).toBe(false);
        menu[1]!.click!();
        expect(h.onResumeLimit).toHaveBeenCalledWith('claude');
    });

    it('two held logins, one each (COUNTED); nothing held: exactly the four verbs (CONTROL)', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const both = trayMenuTemplate(handlers(), [{ provider: 'claude', words: 'rate limit · resumes 14:31' }, { provider: 'codex', words: 'rate limit · next try 14:45' }]);
        expect(both.filter((m) => /^Resume .* now$/.test(m.label ?? ''))).toHaveLength(2);
        expect(trayMenuTemplate(handlers(), []).map((m) => m.label)).toEqual(['Open Genie', 'Settings…', 'Check for updates', 'Quit Genie']);
    });

    it('the tooltip says it too; plain "Genie" when nothing is held', async () => {
        const { trayTooltip } = await import('../src/main/tray.js');
        expect(trayTooltip([{ provider: 'claude', words: 'rate limit · resumes 14:31' }])).toBe('Genie — Claude: rate limit · resumes 14:31');
        expect(trayTooltip([])).toBe('Genie');
    });
});

describe('which logins are held — the host answers', () => {
    let dir: string;
    let now = Date.UTC(2026, 9, 18, 3, 0, 0);
    const events = new Map<string, DriverEvents>();
    const driverFor: DriverFor = (record) => {
        const factory: SessionDriverFactory = (options) => {
            events.set(record.name, options.events);
            return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
        };
        return factory;
    };
    let host: SessionHost;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-tray-limit-'));
        now = Date.UTC(2026, 9, 18, 3, 0, 0);
        events.clear();
        host = new SessionHost({ userData: dir, driverFor, clock: () => now, processTree: noTree, rateLimit: { gate: new RateLimitGate({ marginMs: 2 * MIN }), schedule: () => () => {} } });
    });
    afterEach(async () => {
        host.stopAll();
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });
    const record = (name: string, provider: 'claude' | 'codex' = 'claude'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider, name });

    it('a held Claude login is listed ONCE however many agents it holds; codex, open, is not; Resume now empties it', () => {
        const a = record('atlas'); const b = record('wren'); const c = record('kai', 'codex');
        for (const r of [a, b, c]) host.start(r, dir);
        expect(host.heldLogins()).toEqual([]);
        host.prompt(a.id, 'build it', 'you');
        events.get('atlas')!.onUpdate?.({
            sessionUpdate: 'notice', notice: { level: 'info', message: "You've hit your limit" },
            _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs: now + 60 * MIN, windows: { five_hour: { utilization: 1, resetsAtMs: now + 60 * MIN } }, raw: {} } },
        });
        events.get('atlas')!.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error_during_execution' });
        expect(host.heldLogins()).toEqual([{ provider: 'claude', view: expect.objectContaining({ state: 'paused', resumeAtMs: now + 62 * MIN }) }]);
        host.resumeLimit('claude');
        expect(host.heldLogins()).toEqual([]);
    });
});

describe('main keeps the tray current', () => {
    const src = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
    it('Resume now from the tray resumes the provider’s login; the tray is redrawn only when what is held CHANGES', () => {
        expect(src).toMatch(/onResumeLimit: \(provider\) => \{ host\?\.resumeLimit\(provider\); refreshTray\(\); \}/);
        expect(src).toMatch(/function refreshTray\(\): void \{/);
        expect(src).toMatch(/const held = \(host\?\.heldLogins\(\) \?\? \[\]\)\.flatMap\(\(l\) => \{ const words = limitWords\(l\.view\); return words \? \[\{ provider: l\.provider, words \}\] : \[\]; \}\);/);
        expect(src).toMatch(/if \(key === trayHeldKey\) return;/);
        // Every host change may hold or free a login.
        expect(src).toMatch(/host\.subscribe\(\(agentId\) => \{\n\s*refreshTray\(\);/);
    });
});
