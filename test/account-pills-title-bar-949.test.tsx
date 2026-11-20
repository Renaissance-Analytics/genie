// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsView, type AccountsSnapshot } from '../src/core/accounts-view.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { EMPTY_SNAPSHOT } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * THE ACCOUNT PILLS LIVE IN GENIE'S TITLE BAR (Tynn #949; the owner, 2026-11-20: "the account pills are supposed to be in the
 * genie header, not the dashboard header" — and where: "on the RIGHT side of Genie's title bar, next to the workstation
 * name"). The title bar is the one chrome on every view, so the pills (logo, account, usage, reset, and the popover with
 * Use another account) show everywhere. The Dashboard header has none. Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const NOW = new Date(2026, 10, 20, 9, 30).getTime();
const A = `account_${'a'.repeat(32)}`;
const X = `account_${'d'.repeat(32)}`;
const KNOWN = [
    { id: A, provider: 'claude', label: 'Work Max', identity: { email: 'work@example.invalid', plan: 'max' } },
    { id: X, provider: 'codex', label: 'Account 1', identity: { email: 'codex@example.invalid', plan: null } },
];
const SNAPSHOT: AccountsSnapshot = { providers: accountsView(KNOWN, [], { claude: A, codex: X }), offers: [] };
const LIMITS = { gemini: { plan: null, window: '5h', leftPct: 40, resetsAtMs: NOW + 3_600_000, over: false, windows: [{ window: '5h', usedPct: 60, leftPct: 40, resetsAtMs: NOW + 3_600_000, over: false }] } };

const bar = (extra: object = {}) => (
    <TitleBar route="genie://agent/kai" workstation={{ name: 'AlphaR', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} platform="generic"
        accountPills={{ limits: LIMITS, accounts: SNAPSHOT, now: NOW, onSwitchAccount: () => {} }} {...extra} />
);
const tag = (html: string, attr: string): string => html.match(new RegExp(`<[a-z]+[^>]*${attr}[^>]*>`))![0];

describe('the pills are in the title bar, at the right, next to the workstation name', () => {
    it('the title bar draws every provider\'s pill: an account chip per known account, a rate-limit pill otherwise', () => {
        const html = renderToStaticMarkup(bar());
        expect(html).toContain('data-title-account-pills=""');
        expect(html).toContain('data-account-chip="claude"');
        expect(html).toContain('data-account-chip="codex"');
        expect(html).toContain('data-rate-limit="gemini"');
    });

    it('on the RIGHT: after the spacer and the address, immediately left of the workstation chip', () => {
        const html = renderToStaticMarkup(bar({ update: { phase: 'available', label: 'Update', action: 'update-download', version: null }, onOpenUpdate: () => {} }));
        const pills = html.indexOf('data-title-account-pills');
        const workstation = html.indexOf('data-workstation-health');
        expect(pills).toBeGreaterThan(html.indexOf('data-route'));
        expect(pills).toBeGreaterThan(html.indexOf('data-title-spacer'));
        expect(pills).toBeLessThan(workstation);
        // NEXT TO the workstation name: nothing else of the bar's (the update chip, the remote badge) sits between them.
        expect(html.indexOf('data-update-chip')).toBeLessThan(pills);
        const between = html.slice(pills, workstation);
        for (const other of ['data-update-chip', 'data-remote-badge', 'data-flow-pills', 'data-route']) expect(between).not.toContain(other);
        // POSITIVE CONTROL: the update chip is really in this render, so the order above is measured, not vacuous.
        expect(html).toContain('data-update-chip="available"');
    });

    it('the pills take clicks, never the window drag (the bar is the drag region)', () => {
        expect(tag(renderToStaticMarkup(bar()), 'data-title-account-pills')).toContain('[-webkit-app-region:no-drag]');
    });

    it('the popover opens from the title bar, and Use another account switches', () => {
        const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
        g.IS_REACT_ACT_ENVIRONMENT = true;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root: Root = createRoot(host);
        try {
            const onSwitchAccount = vi.fn();
            act(() => root.render(bar({ accountPills: { limits: {}, accounts: SNAPSHOT, now: NOW, onSwitchAccount } })));
            const chip = host.querySelector('[data-title-bar] [data-account-chip="claude"]')!;
            expect(chip).not.toBeNull();
            act(() => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
            const another = document.querySelector('[data-account-popover="claude"] [data-action="account-use-another"]')!;
            expect(another).not.toBeNull();
            act(() => { another.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
            expect(onSwitchAccount.mock.calls.map(([p, choose]) => [p, choose ?? null])).toEqual([['claude', null]]);
        } finally {
            act(() => root.unmount());
            host.remove();
            document.body.innerHTML = '';
        }
    });

    it('CONTROL: a workspace-share window carries none of the workstation\'s accounts; no pills handed = none drawn', () => {
        expect(renderToStaticMarkup(bar({ scopedHome: 'genie://workspace/w1' }))).not.toContain('data-title-account-pills');
        expect(renderToStaticMarkup(bar({ accountPills: undefined }))).not.toContain('data-title-account-pills');
        expect(renderToStaticMarkup(bar())).toContain('data-title-account-pills');
    });
});

describe('the Dashboard header has no account pills', () => {
    const row: AgentRow = {
        id: 'a1', name: 'kai', provider: 'claude', workspaceId: 'w', fidelity: 'declared', state: 'working',
        duration: '12m', ask: null, reason: null, fixes: [], step: null, target: 'Wire it', activity: null, delivery: null,
        collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
    };
    it('handed the accounts and limits it once drew, the Dashboard draws no pill and no chip', () => {
        const html = renderToStaticMarkup(<Dashboard rows={[row]} workspaces={[{ id: 'w', path: '/w/w' }]} onOpenAgent={() => {}} onAddAgent={() => {}}
            {...({ rateLimits: LIMITS, now: NOW } as object)} accounts={SNAPSHOT} onSwitchAccount={() => {}} />);
        expect(html).not.toContain('data-rate-limits');
        expect(html).not.toContain('data-account-chip');
        expect(html).not.toContain('data-rate-limit=');
        // POSITIVE CONTROL: the Dashboard did render its header and the row.
        expect(html).toContain('data-action="chat-genie"');
        expect(html).toContain('data-agent="a1"');
    });
    it('Shell hands the pills to the TitleBar (every view), not to the Dashboard', () => {
        const shell = source('src/renderer/Shell.tsx');
        const titleBar = shell.slice(shell.indexOf('<TitleBar'), shell.indexOf('/>', shell.indexOf('dnd={dndView')));
        expect(titleBar).toMatch(/accountPills=\{/);
        const dashboard = shell.slice(shell.indexOf('<Dashboard'), shell.indexOf('/>', shell.indexOf('<Dashboard')));
        expect(dashboard).not.toMatch(/rateLimits=/);
        expect(source('src/renderer/components/Dashboard.tsx')).not.toMatch(/<RateLimitPills\b/);
    });
});

describe('on every view (the Shell, rendered)', () => {
    const shell = (route: string) => renderToStaticMarkup(
        <Shell route={route} snapshot={{ ...EMPTY_SNAPSHOT, workspaces: [{ id: 'w', path: '/w/w', agentsKnown: true }], deckItems: [] }} features={EMPTY_FEATURES}
            servable={['dashboard', 'agent', 'settings', 'knowledge']} agentDetail={null} agentResolved selectedRowId={null} chatThread={null} pinned={null}
            onNavigate={() => {}} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onOpenPalette={() => {}} onSelectRow={() => {}}
            onSend={() => {}} onCloseChat={() => {}} answeringApproval={null} onAnswerApproval={() => {}} onAnswerDeckItem={() => {}}
            rateLimits={LIMITS} now={NOW} />,
    );
    it('Settings, Knowledge and the Dashboard each draw the pills once, in the title bar', () => {
        for (const route of ['genie://settings', 'genie://knowledge', 'genie://dashboard']) {
            const html = shell(route);
            expect(html.split('data-title-account-pills=""'), route).toHaveLength(2);
            expect(html.split('data-rate-limit="gemini"'), route).toHaveLength(2);
            expect(html.indexOf('data-title-account-pills'), route).toBeGreaterThan(html.indexOf('data-title-bar'));
        }
        // POSITIVE CONTROL: the Dashboard really rendered (its header's Chat button), and the pill is not in it.
        const dash = shell('genie://dashboard');
        expect(dash).toContain('data-action="chat-genie"');
        expect(dash.indexOf('data-rate-limit="gemini"')).toBeLessThan(dash.indexOf('data-action="chat-genie"'));
    });
});
