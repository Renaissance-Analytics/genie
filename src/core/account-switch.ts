import { providerLogin } from './provider-login.js';

/**
 * HOW A SWITCH ENDED (Tynn #482, Accounts S9). A switch is the person signing in again with the provider's own login in its one
 * home (Tynn #753); Genie never chooses the account, it READS which one is signed in afterwards. So the outcome is what the
 * provider says once the login terminal has ended: another account (switched: the one now active is named), the same one
 * (unchanged), or none (signed out). Only a switch changes the active account; the other two leave it as it was, and offer
 * Retry. No agent is stopped by any of them: they keep their threads.
 */
export interface SwitchAccountRef { readonly id: string; readonly label: string }

export type AccountSwitchOutcome =
    | { readonly kind: 'switched'; readonly provider: string; readonly accountId: string; readonly label: string; readonly fromAccountId: string; readonly fromLabel: string }
    | { readonly kind: 'unchanged'; readonly provider: string; readonly accountId: string; readonly label: string }
    | { readonly kind: 'signed-out'; readonly provider: string; readonly accountId: string; readonly label: string };

/** `before`: the active account when the switch opened; `after`: the active account once the identity has been read again. */
export function switchOutcome(input: { provider: string; before: SwitchAccountRef; after: SwitchAccountRef; signedIn: boolean }): AccountSwitchOutcome {
    const { provider, before, after } = input;
    if (!input.signedIn) return { kind: 'signed-out', provider, accountId: before.id, label: before.label };
    if (after.id === before.id) return { kind: 'unchanged', provider, accountId: after.id, label: after.label };
    return { kind: 'switched', provider, accountId: after.id, label: after.label, fromAccountId: before.id, fromLabel: before.label };
}

/** The words a window shows, and whether Retry is offered. */
export function accountSwitchWords(o: AccountSwitchOutcome): { title: string; body: string; retry: boolean } {
    const name = providerLogin(o.provider)?.name ?? o.provider;
    if (o.kind === 'switched') return { title: `Switched to ${o.label}`, body: `${name} is signed in as ${o.label} now. Your agents keep going.`, retry: false };
    if (o.kind === 'unchanged') return { title: `Still on ${o.label}`, body: `${name} is still signed in as ${o.label}. Nothing changed; your agents keep going.`, retry: true };
    return { title: `${name} is not signed in`, body: `The switch did not finish, so ${o.label} is still the active account. Sign in to carry on.`, retry: true };
}

/** The window's toast: Retry (when offered) opens the provider's switch again. */
export function accountSwitchToast(o: AccountSwitchOutcome, again: (provider: string) => void): { title: string; body: string; action?: { label: string; run: () => void } } {
    const words = accountSwitchWords(o);
    return { title: words.title, body: words.body, ...(words.retry ? { action: { label: 'Retry', run: () => again(o.provider) } } : {}) };
}

/** The outcome as the host signals it to windows, or `null` for anything else. */
export function accountSwitchOutcomeOf(value: unknown): AccountSwitchOutcome | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    const str = (k: string): string | null => (typeof v[k] === 'string' && v[k] !== '' ? (v[k] as string) : null);
    const provider = str('provider'), accountId = str('accountId'), label = str('label');
    if (provider === null || accountId === null || label === null) return null;
    if (v['kind'] === 'unchanged' || v['kind'] === 'signed-out') return { kind: v['kind'], provider, accountId, label };
    if (v['kind'] === 'switched') {
        const fromAccountId = str('fromAccountId'), fromLabel = str('fromLabel');
        if (fromAccountId === null || fromLabel === null) return null;
        return { kind: 'switched', provider, accountId, label, fromAccountId, fromLabel };
    }
    return null;
}

/** RED stub (Tynn #482 fix). */
export function accountSwitchSignal(_o: AccountSwitchOutcome): { kind: string; outcome: unknown } { return { kind: '', outcome: null }; }
