// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsView } from '../src/core/accounts-view.js';
import type { WindowReading } from '../src/core/headroom.js';
import { accountSwitchSteps } from '../src/core/provider-login.js';
import { formatRoute, parseRoute } from '../src/core/route.js';
import type { SwitchOffer } from '../src/core/switch-offer.js';
import { loginRoute, loginTerminalOf } from '../src/main/login-host.js';
import { RateLimitPills } from '../src/renderer/components/Dashboard.js';
import { TakeOverWindow } from '../src/renderer/components/TakeOverWindow.js';

/**
 * THE SWITCH NAMES THE ACCOUNT TO CHOOSE (Tynn #483; the coordinator, 2026-11-16). The provider's own login is where the
 * account is picked (Tynn #753), so a Switch pressed on one account (its popover section, or an offer's target) carries that
 * account to the login window, whose steps then say "choose ada@example.invalid": its email when Genie knows one (what the
 * provider's login shows), else its label. Without one, the steps are R2's. Fixtures name no person.
 */
const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');
const ADA = 'ada@example.invalid';

describe('the steps name the account to choose', () => {
    it.each(['claude', 'codex'] as const)('%s: "choose <account>" in the steps', (provider) => {
        expect(accountSwitchSteps(provider, ADA).join('\n')).toContain(`choose ${ADA}`);
    });
    it('CONTROL: with no account named (Use another account, Tynn #850) the steps say to pick or create a different one', () => {
        expect(accountSwitchSteps('claude').join('\n')).toContain('choose a different account');
        expect(accountSwitchSteps('claude', undefined)).toEqual(accountSwitchSteps('claude'));
    });
});

describe('the login window\'s route carries it', () => {
    it('loginRoute keeps the terminal and adds the account; the route parses back and formats the same', () => {
        const route = loginRoute('t1', 'claude', true, ADA);
        expect(loginTerminalOf(route)).toBe('t1');
        const parsed = parseRoute(route);
        expect(parsed).toMatchObject({ surface: 'takeover', terminalId: 't1', login: 'claude', switching: true, choose: ADA });
        expect(parseRoute(formatRoute(parsed))).toEqual(parsed);
    });
    it('the window\'s steps say "choose <account>"', () => {
        const html = renderToStaticMarkup(<TakeOverWindow terminalId="t1" terminals={{} as never} login="claude" switching choose={ADA} />);
        expect(html).toContain(`choose ${ADA}`);
    });
});

describe('a Switch on one account names it', () => {
    const NOW = new Date(2026, 10, 16, 9, 30).getTime();
    const A = `account_${'a'.repeat(32)}`;
    const B = `account_${'b'.repeat(32)}`;
    const live = (window: string, leftPct: number): WindowReading => ({ refreshed: false, window, leftPct, over: false, resetsAtMs: NOW + 3_600_000 });
    const KNOWN = [
        { id: A, provider: 'claude', label: 'Work Max', identity: { email: 'work@example.invalid', plan: null } },
        { id: B, provider: 'claude', label: 'Home', identity: { email: ADA, plan: null } },
    ];
    const readings = [{ provider: 'claude', accountId: A, runId: 'r', windows: [live('5h', 8)], room: { plan: null, window: '5h', leftPct: 8, resetsAtMs: 0, over: false, windows: [] } }];
    const OFFER: SwitchOffer = { id: 'o1', provider: 'claude', accountId: A, label: 'Work Max', window: '5h', leftPct: 8, over: false, resetsAtMs: NOW + 3_600_000,
        targets: [{ accountId: B, label: 'Home', room: 'unknown', leftPct: null, resetsAtMs: null }] };
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
    afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
    const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    it('from its popover section, and from an offer\'s first target: its email', () => {
        const onSwitchAccount = vi.fn();
        act(() => root.render(<RateLimitPills limits={{}} accounts={{ providers: accountsView(KNOWN, readings, { claude: A }), offers: [OFFER] }} now={NOW} onSwitchAccount={onSwitchAccount} />));
        click(host.querySelector('[data-account-chip="claude"]')!);
        const pop = document.querySelector('[data-account-popover="claude"]')!;
        click(pop.querySelector(`[data-account="${B}"] [data-action="account-switch"]`)!);
        click(pop.querySelector('[data-action="switch-offer-switch"]')!);
        expect(onSwitchAccount.mock.calls).toEqual([['claude', ADA], ['claude', ADA]]);
    });
    it('genie-host puts it in the login window\'s route (Tynn #896); the bridge carries it', () => {
        expect(source('src/main/host-sign-ins.ts')).toMatch(/loginRoute\(id, provider, true, named\)/);
        expect(source('src/renderer/remote-bridge.ts')).toMatch(/answer<SignInResult>\('accounts\.switch', provider, choose \?\? null\)/);
        expect(source('src/renderer/App.tsx')).toMatch(/switching=\{parsed\.switching\} choose=\{parsed\.choose\}/);
    });
});
