import { Icon, Input } from '@particle-academy/react-fancy';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { AgentRow } from '../../core/dashboard-view.js';
import { statusOf, summaryChips } from '../../core/dashboard-view.js';
import type { TreeNode } from '../../core/files-panel.js';
import { limitTitle, limitWords } from '../../core/limit-words.js';
import { workspaceLabel } from '../../core/workspace-label.js';
import type { DeckItem } from '../../core/deck.js';
import { ledgerRow } from '../../core/stream-view.js';
import type { AgentDetail } from '../bridge.js';
import { deviceLabelFromUserAgent } from '../../core/mobile.js';
import { timeLeftWords } from '../../core/pair-confirm.js';
import { useNow } from '../use-now.js';
import { ApprovalCard } from './ApprovalCard.js';
import { ChatProse } from './ChatProse.js';
import { ProviderLogo } from './ProviderLogo.js';

/**
 * THE PHONE'S SHELL — the owner, 2026-10-30: "The mobile ui only need the workspace selector, workstation dashboard, agent
 * chat (with chat stream) and a mobile friendly file browser and viewer with upload support. I need to be able to take
 * photos and attach as file to the chat as well." And 2026-10-11: no terminals, no panels. One column, thumb-sized:
 *
 *  - `MobileWorkspaces`: All, then each workspace by name — how many agents, how many wait on you, asleep said;
 *  - `MobileShell` (the dashboard): the loud `● REMOTE — <host>` badge, NEEDS YOU answerable in place, the AGENTS with their
 *    state word; narrowed to the picked workspace, which also offers its Files;
 *  - `MobileAgent` (the chat): its stream — the agent's words drawn as the chat draws them, everything else one line — what
 *    it waits on you for, and a composer that takes a photo with the camera, picks from the gallery, or attaches a file;
 *  - `MobileFiles` / `MobileFileView`: a folder for the thumb, Upload and Take photo into it; markdown rendered, code as
 *    text, an image as an image, a PDF to open.
 *
 * `null` is "not heard yet" (a skeleton); `[]` is a sentence. Before the welcome there is `MobilePair`; a dropped socket is
 * a Reconnecting bar over the last screen, never the pairing form.
 */

type Workspace = { id: string; path: string; name?: string | undefined; asleep?: boolean | undefined };

export interface MobileAgentsSection {
    /** `null` until the first snapshot. */
    rows: readonly AgentRow[] | null;
    onOpen: (agentId: string) => void;
}

export interface MobileShellProps {
    host: string;
    locked: boolean;
    /** The host's last refusal of something this screen did (a write without the baton, a locked host). */
    refusal: string | null;
    /** `null` until the first snapshot arrived. */
    items: readonly DeckItem[] | null;
    answering: string | null;
    onAnswer: (item: DeckItem, optionId: string, note?: string) => void;
    onDisconnect: () => void;
    /** The agents (dashboard); absent when the app does not offer it. */
    agents?: MobileAgentsSection | undefined;
    /** The host's workspaces, so a workspace is drawn by its name, not its id; absent or `null` = ids as given. */
    workspaces?: readonly Workspace[] | null | undefined;
    /** The workspace the dashboard is narrowed to; `null` = all. Absent = no selector. */
    selectedWorkspace?: string | null | undefined;
    onSelectWorkspace?: ((workspaceId: string | null) => void) | undefined;
    /** A picked workspace's Files. */
    onOpenFiles?: ((workspaceId: string) => void) | undefined;
    /** The socket dropped and the phone is dialing again: said over this screen. */
    reconnecting?: boolean | undefined;
}

const TONE: Record<'ok' | 'warn' | 'bad' | 'muted', string> = {
    ok: 'text-[var(--success)]',
    warn: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    muted: 'text-[var(--fg-4)]',
};

const BUTTON = 'rounded-lg border border-[var(--border-1)] px-3 py-2 text-sm font-medium active:bg-[var(--bg-2)]';
const PRIMARY = 'rounded-lg bg-[var(--primary)] px-4 py-2.5 text-sm font-medium text-white active:opacity-80 disabled:opacity-60';

/** The bar a dropped connection shows while the phone dials again. */
function Reconnecting() {
    return (
        <p data-mobile-reconnecting role="status" className="flex items-center gap-2 border-b border-[var(--border-1)] bg-[var(--warning)]/10 px-4 py-2 text-xs text-[var(--warning)]">
            <Icon name="loader" size="xs" className="animate-spin" />
            Reconnecting…
        </p>
    );
}

export function MobileShell({ host, locked, refusal, items, answering, onAnswer, onDisconnect, agents, workspaces, selectedWorkspace = null, onSelectWorkspace, onOpenFiles, reconnecting = false }: MobileShellProps) {
    const wsLabel = (id: string | null): string | null => (id === null ? null : workspaceLabel(workspaces, id));
    const shownItems = items === null || selectedWorkspace === null ? items : items.filter((i) => i.workspaceId === selectedWorkspace);
    const shownRows = agents?.rows == null || selectedWorkspace === null ? agents?.rows ?? null : agents.rows.filter((r) => r.workspaceId === selectedWorkspace);
    return (
        <div data-mobile="shell" className="flex min-h-dvh flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-[var(--border-1)] bg-[var(--bg-0)] px-4 py-3">
                <span className="size-5 rounded-[5px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />
                <span data-remote-badge className="truncate rounded-md bg-[var(--warning)]/15 px-2 py-0.5 font-mono text-xs font-semibold tracking-wide text-[var(--warning)]">● REMOTE — {host}</span>
                <span className="flex-1" />
                <button type="button" data-action="disconnect" onClick={onDisconnect} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-xs">Disconnect</button>
            </header>

            {reconnecting ? <Reconnecting /> : null}
            {locked ? (
                <p data-locked className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--warning)]">{host} is locked: every change from here is refused until it is unlocked there. Reading still works.</p>
            ) : null}
            {refusal ? (
                <p data-refusal className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--danger)]">{refusal}</p>
            ) : null}

            {onSelectWorkspace && workspaces ? (
                <MobileWorkspaces workspaces={workspaces} agents={agents?.rows ?? []} items={items ?? []} selected={selectedWorkspace} onSelect={onSelectWorkspace} />
            ) : null}

            <main className="flex flex-1 flex-col gap-3 px-4 py-3">
                {selectedWorkspace !== null && onOpenFiles ? (
                    <button type="button" data-action="open-files" onClick={() => onOpenFiles(selectedWorkspace)} className={`${BUTTON} flex items-center gap-2 self-start`}>
                        <Icon name="folder-open" size="sm" />
                        Files in {wsLabel(selectedWorkspace)}
                    </button>
                ) : null}
                <h1 className="text-sm font-semibold">Needs you</h1>
                {shownItems === null ? (
                    <div data-mobile-items="loading" className="flex flex-col gap-2" aria-busy>
                        <div className="h-16 animate-pulse rounded-xl bg-[var(--bg-2)]" />
                        <div className="h-16 animate-pulse rounded-xl bg-[var(--bg-2)]" />
                    </div>
                ) : shownItems.length === 0 ? (
                    <p data-mobile-items="clear" className="py-4 text-center text-[13px] text-[var(--fg-3)]">Nothing needs you.</p>
                ) : (
                    <ul data-mobile-items={shownItems.length} className="flex flex-col gap-3">
                        {shownItems.map((item) => (
                            <li key={item.id} data-mobile-item={item.id} className="rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-3">
                                <NeedsYou item={item} host={host} answering={answering} onAnswer={onAnswer} label={item.agentName ?? wsLabel(item.workspaceId)} workspace={wsLabel(item.workspaceId)} />
                            </li>
                        ))}
                    </ul>
                )}
                {agents ? <AgentsSection rows={shownRows} onOpen={agents.onOpen} workspaces={workspaces} /> : null}
            </main>
        </div>
    );
}

/** One thing waiting on you: an inline question as the Deck's own card; a form or a forwarded one names where to answer. */
function NeedsYou({ item, host, answering, onAnswer, label, workspace }: { item: DeckItem; host: string; answering: string | null; onAnswer: (item: DeckItem, optionId: string, note?: string) => void; label: string | null; workspace: string | null }) {
    return (
        <>
            <div className="flex items-center gap-2 text-xs text-[var(--fg-3)]">
                {item.blocking ? <span className="size-2 rounded-full bg-[var(--warning)]" aria-label="blocking" /> : null}
                <span className="font-medium text-[var(--fg-1)]">{label}</span>
                <span className="font-mono">{workspace}</span>
            </div>
            {item.answer.kind === 'inline' ? (
                <ApprovalCard approval={{ question: item.title, options: item.answer.options }} answering={answering} onAnswer={(optionId, note) => onAnswer(item, optionId, note)} />
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
        </>
    );
}

export interface MobileWorkspacesProps {
    workspaces: readonly Workspace[];
    agents: readonly AgentRow[];
    items: readonly DeckItem[];
    selected: string | null;
    onSelect: (workspaceId: string | null) => void;
}

/** THE WORKSPACE SELECTOR: a row of chips to thumb through — All, then each workspace with its agents and what waits. */
export function MobileWorkspaces({ workspaces, agents, items, selected, onSelect }: MobileWorkspacesProps) {
    const chip = (on: boolean) => `flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${on ? 'border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--fg-1)]' : 'border-[var(--border-1)] text-[var(--fg-2)]'}`;
    return (
        <nav data-mobile-workspaces aria-label="Workspaces" className="flex gap-2 overflow-x-auto border-b border-[var(--border-1)] px-4 py-2">
            <button type="button" data-mobile-ws="all" data-selected={selected === null ? 'true' : 'false'} onClick={() => onSelect(null)} className={chip(selected === null)}>All</button>
            {workspaces.map((w) => {
                const count = agents.filter((a) => a.workspaceId === w.id).length;
                const waiting = items.filter((i) => i.workspaceId === w.id).length;
                return (
                    <button key={w.id} type="button" data-mobile-ws={w.id} data-selected={selected === w.id ? 'true' : 'false'} onClick={() => onSelect(w.id)} className={chip(selected === w.id)}>
                        <span>{w.name ?? workspaceLabel(workspaces, w.id)}</span>
                        <span className="font-mono text-[11px] text-[var(--fg-4)]">{count}</span>
                        {waiting > 0 ? <span data-mobile-ws-waiting={w.id} className="rounded-full bg-[var(--warning)] px-1.5 text-[11px] font-semibold text-black">{waiting}</span> : null}
                        {w.asleep ? <span data-mobile-ws-asleep={w.id} className="text-[11px] text-[var(--fg-4)]">asleep</span> : null}
                    </button>
                );
            })}
        </nav>
    );
}

/** THE AGENTS, as the Dashboard sees them (§4.1's words: Working / Idle / Waiting on you / Broken / Unreachable), one row each; tap to open. */
function AgentsSection({ rows, onOpen, workspaces }: { rows: readonly AgentRow[] | null; onOpen: (agentId: string) => void; workspaces?: readonly Workspace[] | null | undefined }) {
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
                                    <button type="button" data-mobile-agent={r.id} data-state={r.state} onClick={() => onOpen(r.id)} className="flex w-full flex-col gap-1 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-3 text-left active:bg-[var(--bg-2)]">
                                        <span className="flex items-center gap-2 text-[13px]">
                                            <span className="font-medium">{r.name}</span>
                                            <ProviderLogo provider={r.provider} />
                                            <span className="ml-auto font-mono text-[11px] text-[var(--fg-4)]">{workspaceLabel(workspaces, r.workspaceId)}</span>
                                        </span>
                                        <span className="flex items-baseline gap-2 text-xs">
                                            <span className={`font-medium ${TONE[status.tone]}`}>{status.word}</span>
                                            {status.detail ? <span className="truncate text-[var(--fg-3)]" {...(status.title ? { title: status.title } : {})}>{status.detail}</span> : null}
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

export interface MobileAgentProps {
    /** `null` while the host has not answered. */
    detail: AgentDetail | null;
    sending: boolean;
    onBack: () => void;
    /** The message, and the photos/files attached to it (the chat's own attach path on the host). */
    onSend: (text: string, files: File[]) => void;
    onStart: () => void;
    /** Resume now (Tynn #794): open this agent's provider login at once, while its rate limit holds it. */
    onResumeLimit: () => void;
    /** What this agent waits on you for — answerable here. */
    needs?: readonly DeckItem[] | undefined;
    answering?: string | null | undefined;
    onAnswer?: ((item: DeckItem, optionId: string, note?: string) => void) | undefined;
    /** Why the last send did not land, in words (the message and its files are kept to send again). */
    sendRefusal?: string | null | undefined;
    reconnecting?: boolean | undefined;
}

/** A picked photo or file before it is sent: a chip, removable. */
export function PendingAttachments({ files, onRemove }: { files: readonly { name: string; size: number }[]; onRemove: (index: number) => void }) {
    if (files.length === 0) return null;
    return (
        <ul data-pending-attachments className="flex flex-wrap gap-2">
            {files.map((f, i) => (
                <li key={`${f.name}-${i}`} data-pending-attachment={f.name} className="flex items-center gap-1.5 rounded-full bg-[var(--bg-2)] py-1 pl-3 pr-1 text-xs">
                    <Icon name="paperclip" size="xs" />
                    <span className="max-w-[10rem] truncate">{f.name}</span>
                    <span className="font-mono text-[10px] text-[var(--fg-4)]">{f.size >= 1024 * 1024 ? `${(f.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`}</span>
                    <button type="button" data-action="remove-attachment" aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)} className="rounded-full p-1 active:bg-[var(--bg-3)]">
                        <Icon name="x" size="xs" />
                    </button>
                </li>
            ))}
        </ul>
    );
}

/**
 * ONE AGENT on the phone: its chat stream — the agent's words drawn as the chat draws them, everything else one line,
 * oldest first — what it waits on you for, and a composer: text, a photo from the CAMERA, from the GALLERY, or any file.
 * Not running: Start instead of the composer, and the refusal (if a start was refused) in words.
 */
export function MobileAgent({ detail, sending, onBack, onSend, onStart, onResumeLimit, needs = [], answering = null, onAnswer, sendRefusal = null, reconnecting = false }: MobileAgentProps) {
    const [pending, setPending] = useState<File[]>([]);
    if (!detail) {
        return (
            <div data-mobile-agent-view="loading" className="flex min-h-dvh flex-col bg-[var(--bg-0)] p-4" aria-busy>
                <button type="button" data-action="back" onClick={onBack} className="self-start text-xs text-[var(--fg-3)]">← back</button>
                <div className="mt-4 h-6 w-40 animate-pulse rounded-md bg-[var(--bg-2)]" />
            </div>
        );
    }
    const running = detail.session !== null;
    // Held by its provider's limit (Tynn #794): the same words as every surface, and Resume now.
    const held = limitWords(detail.session?.limit);
    const pick = (e: ChangeEvent<HTMLInputElement>) => {
        const files = e.currentTarget.files ? [...e.currentTarget.files] : [];
        if (files.length > 0) setPending((p) => [...p, ...files]);
        e.currentTarget.value = '';
    };
    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const text = String(new FormData(e.currentTarget).get('text') ?? '').trim();
        if (text.length === 0 && pending.length === 0) return;
        onSend(text, pending);
        setPending([]);
        e.currentTarget.reset();
    };
    const attach = 'flex size-10 cursor-pointer items-center justify-center rounded-full border border-[var(--border-1)] active:bg-[var(--bg-2)]';
    return (
        <div data-mobile-agent-view={detail.agent.id} className="flex h-dvh flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header className="flex items-center gap-3 border-b border-[var(--border-1)] px-4 py-3">
                <button type="button" data-action="back" onClick={onBack} className="py-1 pr-2 text-sm text-[var(--fg-3)]">← back</button>
                <span className="text-sm font-semibold">{detail.agent.name}</span>
                <ProviderLogo provider={detail.agent.provider} />
                <span data-running={running ? 'true' : 'false'} className={`ml-auto font-mono text-[11px] ${running ? 'text-[var(--success)]' : 'text-[var(--fg-4)]'}`}>{running ? 'running' : 'not running'}</span>
            </header>
            {reconnecting ? <Reconnecting /> : null}
            {detail.refusal ? <p data-refusal className="border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--danger)]">{detail.refusal}</p> : null}
            {held ? (
                <div data-mobile-limit className="flex items-center gap-3 border-b border-[var(--border-1)] px-4 py-2 text-xs">
                    <span className="text-[var(--warning)]" {...(limitTitle(detail.session?.limit) ? { title: limitTitle(detail.session?.limit)! } : {})}>Paused · {held}</span>
                    <button type="button" data-action="resume-limit" onClick={onResumeLimit} className="ml-auto rounded-lg border border-[var(--border-1)] px-2.5 py-1 font-medium">Resume now</button>
                </div>
            ) : null}
            <main data-mobile-activity className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
                {detail.rows.length === 0 ? (
                    <p className="py-4 text-center text-[13px] text-[var(--fg-3)]">Nothing yet.</p>
                ) : (
                    detail.rows.map((r) => {
                        const row = ledgerRow(r, { agentName: detail.agent.name });
                        if (row.prose) {
                            return (
                                <div key={row.id} data-mobile-row={row.id} data-prose className="rounded-xl bg-[var(--bg-1)] px-3 py-2 text-[14px]">
                                    <ChatProse text={row.main} />
                                </div>
                            );
                        }
                        const mine = row.who?.tone === 'you';
                        return (
                            <div key={row.id} data-mobile-row={row.id} className={`flex items-start gap-2 text-[13px] ${mine ? 'self-end rounded-xl bg-[var(--primary)]/15 px-3 py-2' : ''}`}>
                                {mine ? null : <Icon name={row.icon} size="xs" className="mt-0.5 shrink-0 text-[var(--fg-4)]" />}
                                <span className={`min-w-0 flex-1 ${row.mono ? 'font-mono text-xs' : ''} ${row.italic ? 'italic text-[var(--fg-3)]' : ''} ${row.clamp ? 'truncate' : 'whitespace-pre-wrap break-words'}`}>{row.main}</span>
                                {row.meta ? <span className={`shrink-0 font-mono text-[11px] ${row.metaTone === 'bad' ? 'text-[var(--danger)]' : 'text-[var(--fg-4)]'}`}>{row.meta}</span> : null}
                            </div>
                        );
                    })
                )}
            </main>
            {needs.length > 0 ? (
                <section data-mobile-waiting className="flex flex-col gap-2 border-t border-[var(--warning)]/40 bg-[var(--warning)]/5 px-4 py-3">
                    <h2 className="text-xs font-semibold text-[var(--warning)]">Waiting on you</h2>
                    {needs.map((item) => (
                        <div key={item.id} data-mobile-item={item.id}>
                            <NeedsYou item={item} host={detail.agent.name} answering={answering} onAnswer={(i, o, n) => onAnswer?.(i, o, n)} label={null} workspace={null} />
                        </div>
                    ))}
                </section>
            ) : null}
            <footer className="border-t border-[var(--border-1)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                {running ? (
                    <form data-mobile-composer onSubmit={submit} className="flex flex-col gap-2">
                        {sendRefusal ? <p data-send-refusal className="text-xs text-[var(--danger)]">{sendRefusal}</p> : null}
                        <PendingAttachments files={pending} onRemove={(i) => setPending((p) => p.filter((_, j) => j !== i))} />
                        <textarea name="text" rows={2} aria-label={`Message ${detail.agent.name}`} placeholder={`Tell ${detail.agent.name} what to do next`} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-2 text-[16px]" />
                        <div className="flex items-center gap-2">
                            <label className={attach} aria-label="Take a photo">
                                <Icon name="camera" size="sm" />
                                <input type="file" accept="image/*" capture="environment" data-attach="camera" className="hidden" onChange={pick} />
                            </label>
                            <label className={attach} aria-label="Choose photos">
                                <Icon name="image" size="sm" />
                                <input type="file" accept="image/*" multiple data-attach="gallery" className="hidden" onChange={pick} />
                            </label>
                            <label className={attach} aria-label="Attach a file">
                                <Icon name="paperclip" size="sm" />
                                <input type="file" multiple data-attach="file" className="hidden" onChange={pick} />
                            </label>
                            <span className="flex-1" />
                            <button type="submit" data-action="send-prompt" disabled={sending} className={PRIMARY}>{sending ? 'Sending…' : 'Send'}</button>
                        </div>
                    </form>
                ) : (
                    <button type="button" data-action="start-agent" onClick={onStart} className={`w-full ${PRIMARY}`}>Start {detail.agent.name}</button>
                )}
            </footer>
        </div>
    );
}

export interface MobileFilesProps {
    workspaceName: string;
    /** The folder shown, workspace-relative; `''` = the root. */
    path: string;
    /** `null` until read. */
    entries: readonly TreeNode[] | null;
    onOpen: (entry: TreeNode) => void;
    onUp: () => void;
    onBack: () => void;
    onUpload: (files: File[]) => void;
    /** What is being sent right now, in words (`Sending photo.jpg — 40%`); `false` = nothing. */
    uploading: string | false;
    /** The last upload's outcome in words. */
    outcome: string | null;
    error?: string | null | undefined;
}

/** A WORKSPACE'S FILES for the thumb: Up, folders first, tap to open; Upload and Take photo land in this folder. */
export function MobileFiles({ workspaceName, path, entries, onOpen, onUp, onBack, onUpload, uploading, outcome, error = null }: MobileFilesProps) {
    const pick = (e: ChangeEvent<HTMLInputElement>) => {
        const files = e.currentTarget.files ? [...e.currentTarget.files] : [];
        if (files.length > 0) onUpload(files);
        e.currentTarget.value = '';
    };
    return (
        <div data-mobile-files={path} className="flex min-h-dvh flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-0)] px-4 py-3">
                <button type="button" data-action="back" onClick={onBack} className="py-1 pr-2 text-sm text-[var(--fg-3)]">← back</button>
                <span className="truncate text-sm font-semibold">{workspaceName}</span>
                <span className="truncate font-mono text-xs text-[var(--fg-3)]">/{path}</span>
            </header>
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-1)] px-4 py-2">
                {path !== '' ? (
                    <button type="button" data-action="up" onClick={onUp} className={`${BUTTON} flex items-center gap-1.5`}><Icon name="corner-left-up" size="xs" />Up</button>
                ) : null}
                <span className="flex-1" />
                <label className={`${BUTTON} flex cursor-pointer items-center gap-1.5`}>
                    <Icon name="upload" size="xs" />Upload
                    <input type="file" multiple data-action="upload" className="hidden" onChange={pick} disabled={uploading !== false} />
                </label>
                <label className={`${BUTTON} flex cursor-pointer items-center gap-1.5`}>
                    <Icon name="camera" size="xs" />Take photo
                    <input type="file" accept="image/*" capture="environment" data-action="upload-photo" className="hidden" onChange={pick} disabled={uploading !== false} />
                </label>
            </div>
            {uploading !== false ? <p data-uploading role="status" className="px-4 py-2 text-xs text-[var(--fg-2)]">{uploading}</p> : null}
            {outcome ? <p data-upload-outcome className="px-4 py-2 text-xs text-[var(--fg-3)]">{outcome}</p> : null}
            {error ? <p data-refusal className="px-4 py-2 text-xs text-[var(--danger)]">{error}</p> : null}
            <main className="flex flex-1 flex-col">
                {entries === null ? (
                    <div data-mobile-files-loading className="flex flex-col gap-2 p-4" aria-busy>
                        <div className="h-11 animate-pulse rounded-lg bg-[var(--bg-2)]" />
                        <div className="h-11 animate-pulse rounded-lg bg-[var(--bg-2)]" />
                    </div>
                ) : entries.length === 0 ? (
                    <p data-mobile-files-empty className="py-6 text-center text-[13px] text-[var(--fg-3)]">This folder is empty.</p>
                ) : (
                    <ul className="flex flex-col">
                        {entries.map((e) => (
                            <li key={e.id}>
                                <button type="button" data-file-entry={e.id} data-kind={e.type} onClick={() => onOpen(e)} className="flex min-h-12 w-full items-center gap-3 border-b border-[var(--border-1)] px-4 py-2 text-left text-[14px] active:bg-[var(--bg-2)]">
                                    <Icon name={e.type === 'folder' ? 'folder' : 'file'} size="sm" className={e.type === 'folder' ? 'text-[var(--warning)]' : 'text-[var(--fg-3)]'} />
                                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                                    {e.type === 'folder' ? <Icon name="chevron-right" size="xs" className="text-[var(--fg-4)]" /> : null}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </main>
        </div>
    );
}

export type MobilePreview =
    | { kind: 'markdown'; text: string }
    | { kind: 'text'; text: string }
    | { kind: 'image'; url: string }
    | { kind: 'pdf'; url: string }
    | { kind: 'other'; url: string | null }
    | { kind: 'error'; reason: string };

/** ONE FILE on the phone: markdown rendered, code as text (wrapping), an image fitted to the screen, a PDF to open. */
export function MobileFileView({ path, preview, onBack }: { path: string; preview: MobilePreview | null; onBack: () => void }) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return (
        <div data-mobile-file-view={path} className="flex min-h-dvh flex-col bg-[var(--bg-0)] text-[var(--fg-1)]">
            <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-0)] px-4 py-3">
                <button type="button" data-action="back" onClick={onBack} className="py-1 pr-2 text-sm text-[var(--fg-3)]">← back</button>
                <span className="truncate text-sm font-semibold">{name}</span>
            </header>
            <main className="flex-1 overflow-auto">
                {preview === null ? (
                    <div data-preview="loading" className="m-4 h-40 animate-pulse rounded-lg bg-[var(--bg-2)]" aria-busy />
                ) : preview.kind === 'markdown' ? (
                    <div data-preview="markdown" className="px-4 py-3 text-[15px]"><ChatProse text={preview.text} /></div>
                ) : preview.kind === 'text' ? (
                    <pre data-preview="text" className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-relaxed">{preview.text}</pre>
                ) : preview.kind === 'image' ? (
                    <img data-preview="image" src={preview.url} alt={name} className="mx-auto max-h-[85dvh] max-w-full object-contain p-2" />
                ) : preview.kind === 'pdf' ? (
                    <div data-preview="pdf" className="flex flex-col items-center gap-3 p-6 text-center text-[13px] text-[var(--fg-3)]">
                        <Icon name="file-text" size="lg" />
                        <a href={preview.url} target="_blank" rel="noreferrer" data-action="open-pdf" className={PRIMARY}>Open {name}</a>
                        <span>It opens in this phone’s own PDF viewer.</span>
                    </div>
                ) : preview.kind === 'other' ? (
                    <div data-preview="other" className="flex flex-col items-center gap-3 p-6 text-center text-[13px] text-[var(--fg-3)]">
                        <span>No preview for this kind of file.</span>
                        {preview.url ? <a href={preview.url} download={name} data-action="download" className={BUTTON}>Download</a> : null}
                    </div>
                ) : (
                    <p data-preview="error" className="p-4 text-[13px] text-[var(--danger)]">{preview.reason}</p>
                )}
            </main>
        </div>
    );
}

/** A remembered phone dialing its host — opened from the home screen, or back from sleep. Never the PIN form. */
export function MobileConnecting({ host }: { host: string }) {
    return (
        <div data-mobile="connecting" role="status" className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-[var(--bg-0)] px-6 text-[var(--fg-1)]">
            <span className="size-10 rounded-[10px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />
            <p className="flex items-center gap-2 text-sm"><Icon name="loader" size="sm" className="animate-spin" />Connecting to <span className="font-mono">{host}</span>…</p>
            <p className="text-center text-xs text-[var(--fg-3)]">It must be on and on your tailnet. This keeps trying on its own.</p>
        </div>
    );
}

export interface MobilePairProps {
    /** The page's own origin — where the socket is. Shown, never typed. */
    host: string;
    refusal: string | null;
    connecting: boolean;
    onConnect: (input: { pin: string; label: string }) => void;
    /** The PIN was right; the host's screen is asking "Pair this device?" until `expiresAt` (q_8c07b142). */
    waiting?: { readonly expiresAt: number } | null | undefined;
    /** The clock, for tests; absent = the real one, ticking while it waits. */
    now?: number | undefined;
}

export function MobilePair({ host, refusal, connecting, onConnect, waiting = null, now: fixedNow }: MobilePairProps) {
    const now = useNow(waiting !== null, fixedNow);
    const ownName = typeof navigator === 'undefined' ? 'phone' : deviceLabelFromUserAgent(navigator.userAgent);
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
                <Input name="label" defaultValue={ownName} aria-label="This device’s name" />
                {waiting ? (
                    // Visible progress, never a spinner that says nothing: what it waits for, where, and how long is left.
                    <p data-mobile-waiting="" role="status" className="text-center text-xs text-[var(--fg-2)]">{`Press Allow on ${host} to finish pairing · ${timeLeftWords(waiting.expiresAt - now)}`}</p>
                ) : null}
                {refusal ? <p data-refusal className="text-xs text-[var(--danger)]">{refusal}</p> : null}
                <button type="submit" disabled={connecting || waiting !== null} className="rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-60">{waiting ? 'Waiting for Allow…' : connecting ? 'Connecting…' : 'Connect'}</button>
            </form>
        </div>
    );
}
