import { Icon, Kanban, useKanban } from '@particle-academy/react-fancy';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
    canDrop,
    idsOf,
    newItemKind,
    performBoardAction,
    type BoardActionInput,
    type BoardCard,
    type BoardColumnView,
    type BoardDetail,
    type BoardLevel,
    type BoardOp,
    type BoardScope,
    type BoardView,
    type TynnBoardHost,
    type TynnBoardState,
} from '../../core/tynn-board.js';

export type { BoardActionInput, TynnBoardHost };

/**
 * THE TYNN TAB'S BOARD (genie#1295) — tynn.ai's board, natively, on the same Fancy Kanban tynn.ai's board is built on.
 *
 * Versions → a version's stories → a story's tasks; tynn.ai's columns; each card's one-click next step (an icon, named for
 * a screen reader — the owner: icons over words) held back by tynn.ai's guards; drag gated by tynn.ai's transitions, with
 * Shift to drop anywhere; delete. No user menu, no project picker: the board is the workspace's own project. When there
 * is nothing to show it says why. Titles are Tynn's text, drawn as text, never as markup.
 *
 * Row B2 (workspace-ux 0.2.0): "New story" / "New task" opens a form in the Backlog column (a new item starts there, as on
 * tynn.ai); a card's Details icon opens its detail beside the board (tynn.ai's focus flyout), where it can be edited. A
 * create or an edit says it is running, then that it worked — or Tynn's reason, with Retry (the owner: visible progress,
 * never silent).
 *
 * What a card can do and where it can go are declared in core/tynn-board.ts against the workspace-UX contract.
 */

export interface TynnBoardPanelProps {
    readonly state: TynnBoardState;
    readonly onScope: (scope: BoardScope) => void;
    readonly onAction: (input: BoardActionInput) => void;
    readonly onRefresh?: (() => void) | undefined;
    /** Run the last failed create or edit again. */
    readonly onRetry?: (() => void) | undefined;
}

const SINGULAR: Record<BoardLevel, string> = { versions: 'versions', stories: 'stories', tasks: 'tasks' };

/** Is Shift held? Tynn's override: a drag held with Shift drops on any column (tynn.ai's board does the same). */
function useShift(): boolean {
    const [held, setHeld] = useState(false);
    useEffect(() => {
        const sync = (e: KeyboardEvent) => setHeld(e.shiftKey);
        const clear = () => setHeld(false);
        window.addEventListener('keydown', sync);
        window.addEventListener('keyup', sync);
        window.addEventListener('blur', clear);
        return () => {
            window.removeEventListener('keydown', sync);
            window.removeEventListener('keyup', sync);
            window.removeEventListener('blur', clear);
        };
    }, []);
    return held;
}

function IconButton({ icon, label, onClick, disabled = false, data }: { icon: string; label: string; onClick: () => void; disabled?: boolean; data: Record<string, string> }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            className="rounded p-1 text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)] disabled:opacity-40"
            {...data}
        >
            <Icon name={icon} size="xs" />
        </button>
    );
}

/** A real button that looks like one: the form's submit, with its own in-progress label while it runs. */
function SubmitButton({ icon, label, busyLabel, busy, disabled }: { icon: string; label: string; busyLabel: string; busy: boolean; disabled: boolean }) {
    return (
        <button
            type="submit"
            data-tynn-submit=""
            disabled={busy || disabled}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-[var(--accent-fg,white)] hover:opacity-90 disabled:opacity-50"
        >
            <Icon name={busy ? 'loader' : icon} size="xs" className={busy ? 'animate-spin' : ''} />
            {busy ? busyLabel : label}
        </button>
    );
}

const VERB_WORDS: Record<string, { running: string; done: string }> = {
    'story.create': { running: 'Creating story…', done: 'Story created' },
    'task.create': { running: 'Creating task…', done: 'Task created' },
    'story.edit': { running: 'Saving…', done: 'Saved' },
    'task.edit': { running: 'Saving…', done: 'Saved' },
};

/** What the create or edit in flight is doing, or how it ended: running, done, or Tynn's reason with Retry. */
function OpLine({ op, onRetry }: { op: BoardOp; onRetry?: (() => void) | undefined }) {
    const words = VERB_WORDS[op.action] ?? { running: 'Working…', done: 'Done' };
    if (op.phase === 'running') {
        return <p data-tynn-op="running" aria-live="polite" className="flex items-center gap-1.5 text-[12px] text-[var(--fg-2)]"><Icon name="loader" size="xs" className="animate-spin" /> {words.running}</p>;
    }
    if (op.phase === 'done') {
        return <p data-tynn-op="done" aria-live="polite" className="flex items-center gap-1.5 text-[12px] text-[var(--success,var(--fg-2))]"><Icon name="circle-check" size="xs" /> {words.done}</p>;
    }
    return (
        <p data-tynn-op="failed" role="alert" className="flex items-center gap-1.5 rounded bg-[var(--warning)]/10 px-2 py-1 text-[12px] text-[var(--warning)]">
            <Icon name="circle-alert" size="xs" />
            <span className="min-w-0 flex-1">{op.reason ?? 'It did not work.'}</span>
            {onRetry ? (
                <button type="button" data-tynn-retry="" onClick={onRetry} className="inline-flex items-center gap-1 rounded border border-current px-1.5 py-0.5 text-[11px] font-medium">
                    <Icon name="rotate-ccw" size="xs" /> Retry
                </button>
            ) : null}
        </p>
    );
}

const inputClass = 'w-full rounded border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-[12px] text-[var(--fg-1)]';

/** "New story" / "New task": a title and a description (Tynn requires both). It lands in Backlog. */
function NewItemForm({ kind, view, op, onAction, onClose, onRetry }: { kind: 'story' | 'task'; view: BoardView; op: BoardOp | null; onAction: TynnBoardPanelProps['onAction']; onClose: () => void; onRetry?: (() => void) | undefined }) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const mine = op !== null && op.action === `${kind}.create` ? op : null;
    const busy = mine?.phase === 'running';
    const ids = kind === 'story' ? { versionId: view.versionId ?? '' } : { storyId: view.storyId ?? '' };
    const submit = (e: { preventDefault(): void }) => {
        e.preventDefault();
        if (busy || title.trim() === '' || description.trim() === '') return;
        onAction({ action: `${kind}.create`, ids, body: { title, description } });
    };
    return (
        <form data-tynn-new-form={kind} onSubmit={submit} className="flex flex-col gap-1.5 rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] p-2">
            <input aria-label="Title" placeholder="Title" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} className={inputClass} autoFocus />
            <textarea aria-label="Description" placeholder="Description" rows={3} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
            {mine && mine.phase !== 'done' ? <OpLine op={mine} onRetry={onRetry} /> : null}
            <div className="flex items-center justify-end gap-1">
                <IconButton icon="x" label="Cancel" onClick={onClose} disabled={busy} data={{ 'data-tynn-cancel': '' }} />
                <SubmitButton icon="plus" label={`Create ${kind}`} busyLabel={`Creating ${kind}…`} busy={busy} disabled={title.trim() === '' || description.trim() === ''} />
            </div>
        </form>
    );
}

function Card({ card, scope, onScope, onAction }: { card: BoardCard; scope: BoardScope; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction'] }) {
    const drill = card.drill;
    const remove = () => {
        if (globalThis.confirm?.(`Delete this ${card.kind}? This cannot be undone.`) !== false) onAction({ action: `${card.kind}.delete`, ids: idsOf(card) });
    };
    const hasDetail = card.kind === 'story' || card.kind === 'task';
    return (
        <Kanban.Card id={card.id} unstyled className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] p-2 text-[12px]">
            <div data-tynn-card={card.id} data-tynn-card-status={card.status} className="flex flex-col gap-1">
                <div className="flex items-start gap-1.5">
                    {card.number !== null ? <span className="shrink-0 font-mono text-[11px] text-[var(--fg-3)]">{card.number}</span> : null}
                    {drill ? (
                        <button type="button" data-tynn-open={card.id} onClick={() => onScope(drill)} className="min-w-0 flex-1 text-left text-[var(--fg-1)] hover:underline">{card.title}</button>
                    ) : (
                        <span className="min-w-0 flex-1 text-[var(--fg-1)]">{card.title}</span>
                    )}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-[var(--fg-3)]">
                    {card.progress !== null ? <span data-tynn-progress="">{card.progress}</span> : null}
                    {card.claimedBy !== null ? <span className="truncate" title={card.claimedBy}><Icon name="user" size="xs" /> {card.claimedBy}</span> : null}
                    <span className="ml-auto flex items-center">
                        {card.quick ? (
                            <IconButton icon={card.quick.icon} label={card.quick.label} disabled={card.quick.disabled} onClick={() => onAction({ action: card.quick!.actionId, ids: idsOf(card) })} data={{ 'data-tynn-step': card.quick.actionId }} />
                        ) : null}
                        {hasDetail ? <IconButton icon="panel-right-open" label="Details" onClick={() => onScope({ ...scope, focus: `${card.kind}:${card.id}` })} data={{ 'data-tynn-details': card.id }} /> : null}
                        <IconButton icon="trash-2" label="Delete" onClick={remove} data={{ 'data-tynn-delete': card.id }} />
                    </span>
                </div>
            </div>
        </Kanban.Card>
    );
}

function Column({ column, view, scope, override, composer, onScope, onAction }: { column: BoardColumnView; view: BoardView; scope: BoardScope; override: boolean; composer: ReactNode; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction'] }) {
    const { draggedCard, dragSource } = useKanban();
    // While a card is dragged, a column it cannot reach reads as off (tynn.ai dims it too); Shift opens them all.
    const illegal = draggedCard !== null && dragSource !== null && !canDrop(view.level, dragSource, column.status, override);
    return (
        <Kanban.Column id={column.status} title={column.label} unstyled className={`flex min-h-0 min-w-[200px] flex-1 basis-0 flex-col gap-2 rounded-md bg-[var(--bg-2)] p-2 ${illegal ? 'opacity-30' : ''}`}>
            {composer}
            {column.cards.length === 0 && !composer ? (
                <p data-tynn-empty={column.status} className="py-2 text-center text-[11px] text-[var(--fg-4)]">No {SINGULAR[view.level]}</p>
            ) : column.cards.map((c) => <Card key={c.id} card={c} scope={scope} onScope={onScope} onAction={onAction} />)}
        </Kanban.Column>
    );
}

/** The card's edit: the fields tynn.ai's flyout edits. A list is one entry per line. */
function EditForm({ detail, op, onAction, onClose, onRetry }: { detail: BoardDetail; op: BoardOp | null; onAction: TynnBoardPanelProps['onAction']; onClose: () => void; onRetry?: (() => void) | undefined }) {
    const [title, setTitle] = useState(detail.title);
    const [description, setDescription] = useState(detail.description);
    const [list, setList] = useState((detail.kind === 'story' ? detail.acceptanceCriteria : detail.verificationSteps).join('\n'));
    const [codeArea, setCodeArea] = useState(detail.codeArea ?? '');
    const mine = op !== null && op.action === `${detail.kind}.edit` ? op : null;
    const busy = mine?.phase === 'running';
    const listLabel = detail.kind === 'story' ? 'Acceptance criteria, one per line' : 'Verification steps, one per line';
    const submit = (e: { preventDefault(): void }) => {
        e.preventDefault();
        if (busy || title.trim() === '') return;
        const entries = list.split('\n');
        const body = detail.kind === 'story'
            ? { title, description, acceptance_criteria: entries }
            : { title, description, verification_steps: entries, code_area: codeArea };
        onAction({ action: `${detail.kind}.edit`, ids: idsOf({ id: detail.id, kind: detail.kind }), body });
    };
    return (
        <form data-tynn-edit-form={detail.id} onSubmit={submit} className="flex flex-col gap-1.5">
            <input aria-label="Title" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
            <textarea aria-label="Description" rows={5} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
            <textarea aria-label={listLabel} placeholder={listLabel} rows={4} value={list} disabled={busy} onChange={(e) => setList(e.target.value)} className={inputClass} />
            {detail.kind === 'task' ? <input aria-label="Code area" placeholder="Code area" value={codeArea} disabled={busy} onChange={(e) => setCodeArea(e.target.value)} className={inputClass} /> : null}
            {mine && mine.phase !== 'done' ? <OpLine op={mine} onRetry={onRetry} /> : null}
            <div className="flex items-center justify-end gap-1">
                <IconButton icon="x" label="Cancel" onClick={onClose} disabled={busy} data={{ 'data-tynn-cancel': '' }} />
                <SubmitButton icon="check" label="Save" busyLabel="Saving…" busy={busy} disabled={title.trim() === ''} />
            </div>
        </form>
    );
}

function List({ title, items, mark }: { title: string; items: readonly string[]; mark: string }) {
    if (items.length === 0) return null;
    return (
        <section className="flex flex-col gap-1">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-[var(--fg-3)]">{title}</h4>
            <ul className="flex flex-col gap-0.5">
                {items.map((item, i) => <li key={`${i}:${item}`} className="flex gap-1.5 text-[12px] text-[var(--fg-1)]"><Icon name={mark} size="xs" className="mt-0.5 shrink-0 text-[var(--fg-3)]" /> <span>{item}</span></li>)}
            </ul>
        </section>
    );
}

/** tynn.ai's focus flyout: the card's detail beside the board, with its edit. */
function Detail({ detail, op, onClose, onAction, onRetry }: { detail: BoardDetail; op: BoardOp | null; onClose: () => void; onAction: TynnBoardPanelProps['onAction']; onRetry?: (() => void) | undefined }) {
    const editOp = op !== null && op.action === `${detail.kind}.edit` ? op : null;
    const [editing, setEditing] = useState(editOp !== null && editOp.phase !== 'done');
    // A finished save closes the form; the detail re-read shows what Tynn kept.
    const lastPhase = useRef(editOp?.phase);
    useEffect(() => {
        if (editOp?.phase === 'done' && lastPhase.current !== 'done') setEditing(false);
        lastPhase.current = editOp?.phase;
    }, [editOp?.phase]);
    return (
        <aside data-tynn-detail={detail.id} aria-label={`${detail.kind === 'story' ? 'Story' : 'Task'} detail`} className="flex w-[340px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border-1)] bg-[var(--bg-1)] p-3">
            <div className="flex items-start gap-1.5">
                {detail.number !== null ? <span className="shrink-0 font-mono text-[11px] text-[var(--fg-3)]">{detail.number}</span> : null}
                <h3 className="min-w-0 flex-1 text-[13px] font-medium text-[var(--fg-1)]">{detail.title}</h3>
                {!editing ? <IconButton icon="pencil" label="Edit" onClick={() => setEditing(true)} data={{ 'data-tynn-edit': detail.id }} /> : null}
                <IconButton icon="x" label="Close" onClick={onClose} data={{ 'data-tynn-detail-close': '' }} />
            </div>
            <div className="flex items-center gap-2 text-[11px] text-[var(--fg-3)]">
                <span data-tynn-detail-status={detail.status} className="rounded bg-[var(--bg-2)] px-1.5 py-0.5">{detail.status}</span>
                {detail.parent ? <span className="truncate">{detail.parent.label}</span> : null}
            </div>
            {editOp && editOp.phase === 'done' && !editing ? <OpLine op={editOp} /> : null}
            {editing ? (
                <EditForm detail={detail} op={editOp} onAction={onAction} onClose={() => setEditing(false)} onRetry={onRetry} />
            ) : (
                <>
                    {detail.description !== '' ? <p className="whitespace-pre-wrap text-[12px] text-[var(--fg-1)]">{detail.description}</p> : null}
                    <List title="Acceptance criteria" items={detail.acceptanceCriteria} mark="check" />
                    <List title="Verification" items={detail.verificationSteps} mark="check" />
                    {detail.codeArea !== null ? <p className="font-mono text-[11px] text-[var(--fg-3)]">{detail.codeArea}</p> : null}
                    <List title="Tasks" items={detail.tasks.map((t) => [t.number, t.title, `(${t.status})`].filter(Boolean).join(' '))} mark="square-check" />
                    <List title="Features" items={detail.features} mark="tag" />
                </>
            )}
        </aside>
    );
}

function Board({ state, onScope, onAction, onRefresh, onRetry }: { state: Extract<TynnBoardState, { state: 'ready' }>; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction']; onRefresh?: (() => void) | undefined; onRetry?: (() => void) | undefined }) {
    const { view, refused = null, detail = null, detailRefused = null, op = null } = state;
    const shift = useShift();
    const kind = view.level === 'versions' ? 'version' : view.level === 'stories' ? 'story' : 'task';
    const newKind = newItemKind(view.level);
    const createOp = op !== null && newKind !== null && op.action === `${newKind}.create` ? op : null;
    const [composing, setComposing] = useState(createOp !== null && createOp.phase !== 'done');
    // A create that worked closes its form; the board re-read shows the new card in Backlog.
    const lastPhase = useRef(createOp?.phase);
    useEffect(() => {
        if (createOp?.phase === 'done' && lastPhase.current !== 'done') setComposing(false);
        lastPhase.current = createOp?.phase;
    }, [createOp?.phase]);
    const scope: BoardScope = view.level === 'stories' && view.versionId !== null ? { version: view.versionId } : view.level === 'tasks' && view.storyId !== null ? { story: view.storyId } : {};
    const statusOf = (id: string) => view.columns.find((c) => c.cards.some((card) => card.id === id))?.status ?? null;
    const move = (cardId: string, from: string, to: string, toIndex: number) => {
        if (!view.draggable) return;
        // The board's own gate first (tynn.ai's too); Tynn enforces the same rules either way.
        if (!canDrop(view.level, statusOf(cardId) ?? from, to, shift)) return;
        onAction({ action: `${kind}.move`, ids: idsOf({ id: cardId, kind }), body: { status: to, order: toIndex, ...(shift ? { override: true } : {}) } });
    };
    const start = view.columns[0]?.status;
    const composer = composing && newKind !== null
        ? <NewItemForm kind={newKind} view={view} op={createOp} onAction={onAction} onClose={() => setComposing(false)} onRetry={onRetry} />
        : null;
    return (
        <div className="flex min-h-0 flex-1">
            <div data-tynn-board={view.level} className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-3">
                <div className="flex items-center gap-2 text-[12px]">
                    {view.up !== null ? <IconButton icon="chevron-left" label="Up" onClick={() => onScope(view.up!)} data={{ 'data-tynn-up': '' }} /> : null}
                    <button type="button" data-tynn-crumb="versions" onClick={() => onScope({})} className="text-[var(--fg-2)] hover:text-[var(--fg-1)]">Versions</button>
                    {view.crumbs.map((c) => (
                        <span key={`${c.scope.version ?? ''}:${c.scope.story ?? ''}`} className="flex items-center gap-2">
                            <Icon name="chevron-right" size="xs" />
                            <button type="button" data-tynn-crumb={c.scope.story ?? c.scope.version ?? ''} onClick={() => onScope(c.scope)} className="text-[var(--fg-2)] hover:text-[var(--fg-1)]">{c.label}</button>
                        </span>
                    ))}
                    {shift && view.draggable ? <span data-tynn-override="" className="text-[var(--warning)]">Shift: drop anywhere</span> : null}
                    <span className="ml-auto flex items-center gap-1">
                        {createOp && createOp.phase === 'done' && !composing ? <OpLine op={createOp} /> : null}
                        {newKind !== null ? (
                            <IconButton icon="plus" label={`New ${newKind}`} disabled={composing} onClick={() => setComposing(true)} data={{ 'data-tynn-new': newKind }} />
                        ) : null}
                        {onRefresh ? <IconButton icon="refresh-cw" label="Refresh" onClick={onRefresh} data={{ 'data-tynn-refresh': '' }} /> : null}
                    </span>
                </div>
                {refused ? <p data-tynn-board-refused="" role="alert" className="rounded bg-[var(--warning)]/10 px-2 py-1 text-[12px] text-[var(--warning)]">{refused}</p> : null}
                {detailRefused ? <p data-tynn-detail-refused="" role="alert" className="rounded bg-[var(--warning)]/10 px-2 py-1 text-[12px] text-[var(--warning)]">{detailRefused}</p> : null}
                <Kanban onCardMove={move} className="flex min-h-0 flex-1 items-start gap-2 overflow-x-auto">
                    {view.columns.map((col) => <Column key={col.status} column={col} view={view} scope={scope} override={shift} composer={col.status === start ? composer : null} onScope={onScope} onAction={onAction} />)}
                </Kanban>
            </div>
            {detail ? <Detail key={detail.id} detail={detail} op={op} onClose={() => onScope(scope)} onAction={onAction} onRetry={onRetry} /> : null}
        </div>
    );
}

export function TynnBoardPanel({ state, onScope, onAction, onRefresh, onRetry }: TynnBoardPanelProps) {
    if (state.state === 'ready') return <Board state={state} onScope={onScope} onAction={onAction} onRefresh={onRefresh} onRetry={onRetry} />;
    const line = state.state === 'loading'
        ? <><Icon name="loader" size="xs" /> Reading Tynn…</>
        : state.state === 'not-linked'
            ? 'This workspace has no Tynn project.'
            : state.reason;
    return <p data-tynn-board-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
}

/** Create and edit report their progress; the workflow steps, drags and deletes keep the board's refused line. */
const REPORTS_PROGRESS = /\.(create|edit)$/;

/** The tab: keeps the scope, reads the board, acts, and reads it again — a refused step stays on screen in Tynn's words. */
export function TynnBoardTab({ workspaceId, host }: { workspaceId: string; host: TynnBoardHost }) {
    const [scope, setScope] = useState<BoardScope>({});
    const [state, setState] = useState<TynnBoardState>({ state: 'loading' });
    const [op, setOp] = useState<BoardOp | null>(null);
    const [lastInput, setLastInput] = useState<BoardActionInput | null>(null);
    const read = useCallback(async (at: BoardScope, refused: string | null = null) => {
        const r = await host.read(workspaceId, at);
        if (r.ok) setState({ state: 'ready', view: r.view, refused, detail: r.detail ?? null, detailRefused: r.detailRefused ?? null });
        else setState(r.state === 'not-linked' ? { state: 'not-linked' } : r.state === 'signed-out' ? { state: 'signed-out', reason: r.reason } : { state: 'error', reason: r.reason });
    }, [host, workspaceId]);
    useEffect(() => { void read(scope); }, [read, scope]);
    const act = async (input: BoardActionInput) => {
        const tracked = REPORTS_PROGRESS.test(input.action);
        if (tracked) setLastInput(input);
        const r = tracked ? await performBoardAction(host, workspaceId, input, setOp) : await host.act(workspaceId, input);
        if (!r.ok && (r.state === 'not-linked' || r.state === 'signed-out')) {
            setState(r.state === 'not-linked' ? { state: 'not-linked' } : { state: 'signed-out', reason: r.reason });
            return;
        }
        // A tracked action's failure is said by its own line (with Retry); the others keep the board's refused line.
        await read(scope, r.ok || tracked ? null : r.reason);
    };
    const shown: TynnBoardState = state.state === 'ready' ? { ...state, op } : state;
    const changeScope = (next: BoardScope) => { setOp(null); setScope(next); };
    return (
        <TynnBoardPanel
            state={shown}
            onScope={changeScope}
            onAction={(input) => { void act(input); }}
            onRefresh={() => { void read(scope); }}
            onRetry={lastInput ? () => { void act(lastInput); } : undefined}
        />
    );
}
