import { Avatar, Badge, Button, Callout, Icon, Popover, Progress } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { activeAccountOf, chooseWords, type AccountView, type AccountWindowRow, type ProviderAccountsView } from '../../core/accounts-view.js';
import { shortDateTime } from '../../core/clock-words.js';
import { limitLevel, resetsIn, windowWords, type LimitLevel, type WindowReading } from '../../core/headroom.js';
import type { SwitchOffer, SwitchTarget } from '../../core/switch-offer.js';
import { rankSwitchNext } from '../../core/switch-next.js';
import { DesignAuthRow } from './DesignAuthRow.js';
import type { DesignAuthView } from '../../core/design-auth.js';
import { ProviderLogo, providerName } from './ProviderLogo.js';

/**
 * THE PROVIDER'S ACCOUNT CHIP (Tynn #483, Accounts S10). The chip names the account signed in on the host, which every agent
 * of the provider uses (Tynn #751/#753), with its tightest window. Its popover (wide, two panes since Tynn #988: the signed-in
 * account large on the left, the others in a column on the right in the order to switch to them) lists every known account:
 * its name, its plan (a chip only when known), one bar per window with the share left and the local reset time ("unknown" for a window not reported,
 * "Refreshed" past its reset), and, on every account but the signed-in one, one click to switch: the provider's own login, in
 * its one home (S9). Below them, always, "Use another account" (Tynn #850): the same login naming no account, for one Genie
 * does not know yet. A standing switch offer (S8) leads the popover and marks the chip. Every action is a react-fancy Button.
 */
export interface AccountsChipProps {
    readonly view: ProviderAccountsView;
    readonly offer: SwitchOffer | null;
    readonly now: number;
    readonly onSwitch?: ((provider: string, choose?: string) => void) | undefined;
    readonly onDismissOffer?: ((id: string) => void) | undefined;
    /** Claude Design's authorization for the machine (Tynn #480): shown in Claude's popover. */
    readonly design?: DesignAuthView | undefined;
    readonly onDesignSignIn?: (() => void) | undefined;
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

export function AccountsChip({ view, offer, now, onSwitch, onDismissOffer, design, onDesignSignIn }: AccountsChipProps) {
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
    const others = rankSwitchNext(view.accounts.filter((a) => a.id !== active.id), now);
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
            {/* WIDE, TWO PANES (Tynn #988): the signed-in account large on the left with all its stats; the other accounts in a
                column on the right, in the order to switch to them (rankSwitchNext), each with its Switch. */}
            <Popover.Content role="dialog" aria-label={`${name} accounts`} data-account-popover={provider} data-layout="two-pane"
                className="w-[40rem] max-w-[calc(100vw-1.5rem)] overflow-hidden border-[var(--border-1)] bg-[var(--surface-raised)] p-0 text-[var(--fg-1)]">
                <div className="flex max-h-[70vh] text-xs">
                <div data-accounts-pane="active" className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
                    <div className="flex items-center gap-2">
                        <ProviderLogo provider={provider} size="md" />
                        <span className="text-[var(--fg-3)]">{name}</span>
                    </div>
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
                    <ActiveAccount account={active} now={now} />
                    {design && provider === 'claude' ? <DesignAuthRow design={design} onSignIn={onDesignSignIn} /> : null}
                </div>
                <div data-accounts-pane="others" className="flex w-60 shrink-0 flex-col border-l border-[var(--border-1)] bg-[var(--bg-1)]">
                    {/* The list scrolls; Use another account stays below it, always in view (measured in the real app: at a
                        640 px window it had scrolled out of the popover). */}
                    <div data-accounts-others-list="" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-3)]">{others.length > 0 ? 'Switch to next' : 'Other accounts'}</span>
                        {others.length === 0 ? <span className="text-[var(--fg-3)]">No other {name} account yet.</span> : null}
                        {others.map((a, i) => <OtherAccount key={a.id} account={a} rank={i + 1} now={now} onSwitch={() => switchTo(chooseWords(a))} />)}
                    </div>
                    {/* USE ANOTHER ACCOUNT (Tynn #850): always here, even with one known account. The provider's own login,
                        naming no account: the person picks or creates a different one, and Genie reads who it is afterwards. */}
                    <div className="shrink-0 border-t border-[var(--border-1)] p-2">
                        <Button type="button" size="xs" variant="ghost" icon="user-plus" data-action="account-use-another" onClick={() => switchTo()}>Use another account</Button>
                    </div>
                </div>
                </div>
            </Popover.Content>
        </Popover>
    );
}

/** The plan chip, only when the plan is known (Tynn #988: a chip reading "unknown" told the person nothing). */
function PlanChip({ plan }: { plan: string | null }) {
    return plan ? <Badge size="sm" variant="soft" color="violet" data-account-plan="">{plan}</Badge> : null;
}

/** THE LEFT PANE: the account the chip names, large, with who it is and every window it reported. */
function ActiveAccount({ account, now }: { account: AccountView; now: number }) {
    return (
        <section data-account={account.id} data-active={account.active ? 'true' : 'false'} className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
                <Avatar size="lg" fallback={initial(account.label)} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold">{account.label}</span>
                    {account.email && account.email !== account.label ? <span data-account-email="" className="truncate text-[var(--fg-3)]">{account.email}</span> : null}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <PlanChip plan={account.plan} />
                        {account.active
                            ? <Badge size="sm" variant="outline" color="green" dot data-account-active="">Signed in</Badge>
                            : <Badge size="sm" variant="outline" color="zinc" data-account-active-unknown="">Not signed in</Badge>}
                    </div>
                </div>
            </div>
            <div className="flex flex-col gap-2.5 border-t border-[var(--border-1)] pt-3">
                {account.windows.map((w) => <WindowRow key={w.window} w={w} now={now} />)}
            </div>
        </section>
    );
}

/** THE RIGHT COLUMN: another account, compact: its name, plan, a line per window and its Switch. */
function OtherAccount({ account, rank, now, onSwitch }: { account: AccountView; rank: number; now: number; onSwitch: () => void }) {
    return (
        <section data-account={account.id} data-active="false" data-switch-rank={rank} className="flex flex-col gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--surface-raised)] p-2">
            <div className="flex items-center gap-1.5">
                <Avatar size="xs" fallback={initial(account.label)} />
                <span className="min-w-0 flex-1 truncate font-medium" title={account.email ?? account.label}>{account.label}</span>
                <PlanChip plan={account.plan} />
            </div>
            {account.windows.map((w) => <CompactWindow key={w.window} w={w} now={now} />)}
            <Button type="button" size="xs" icon="arrow-right-left" data-action="account-switch" aria-label={`Switch to ${account.label}`} className="self-end" onClick={onSwitch}>Switch</Button>
        </section>
    );
}

function CompactWindow({ w, now }: { w: AccountWindowRow; now: number }) {
    if ('unknown' in w) {
        return <div data-account-window={w.window} data-level="unknown" className="flex gap-2 text-[11px] text-[var(--fg-3)]"><span className="w-10 shrink-0">{w.window}</span><span>unknown</span></div>;
    }
    if (w.refreshed || w.resetsAtMs <= now) {
        return <div data-account-window={w.window} data-level="refreshed" className="flex gap-2 text-[11px] text-[var(--fg-3)]"><span className="w-10 shrink-0">{w.window}</span><span>Refreshed</span></div>;
    }
    const level = limitLevel(w);
    return (
        <div data-account-window={w.window} data-level={level} className="flex flex-col text-[11px]">
            <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-[var(--fg-2)]">{w.window}</span>
                <Progress value={w.leftPct} max={100} size="sm" color={LEVEL_COLOR[level]} aria-label={`${w.window} left`} className="flex-1" />
                <span className={`w-8 shrink-0 text-right tabular-nums ${LEVEL_TEXT[level]}`}>{w.over ? 'over' : `${w.leftPct}%`}</span>
            </div>
            {/* The reset is half of the switch-next rule, so it is read in full, not cut short. */}
            <span data-account-reset-in="" className="pl-12 text-[var(--fg-4)]" title={shortDateTime(w.resetsAtMs)}>{resetsIn(w.resetsAtMs, now)}</span>
        </div>
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
