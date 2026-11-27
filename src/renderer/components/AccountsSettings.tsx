import { Avatar, Badge, Button, Input, MultiSwitch } from '@particle-academy/react-fancy';
import { useEffect, useRef, useState } from 'react';
import { PANEL_RECHECK_MS } from '../../core/usage-probe.js';
import { chooseWords, type AccountView, type AccountsSnapshot, type AccountWindowRow } from '../../core/accounts-view.js';
import { forgetRefusal, SWITCH_OFFER_WINDOW_CHOICES, type AccountsAction, type AccountsActResult } from '../../core/account-settings.js';
import { shortDateTime } from '../../core/clock-words.js';
import { usedWords } from '../../core/headroom.js';
import { parseSwitchOfferWindows } from '../../core/switch-offer.js';
import { ProviderLogo } from './ProviderLogo.js';
import { DesignAuthRow } from './DesignAuthRow.js';

/**
 * SETTINGS → PROVIDERS → ACCOUNTS (Tynn #484, Accounts S11). Every known account of each provider with its usage, the one
 * signed in on the host marked (every agent of the provider uses it, Tynn #751); Switch on any other (one click: the provider's
 * own login, naming the account, S9/S10), Rename, and Forget, which is refused for the signed-in account and says so; under
 * each provider, always, "Use another account" (Tynn #850: the same login naming no account, for a new one). Above
 * them, the windows that make Genie offer a switch (S8). There is no per-agent account: agents use the signed-in one.
 */
/** The choices of `when_active_account_out`, in the words of its setting. */
const WHEN_OUT_CHOICES: ReadonlyArray<{ value: 'ask' | 'switch'; label: string }> = [
    { value: 'ask', label: 'Ask me' },
    { value: 'switch', label: 'Switch to the account with the most room' },
];

export interface AccountsSettingsProps {
    readonly snapshot: AccountsSnapshot | undefined;
    /** The `switch_offer_windows` setting as stored. */
    readonly offerWindows: unknown;
    readonly onSetOfferWindows: (value: string) => void;
    /** The `when_active_account_out` setting as stored (Tynn #1089): `ask` (the default) or `switch`. */
    readonly whenOut?: unknown;
    readonly onSetWhenOut?: ((value: string) => void) | undefined;
    readonly onSwitch?: ((provider: string, choose?: string) => void) | undefined;
    readonly onAct?: ((action: AccountsAction) => Promise<AccountsActResult>) | undefined;
    readonly now?: number | undefined;
    /** Design sign-in for the machine (Tynn #480). */
    readonly onDesignSignIn?: (() => void) | undefined;
}

export function AccountsSettings({ snapshot, offerWindows, onSetOfferWindows, whenOut, onSetWhenOut, onSwitch, onAct, now, onDesignSignIn }: AccountsSettingsProps) {
    const at = now ?? Date.now();
    // Tynn #1084: open, this page asks for readings (under the probe's 15-min rules), and every 5 min while it stays open.
    const act = useRef(onAct);
    act.current = onAct;
    const providers = (snapshot?.providers ?? []).map((p) => p.provider).join(',');
    useEffect(() => {
        if (providers === '') return undefined;
        const ask = () => { for (const provider of providers.split(',')) void act.current?.({ kind: 'read-usage', provider }); };
        ask();
        const timer = setInterval(ask, PANEL_RECHECK_MS);
        return () => clearInterval(timer);
    }, [providers]);
    return (
        <section data-settings-accounts="" className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
                <div className="text-sm font-medium">Accounts</div>
                <div data-switch-offer-windows="" className="ml-auto flex items-center gap-2 text-xs text-[var(--fg-3)]">
                    <span>Offer a switch when</span>
                    <MultiSwitch size="sm" list={SWITCH_OFFER_WINDOW_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
                        value={parseSwitchOfferWindows(offerWindows)} onValueChange={(v) => onSetOfferWindows(v)} aria-label="Offer a switch when this window is nearly used" />
                </div>
                {onSetWhenOut ? (
                    // WHEN THE ACTIVE ACCOUNT RUNS OUT (Tynn #1089): the person's rule; never a silent switch.
                    <div data-when-active-out="" className="flex items-center gap-2 text-xs text-[var(--fg-3)]">
                        <span>When the active account runs out</span>
                        <MultiSwitch size="sm" list={WHEN_OUT_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
                            value={whenOut === 'switch' ? 'switch' : 'ask'} onValueChange={(v) => onSetWhenOut(v)} aria-label="When the active account runs out" />
                    </div>
                ) : null}
            </div>
            {snapshot === undefined ? <p className="text-sm text-[var(--fg-3)]">Accounts show once Genie’s host answers.</p> : null}
            {snapshot?.providers.map((p) => (
                <div key={p.provider} data-settings-accounts-provider={p.provider} className="flex flex-col">
                    <ProviderLogo provider={p.provider} size="md" className="mb-1 text-[var(--fg-1)]" />
                    <ul className="divide-y divide-[var(--border-1)]">
                        {p.accounts.map((a) => <AccountRow key={a.id} account={a} now={at} onSwitch={onSwitch} onAct={onAct} />)}
                    </ul>
                    {/* USE ANOTHER ACCOUNT (Tynn #850): the provider's own login naming no account, even with one known. */}
                    <Button type="button" size="xs" variant="ghost" icon="user-plus" data-action="account-use-another" className="self-start" onClick={() => onSwitch?.(p.provider)}>Use another account</Button>
                    {p.provider === 'claude' && snapshot.design ? <DesignAuthRow design={snapshot.design} onSignIn={onDesignSignIn} /> : null}
                </div>
            ))}
        </section>
    );
}

function usageWords(w: AccountWindowRow, now: number): string {
    if ('unknown' in w) return 'unknown';
    if (w.refreshed || w.resetsAtMs <= now) return 'Refreshed';
    return `${usedWords(w)} · ${shortDateTime(w.resetsAtMs)}`;
}

function AccountRow({ account, now, onSwitch, onAct }: { account: AccountView; now: number; onSwitch: AccountsSettingsProps['onSwitch']; onAct: AccountsSettingsProps['onAct'] }) {
    const [renaming, setRenaming] = useState<string | null>(null);
    const [said, setSaid] = useState<string | null>(null);
    const act = (action: AccountsAction) => {
        setSaid(null);
        void onAct?.(action).then((r) => { if (!r.ok) setSaid(r.reason); else setRenaming(null); }, (e: unknown) => setSaid(e instanceof Error ? e.message : String(e)));
    };
    // SWITCH BY ID (the review of #2139): a Claude account is switched to by the host, which makes it active when Claude Code
    // says it is signed in and signs it in only when it is not. Never a login by its email: two accounts may share one.
    // Another provider's switch is still its own login, naming the account (Tynn #753).
    const switchTo = () => {
        if (account.provider === 'claude' && onAct) act({ kind: 'switch', id: account.id });
        else onSwitch?.(account.provider, chooseWords(account));
    };
    const forget = () => {
        const refused = forgetRefusal(account);
        if (refused) { setSaid(refused); return; }
        act({ kind: 'forget', id: account.id });
    };
    return (
        <li data-settings-account={account.id} data-active={account.active ? 'true' : 'false'} className="flex flex-col gap-1 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
                <Avatar size="xs" fallback={(account.label.trim()[0] ?? '?').toUpperCase()} />
                {renaming === null ? (
                    <span className="min-w-0 truncate font-medium">{account.label}</span>
                ) : (
                    <Input size="sm" value={renaming} onValueChange={setRenaming} data-account-rename-input="" aria-label={`New name for ${account.label}`} className="w-48" />
                )}
                {account.email && account.email !== account.label ? <span className="truncate text-xs text-[var(--fg-3)]">{account.email}</span> : null}
                <Badge size="sm" variant="soft" color={account.plan ? 'violet' : 'zinc'} data-account-plan="">{account.plan ?? 'unknown'}</Badge>
                {account.active ? <Badge size="sm" variant="outline" color="green" dot data-account-active="">Signed in</Badge> : null}
                <span className="ml-auto flex items-center gap-1.5">
                    {!account.active ? <Button type="button" size="xs" icon="arrow-right-left" data-action="account-switch" aria-label={`Switch to ${account.label}`} onClick={switchTo}>Switch</Button> : null}
                    {renaming === null
                        ? <Button type="button" size="xs" variant="ghost" data-action="account-rename" onClick={() => { setSaid(null); setRenaming(account.label); }}>Rename</Button>
                        : <>
                            <Button type="button" size="xs" data-action="account-rename-save" disabled={!renaming.trim()} onClick={() => act({ kind: 'rename', id: account.id, label: renaming.trim() })}>Save</Button>
                            <Button type="button" size="xs" variant="ghost" data-action="account-rename-cancel" onClick={() => setRenaming(null)}>Cancel</Button>
                        </>}
                    <Button type="button" size="xs" variant="ghost" data-action="account-forget" onClick={forget}>Forget</Button>
                    {/* SIGN OUT AND REMOVE (Tynn #1011): prism-acp's logout() for an account with a folder of its own, not the
                        one every agent uses; then the account and its folder go. No window, no terminal. */}
                    {onAct ? <Button type="button" size="xs" variant="ghost" icon="refresh-cw" data-action="check-usage" disabled={account.usage?.state === 'reading'} onClick={() => act({ kind: 'read-usage', provider: account.provider, id: account.id, manual: true })}>Check usage now</Button> : null}
                    {account.ownDirectory === true && !account.active
                        ? <Button type="button" size="xs" variant="ghost" icon="log-out" data-action="account-sign-out" onClick={() => act({ kind: 'sign-out', id: account.id })}>Sign out and remove</Button>
                        : null}
                </span>
            </div>
            <div className="flex flex-wrap gap-3 pl-7 text-xs text-[var(--fg-3)]">
                {/* Tynn #1070: an account never read says so; one read lists the windows IT has, and only those. */}
                {/* Tynn #1084: being read now, or why it could not be; "Check usage now" reads it at once. */}
                {account.usage?.state === 'reading'
                    ? <span data-account-usage-reading="" {...(account.read === false ? { 'data-account-usage-unknown': '' } : {})}>{account.read === false ? 'Usage unknown · Reading usage…' : 'Reading usage…'}</span>
                    : account.read === false ? <span data-account-usage-unknown="">Usage unknown: not read yet</span> : null}
                {account.usage?.state === 'failed' ? <span data-account-usage-failed="" className="text-[var(--warning)]">{`Could not read usage: ${account.usage.reason}`}</span> : null}
                {account.windows.map((w) => <span key={w.window} data-account-usage={w.window}><span className="text-[var(--fg-2)]">{w.window}</span> {usageWords(w, now)}</span>)}
            </div>
            {said ? <p role="alert" data-account-refused="" className="pl-7 text-xs text-[var(--warning)]">{said}</p> : null}
        </li>
    );
}
