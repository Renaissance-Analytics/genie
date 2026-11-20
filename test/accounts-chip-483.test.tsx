// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsView, type AccountsSnapshot } from '../src/core/accounts-view.js';
import { shortDateTime } from '../src/core/clock-words.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { AccountHeadroom } from '../src/core/headroom-board.js';
import type { WindowReading } from '../src/core/headroom.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { SwitchOffer } from '../src/core/switch-offer.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { Dashboard, RateLimitPills } from '../src/renderer/components/Dashboard.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { control } from './helpers/control-markup.js';

/**
 * ACCOUNTS S10 (Tynn #483): THE HEADER CHIP AND ITS POPOVER, on the same-home model (Tynn #751/#753). The chip names the
 * account signed in on the host (the one every agent of the provider uses). Its popover lists every known account: name, plan
 * (or "unknown"), a bar per window (5 h and weekly always; "unknown" when not reported), local reset times, and one click to
 * switch. A standing switch offer (S8) shows in the popover and on the agent rows of that provider. Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 16, 9, 30).getTime();
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const X = `account_${'d'.repeat(32)}`;
const live = (window: string, leftPct: number, resetsAtMs: number): WindowReading => ({ refreshed: false, window, leftPct, over: false, resetsAtMs });
const reading = (accountId: string, windows: WindowReading[], provider = 'claude', plan: string | null = null): AccountHeadroom => ({
    provider, accountId, runId: 'run_1', windows, room: { plan, window: '5h', leftPct: 0, resetsAtMs: 0, over: false, windows: [] },
});
const KNOWN = [
    { id: A, provider: 'claude', label: 'Work Max', identity: { name: null, email: 'work@example.invalid', plan: 'max' } },
    { id: B, provider: 'claude', label: 'ada@example.invalid', identity: { name: null, email: 'ada@example.invalid', plan: null } },
    { id: X, provider: 'codex', label: 'Account 1', identity: { name: null, email: null, plan: null } },
];

describe('S10: the accounts a window is shown (pure)', () => {
    it('a provider with two known accounts gives two, the active one first and marked', () => {
        const view = accountsView(KNOWN, [reading(A, [live('5h', 8, NOW + HOUR)])], { claude: B, codex: X });
        const claude = view.find((p) => p.provider === 'claude')!;
        expect(claude.accounts.map((a) => [a.id, a.active])).toEqual([[B, true], [A, false]]);
    });
    it('the plan is the identity\'s, else the reading\'s, else null (shown unknown): never a guess', () => {
        const view = accountsView(KNOWN, [reading(B, [live('5h', 50, NOW + HOUR)], 'claude', 'pro')], { claude: A });
        const claude = view.find((p) => p.provider === 'claude')!;
        expect(claude.accounts.find((a) => a.id === A)!.plan).toBe('max');
        expect(claude.accounts.find((a) => a.id === B)!.plan).toBe('pro');
        const bare = accountsView(KNOWN, [], { claude: A }).find((p) => p.provider === 'claude')!;
        expect(bare.accounts.find((a) => a.id === B)!.plan).toBeNull();
    });
    it('every account has a 5 h and a weekly row: one not reported is unknown, one past its reset is Refreshed, others follow', () => {
        const view = accountsView(KNOWN, [reading(A, [{ refreshed: true, window: '5h' }, live('7d opus', 40, NOW + 9 * HOUR)])], { claude: A });
        const a = view.find((p) => p.provider === 'claude')!.accounts.find((x) => x.id === A)!;
        expect(a.windows).toEqual([{ refreshed: true, window: '5h' }, { unknown: true, window: '7d' }, live('7d opus', 40, NOW + 9 * HOUR)]);
    });
    it('CONTROL: a provider nobody has used here (no email, no reading) is left out', () => {
        expect(accountsView(KNOWN, [], { claude: A, codex: X }).map((p) => p.provider)).not.toContain('codex');
    });
});

const OFFER: SwitchOffer = {
    id: 'switch-offer:a:5h:1', provider: 'claude', accountId: A, label: 'Work Max', window: '5h', leftPct: 8, over: false, resetsAtMs: NOW + HOUR,
    targets: [{ accountId: B, label: 'ada@example.invalid', room: 'unknown', leftPct: null, resetsAtMs: null }],
};
const SNAPSHOT = (offers: SwitchOffer[] = []): AccountsSnapshot => ({
    providers: accountsView(KNOWN, [reading(A, [live('5h', 8, NOW + HOUR), live('7d', 60, NOW + 50 * HOUR)])], { claude: A }), offers,
});

describe('S10: the chip and its popover', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const render = (snapshot: AccountsSnapshot, handlers: { onSwitchAccount?: (p: string) => void; onDismissSwitchOffer?: (id: string) => void } = {}) =>
        act(() => root.render(<RateLimitPills limits={{}} accounts={snapshot} now={NOW} {...handlers} />));
    const chip = () => host.querySelector('[data-account-chip="claude"]') as HTMLButtonElement;
    const popover = () => document.querySelector('[data-account-popover="claude"]') as HTMLElement | null;

    it('the chip names the signed-in account', () => {
        render(SNAPSHOT());
        expect(chip()).not.toBeNull();
        expect(chip().textContent).toContain('Work Max');
    });
    it('the popover renders one section per known account, each with its name, its plan or "unknown", and a bar per window', () => {
        render(SNAPSHOT());
        click(chip());
        const sections = popover()!.querySelectorAll('[data-account]');
        expect([...sections].map((s) => s.getAttribute('data-account'))).toEqual([A, B]);
        expect(sections[0]!.textContent).toContain('Work Max');
        expect(sections[0]!.querySelector('[data-account-plan]')!.textContent).toBe('max');
        expect(sections[1]!.querySelector('[data-account-plan]')!.textContent).toBe('unknown');
        expect(sections[0]!.querySelectorAll('[data-account-window]')).toHaveLength(2);
        expect(sections[0]!.querySelector('[data-account-window="5h"] [role="progressbar"]')).not.toBeNull();
        expect(sections[1]!.querySelector('[data-account-window="5h"]')!.textContent).toContain('unknown');
    });
    it('reset times are shown in the local zone', () => {
        render(SNAPSHOT());
        click(chip());
        expect(popover()!.querySelector(`[data-account="${A}"] [data-account-window="5h"]`)!.textContent).toContain(shortDateTime(NOW + HOUR));
    });
    it('Switch on another account is one click: it starts the provider\'s switch', () => {
        const onSwitchAccount = vi.fn();
        render(SNAPSHOT(), { onSwitchAccount });
        click(chip());
        click(popover()!.querySelector(`[data-account="${B}"] [data-action="account-switch"]`)!);
        expect(onSwitchAccount).toHaveBeenCalledWith('claude', 'ada@example.invalid');
        expect(popover()!.querySelector(`[data-account="${A}"] [data-action="account-switch"]`)).toBeNull();
    });
    it('a standing offer is a Callout in the popover: Switch starts the switch, Not now dismisses that offer', () => {
        const onSwitchAccount = vi.fn();
        const onDismissSwitchOffer = vi.fn();
        render(SNAPSHOT([OFFER]), { onSwitchAccount, onDismissSwitchOffer });
        expect(chip().getAttribute('data-offer')).toBe(OFFER.id);
        click(chip());
        const offer = popover()!.querySelector(`[data-switch-offer="${OFFER.id}"]`)!;
        expect(offer.textContent).toContain('Work Max');
        expect(offer.textContent).toContain('ada@example.invalid');
        click(offer.querySelector('[data-action="switch-offer-switch"]')!);
        expect(onSwitchAccount).toHaveBeenCalledWith('claude', 'ada@example.invalid');
        click(offer.querySelector('[data-action="switch-offer-dismiss"]')!);
        expect(onDismissSwitchOffer).toHaveBeenCalledWith(OFFER.id);
    });
    it('CONTROL: with no accounts snapshot the provider pill is drawn as before', () => {
        act(() => root.render(<RateLimitPills limits={{ claude: { plan: null, window: '5h', leftPct: 40, resetsAtMs: NOW + HOUR, over: false, windows: [{ window: '5h', usedPct: 60, leftPct: 40, resetsAtMs: NOW + HOUR, over: false }] } }} now={NOW} />));
        expect(host.querySelector('[data-rate-limit="claude"]')).not.toBeNull();
    });
});

describe('S10: the offer on the agent row, and every action a react-fancy Button', () => {
    const base: AgentRow = {
        id: 'a1', name: 'kai', provider: 'claude', workspaceId: 'w', fidelity: 'declared', state: 'working',
        duration: '12m', ask: null, reason: null, fixes: [], step: null, target: 'Wire it', activity: null, delivery: null,
        collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
    };
    const html = () => renderToStaticMarkup(<Dashboard rows={[base, { ...base, id: 'c1', name: 'tern', provider: 'codex' }]} workspaces={[{ id: 'w', path: '/w/w' }]}
        onOpenAgent={() => {}} onAddAgent={() => {}} accounts={SNAPSHOT([OFFER])} onSwitchAccount={() => {}} />);
    // The chip is in Genie's title bar (Tynn #949), not the Dashboard header.
    const bar = () => renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'AlphaR', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} platform="generic"
        accountPills={{ limits: {}, accounts: SNAPSHOT([OFFER]), onSwitchAccount: () => {}, now: NOW }} />);
    it('the provider\'s agent rows carry the offer as one button; another provider\'s row does not', () => {
        expect(control(html(), `data-switch-offer-row="${OFFER.id}"`)).toMatchObject({ tag: 'button', fancy: true });
        expect(html().split(`data-switch-offer-row="${OFFER.id}"`)).toHaveLength(2);
    });
    it('the chip is a react-fancy Button, and AccountsChip draws no raw <button>', () => {
        expect(control(bar(), 'data-account-chip="claude"')).toMatchObject({ tag: 'button', fancy: true });
        const chipSource = source('src/renderer/components/AccountsChip.tsx');
        expect(chipSource).not.toMatch(/<button\b/);
        for (const c of ['Popover', 'Progress', 'Avatar', 'Badge', 'Callout', 'Button']) expect(chipSource).toMatch(new RegExp(`import \\{[^}]*\\b${c}\\b[^}]*\\} from '@particle-academy/react-fancy'`));
    });
});

describe('S10: the host serves the accounts', () => {
    it('a local window reads every known account and the standing offers through engine.accounts', async () => {
        const server = new SessionEngineServer({ token: 'fixture', build: 'fixture', accounts: () => SNAPSHOT([OFFER]) });
        const client = new SessionEngineClient(), [h, w] = memoryPair();
        server.accept(h, { local: true });
        expect(await client.connect(w, 'fixture')).toMatchObject({ ok: true });
        expect(await client.accounts()).toEqual(SNAPSHOT([OFFER]));
        w.close();
    });
    it('genie-host builds them from the book, the board and the offers; the one protocol carries them (accounts.list, Tynn #895); App hands them to the Dashboard', () => {
        expect(source('src/main/genie-host.ts')).toMatch(/const accountsSnapshot = \(\): AccountsSnapshot => \(\{ providers: accountsView\(/);
        expect(source('src/main/genie-host.ts')).toMatch(/accountsPortNow = \{ list: \(\) => accountsSnapshot\(\)/);
        expect(source('src/renderer/remote-bridge.ts')).toMatch(/accounts: async \(\) => \{ const r = await call\('accounts\.list'\)/);
        expect(source('src/main/preload.ts')).not.toMatch(/genie:accounts/);
        expect(source('src/renderer/App.tsx')).toMatch(/accounts=\{accountsSnapshot/);
    });
});
