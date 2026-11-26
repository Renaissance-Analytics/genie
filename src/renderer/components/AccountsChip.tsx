import { Avatar, Badge, Button, Callout, Icon, Input, Popover, Progress } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { activeAccountOf, chooseWords, type AccountView, type AccountWindowRow, type ProviderAccountsView } from '../../core/accounts-view.js';
import { shortDateTime } from '../../core/clock-words.js';
import { limitLevel, resetsIn, windowWords, type LimitLevel, type WindowReading } from '../../core/headroom.js';
import { offerWords, targetWords, type SwitchOffer } from '../../core/switch-offer.js';
import { rankSwitchNext } from '../../core/switch-next.js';
import { DesignAuthRow } from './DesignAuthRow.js';
import type { AccountsAction, AccountsActResult } from '../../core/account-settings.js';
import { mismatchWords, type ClaudeAccountLive, type ClaudeSignInView } from '../../core/claude-accounts.js';
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
    /** Tynn #1011: add a Claude account of its own, or make one active (one click, no terminal). */
    readonly onAccountsAct?: ((action: AccountsAction) => Promise<AccountsActResult> | void) | undefined;
    /** Tynn #1011: the Claude sign-ins running now (in the browser, or waiting for a code the CLI asked for). */
    readonly signIns?: readonly ClaudeSignInView[] | undefined;
}

/** The footer's rows (Add subscription, Add Console, Use another account): full width, icon and words from the left edge. */
const FOOTER_ROW = 'w-full justify-start';

const LEVEL_TEXT:Readonly<Record<LimitLevel, string>> = { ok: 'text-[var(--fg-2)]', warning: 'text-[var(--warning)]', danger: 'text-[var(--danger)]' };
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

export function AccountsChip({ view, offer, now, onSwitch, onDismissOffer, design, onDesignSignIn, onAccountsAct, signIns }: AccountsChipProps) {
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
    /*
     * HOW AN ACCOUNT IS SWITCHED TO (Tynn #1011). One Claude Code reports signed in where it lives (its own directory, or the
     * default home it is signed in to now) becomes the active account with one click: no terminal, no login. Any other Claude
     * account offers Sign in: prism-acp's hidden login, Anthropic's page in the browser (the owner: "I should not see any
     * terminals"). Another provider's account is still reached by its own login (#753).
     */
    const choose = (a: AccountView): { kind: 'switch' | 'sign-in'; run: () => void } => {
        if (a.live?.signedIn === true) return { kind: 'switch', run: () => { void onAccountsAct?.({ kind: 'set-active', id: a.id }); } };
        // Sign in only for an account Claude Code SAID is signed out (the review of #2139).
        if (provider === 'claude' && onAccountsAct && a.live?.signedIn === false) return { kind: 'sign-in', run: () => { void onAccountsAct({ kind: 'sign-in', id: a.id }); } };
        // Its state is not known yet (not read, or the read failed): Switch, by id, and the host asks Claude Code itself,
        // makes it active when it is signed in and signs it in only when it is not.
        if (provider === 'claude' && onAccountsAct) return { kind: 'switch', run: () => { void onAccountsAct({ kind: 'switch', id: a.id }); } };
        return { kind: 'switch', run: () => switchTo(chooseWords(a)) };
    };
    // The offer's Switch: for Claude, the account it suggests BY ID (two accounts may share an email); else the provider's login.
    const switchToOffer = () => {
        if (provider === 'claude' && onAccountsAct && firstTarget) void onAccountsAct({ kind: 'switch', id: firstTarget.accountId });
        else switchTo(offerChoose);
    };
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
                            <p>{offerWords(offer)}</p>
                            {offer.targets.length > 0
                                ? <p className="text-[var(--fg-3)]">Room: {offer.targets.map(targetWords).join(', ')}</p>
                                : <p className="text-[var(--fg-3)]">No other {name} account has room.</p>}
                            <div className="mt-1.5 flex gap-1.5">
                                {offer.targets.length > 0 ? <Button type="button" size="xs" icon="arrow-right-left" data-action="switch-offer-switch" onClick={switchToOffer}>Switch</Button> : null}
                                <Button type="button" size="xs" variant="ghost" data-action="switch-offer-dismiss" onClick={() => onDismissOffer?.(offer.id)}>Not now</Button>
                            </div>
                        </Callout>
                    ) : null}
                    {(signIns ?? []).filter((s) => view.accounts.some((a) => a.id === s.accountId) || provider === 'claude').map((s) => <SignInPending key={s.accountId} signIn={s} onAct={onAccountsAct} />)}
                    <ActiveAccount account={active} now={now} onSignIn={provider === 'claude' && onAccountsAct && active.ownDirectory === true && active.live?.signedIn !== true ? () => { void onAccountsAct({ kind: 'sign-in', id: active.id }); } : undefined} />
                    {design && provider === 'claude' ? <DesignAuthRow design={design} onSignIn={onDesignSignIn} /> : null}
                </div>
                <div data-accounts-pane="others" className="flex w-60 shrink-0 flex-col border-l border-[var(--border-1)] bg-[var(--bg-1)]">
                    {/* The list scrolls; Use another account stays below it, always in view (measured in the real app: at a
                        640 px window it had scrolled out of the popover). */}
                    <div data-accounts-others-list="" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-3)]">{others.length > 0 ? 'Switch to next' : 'Other accounts'}</span>
                        {others.length === 0 ? <span className="text-[var(--fg-3)]">No other {name} account yet.</span> : null}
                        {others.map((a, i) => <OtherAccount key={a.id} account={a} rank={i + 1} now={now} action={choose(a)} />)}
                    </div>
                    {/* USE ANOTHER ACCOUNT (Tynn #850): always here, even with one known account. The provider's own login,
                        naming no account: the person picks or creates a different one, and Genie reads who it is afterwards. */}
                    <div className="flex shrink-0 flex-col gap-1 border-t border-[var(--border-1)] p-2">
                        {/* ADD AN ACCOUNT OF ITS OWN (Tynn #1011): a directory of its own; the person then signs in with Claude Code's
                            own login (a claude.ai plan, or a Console account billed per token). */}
                        {provider === 'claude' && onAccountsAct ? (
                            <div data-accounts-add="" className="flex flex-col gap-1">
                                <Button type="button" size="xs" variant="ghost" icon="plus" data-action="account-add-subscription" className={FOOTER_ROW} onClick={() => { void onAccountsAct({ kind: 'add-claude', method: 'subscription' }); }}>Add subscription</Button>
                                <Button type="button" size="xs" variant="ghost" icon="plus" data-action="account-add-console" className={FOOTER_ROW} onClick={() => { void onAccountsAct({ kind: 'add-claude', method: 'console' }); }}>Add Console (API)</Button>
                            </div>
                        ) : null}
                        <Button type="button" size="xs" variant="ghost" icon="user-plus" data-action="account-use-another" className={FOOTER_ROW} onClick={() => { if (provider === 'claude' && onAccountsAct) void onAccountsAct({ kind: 'use-another', method: 'subscription' }); else switchTo(); }}>Use another account</Button>
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
function ActiveAccount({ account, now, onSignIn }: { account: AccountView; now: number; onSignIn?: (() => void) | undefined }) {
    return (
        <section data-account={account.id} data-active={account.active ? 'true' : 'false'} className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
                <Avatar size="lg" fallback={initial(account.label)} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold">{account.label}</span>
                    {account.email && account.email !== account.label ? <span data-account-email="" className="truncate text-[var(--fg-3)]">{account.email}</span> : null}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <PlanChip plan={account.plan} />
                        {/* With a live state (Tynn #1011) that is the one pill: this pane IS the active account, so "Active" beside
                            "Signed in" said the same thing twice. Without one, the book's own state stands. */}
                        {account.live
                            ? <LiveBadge live={account.live} />
                            : account.active
                                ? <Badge size="sm" variant="outline" color="green" dot data-account-active="">Signed in</Badge>
                                : <Badge size="sm" variant="outline" color="zinc" data-account-active-unknown="">Not signed in</Badge>}
                        {account.live ? <BillingChip live={account.live} /> : null}
                    </div>
                    {account.live?.org ? <span data-account-org="" className="truncate text-[var(--fg-3)]">{account.live.org}</span> : null}
                    {account.live?.loginExpiresAt ? <span data-account-login-expires="" className="text-[11px] text-[var(--fg-4)]">Sign-in good until {shortDateTime(Date.parse(account.live.loginExpiresAt))}</span> : null}
                </div>
            </div>
            {onSignIn ? <Button type="button" size="sm" icon="log-in" data-action="account-sign-in" className="self-start" onClick={onSignIn}>Sign in</Button> : null}
            <div className="flex flex-col gap-2.5 border-t border-[var(--border-1)] pt-3">
                {account.read === false ? <UsageUnknown /> : null}
                {account.windows.map((w) => <WindowRow key={w.window} w={w} now={now} />)}
            </div>
        </section>
    );
}

/** THE RIGHT COLUMN: another account, compact: its name, plan, a line per window and its Switch. */
function OtherAccount({ account, rank, now, action }: { account: AccountView; rank: number; now: number; action: { kind: 'switch' | 'sign-in'; run: () => void } }) {
    return (
        <section data-account={account.id} data-active="false" data-switch-rank={rank} className="flex flex-col gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--surface-raised)] p-2">
            <div className="flex items-center gap-1.5">
                <Avatar size="xs" fallback={initial(account.label)} />
                <span className="min-w-0 flex-1 truncate font-medium" title={account.email ?? account.label}>{account.label}</span>
                <PlanChip plan={account.plan} />
            </div>
            {account.live ? <div className="flex flex-wrap gap-1"><LiveBadge live={account.live} /><BillingChip live={account.live} /></div> : null}
            {account.read === false ? <UsageUnknown /> : null}
            {account.windows.map((w) => <CompactWindow key={w.window} w={w} now={now} />)}
            {action.kind === 'switch'
                ? <Button type="button" size="xs" icon="arrow-right-left" data-action="account-switch" aria-label={`Switch to ${account.label}`} className="self-end" onClick={action.run}>Switch</Button>
                : <Button type="button" size="xs" icon="log-in" data-action="account-sign-in" aria-label={`Sign in to ${account.label}`} className="self-end" onClick={action.run}>Sign in</Button>}
        </section>
    );
}

/**
 * A SIGN-IN IN THE BROWSER (Tynn #1011): finish it there, or Cancel. A code field ONLY when the CLI asked for a pasted code;
 * Send hands it straight back to the CLI (Genie keeps it nowhere) and the field empties.
 */
function SignInPending({ signIn, onAct }: { signIn: ClaudeSignInView; onAct: AccountsChipProps['onAccountsAct'] }) {
    const [code, setCode] = useState('');
    const send = () => {
        const value = code.trim();
        if (!value || !signIn.requestId) return;
        setCode('');
        void onAct?.({ kind: 'submit-code', requestId: signIn.requestId, code: value });
    };
    return (
        <Callout color="blue" icon={<Icon name="log-in" size="sm" />} data-sign-in-pending={signIn.accountId}>
            {signIn.state === 'code'
                ? <p>Claude Code asks for the code from the sign-in page for {signIn.label}. Paste it here.</p>
                : <p>Finish signing in to {signIn.label} in your browser.</p>}
            {signIn.state === 'code' ? (
                <div data-sign-in-code="" className="mt-1.5 flex items-center gap-1.5">
                    <Input size="sm" value={code} onValueChange={setCode} aria-label={`Sign-in code for ${signIn.label}`} autoComplete="off" className="flex-1" />
                    <Button type="button" size="xs" data-action="sign-in-send-code" disabled={!code.trim()} onClick={send}>Send</Button>
                </div>
            ) : null}
            <div className="mt-1.5 flex gap-1.5">
                <Button type="button" size="xs" variant="ghost" data-action="sign-in-cancel" onClick={() => { void onAct?.({ kind: 'cancel-sign-in', id: signIn.accountId }); }}>Cancel</Button>
            </div>
        </Callout>
    );
}

/** What Claude Code reports for the account now (prism-acp): ready, not signed in, or a typed mismatch with what was chosen. */
function LiveBadge({ live }: { live: ClaudeAccountLive }) {
    const { state, differences } = live.check;
    if (state === 'mismatch') {
        return <Badge size="sm" variant="soft" color="amber" data-account-live="mismatch" data-differences={differences.join(' ')} title={`Not what was chosen: ${mismatchWords(differences)}.`}>Mismatch</Badge>;
    }
    return state === 'ready'
        ? <Badge size="sm" variant="outline" color="green" dot data-account-live="ready">Signed in</Badge>
        : <Badge size="sm" variant="outline" color="zinc" data-account-live="signedOut">Not signed in</Badge>;
}

/** Who pays, as the CLI reports it: the plan, or per-token API usage. Nothing for an unknown. */
function BillingChip({ live }: { live: ClaudeAccountLive }) {
    const words = live.billing === 'subscription' ? 'Subscription' : live.billing === 'apiUsage' ? 'API usage' : null;
    return words ? <Badge size="sm" variant="soft" color="zinc" data-account-billing="">{words}</Badge> : null;
}

/** Tynn #1070: an account with no reading of its own yet. Its usage is unknown; no other account's figures stand in for it. */
function UsageUnknown() {
    return (
        <div data-account-usage-unknown="" className="flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
            <Icon name="circle-help" size="xs" />
            <span>Usage unknown: not read yet</span>
        </div>
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
