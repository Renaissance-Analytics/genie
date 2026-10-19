import { describe, expect, it } from 'vitest';
import { statusOf, type AgentRow } from '../src/core/dashboard-view.js';
import { agentRowFor } from '../src/core/roster.js';
import type { LiveSession } from '../src/core/roster.js';
import { trayMenuTemplate, trayTooltip } from '../src/main/tray.js';

/**
 * SIGNED OUT, WHEREVER AN AGENT IS SEEN (the owner, 2026-10-18: provider login issues, "with a button to help resolve
 * it"). #967 put it on the Agent view and in the chat. The Dashboard row says it too, and the tray — where Genie is
 * seen when its window is not — names the signed-out login with `Log in to <provider>`, which opens the same login
 * window as the header's button.
 */
function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}
const live = (over: Partial<LiveSession>): LiveSession => ({ running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over } as LiveSession);
const record = { id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'ws' } as never;
const handlers = { onOpen: () => {}, onSettings: () => {}, onCheckUpdates: () => {}, onQuit: () => {} };

describe('the Dashboard row', () => {
    it('the session’s sign-out reaches the row, and the row says Signed out and what to do', () => {
        expect(agentRowFor(record, live({ signedOut: true }), () => 2).signedOut).toBe(true);
        expect(statusOf(row({ signedOut: true }))).toEqual({ word: 'Signed out', detail: 'log in to continue', tone: 'warn' });
    });

    it('a question waiting on you still comes first; CONTROL: not signed out is Idle', () => {
        expect(statusOf(row({ signedOut: true, state: 'waiting', ask: 'Run it?' })).word).toBe('Waiting on you');
        expect(statusOf(row({})).word).toBe('Idle');
        expect(agentRowFor(record, live({}), () => 2).signedOut).toBe(false);
    });
});

describe('the tray', () => {
    it('names each signed-out login and offers its login; the click opens it (COUNTED: two providers, two items)', () => {
        const opened: string[] = [];
        const menu = trayMenuTemplate({ ...handlers, onProviderLogin: (p) => opened.push(p) }, [], null, ['claude', 'codex']);
        const labels = menu.map((i) => i.label);
        expect(labels).toContain('Claude: signed out');
        expect(menu.find((i) => i.label === 'Claude: signed out')!.enabled).toBe(false);
        const logins = menu.filter((i) => i.label?.startsWith('Log in to '));
        expect(logins.map((i) => i.label)).toEqual(['Log in to Claude', 'Log in to Codex']);
        for (const item of logins) item.click!();
        expect(opened).toEqual(['claude', 'codex']);
        expect(trayTooltip([], ['claude'])).toBe('Genie — Claude: signed out');
    });

    it('CONTROL: nobody signed out — no login lines, and the tooltip is just Genie', () => {
        const menu = trayMenuTemplate({ ...handlers, onProviderLogin: () => {} }, [], null, []);
        expect(menu.some((i) => i.label?.startsWith('Log in to ') || i.label?.endsWith('signed out'))).toBe(false);
        expect(trayTooltip([], [])).toBe('Genie');
    });
});
