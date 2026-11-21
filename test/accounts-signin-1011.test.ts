import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capabilityOf, REMOTE_METHODS, SIGN_IN_METHODS, type CallContext } from '../src/core/remote-protocol.js';
import { hostSignIns } from '../src/main/host-sign-ins.js';
import { loginRoute } from '../src/main/login-host.js';

/*
 * SIGN IN TO ONE ACCOUNT (Tynn #1011): `accounts.signIn(accountId)`, a sign-in like the others (Tynn #896). genie-host starts
 * Claude Code's own login for that account's directory (prism-acp `loginCommand`) in a terminal, and the window that asked
 * opens it for the person, who finishes Anthropic's own flow. The host owner's only; a share-link guest is refused with the
 * other sign-ins (SIGN_IN_METHODS, remote-host.ts #signInRefusal).
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const context = (connectionId: string): CallContext => ({ connectionId, origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'x' });

function fixture() {
    const started: Array<[string, string | undefined]> = [];
    const asked: string[] = [];
    const cancelled: string[] = [];
    let close: () => void = () => {};
    const ports = {
        login: (provider: string, accountId?: string) => { started.push([provider, accountId]); return { ok: true as const, terminalId: `term_${accountId}` }; },
        switchLogin: () => ({ ok: true as const, terminalId: 'sw' }),
        providerOf: () => null,
        accountProvider: (accountId: string) => (accountId === 'account_known' ? 'claude' : null),
        cancel: (t: string) => { cancelled.push(t); },
        openWindow: (_c: CallContext | undefined, route: string, closed: () => void) => { asked.push(route); close = closed; return true; },
    };
    return { ports, started, asked, cancelled, close: () => close() };
}

describe('accounts.signIn: one account\'s own sign-in, visible to the person', () => {
    it('is a sign-in method: named once with the others, a write', () => {
        expect(REMOTE_METHODS as readonly string[]).toContain('accounts.signIn');
        expect(SIGN_IN_METHODS as readonly string[]).toContain('accounts.signIn');
        expect(capabilityOf('accounts.signIn')).toBe('write');
    });

    it('starts that account\'s login and opens its window on the caller; closing it cancels the login', async () => {
        const f = fixture();
        const r = await hostSignIns(f.ports).accountLogin('account_known', context('c1'));
        expect(r).toEqual({ ok: true, terminalId: 'term_account_known', route: loginRoute('term_account_known', 'claude') });
        expect(f.started).toEqual([['claude', 'account_known']]);
        expect(f.asked).toEqual([loginRoute('term_account_known', 'claude')]);
        f.close();
        expect(f.cancelled).toEqual(['term_account_known']);
    });

    it('an account the host does not know is refused, and nothing starts', async () => {
        const f = fixture();
        expect(await hostSignIns(f.ports).accountLogin('account_nobody', context('c1'))).toEqual({ ok: false, reason: 'Genie does not know that account.' });
        expect(await hostSignIns(f.ports).accountLogin(42 as unknown as string, context('c1'))).toMatchObject({ ok: false });
        expect(f.started).toEqual([]);
    });

    it('the host answers it from its sign-ins', () => {
        expect(src('src/main/host-api.ts')).toMatch(/case 'accounts\.signIn':\s*\n\s*return deps\.signIns \? deps\.signIns\.accountLogin\(str\(args\[0\]\), context\)/);
    });
});
