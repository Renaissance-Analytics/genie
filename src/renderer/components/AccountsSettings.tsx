import { Avatar, Badge, Button, Input, MultiSwitch } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { chooseWords, type AccountView, type AccountsSnapshot, type AccountWindowRow } from '../../core/accounts-view.js';
import { forgetRefusal, SWITCH_OFFER_WINDOW_CHOICES, type AccountsAction, type AccountsActResult } from '../../core/account-settings.js';
import { shortDateTime } from '../../core/clock-words.js';
import { parseSwitchOfferWindows } from '../../core/switch-offer.js';
import { ProviderLogo } from './ProviderLogo.js';

/**
 * SETTINGS → PROVIDERS → ACCOUNTS (Tynn #484, Accounts S11). Every known account of each provider with its usage, the one
 * signed in on the host marked (every agent of the provider uses it, Tynn #751); Switch on any other (one click: the provider's
 * own login, naming the account, S9/S10), Rename, and Forget, which is refused for the signed-in account and says so. Above
 * them, the windows that make Genie offer a switch (S8). There is no per-agent account: agents use the signed-in one.
 */
export interface AccountsSettingsProps {
    readonly snapshot: AccountsSnapshot | undefined;
    /** The `switch_offer_windows` setting as stored. */
    readonly offerWindows: unknown;
    readonly onSetOfferWindows: (value: string) => void;
    readonly onSwitch?: ((provider: string, choose?: string) => void) | undefined;
    readonly onAct?: ((action: AccountsAction) => Promise<AccountsActResult>) | undefined;
    readonly now?: number | undefined;
}

export function AccountsSettings({ snapshot, offerWindows, onSetOfferWindows, onSwitch, onAct, now }: AccountsSettingsProps) {
    const at = now ?? Date.now();
    return (
        <section data-settings-accounts="" className="mt-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
                <div className="text-sm font-medium">Accounts</div>
                <div data-switch-offer-windows="" className="ml-auto flex items-center gap-2 text-xs text-[var(--fg-3)]">
                    <span>Offer a switch when</span>
                    <MultiSwitch size="sm" list={SWITCH_OFFER_WINDOW_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
                        value={parseSwitchOfferWindows(offerWindows)} onValueChange={(v) => onSetOfferWindows(v)} aria-label="Offer a switch when this window is nearly used" />
                </div>
            </div>
            {snapshot === undefined ? <p className="text-sm text-[var(--fg-3)]">Accounts show once Genie’s host answers.</p> : null}
            {snapshot?.providers.map((p) => (
                <div key={p.provider} data-settings-accounts-provider={p.provider} className="flex flex-col">
                    <ProviderLogo provider={p.provider} size="md" className="mb-1 text-[var(--fg-1)]" />
                    <ul className="divide-y divide-[var(--border-1)]">
                        {p.accounts.map((a) => <AccountRow key={a.id} account={a} now={at} onSwitch={onSwitch} onAct={onAct} />)}
                    </ul>
                </div>
            ))}
        </section>
    );
}

function usageWords(w: AccountWindowRow, now: number): string {
    if ('unknown' in w) return 'unknown';
    if (w.refreshed || w.resetsAtMs <= now) return 'Refreshed';
    return `${w.over ? 'over' : `${w.leftPct}%`} · ${shortDateTime(w.resetsAtMs)}`;
}

function AccountRow({ account, now, onSwitch, onAct }: { account: AccountView; now: number; onSwitch: AccountsSettingsProps['onSwitch']; onAct: AccountsSettingsProps['onAct'] }) {
    const [renaming, setRenaming] = useState<string | null>(null);
    const [said, setSaid] = useState<string | null>(null);
    const act = (action: AccountsAction) => {
        setSaid(null);
        void onAct?.(action).then((r) => { if (!r.ok) setSaid(r.reason); else setRenaming(null); }, (e: unknown) => setSaid(e instanceof Error ? e.message : String(e)));
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
                    {!account.active ? <Button type="button" size="xs" icon="arrow-right-left" data-action="account-switch" aria-label={`Switch to ${account.label}`} onClick={() => onSwitch?.(account.provider, chooseWords(account))}>Switch</Button> : null}
                    {renaming === null
                        ? <Button type="button" size="xs" variant="ghost" data-action="account-rename" onClick={() => { setSaid(null); setRenaming(account.label); }}>Rename</Button>
                        : <>
                            <Button type="button" size="xs" data-action="account-rename-save" disabled={!renaming.trim()} onClick={() => act({ kind: 'rename', id: account.id, label: renaming.trim() })}>Save</Button>
                            <Button type="button" size="xs" variant="ghost" data-action="account-rename-cancel" onClick={() => setRenaming(null)}>Cancel</Button>
                        </>}
                    <Button type="button" size="xs" variant="ghost" data-action="account-forget" onClick={forget}>Forget</Button>
                </span>
            </div>
            <div className="flex flex-wrap gap-3 pl-7 text-xs text-[var(--fg-3)]">
                {account.windows.map((w) => <span key={w.window} data-account-usage={w.window}><span className="text-[var(--fg-2)]">{w.window}</span> {usageWords(w, now)}</span>)}
            </div>
            {said ? <p role="alert" data-account-refused="" className="pl-7 text-xs text-[var(--warning)]">{said}</p> : null}
        </li>
    );
}
