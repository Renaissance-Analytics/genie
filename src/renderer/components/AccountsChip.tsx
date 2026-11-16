import { Avatar, Badge, Button, Callout, Icon, Popover, Progress } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { activeAccountOf, chooseWords, type AccountView, type AccountWindowRow, type ProviderAccountsView } from '../../core/accounts-view.js';
import { shortDateTime } from '../../core/clock-words.js';
import { limitLevel, resetsIn, windowWords, type LimitLevel, type WindowReading } from '../../core/headroom.js';
import type { SwitchOffer, SwitchTarget } from '../../core/switch-offer.js';
import { ProviderLogo, providerName } from './ProviderLogo.js';

/**
 * THE PROVIDER'S ACCOUNT CHIP (Tynn #483, Accounts S10). The chip names the account signed in on the host, which every agent
 * of the provider uses (Tynn #751/#753), with its tightest window. Its popover lists every known account: its name, its plan
 * (or "unknown"), one bar per window with the share left and the local reset time ("unknown" for a window not reported,
 * "Refreshed" past its reset), and, on every account but the signed-in one, one click to switch: the provider's own login, in
 * its one home (S9). A standing switch offer (S8) leads the popover and marks the chip. Every action is a react-fancy Button.
 */
export interface AccountsChipProps {
    readonly view: ProviderAccountsView;
    readonly offer: SwitchOffer | null;
    readonly now: number;
    readonly onSwitch?: ((provider: string, choose?: string) => void) | undefined;
    readonly onDismissOffer?: ((id: string) => void) | undefined;
}

const LEVEL_TEXT: Readonly<Record<LimitLevel, string>> = { ok: 'text-[var(--fg-2)]', warning: 'text-[var(--warning)]', danger: 'text-[var(--danger)]' };
const LEVEL_COLOR: Readonly<Record<LimitLevel, 'green' | 'amber' | 'red'>> = { ok: 'green', warning: 'amber', danger: 'red' };

/** Initials for the account's avatar: the label's first letter (an email's, before the @). */
const initial = (label: string): string => (label.trim()[0] ?? '?').toUpperCase();

/** The tightest live window of an account, or null when none has a figure. */
/** A window read live: a figure and a reset (not unknown, not Refreshed). */
type LiveWindow = Extract<WindowReading, { refreshed: false }>;

function tightest(account: AccountView): LiveWindow | null {
    const live = account.windows.filter((w): w is LiveWindow => !('unknown' in w) && w.refreshed === false);
    if (live.length === 0) return null;
    return live.reduce((a, b) => ((b.over ? -1 : b.leftPct) < (a.over ? -1 : a.leftPct) ? b : a));
}

function targetWords(t: SwitchTarget): string {
    if (t.room === 'unknown') return `${t.label} (not used yet)`;
    if (t.room === 'reset') return `${t.label} (window reset)`;
    return `${t.label} (${t.leftPct}% left)`;
}

export function AccountsChip({ view, offer, now, onSwitch, onDismissOffer }: AccountsChipProps) {
    const [open, setOpen] = useState(false);
    const active = activeAccountOf(view);
    if (!active) return null;
    const provider = view.provider;
    const name = providerName(provider);
    const tight = tightest(active);
    const level: LimitLevel = tight ? limitLevel(tight) : 'ok';
    // The switch opens the provider's login in a window of its own; the popover stays as it is under it.
    const switchTo = (choose?: string) => { onSwitch?.(provider, choose); };
    // The offer's Switch names its first suggestion (Tynn #483): the person chooses it in the provider's login.
    const firstTarget = offer?.targets[0];
    const firstAccount = firstTarget ? view.accounts.find((a) => a.id === firstTarget.accountId) : undefined;
    const offerChoose = firstAccount ? chooseWords(firstAccount) : firstTarget?.label;
    return (
        <Popover placement="bottom-end" open={open} onOpenChange={setOpen}>
            <Popover.Trigger>
                <Button
                    type="button"
                    size="xs"
                    data-account-chip={provider}
                    data-level={level}
                    {...(offer ? { 'data-offer': offer.id } : {})}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label={`${name}: signed in as ${active.label}${tight ? `, ${tight.over ? 'over the limit' : `${tight.leftPct}% left`} ${windowWords(tight.window)}` : ''}${offer ? '. A switch is offered' : ''}`}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } }}
                    className={`gap-1 hover:bg-[var(--bg-2)] ${open ? 'bg-[var(--bg-2)]' : ''} ${offer ? 'ring-1 ring-[var(--warning)]' : ''}`}
                >
                    <ProviderLogo provider={provider} size="xs" className="text-[var(--fg-3)]" />
                    <span data-account-chip-label="" className="max-w-[10rem] truncate text-[var(--fg-2)]">{active.label}</span>
                    {tight ? <span className={`tabular-nums ${LEVEL_TEXT[level]}`}>{tight.over ? 'over' : `${tight.leftPct}%`}</span> : null}
                    {tight ? <span className="text-[11px] text-[var(--fg-4)]">{tight.window}</span> : null}
                    {offer ? <Icon name="arrow-right-left" size="xs" className="text-[var(--warning)]" /> : null}
                </Button>
            </Popover.Trigger>
            <Popover.Content role="dialog" aria-label={`${name} accounts`} data-account-popover={provider}
                className="w-72 border-[var(--border-1)] bg-[var(--surface-raised)] p-3 text-[var(--fg-1)]">
                <div className="flex flex-col gap-3 text-xs">
                    <ProviderLogo provider={provider} size="md" />
                    {offer ? (
                        <Callout color="amber" icon={<Icon name="arrow-right-left" size="sm" />} data-switch-offer={offer.id}>
                            <p>{offer.label}: {offer.over ? 'spent' : `${offer.leftPct}% left`} of its {windowWords(offer.window)} window.</p>
                            {offer.targets.length > 0
                                ? <p className="text-[var(--fg-3)]">Room: {offer.targets.map(targetWords).join(', ')}</p>
                                : <p className="text-[var(--fg-3)]">No other {name} account has room.</p>}
                            <div className="mt-1.5 flex gap-1.5">
                                {offer.targets.length > 0 ? <Button type="button" size="xs" icon="arrow-right-left" data-action="switch-offer-switch" onClick={() => switchTo(offerChoose)}>Switch</Button> : null}
                                <Button type="button" size="xs" variant="ghost" data-action="switch-offer-dismiss" onClick={() => onDismissOffer?.(offer.id)}>Not now</Button>
                            </div>
                        </Callout>
                    ) : null}
                    {view.accounts.map((a) => <AccountSection key={a.id} account={a} now={now} onSwitch={() => switchTo(chooseWords(a))} />)}
                </div>
            </Popover.Content>
        </Popover>
    );
}

function AccountSection({ account, now, onSwitch }: { account: AccountView; now: number; onSwitch: () => void }) {
    return (
        <section data-account={account.id} data-active={account.active ? 'true' : 'false'} className="flex flex-col gap-1.5 border-t border-[var(--border-1)] pt-2">
            <div className="flex items-center gap-1.5">
                <Avatar size="xs" fallback={initial(account.label)} />
                <span className="min-w-0 flex-1 truncate font-medium">{account.label}</span>
                <Badge size="sm" variant="soft" color={account.plan ? 'violet' : 'zinc'} data-account-plan="">{account.plan ?? 'unknown'}</Badge>
                {account.active
                    ? <Badge size="sm" variant="outline" color="green" dot data-account-active="">Signed in</Badge>
                    : <Button type="button" size="xs" icon="arrow-right-left" data-action="account-switch" aria-label={`Switch to ${account.label}`} onClick={onSwitch}>Switch</Button>}
            </div>
            {account.windows.map((w) => <WindowRow key={w.window} w={w} now={now} />)}
        </section>
    );
}

function WindowRow({ w, now }: { w: AccountWindowRow; now: number }) {
    if ('unknown' in w) {
        return (
            <div data-account-window={w.window} data-level="unknown" className="flex items-center gap-2 text-[var(--fg-3)]">
                <span className="w-12 shrink-0 text-[var(--fg-2)]">{w.window}</span>
                <Icon name="circle-help" size="xs" />
                <span>unknown</span>
            </div>
        );
    }
    if (w.refreshed || w.resetsAtMs <= now) {
        return (
            <div data-account-window={w.window} data-level="refreshed" className="flex items-center gap-2 text-[var(--fg-3)]">
                <span className="w-12 shrink-0 text-[var(--fg-2)]">{w.window}</span>
                <span>Refreshed</span>
            </div>
        );
    }
    const level = limitLevel(w);
    return (
        <div data-account-window={w.window} data-level={level} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[var(--fg-2)]">{w.window}</span>
                <Progress value={w.leftPct} max={100} size="sm" color={LEVEL_COLOR[level]} aria-label={`${w.window} left`} className="flex-1" />
                <span className={`w-9 shrink-0 text-right tabular-nums ${LEVEL_TEXT[level]}`}>{w.over ? 'over' : `${w.leftPct}%`}</span>
            </div>
            <div className="flex gap-2 pl-14 text-[11px]">
                <span className="text-[var(--fg-2)]">{resetsIn(w.resetsAtMs, now)}</span>
                <span data-account-reset-at="" className="text-[var(--fg-4)]">{shortDateTime(w.resetsAtMs)}</span>
            </div>
        </div>
    );
}
