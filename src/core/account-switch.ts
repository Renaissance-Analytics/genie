import { clockAmPm } from './clock-words.js';
import type { Headroom } from './headroom.js';
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

/**
 * The host's signal to its windows: its own kind, and the outcome WHOLE under `outcome`. Spreading the outcome into the signal
 * let the outcome's `kind` overwrite the signal's (measured: tsc TS2783), and main never recognised a switch.
 */
export function accountSwitchSignal(o: AccountSwitchOutcome): { readonly kind: 'account-switch'; readonly outcome: AccountSwitchOutcome } {
    return { kind: 'account-switch', outcome: o };
}

/**
 * WHAT EVERY RUNNING AGENT IS TOLD AT A SWITCH (Tynn #1011; the owner: "whenever we have an account switch make sure to post
 * the updated rate limit status so agents know it is reset. they keep getting stuck in holding patterns because they think the
 * rate limit is about to hit."). One line, ahead of the agent's next turn: the account it now draws on, each window's use as
 * that account last reported it, and when the nearest one resets; and that the warnings it saw before were the old account's.
 * With no reading for the account yet, it says so: never a guessed figure.
 */
export function accountSwitchNote(label: string, headroom: Headroom | null, nowMs: number): string {
    const after = 'Earlier rate-limit warnings were about the previous account, so carry on with your work at its normal pace.';
    if (!headroom || headroom.windows.length === 0) return `Account switched to ${label}: its usage is not known yet. ${after}`;
    const parts = headroom.windows.map((w) => {
        if (w.resetsAtMs <= nowMs) return `${w.window} reset`;
        if (w.over) return `${w.window} over the limit`;
        return `${w.window} ${Math.max(0, Math.round(w.usedPct))}% used`;
    });
    const upcoming = headroom.windows.filter((w) => w.resetsAtMs > nowMs).map((w) => w.resetsAtMs);
    const resets = upcoming.length > 0 ? `, resets ${clockAmPm(Math.min(...upcoming))}` : '';
    return `Account switched to ${label}: ${parts.join(', ')}${resets}. ${after}`;
}

/**
 * WHY AN AGENT STAYS ON ITS OLD ACCOUNT (Tynn #1084), in plain words: its conversation cannot be opened on the new account (it is
 * not in that account's history), or Genie could not tell. Said on its header, its chat line and the panel, never "moves at next
 * idle", which would never come true.
 */
export function staysWhy(store: 'absent' | 'indeterminate', to: string): string {
    return store === 'absent' ? `its conversation can't be opened on ${to}` : `Genie could not tell whether ${to} can open its conversation`;
}

/**
 * WHAT AN AGENT IS TOLD ON A SWITCH (Tynn #1084). One that moves now hears the switch and the new account's room. One still in
 * the old account's folder (busy: it moves at its next clean idle) is told exactly that: it is still running on the old
 * account until its current work is idle, then continues on the new one. "Account switched" to an agent that had not switched
 * is what the owner's coordinator was told on beta.66.1.
 */
export function switchNoteFor(input: { readonly to: string; readonly from: string; readonly movesLater: boolean; readonly headroom: Headroom | null; readonly nowMs: number }): string {
    if (!input.movesLater) return accountSwitchNote(input.to, input.headroom, input.nowMs);
    return `The active account is ${input.to} now, but you are still running on ${input.from} until your current work is idle; then you continue on ${input.to}, on this same conversation. Rate-limit readings until then are ${input.from}'s.`;
}
