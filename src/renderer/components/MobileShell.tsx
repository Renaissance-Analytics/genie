import { Button, Icon, Input, Tabs } from '@particle-academy/react-fancy';
import { useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { composerKey } from '../../core/send-key.js';
import { sendKeyNow } from '../send-key-store.js';

/** A fine pointer comes with a real keyboard often enough; a touch-only phone has neither. */
const hasHardwareKeyboard = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(any-pointer: fine)').matches;
import type { AgentRow } from '../../core/dashboard-view.js';
import { statusOf, summaryChips } from '../../core/dashboard-view.js';
import type { TreeNode } from '../../core/files-panel.js';
import { limitTitle, limitWords } from '../../core/limit-words.js';
import { workspaceLabel } from '../../core/workspace-label.js';
import type { DeckItem } from '../../core/deck.js';
import { chatAgentsKey, chatFollowKey, chatThreadFrom } from '../../core/chat-view.js';
import type { ChatRefs } from '../../core/chat-markup.js';
import { atThreadEnd } from '../../core/chat-width.js';
import type { ToolOutputReply } from '../../core/tool-row-bound.js';
import type { AgentDetail } from '../bridge.js';
import { MOBILE_PANELS, deviceLabelFromUserAgent, panelAfter, swipeStep, type MobilePanel } from '../../core/mobile.js';
import { timeLeftWords } from '../../core/pair-confirm.js';
import { useNow } from '../use-now.js';
import { ApprovalCard } from './ApprovalCard.js';
import { ChatMessages } from './ChatFlyout.js';
import { ChatProse } from './ChatProse.js';
import { ProviderLogo } from './ProviderLogo.js';
import { QuestionForm } from './QuestionForm.js';
import { Stream } from './Stream.js';

/**
 * THE PHONE'S SHELL — the owner, 2026-10-30: "The mobile ui only need the workspace selector, workstation dashboard, agent
 * chat (with chat stream) and a mobile friendly file browser and viewer with upload support. I need to be able to take
 * photos and attach as file to the chat as well." And 2026-10-11: no terminals, and none of the desktop's docked panels.
 * And 2026-11-12 (Tynn #652): "I should have full chat stream and work streams as slideable panels and ability answer any
 * FTQ." One column, thumb-sized:
 *
 *  - `MobileWorkspaces`: All, then each workspace by name — how many agents, how many wait on you, asleep said;
 *  - `MobileShell` (the dashboard): the loud `● REMOTE — <host>` badge, NEEDS YOU answerable in place (a question form
 *    too), the AGENTS with their state word; narrowed to the picked workspace, which also offers its Files;
 *  - `MobileAgent`: three panels swiped between — the agent list, the desktop chat's rows, the desktop work stream — what
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
    /** A question with options, multi-select or free text, answered on the phone: the desktop's own form and call. */
    onAnswerForm?: ((item: DeckItem, selections: string[][], notes: string[]) => void) | undefined;
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

const TONE: Record<'ok' | 'warn' | 'bad' | 'muted' | 'cool', string> = {
    ok: 'text-[var(--success)]',
    warn: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    muted: 'text-[var(--fg-4)]',
    // Cooling (core/session.ts COOLING_MS): its own colour, not Working's green nor Idle's grey.
    cool: 'text-[var(--sky-400)]',
};

const BUTTON = 'rounded-lg border border-[var(--border-1)] px-3 py-2 text-sm font-medium active:bg-[var(--bg-2)]';
/** A thumb's target (Tynn #652): at least 44 px each way. */
const TOUCH = 'min-h-11 min-w-11';
/** A question form on the phone: its options, notes and Answer at least 44 px tall; the notes at 16 px, so iOS does not zoom. */
const QUESTION_TOUCH = '[&_button]:min-h-11 [&_textarea]:min-h-11 [&_textarea]:text-[16px]';
const PRIMARY = 'rounded-lg bg-[var(--primary)] px-4 py-2.5 text-sm font-medium text-white active:opacity-80 disabled:opacity-60';

/**
 * EVERY PHONE SCREEN SCROLLS INSIDE ITSELF (the owner, 2026-11-01: "it won't scroll at all so I am stuck"). The page is
 * the desktop's, whose DOCUMENT never scrolls (genie#1290: `html { overflow: hidden }`, `body, #root { overflow: clip }`).
 * A screen that grew past the phone (`min-h-dvh`) was clipped with nothing to scroll. So a screen is exactly one dynamic
 * viewport tall (`dvh`: it follows the address bar and, with `interactive-widget=resizes-content`, the keyboard), its bars
 * keep their height, and ONE bounded flex child scrolls: `min-h-0` gives it a height, and `overscroll-contain` keeps a
 * pull at the top from becoming the browser's pull-to-refresh or rubber-banding the page. `touch-action` stays the
 * browser's own (`auto`): an overflow scroller gets native momentum on iOS 13+ and Android, and pinch and sideways pans
 * (a wide table in a markdown file) keep working.
 */
const SCREEN = 'flex h-dvh flex-col overflow-hidden bg-[var(--bg-0)] text-[var(--fg-1)]';
const SCROLL = 'min-h-0 flex-1 overflow-y-auto overscroll-contain';
/** Below the last row: clear of the home indicator. */
const SAFE_BOTTOM = 'pb-[max(0.75rem,env(safe-area-inset-bottom))]';
/** The top bar clears the status bar and notch: the installed app draws under them (black-translucent, viewport-fit=cover). */
const SAFE_TOP = 'pt-[max(0.75rem,env(safe-area-inset-top))]';

/** The bar a dropped connection shows while the phone dials again. */
function Reconnecting() {
    return (
        <p data-mobile-reconnecting role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] bg-[var(--warning)]/10 px-4 py-2 text-xs text-[var(--warning)]">
            <Icon name="loader" size="xs" className="animate-spin" />
            Reconnecting…
        </p>
    );
}

export function MobileShell({ host, locked, refusal, items: reportedItems, answering, onAnswer, onAnswerForm, onDisconnect, agents, workspaces: registeredWorkspaces, selectedWorkspace: requestedWorkspace = null, onSelectWorkspace, onOpenFiles, reconnecting = false }: MobileShellProps) {
    const hibernated = new Set((registeredWorkspaces ?? []).filter((workspace) => workspace.asleep === true).map((workspace) => workspace.id));
    const workspaces = registeredWorkspaces?.filter((workspace) => !hibernated.has(workspace.id)) ?? registeredWorkspaces;
    const selectedWorkspace = requestedWorkspace !== null && hibernated.has(requestedWorkspace) ? null : requestedWorkspace;
    const items = reportedItems?.filter((item) => item.workspaceId === null || !hibernated.has(item.workspaceId)) ?? reportedItems;
    const activeRows = agents?.rows?.filter((row) => !hibernated.has(row.workspaceId)) ?? agents?.rows;
    const wsLabel = (id: string | null): string | null => (id === null ? null : workspaceLabel(workspaces, id));
    const shownItems = items === null || selectedWorkspace === null ? items : items.filter((i) => i.workspaceId === selectedWorkspace);
    const shownRows = activeRows == null || selectedWorkspace === null ? activeRows ?? null : activeRows.filter((row) => row.workspaceId === selectedWorkspace);
    return (
        <div data-mobile="shell" className={SCREEN}>
            <header className={`flex shrink-0 items-center gap-3 border-b border-[var(--border-1)] bg-[var(--bg-0)] px-4 pb-3 ${SAFE_TOP}`}>
                <span className="size-5 rounded-[5px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />
                <span data-remote-badge className="truncate rounded-md bg-[var(--warning)]/15 px-2 py-0.5 font-mono text-xs font-semibold tracking-wide text-[var(--warning)]">● REMOTE — {host}</span>
                <span className="flex-1" />
                <Button size="xs" type="button" data-action="disconnect" onClick={onDisconnect} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-xs">Disconnect</Button>
            </header>

            {reconnecting ? <Reconnecting /> : null}
            {locked ? (
                <p data-locked className="shrink-0 border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--warning)]">{host} is locked: every change from here is refused until it is unlocked there. Reading still works.</p>
            ) : null}
            {refusal ? (
                <p data-refusal className="shrink-0 border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--danger)]">{refusal}</p>
            ) : null}

            {onSelectWorkspace && workspaces ? (
                <MobileWorkspaces workspaces={workspaces} agents={agents?.rows ?? []} items={items ?? []} selected={selectedWorkspace} onSelect={onSelectWorkspace} />
            ) : null}

            <main data-mobile-scroll className={`${SCROLL} flex flex-col gap-3 px-4 pt-3 ${SAFE_BOTTOM}`}>
                {selectedWorkspace !== null && onOpenFiles ? (
                    <Button size="xs" labelClassName="contents" type="button" data-action="open-files" onClick={() => onOpenFiles(selectedWorkspace)} className={`${BUTTON} flex items-center gap-2 self-start`}>
                        <Icon name="folder-open" size="sm" />
                        Files in {wsLabel(selectedWorkspace)}
                    </Button>
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
                                <NeedsYou item={item} host={host} answering={answering} onAnswer={onAnswer} onAnswerForm={onAnswerForm} label={item.agentName ?? wsLabel(item.workspaceId)} workspace={wsLabel(item.workspaceId)} />
                            </li>
                        ))}
                    </ul>
                )}
                {agents ? <MobileAgentList rows={shownRows} onOpen={agents.onOpen} workspaces={workspaces} /> : null}
            </main>
        </div>
    );
}

/** One thing waiting on you: an inline question as the Deck's own card; a form or a forwarded one names where to answer. */
function NeedsYou({ item, host, answering, onAnswer, onAnswerForm, label, workspace }: { item: DeckItem; host: string; answering: string | null; onAnswer: (item: DeckItem, optionId: string, note?: string) => void; onAnswerForm?: ((item: DeckItem, selections: string[][], notes: string[]) => void) | undefined; label: string | null; workspace: string | null }) {
    // A form the phone can draw (it carries its questions) is answered here, with the desktop's own form (Tynn #652).
    const questions = item.answer.kind === 'form' && onAnswerForm ? item.answer.questions ?? null : null;
    return (
        <>
            <div className="flex items-center gap-2 text-xs text-[var(--fg-3)]">
                {item.blocking ? <span className="size-2 rounded-full bg-[var(--warning)]" aria-label="blocking" /> : null}
                <span className="font-medium text-[var(--fg-1)]">{label}</span>
                <span className="font-mono">{workspace}</span>
            </div>
            {item.answer.kind === 'inline' ? (
                <ApprovalCard approval={{ question: item.title, options: item.answer.options, why: item.why ?? null }} answering={answering} onAnswer={(optionId, note) => onAnswer(item, optionId, note)} />
            ) : (
                <p className="mt-1 text-[13px]">{item.title}</p>
            )}
            {questions ? (
                <div data-mobile-question={item.id} className={`mt-2 ${QUESTION_TOUCH}`}>
                    <QuestionForm key={`${item.id}:${item.revision ?? 0}`} item={item} answering={answering} onSubmit={(selections, notes) => onAnswerForm?.(item, selections, notes)} showHeaders={questions.length > 1} />
                </div>
            ) : item.answer.kind === 'form' ? (
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

/** The value of the All tab; workspace ids are never empty, so it cannot collide with one. */
const ALL_WORKSPACES = '';

/**
 * THE WORKSPACE SELECTOR: a row of chips to thumb through — All, then each workspace with its agents and what waits.
 * react-fancy Tabs in the pills variant, not Buttons (the owner, 2026-11-01: "those should not be buttons, it's a menu"):
 * each is role="tab", the one in view aria-selected.
 */
export function MobileWorkspaces({ workspaces: registered, agents, items, selected: requested, onSelect }: MobileWorkspacesProps) {
    const workspaces = registered.filter((w) => w.asleep !== true);
    const selected = requested !== null && registered.some((w) => w.id === requested && w.asleep) ? null : requested;
    return (
        <nav data-mobile-workspaces aria-label="Workspaces" className="shrink-0 overflow-x-auto overscroll-x-contain border-b border-[var(--border-1)] px-4 py-2">
            <Tabs variant="pills" activeTab={selected ?? ALL_WORKSPACES} onTabChange={(id) => onSelect(id === ALL_WORKSPACES ? null : id)}>
                <Tabs.List className="w-max gap-1">
                    <Tabs.Tab value={ALL_WORKSPACES} data-mobile-ws="all" className="shrink-0 px-3 text-sm">All</Tabs.Tab>
                    {workspaces.map((w) => {
                        const count = agents.filter((a) => a.workspaceId === w.id).length;
                        const waiting = items.filter((i) => i.workspaceId === w.id).length;
                        return (
                            <Tabs.Tab key={w.id} value={w.id} data-mobile-ws={w.id} className="flex shrink-0 items-center gap-1.5 px-3 text-sm">
                                <span>{w.name ?? workspaceLabel(workspaces, w.id)}</span>
                                <span className="font-mono text-[11px] text-[var(--fg-4)]">{count}</span>
                                {waiting > 0 ? <span data-mobile-ws-waiting={w.id} className="rounded-full bg-[var(--warning)] px-1.5 text-[11px] font-semibold text-black">{waiting}</span> : null}
                            </Tabs.Tab>
                        );
                    })}
                </Tabs.List>
            </Tabs>
        </nav>
    );
}

/** THE AGENTS, as the Dashboard sees them (§4.1's words: Working / Idle / Waiting on you / Broken / Unreachable), one row each; tap to open. */
export function MobileAgentList({ rows, onOpen, workspaces, current = null }: { rows: readonly AgentRow[] | null; onOpen: (agentId: string) => void; workspaces?: readonly Workspace[] | null | undefined; /** The agent open now (the panels' list): ringed. */ current?: string | null | undefined }) {
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
                                    <Button size="xs" labelClassName="contents" type="button" data-mobile-agent={r.id} data-state={r.state} {...(r.id === current ? { 'data-mobile-agent-open': 'true' } : {})} onClick={() => onOpen(r.id)} className={`flex min-h-11 w-full flex-col gap-1 rounded-xl border bg-[var(--bg-1)] p-3 text-left active:bg-[var(--bg-2)] justify-start items-stretch ${r.id === current ? 'border-[var(--primary)]' : 'border-[var(--border-1)]'}`}>
                                        <span className="flex items-center gap-2 text-[13px]">
                                            <span className="font-medium">{r.name}</span>
                                            <ProviderLogo provider={r.provider} />
                                            <span className="ml-auto font-mono text-[11px] text-[var(--fg-4)]">{workspaceLabel(workspaces, r.workspaceId)}</span>
                                        </span>
                                        <span className="flex items-baseline gap-2 text-xs">
                                            <span className={`font-medium ${TONE[status.tone]}`}>{status.word}</span>
                                            {status.detail ? <span className="truncate text-[var(--fg-3)]" {...(status.title ? { title: status.title } : {})}>{status.detail}</span> : null}
                                        </span>
                                    </Button>
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
    /** A question form answered here (the desktop's QuestionForm and call). */
    onAnswerForm?: ((item: DeckItem, selections: string[][], notes: string[]) => void) | undefined;
    /** The agent list, the first panel. */
    agents?: MobileAgentsSection | undefined;
    workspaces?: readonly Workspace[] | null | undefined;
    /** The panel it opens on; absent = the chat. */
    initialPanel?: MobilePanel | undefined;
    /** A tool row's whole output, asked of the host when the row is opened (the desktop Stream's). */
    loadToolOutput?: ((toolCallId: string) => Promise<ToolOutputReply>) | undefined;
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
                    <Button size="xs" labelClassName="contents" type="button" data-action="remove-attachment" aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)} className="rounded-full p-1 active:bg-[var(--bg-3)]">
                        <Icon name="x" size="xs" />
                    </Button>
                </li>
            ))}
        </ul>
    );
}

/** No links out of the phone's chat yet: a file, agent or workspace pill reads as its words. */
const PHONE_CHAT_REFS: ChatRefs = { files: false, agents: [], workspaces: [] };

/** The three panels' tabs: an icon and one short word each. */
const PANEL_TABS: Record<MobilePanel, { icon: string; label: string }> = {
    agents: { icon: 'users', label: 'Agents' },
    chat: { icon: 'message-square', label: 'Chat' },
    work: { icon: 'activity', label: 'Work' },
};

/** A key pressed while typing (the composer, a question's note) or on a tab is that control's, never a panel change. */
const typingIn = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('textarea, input, select, [contenteditable="true"], [role="tab"]') !== null;

/** A touch that starts in something that scrolls sideways (code, a wide table) or is typed into is that thing's, not a swipe. */
function ownsSideways(target: EventTarget | null, stop: Element): boolean {
    for (let el = target instanceof Element ? target : null; el && el !== stop; el = el.parentElement) {
        if (el.matches('textarea, input, select, pre, table')) return true;
        if (el.scrollWidth > el.clientWidth + 1 && typeof getComputedStyle === 'function') {
            const x = getComputedStyle(el).overflowX;
            if (x === 'auto' || x === 'scroll') return true;
        }
    }
    return false;
}

/**
 * ONE AGENT on the phone (Tynn #652; the owner, 2026-11-12: "I should have full chat stream and work streams as slideable
 * panels and ability answer any FTQ. I also need the ability to attach files and use my camera."). Three panels, swiped
 * between (or the tabs, or the arrow keys):
 *
 *  - AGENTS: every agent with its state word, tap to open one;
 *  - CHAT: the desktop chat's own rows (`ChatMessages`, over the thread `chatThreadFrom` derives on the desktop);
 *  - WORK: the desktop's work stream (`Stream`), its tool rows and all.
 *
 * Under the chat and the work: what this agent waits on you for — an inline question as the Deck's card, a form as the
 * desktop's QuestionForm — and the composer: words, a photo from the CAMERA, from the GALLERY, or any file. Not running:
 * Start instead of the composer. No terminal, ever (the owner, 2026-10-11).
 *
 * Only the panel in view is drawn, so the screen keeps its one bounded scroller (mobile-scroll.test.tsx).
 */
export function MobileAgent({ detail, sending, onBack, onSend, onStart, onResumeLimit, needs = [], answering = null, onAnswer, onAnswerForm, sendRefusal = null, reconnecting = false, agents, workspaces, initialPanel = 'chat', loadToolOutput }: MobileAgentProps) {
    const [pending, setPending] = useState<File[]>([]);
    const [panel, setPanel] = useState<MobilePanel>(initialPanel);
    const [selectedRow, setSelectedRow] = useState<string | null>(null);
    const touchFrom = useRef<{ x: number; y: number } | null>(null);
    const chatScroll = useRef<HTMLElement | null>(null);
    const following = useRef(true);
    const agentRows = agents?.rows ?? null;
    // Keyed on what the thread reads of the agents (ids, names, fidelity), not on the snapshot's array, which is new
    // whenever any agent's status changes (genie#1340) — as the desktop chat keys it.
    const agentsKey = chatAgentsKey(agentRows ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const thread = useMemo(() => (detail ? chatThreadFrom(detail, detail.agent.id, agentRows ?? [], Date.now) : null), [detail, agentsKey]);
    const followKey = chatFollowKey(thread?.agentId ?? null, thread?.messages ?? []);
    // Following the end of the chat, as the desktop's does: new words come into view unless you scrolled up to read.
    useLayoutEffect(() => {
        const el = chatScroll.current;
        if (el && following.current) el.scrollTop = el.scrollHeight;
    }, [followKey, panel]);
    if (!detail) {
        return (
            <div data-mobile-agent-view="loading" className={SCREEN} aria-busy>
                <div data-mobile-scroll className={`${SCROLL} flex flex-col px-4 pb-4 ${SAFE_TOP}`}>
                    <Button size="xs" type="button" data-action="back" onClick={onBack} className={`${TOUCH} self-start text-xs text-[var(--fg-3)]`}>← back</Button>
                    <div className="mt-4 h-6 w-40 animate-pulse rounded-md bg-[var(--bg-2)]" />
                </div>
            </div>
        );
    }
    const running = detail.session !== null;
    // Held by its provider's limit (Tynn #794): the same words as every surface, and Resume now.
    const held = limitWords(detail.session?.limit);
    const step = (s: -1 | 0 | 1) => { if (s !== 0) setPanel((p) => panelAfter(p, s)); };
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
    const attach = 'flex size-11 cursor-pointer items-center justify-center rounded-full border border-[var(--border-1)] active:bg-[var(--bg-2)]';
    const messages = thread?.messages ?? [];
    return (
        <div
            data-mobile-agent-view={detail.agent.id}
            data-mobile-panels={panel}
            className={SCREEN}
            onKeyDown={(e) => {
                if (typingIn(e.target)) return;
                if (e.key === 'ArrowRight') step(1);
                else if (e.key === 'ArrowLeft') step(-1);
            }}
            onTouchStart={(e) => {
                const t = e.touches[0];
                touchFrom.current = t && !ownsSideways(e.target, e.currentTarget) ? { x: t.clientX, y: t.clientY } : null;
            }}
            onTouchEnd={(e) => {
                const from = touchFrom.current;
                touchFrom.current = null;
                const t = e.changedTouches[0];
                if (from && t) step(swipeStep(t.clientX - from.x, t.clientY - from.y));
            }}
        >
            <header className={`flex shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-4 pb-2 ${SAFE_TOP}`}>
                <Button size="xs" type="button" data-action="back" onClick={onBack} className={`${TOUCH} pr-2 text-sm text-[var(--fg-3)]`}>← back</Button>
                <span className="truncate text-sm font-semibold">{detail.agent.name}</span>
                <ProviderLogo provider={detail.agent.provider} />
                <span data-running={running ? 'true' : 'false'} className={`ml-auto font-mono text-[11px] ${running ? 'text-[var(--success)]' : 'text-[var(--fg-4)]'}`}>{running ? 'running' : 'not running'}</span>
            </header>
            {/* THE PANELS' TABS — react-fancy Tabs (a menu, not buttons: the owner, 2026-11-01), thumb-sized. */}
            <nav data-mobile-panel-tabs aria-label="Panels" className="shrink-0 border-b border-[var(--border-1)] px-2 py-1">
                <Tabs variant="pills" activeTab={panel} onTabChange={(id) => setPanel(id as MobilePanel)}>
                    <Tabs.List className="w-full gap-1">
                        {MOBILE_PANELS.map((p) => (
                            <Tabs.Tab key={p} value={p} data-mobile-panel-tab={p} className="flex min-h-11 flex-1 items-center justify-center gap-1.5 px-2 text-sm">
                                <Icon name={PANEL_TABS[p].icon} size="sm" />
                                <span>{PANEL_TABS[p].label}</span>
                                {p === 'chat' && needs.length > 0 ? <span data-mobile-needs-count={needs.length} className="rounded-full bg-[var(--warning)] px-1.5 text-[11px] font-semibold text-black">{needs.length}</span> : null}
                            </Tabs.Tab>
                        ))}
                    </Tabs.List>
                </Tabs>
            </nav>
            {reconnecting ? <Reconnecting /> : null}
            {detail.refusal ? <p data-refusal className="shrink-0 border-b border-[var(--border-1)] px-4 py-2 text-xs text-[var(--danger)]">{detail.refusal}</p> : null}
            {held ? (
                <div data-mobile-limit className="flex shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-4 py-2 text-xs">
                    <span className="text-[var(--warning)]" {...(limitTitle(detail.session?.limit) ? { title: limitTitle(detail.session?.limit)! } : {})}>Paused · {held}</span>
                    <Button size="xs" type="button" data-action="resume-limit" onClick={onResumeLimit} className={`${TOUCH} ml-auto rounded-lg border border-[var(--border-1)] px-2.5 font-medium`}>Resume now</Button>
                </div>
            ) : null}
            {panel === 'agents' ? (
                <main data-mobile-panel="agents" data-mobile-scroll className={`${SCROLL} flex flex-col gap-2 px-4 py-3 ${SAFE_BOTTOM}`}>
                    <MobileAgentList rows={agentRows ?? []} onOpen={(id) => agents?.onOpen(id)} workspaces={workspaces} current={detail.agent.id} />
                </main>
            ) : panel === 'chat' ? (
                <main
                    ref={(el) => { chatScroll.current = el; }}
                    data-mobile-panel="chat"
                    data-mobile-scroll
                    onScroll={(e) => { const el = e.currentTarget; following.current = atThreadEnd(el.scrollTop, el.scrollHeight, el.clientHeight); }}
                    className={`${SCROLL} relative flex flex-col`}
                >
                    {messages.length === 0 ? (
                        <p className="py-4 text-center text-[13px] text-[var(--fg-3)]">Nothing yet.</p>
                    ) : (
                        <div data-chat-log="" className="flex min-h-full min-w-0 flex-col justify-end gap-3 px-3 py-3 text-[14px] [overflow-wrap:anywhere]">
                            <ChatMessages messages={messages} thread={thread} refs={PHONE_CHAT_REFS} mailOnly={thread?.fidelity === 'observed'} />
                        </div>
                    )}
                </main>
            ) : (
                <main data-mobile-panel="work" data-mobile-scroll className={`${SCROLL} flex flex-col`}>
                    <div className="min-h-0 flex-1">
                        <Stream
                            rows={detail.rows}
                            lanes={null}
                            at={null}
                            selectedId={selectedRow}
                            onSelect={setSelectedRow}
                            agentName={detail.agent.name}
                            live={detail.session?.running === true && detail.session.turnState === 'working'}
                            loadToolOutput={loadToolOutput}
                        />
                    </div>
                </main>
            )}
            {panel !== 'agents' && needs.length > 0 ? (
                <section data-mobile-waiting className="flex max-h-[40dvh] shrink-0 flex-col gap-2 overflow-y-auto overscroll-contain border-t border-[var(--warning)]/40 bg-[var(--warning)]/5 px-4 py-3">
                    <h2 className="text-xs font-semibold text-[var(--warning)]">Waiting on you</h2>
                    {needs.map((item) => (
                        <div key={item.id} data-mobile-item={item.id}>
                            <NeedsYou item={item} host={detail.agent.name} answering={answering} onAnswer={(i, o, n) => onAnswer?.(i, o, n)} onAnswerForm={onAnswerForm} label={null} workspace={null} />
                        </div>
                    ))}
                </section>
            ) : null}
            {panel !== 'agents' ? (
                <footer className="shrink-0 border-t border-[var(--border-1)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                    {running ? (
                        <form data-mobile-composer onSubmit={submit} className="flex flex-col gap-2">
                            {sendRefusal ? <p data-send-refusal className="text-xs text-[var(--danger)]">{sendRefusal}</p> : null}
                            <PendingAttachments files={pending} onRemove={(i) => setPending((p) => p.filter((_, j) => j !== i))} />
                            <textarea name="text" rows={2} aria-label={`Message ${detail.agent.name}`} placeholder={`Tell ${detail.agent.name} what to do next`} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-2 text-[16px]"
                                onKeyDown={(e) => {
                                    // A hardware keyboard only (Tynn issue #697): on a touch keyboard Enter stays a new line, and Send is the button.
                                    if (!hasHardwareKeyboard()) return;
                                    if (composerKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }, sendKeyNow()) !== 'send') return;
                                    e.preventDefault();
                                    e.currentTarget.form?.requestSubmit();
                                }} />
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
                                <Button size="xs" type="submit" data-action="send-prompt" disabled={sending} className={`${PRIMARY} min-h-11`}>{sending ? 'Sending…' : 'Send'}</Button>
                            </div>
                        </form>
                    ) : (
                        <Button size="xs" type="button" data-action="start-agent" onClick={onStart} className={`w-full min-h-11 ${PRIMARY}`}>Start {detail.agent.name}</Button>
                    )}
                </footer>
            ) : null}
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
        <div data-mobile-files={path} className={SCREEN}>
            <header className={`flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-0)] px-4 pb-3 ${SAFE_TOP}`}>
                <Button size="xs" type="button" data-action="back" onClick={onBack} className="py-1 pr-2 text-sm text-[var(--fg-3)]">← back</Button>
                <span className="truncate text-sm font-semibold">{workspaceName}</span>
                <span className="truncate font-mono text-xs text-[var(--fg-3)]">/{path}</span>
            </header>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-1)] px-4 py-2">
                {path !== '' ? (
                    <Button size="xs" labelClassName="contents" type="button" data-action="up" onClick={onUp} className={`${BUTTON} flex items-center gap-1.5`}><Icon name="corner-left-up" size="xs" />Up</Button>
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
            {uploading !== false ? <p data-uploading role="status" className="shrink-0 px-4 py-2 text-xs text-[var(--fg-2)]">{uploading}</p> : null}
            {outcome ? <p data-upload-outcome className="shrink-0 px-4 py-2 text-xs text-[var(--fg-3)]">{outcome}</p> : null}
            {error ? <p data-refusal className="shrink-0 px-4 py-2 text-xs text-[var(--danger)]">{error}</p> : null}
            <main data-mobile-scroll className={`${SCROLL} flex flex-col ${SAFE_BOTTOM}`}>
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
                                <Button size="xs" labelClassName="contents" type="button" data-file-entry={e.id} data-kind={e.type} onClick={() => onOpen(e)} className="flex min-h-12 w-full items-center gap-3 border-b border-[var(--border-1)] px-4 py-2 text-left text-[14px] active:bg-[var(--bg-2)] justify-start">
                                    <Icon name={e.type === 'folder' ? 'folder' : 'file'} size="sm" className={e.type === 'folder' ? 'text-[var(--warning)]' : 'text-[var(--fg-3)]'} />
                                    <span className="min-w-0 flex-1 truncate">{e.label}</span>
                                    {e.type === 'folder' ? <Icon name="chevron-right" size="xs" className="text-[var(--fg-4)]" /> : null}
                                </Button>
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
        <div data-mobile-file-view={path} className={SCREEN}>
            <header className={`flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-0)] px-4 pb-3 ${SAFE_TOP}`}>
                <Button size="xs" type="button" data-action="back" onClick={onBack} className="py-1 pr-2 text-sm text-[var(--fg-3)]">← back</Button>
                <span className="truncate text-sm font-semibold">{name}</span>
            </header>
            <main data-mobile-scroll className={`${SCROLL} overflow-x-auto ${SAFE_BOTTOM}`}>
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
                        {/* A blob: object URL (createObjectURL, the PWA's https origin): react-fancy 5.72.0+ accepts it in Button's link form. */}
                        <Button size="xs" href={preview.url} target="_blank" rel="noreferrer" data-action="open-pdf" className={PRIMARY}>Open {name}</Button>
                        <span>It opens in this phone’s own PDF viewer.</span>
                    </div>
                ) : preview.kind === 'other' ? (
                    <div data-preview="other" className="flex flex-col items-center gap-3 p-6 text-center text-[13px] text-[var(--fg-3)]">
                        <span>No preview for this kind of file.</span>
                        {preview.url ? <Button size="xs" href={preview.url} download={name} data-action="download" className={BUTTON}>Download</Button> : null}
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
        <div data-mobile="connecting" role="status" className={SCREEN}>
            <div data-mobile-scroll className={`${SCROLL} flex flex-col px-6 ${SAFE_TOP} ${SAFE_BOTTOM}`}>
                {/* `my-auto`, not `justify-center` on the scroller: centred while it fits, and when it does not, it overflows
                    downward where it can be scrolled to — a centred overflow spills off the TOP, out of reach. */}
                <div className="my-auto flex flex-col items-center gap-3 py-6">
                    <span className="size-10 rounded-[10px] bg-gradient-to-br from-[var(--brand-grad-from)] via-[var(--brand-grad-via)] to-[var(--brand-grad-to)]" aria-hidden />
                    <p className="flex items-center gap-2 text-sm"><Icon name="loader" size="sm" className="animate-spin" />Connecting to <span className="font-mono">{host}</span>…</p>
                    <p className="text-center text-xs text-[var(--fg-3)]">It must be on and on your tailnet. This keeps trying on its own.</p>
                </div>
            </div>
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
        <div data-mobile="pair" className={SCREEN}>
            {/* The keyboard takes half a small phone: the form scrolls, so Connect is always reachable above it. */}
            <div data-mobile-scroll className={`${SCROLL} flex flex-col px-6 ${SAFE_TOP} ${SAFE_BOTTOM}`}>
                <div className="my-auto flex flex-col items-center gap-4 py-6">
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
                        <Button size="xs" type="submit" disabled={connecting || waiting !== null} className="rounded-lg bg-[var(--primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-60">{waiting ? 'Waiting for Allow…' : connecting ? 'Connecting…' : 'Connect'}</Button>
                    </form>
                </div>
            </div>
        </div>
    );
}
