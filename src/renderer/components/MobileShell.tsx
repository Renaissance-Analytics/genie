import { Icon, Input } from '@particle-academy/react-fancy';
import type { FormEvent } from 'react';
import type { AgentRow } from '../../core/dashboard-view.js';
import { statusOf, summaryChips } from '../../core/dashboard-view.js';
import type { DeckItem } from '../../core/deck.js';
import { ledgerRow } from '../../core/stream-view.js';
import type { AgentDetail } from '../bridge.js';
import { ApprovalCard } from './ApprovalCard.js';

/**
 * THE PHONE'S SHELL — the minimum to respond to agents, keep them going and set up new work (the owner,
 * 2026-10-11: "mobile does not need panel support and no terminals at all … dashboards and agent chats
 * and activity"). One column, thumb-sized:
 *
 *  - the loud `● REMOTE — <host>` badge, the same words the desktop wears when it drives another machine;
 *  - NEEDS YOU: everything waiting on you, answerable in place with the Deck's own approval card (a form
 *    question names the desktop; a forwarded one names its host);
 *  - AGENTS: every agent with its status word and detail, the summary chips above; tap one to open it;
 *  - one agent at a time (`MobileAgent`): its activity ledger — the same rows the desktop Stream draws,
 *    one line each — and a composer to keep it going, or Start when it is not running;
 *  - SEND A FILE to an agent's inbox.
 *
 * There is no terminal and no panel here, not hidden: absent. `null` is "not heard yet" (a skeleton);
 * `[]` is a sentence. Before the welcome there is `MobilePair`.
 */

export interface MobileAgentsSection {
    /** `null` until the first snapshot. */
    rows: readonly AgentRow[] | null;
    onOpen: (agentId: string) => void;
}

export interface MobileUploadSection {
    agents: readonly { id: string; name: string; provider: string; workspaceId: string }[];
    sending: boolean;
    outcome: string | null;
    onSend: (input: { to: string; text: string; file: File }) => void;
}

export interface MobileShellProps {
    host: string;
    locked: boolean;
    /** The host's last refusal of something this screen did (a write without the baton, a locked host). */
    refusal: string | null;
    /** `null` until the first snapshot arrived. */
    items: readonly DeckItem[] | null;
    answering: string | null;
    onAnswer: (item: DeckItem, optionId: string) => void;
    onDisconnect: () => void;
    /** The agents (dashboard); absent when the app does not offer it. */
    agents?: MobileAgentsSection | undefined;
    /** Upload to an agent's inbox; absent when the app does not offer it. */
    upload?: MobileUploadSection | undefined;
}

const TONE: Record<'ok' | 'warn' | 'bad' | 'muted', string> = {
    ok: 'text-[var(--success)]',
    warn: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    muted: 'text-[var(--fg-4)]',
};

export function MobileShell({ host, locked, refusal, items, answering, onAnswer, onDisconnect, agents, upload }: MobileShellProps) {
    return (
        <div data-mobile="shell" className="flex min-h-dvh flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header className="flex items-center gap-3 border-b border-[var(--border-1)] px-4 py-3">
                <span className="size-5 rounded-[5px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />
                <span data-remote-badge className="rounded-md bg-[var(--warning)]/15 px-2 py-0.5 font-mono text-xs font-semibold tracking-wide text-[var(--warning)]">● REMOTE — {host}</span>
                <span className="flex-1" />
                <button type="button" data-action="disconnect" onClick={onDisconnect} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-xs">Disconnect</button>
            </header>

            {locked ? (
                <p data-locked className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--warning)]">{host} is locked: every change from here is refused until it is unlocked there. Reading still works.</p>
            ) : null}
            {refusal ? (
                <p data-refusal className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--danger)]">{refusal}</p>
            ) : null}

            <main className="flex flex-1 flex-col gap-3 px-4 py-3">
                <h1 className="text-sm font-semibold">Needs you</h1>
                {items === null ? (
                    <div data-mobile-items="loading" className="flex flex-col gap-2" aria-busy>
                        <div className="h-16 animate-pulse rounded-xl bg-[var(--bg-2)]" />
                        <div className="h-16 animate-pulse rounded-xl bg-[var(--bg-2)]" />
                    </div>
                ) : items.length === 0 ? (
                    <p data-mobile-items="clear" className="py-4 text-center text-[13px] text-[var(--fg-3)]">Nothing needs you.</p>
                ) : (
                    <ul data-mobile-items={items.length} className="flex flex-col gap-3">
                        {items.map((item) => (
                            <li key={item.id} data-mobile-item={item.id} className="rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-3">
                                <div className="flex items-center gap-2 text-xs text-[var(--fg-3)]">
                                    {item.blocking ? <span className="size-2 rounded-full bg-[var(--warning)]" aria-label="blocking" /> : null}
                                    <span className="font-medium text-[var(--fg-1)]">{item.agentName ?? item.workspaceId}</span>
                                    <span className="font-mono">{item.workspaceId}</span>
                                </div>
                                {item.answer.kind === 'inline' ? (
                                    <ApprovalCard approval={{ question: item.title, options: item.answer.options }} answering={answering} onAnswer={(optionId) => onAnswer(item, optionId)} />
                                ) : (
                                    <p className="mt-1 text-[13px]">{item.title}</p>
                                )}
                                {item.answer.kind === 'form' ? (
                                    <p data-mobile-elsewhere={host} className="mt-2 flex items-center gap-1.5 text-xs text-[var(--fg-3)]">
                                        <Icon name="list-checks" size="xs" />
                                        {item.answer.fields} questions — answer them on {host}’s screen.
                                    </p>
                                ) : null}
                                {item.answer.kind === 'elsewhere' ? (
                                    <p data-deck-elsewhere={item.answer.host} className="mt-2 text-xs text-[var(--fg-3)]">
                                        Raised on <span className="font-mono text-[var(--fg-2)]">{item.answer.host}</span>, and it has to be answered there.
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
                {agents ? <AgentsSection {...agents} /> : null}
                {upload ? <UploadSection {...upload} /> : null}
            </main>
        </div>
    );
}

/** THE AGENTS, as the Dashboard sees them (§4.1's words: Working / Idle / Waiting on you / Broken / Unreachable), one row each; tap to open. */
function AgentsSection({ rows, onOpen }: MobileAgentsSection) {
    return (
        <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">Agents</h2>
            {rows === null ? (
                <div data-mobile-agents="loading" className="flex flex-col gap-2" aria-busy>
                    <div className="h-12 animate-pulse rounded-xl bg-[var(--bg-2)]" />
                    <div className="h-12 animate-pulse rounded-xl bg-[var(--bg-2)]" />
                </div>
            ) : rows.length === 0 ? (
                <p data-mobile-agents="none" className="py-2 text-[13px] text-[var(--fg-3)]">No agents yet. Add one on {'the desktop'}; it shows here the moment it exists.</p>
            ) : (
                <>
                    <div data-mobile-chips className="flex flex-wrap gap-2 text-xs text-[var(--fg-3)]">
                        {summaryChips(rows).map((c) => <span key={c.state} data-chip={c.state} className="rounded-md bg-[var(--bg-2)] px-2 py-0.5">{c.label}</span>)}
                    </div>
                    <ul data-mobile-agents={rows.length} className="flex flex-col gap-2">
                        {rows.map((r) => {
                            const status = statusOf(r);
                            return (
                                <li key={r.id}>
                                    <button type="button" data-mobile-agent={r.id} data-state={r.state} onClick={() => onOpen(r.id)} className="flex w-full flex-col gap-1 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-3 text-left">
                                        <span className="flex items-center gap-2 text-[13px]">
                                            <span className="font-medium">{r.name}</span>
                                            <span className="font-mono text-[11px] text-[var(--fg-4)]">{r.provider}</span>
                                            <span className="ml-auto font-mono text-[11px] text-[var(--fg-4)]">{r.workspaceId}</span>
                                        </span>
                                        <span className="flex items-baseline gap-2 text-xs">
                                            <span className={`font-medium ${TONE[status.tone]}`}>{status.word}</span>
                                            {status.detail ? <span className="truncate text-[var(--fg-3)]">{status.detail}</span> : null}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
        </section>
    );
}

/**
 * UPLOAD: a recipient from the host's own agents by FULL address (the short form can be ambiguous and
 * the phone has no room for a disambiguation dance), one file, a line of text, one button. The outcome
 * — sent, or the inbox's refusal — is a sentence under the form.
 */
function UploadSection({ agents, sending, outcome, onSend }: MobileUploadSection) {
    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const file = data.get('file');
        if (!(file instanceof File)) return;
        onSend({ to: String(data.get('to') ?? ''), text: String(data.get('text') ?? ''), file });
    };
    return (
        <section data-mobile-upload className="rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-3">
            <h2 className="text-sm font-semibold">Send a file</h2>
            <form onSubmit={submit} className="mt-2 flex flex-col gap-2">
                <select name="to" aria-label="To" className="rounded-md border border-[var(--border-1)] bg-[var(--bg-0)] px-2 py-1.5 text-sm">
                    {agents.map((a) => <option key={a.id} value={`${a.workspaceId}:${a.provider}:${a.name}`}>{a.name} · {a.workspaceId}</option>)}
                </select>
                <input type="file" name="file" aria-label="File" className="text-sm" />
                <Input name="text" placeholder="a line to go with it" aria-label="Message" />
                <button type="submit" data-action="send-file" disabled={sending} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">{sending ? 'Sending…' : 'Send'}</button>
            </form>
            {outcome ? <p data-upload-outcome className="mt-2 text-xs text-[var(--fg-3)]">{outcome}</p> : null}
        </section>
    );
}

export interface MobileAgentProps {
    /** `null` while the host has not answered. */
    detail: AgentDetail | null;
    sending: boolean;
    onBack: () => void;
    onSend: (text: string) => void;
    onStart: () => void;
}

/**
 * ONE AGENT on the phone: its activity as a ledger — the same rows the desktop Stream draws, one line each,
 * oldest first — and a composer to keep it going. Not running: Start instead of the composer, and the
 * refusal (if a start was refused) in words. The back control returns to the shell.
 */
export function MobileAgent({ detail, sending, onBack, onSend, onStart }: MobileAgentProps) {
    if (!detail) {
        return (
            <div data-mobile-agent-view="loading" className="flex min-h-dvh flex-col bg-[var(--bg-0)] p-4" aria-busy>
                <button type="button" data-action="back" onClick={onBack} className="self-start text-xs text-[var(--fg-3)]">← back</button>
                <div className="mt-4 h-6 w-40 animate-pulse rounded-md bg-[var(--bg-2)]" />
            </div>
        );
    }
    const running = detail.session !== null;
    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const text = String(new FormData(e.currentTarget).get('text') ?? '').trim();
        if (text.length > 0) onSend(text);
        e.currentTarget.reset();
    };
    return (
        <div data-mobile-agent-view={detail.agent.id} className="flex min-h-dvh flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header className="flex items-center gap-3 border-b border-[var(--border-1)] px-4 py-3">
                <button type="button" data-action="back" onClick={onBack} className="text-xs text-[var(--fg-3)]">← back</button>
                <span className="text-sm font-semibold">{detail.agent.name}</span>
                <span className="font-mono text-[11px] text-[var(--fg-4)]">{detail.agent.provider}</span>
                <span data-running={running ? 'true' : 'false'} className={`ml-auto font-mono text-[11px] ${running ? 'text-[var(--success)]' : 'text-[var(--fg-4)]'}`}>{running ? 'running' : 'not running'}</span>
            </header>
            {detail.refusal ? <p data-refusal className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--danger)]">{detail.refusal}</p> : null}
            <main data-mobile-activity className="flex flex-1 flex-col gap-1 overflow-auto px-4 py-3">
                {detail.rows.length === 0 ? (
                    <p className="py-4 text-center text-[13px] text-[var(--fg-3)]">Nothing yet.</p>
                ) : (
                    detail.rows.map((r) => {
                        const row = ledgerRow(r);
                        return (
                            <div key={row.id} data-mobile-row={row.id} className="flex items-start gap-2 text-[13px]">
                                <Icon name={row.icon} size="xs" className="mt-0.5 shrink-0 text-[var(--fg-4)]" />
                                <span className={`min-w-0 flex-1 ${row.mono ? 'font-mono text-xs' : ''} ${row.italic ? 'italic text-[var(--fg-3)]' : ''} ${row.clamp ? 'truncate' : 'break-words'}`}>{row.main}</span>
                                {row.meta ? <span className={`shrink-0 font-mono text-[11px] ${row.metaTone === 'bad' ? 'text-[var(--danger)]' : 'text-[var(--fg-4)]'}`}>{row.meta}</span> : null}
                            </div>
                        );
                    })
                )}
            </main>
            <footer className="border-t border-[var(--border-1)] p-3">
                {running ? (
                    <form data-mobile-composer onSubmit={submit} className="flex flex-col gap-2">
                        <textarea name="text" rows={3} aria-label={`Message ${detail.agent.name}`} placeholder={`Tell ${detail.agent.name} what to do next`} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1.5 text-sm" />
                        <button type="submit" data-action="send-prompt" disabled={sending} className="self-end rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">{sending ? 'Sending…' : 'Send'}</button>
                    </form>
                ) : (
                    <button type="button" data-action="start-agent" onClick={onStart} className="w-full rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium text-white">Start {detail.agent.name}</button>
                )}
            </footer>
        </div>
    );
}

export interface MobilePairProps {
    /** The page's own origin — where the socket is. Shown, never typed. */
    host: string;
    refusal: string | null;
    connecting: boolean;
    onConnect: (input: { pin: string; label: string }) => void;
}

export function MobilePair({ host, refusal, connecting, onConnect }: MobilePairProps) {
    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        onConnect({ pin: String(data.get('pin') ?? ''), label: String(data.get('label') ?? '') });
    };
    return (
        <div data-mobile="pair" className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[var(--bg-0)] px-6 text-[var(--fg-1)]">
            <span className="size-10 rounded-[10px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />
            <h1 className="text-base font-semibold">Pair with <span className="font-mono">{host}</span></h1>
            <p className="text-center text-[13px] text-[var(--fg-3)]">Type the PIN that machine shows under Settings → Workstation → Remote access. It is good for two minutes.</p>
            <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
                <Input name="pin" inputMode="numeric" autoComplete="one-time-code" placeholder="482913" aria-label="PIN" className="text-center font-mono text-lg tracking-[0.3em]" />
                <Input name="label" defaultValue="phone" aria-label="This device’s name" />
                {refusal ? <p data-refusal className="text-xs text-[var(--danger)]">{refusal}</p> : null}
                <button type="submit" disabled={connecting} className="rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-60">{connecting ? 'Connecting…' : 'Connect'}</button>
            </form>
        </div>
    );
}
