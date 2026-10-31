import { Icon, Kanban, useKanban } from '@particle-academy/react-fancy';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
    applyBoardChanges,
    BoardFollower,
    canDrop,
    changedEdit,
    idsOf,
    initialsOf,
    newItemKind,
    performBoardAction,
    performClaimThenStart,
    RISK_LEVELS,
    startPlan,
    type BoardActionInput,
    type BoardCard,
    type BoardColumnView,
    type BoardDetail,
    type BoardLevel,
    type BoardOp,
    type BoardScope,
    type BoardView,
    type BoardChanges,
    type BoardDetail as BoardDetailRow,
    type Claimant,
    type LiveState,
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
 * Row B3 (workspace-ux 0.3.0): a claimed card shows its claimant (a person's initials, an agent's mark; the name on hover)
 * and the claimant can release it; a backlog card's Start follows the project's claim mode, as tynn.ai's does; a person
 * who may manage the project assigns from the project's eligible claimants. Each says it is running, then that it
 * worked, or Tynn's reason with Retry.
 *
 * Row B4 (workspace-ux 0.4.0): the board is live. When it changes on Tynn, by a person or an agent, the tab asks what
 * changed since its cursor and redraws only the cards that changed (core/tynn-board.ts applyBoardChanges keeps every other
 * card and column object, and cards are memoised). An icon says live, or reconnecting while the link is down; after a
 * reconnect it catches up from its cursor, so nothing is missed.
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
    /** The project's eligible claimants for the Assign picker: null until asked for, 'loading' while read. */
    readonly claimants?: readonly Claimant[] | 'loading' | null | undefined;
    readonly onLoadClaimants?: (() => void) | undefined;
    /** Row B4: following Tynn live (an icon), or not (none). */
    readonly live?: LiveState | undefined;
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

function IconButton({ icon, label, onClick, disabled = false, data, menu = false }: { icon: string; label: string; onClick: () => void; disabled?: boolean; data: Record<string, string>; menu?: boolean }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            {...(menu ? { 'aria-haspopup': 'menu' as const } : {})}
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
    'story.claim-start': { running: 'Claiming and starting…', done: 'Claimed and started' },
    'task.claim-start': { running: 'Claiming and starting…', done: 'Claimed and started' },
    'story.unclaim': { running: 'Releasing claim…', done: 'Claim released' },
    'task.unclaim': { running: 'Releasing claim…', done: 'Claim released' },
    'story.assign': { running: 'Assigning…', done: 'Assigned' },
    'task.assign': { running: 'Assigning…', done: 'Assigned' },
    // WIP's inline steps (row W1): each says it is running, then that it worked.
    'task.start': { running: 'Starting…', done: 'Started' },
    'task.ready': { running: 'Moving to QA…', done: 'Ready for QA' },
    'task.done': { running: 'Finishing…', done: 'Done' },
    'task.restart': { running: 'Restarting…', done: 'Restarted' },
    // The VIP lane's (row V1): start VIP work, move a story on, release.
    'vip.create': { running: 'Starting VIP…', done: 'VIP started' },
    'story.move': { running: 'Moving…', done: 'Moved' },
    'version.release': { running: 'Releasing…', done: 'Released' },
    // The Home's Details save (row H1).
    'details.update': { running: 'Saving…', done: 'Saved' },
};

/** The claim actions: their progress is said on the board's own line, not in a form. */
const CLAIM_OP = /\.(claim-start|unclaim|assign)$/;

/** Who holds a card: a person's initials or an agent's mark, the name on hover and for a screen reader. */
export function Avatar({ who }: { who: { type: 'user' | 'agent'; id: string; name: string; initials?: string } }) {
    const label = `Claimed by ${who.name}${who.type === 'agent' ? ' (agent)' : ''}`;
    return (
        <span
            data-tynn-claimant={who.id}
            data-tynn-claimant-kind={who.type}
            title={label}
            aria-label={label}
            role="img"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--bg-2)] text-[9px] font-semibold text-[var(--fg-2)]"
        >
            {who.type === 'agent' ? <Icon name="bot" size="xs" /> : (who.initials ?? who.name.charAt(0).toUpperCase())}
        </span>
    );
}

const menuItemClass = 'flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] text-[var(--fg-1)] hover:bg-[var(--bg-2)]';

/** A small menu under an icon button (the Start choice, the Assign picker). */
function Menu({ children, label }: { children: ReactNode; label: string }) {
    return (
        <span role="menu" aria-label={label} onClick={(e) => e.stopPropagation()} className="absolute right-0 top-full z-20 mt-1 flex max-h-56 min-w-[10rem] flex-col overflow-y-auto rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] shadow-sm">
            {children}
        </span>
    );
}

/**
 * A backlog card's Start, by the project's claim mode (tynn.ai's Claim.jsx): off or already mine → Start; required →
 * one "Claim and start"; optional → a choice of "Claim + Start" or "Start".
 */
function StartControl({ card, claims, onAction }: { card: BoardCard; claims: BoardView['claims']; onAction: TynnBoardPanelProps['onAction'] }) {
    const [open, setOpen] = useState(false);
    const step = card.quick!;
    const kind = card.kind as 'story' | 'task';
    const plan = startPlan(card, claims);
    const claimStart = () => onAction({ action: `${kind}.claim-start`, ids: idsOf(card) });
    const start = () => onAction({ action: step.actionId, ids: idsOf(card) });
    if (plan === 'claim-then-start') {
        return <IconButton icon="play" label="Claim and start" disabled={step.disabled} onClick={claimStart} data={{ 'data-tynn-step': `${kind}.claim-start` }} />;
    }
    if (plan === 'choose') {
        return (
            <span className="relative inline-flex">
                <IconButton icon="play" label={step.label} disabled={step.disabled} menu onClick={() => setOpen((o) => !o)} data={{ 'data-tynn-start-choice': card.id }} />
                {open && !step.disabled ? (
                    <Menu label="Start">
                        <button type="button" role="menuitem" data-tynn-claim-start={card.id} className={menuItemClass} onClick={() => { setOpen(false); claimStart(); }}><Icon name="hand" size="xs" /> Claim + Start</button>
                        <button type="button" role="menuitem" data-tynn-plain-start={card.id} className={menuItemClass} onClick={() => { setOpen(false); start(); }}><Icon name="play" size="xs" /> Start</button>
                    </Menu>
                ) : null}
            </span>
        );
    }
    return <IconButton icon={step.icon} label={step.label} disabled={step.disabled} onClick={start} data={{ 'data-tynn-step': step.actionId }} />;
}

/** The Assign picker: the project's eligible claimants (read when first opened), each with their avatar. */
function AssignControl({ card, claimants, onLoadClaimants, onAction }: { card: BoardCard; claimants: TynnBoardPanelProps['claimants']; onLoadClaimants?: (() => void) | undefined; onAction: TynnBoardPanelProps['onAction'] }) {
    const [open, setOpen] = useState(false);
    const toggle = () => {
        setOpen((o) => !o);
        if (!open && (claimants === null || claimants === undefined)) onLoadClaimants?.();
    };
    return (
        <span className="relative inline-flex">
            <IconButton icon="user-plus" label="Assign to…" menu onClick={toggle} data={{ 'data-tynn-assign': card.id }} />
            {open ? (
                <Menu label="Assign to">
                    {claimants === 'loading' || claimants === null || claimants === undefined
                        ? <span className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-[var(--fg-3)]"><Icon name="loader" size="xs" className="animate-spin" /> Loading…</span>
                        : claimants.length === 0
                            ? <span className="px-2.5 py-1.5 text-[12px] text-[var(--fg-3)]">No one can be assigned here</span>
                            : claimants.map((c) => (
                                <button key={`${c.type}:${c.id}`} type="button" role="menuitem" data-tynn-assign-to={`${c.type}:${c.id}`} className={menuItemClass}
                                    onClick={() => { setOpen(false); onAction({ action: `${card.kind}.assign`, ids: idsOf(card), body: { type: c.type, id: c.id } }); }}>
                                    <Avatar who={{ ...c, initials: initialsOf(c.name) }} /> <span className="min-w-0 truncate">{c.name}</span>
                                </button>
                            ))}
                </Menu>
            ) : null}
        </span>
    );
}

/** What the create or edit in flight is doing, or how it ended: running, done, or Tynn's reason with Retry. */
export function OpLine({ op, onRetry }: { op: BoardOp; onRetry?: (() => void) | undefined }) {
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

interface ClaimProps { readonly claims: BoardView['claims']; readonly claimants: TynnBoardPanelProps['claimants']; readonly onLoadClaimants?: (() => void) | undefined }

type CardProps = { card: BoardCard; scope: BoardScope; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction']; claim: ClaimProps };

/**
 * A card redraws when ITS card changed (a live update keeps every other card's object), when the scope or the claim
 * settings change. The handlers are not compared: they act on the tab's current scope through a ref.
 */
const Card = memo(CardView, (a: CardProps, b: CardProps) => a.card === b.card && a.scope.version === b.scope.version && a.scope.story === b.scope.story
    && a.scope.focus === b.scope.focus && a.claim.claims === b.claim.claims && a.claim.claimants === b.claim.claimants);

function CardView({ card, scope, onScope, onAction, claim }: CardProps) {
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
                    {card.claim !== null ? (
                        <span className="inline-flex items-center gap-0.5">
                            <Avatar who={card.claim} />
                            {card.claim.mine ? <IconButton icon="x" label="Release claim" onClick={() => onAction({ action: `${card.kind}.unclaim`, ids: idsOf(card) })} data={{ 'data-tynn-release': card.id }} /> : null}
                        </span>
                    ) : null}
                    <span className="ml-auto flex items-center">
                        {card.quick && card.quick.verb === 'start' && hasDetail ? (
                            <StartControl card={card} claims={claim.claims} onAction={onAction} />
                        ) : card.quick ? (
                            <IconButton icon={card.quick.icon} label={card.quick.label} disabled={card.quick.disabled} onClick={() => onAction({ action: card.quick!.actionId, ids: idsOf(card) })} data={{ 'data-tynn-step': card.quick.actionId }} />
                        ) : null}
                        {hasDetail && claim.claims?.canAssign === true ? <AssignControl card={card} claimants={claim.claimants} onLoadClaimants={claim.onLoadClaimants} onAction={onAction} /> : null}
                        {hasDetail ? <IconButton icon="panel-right-open" label="Details" onClick={() => onScope({ ...scope, focus: `${card.kind}:${card.id}` })} data={{ 'data-tynn-details': card.id }} /> : null}
                        <IconButton icon="trash-2" label="Delete" onClick={remove} data={{ 'data-tynn-delete': card.id }} />
                    </span>
                </div>
            </div>
        </Kanban.Card>
    );
}

function Column({ column, view, scope, override, composer, onScope, onAction, claim }: { column: BoardColumnView; view: BoardView; scope: BoardScope; override: boolean; composer: ReactNode; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction']; claim: ClaimProps }) {
    const { draggedCard, dragSource } = useKanban();
    // While a card is dragged, a column it cannot reach reads as off (tynn.ai dims it too); Shift opens them all.
    const illegal = draggedCard !== null && dragSource !== null && !canDrop(view.level, dragSource, column.status, override);
    return (
        <Kanban.Column id={column.status} title={column.label} unstyled className={`flex min-h-0 min-w-[200px] flex-1 basis-0 flex-col gap-2 rounded-md bg-[var(--bg-2)] p-2 ${illegal ? 'opacity-30' : ''}`}>
            {composer}
            {column.cards.length === 0 && !composer ? (
                <p data-tynn-empty={column.status} className="py-2 text-center text-[11px] text-[var(--fg-4)]">No {SINGULAR[view.level]}</p>
            ) : column.cards.map((c) => <Card key={c.id} card={c} scope={scope} onScope={onScope} onAction={onAction} claim={claim} />)}
        </Kanban.Column>
    );
}

/** A list field as the form holds it: one entry per line. */
function LinesField({ label, value, onChange, busy, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; busy: boolean; rows?: number }) {
    return <textarea aria-label={label} placeholder={label} rows={rows} value={value} disabled={busy} onChange={(e) => onChange(e.target.value)} className={inputClass} />;
}

/** The card's edit: every field tynn.ai's flyout edits. A list is one entry per line; tags are comma separated. */
function EditForm({ detail, op, onAction, onClose, onRetry }: { detail: BoardDetail; op: BoardOp | null; onAction: TynnBoardPanelProps['onAction']; onClose: () => void; onRetry?: (() => void) | undefined }) {
    const [title, setTitle] = useState(detail.title);
    const [description, setDescription] = useState(detail.description);
    const [list, setList] = useState((detail.kind === 'story' ? detail.acceptanceCriteria : detail.verificationSteps).join('\n'));
    const [codeArea, setCodeArea] = useState(detail.codeArea ?? '');
    const [tags, setTags] = useState(detail.tags.join(', '));
    const [persona, setPersona] = useState(detail.persona ?? '');
    const [outcome, setOutcome] = useState(detail.outcomeMetric ?? '');
    const [risk, setRisk] = useState<string>(detail.riskLevel ?? '');
    const [effort, setEffort] = useState(detail.effortPoints === null ? '' : String(detail.effortPoints));
    const [dod, setDod] = useState(detail.dodReference ?? '');
    const [env, setEnv] = useState((detail.envRequirements ?? []).join('\n'));
    const [blocking, setBlocking] = useState(detail.blockingOn.join('\n'));
    const [produces, setProduces] = useState(detail.produces.join('\n'));
    const mine = op !== null && op.action === `${detail.kind}.edit` ? op : null;
    const busy = mine?.phase === 'running';
    const listLabel = detail.kind === 'story' ? 'Acceptance criteria, one per line' : 'Verification steps, one per line';
    const submit = (e: { preventDefault(): void }) => {
        e.preventDefault();
        if (busy || title.trim() === '') return;
        const form: Record<string, unknown> = detail.kind === 'story'
            ? {
                title, description, acceptance_criteria: list.split('\n'), tags: tags.split(','), persona, outcome_metric: outcome,
                risk_level: risk, effort_points: effort.trim() === '' ? '' : Number(effort), dod_reference: dod,
            }
            : {
                title, description, verification_steps: list.split('\n'), code_area: codeArea,
                env_requirements: env.split('\n'), blocking_on: blocking.split('\n'), produces: produces.split('\n'),
            };
        // Only what the person changed: a field this Genie could not read is never sent back over what Tynn holds.
        const body = changedEdit(detail, form);
        if (Object.keys(body).length === 0) { onClose(); return; }
        onAction({ action: `${detail.kind}.edit`, ids: idsOf({ id: detail.id, kind: detail.kind }), body });
    };
    return (
        <form data-tynn-edit-form={detail.id} onSubmit={submit} className="flex flex-col gap-1.5">
            <input aria-label="Title" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
            <textarea aria-label="Description" rows={5} value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
            <LinesField label={listLabel} value={list} onChange={setList} busy={busy} rows={4} />
            {detail.kind === 'story' ? (
                <>
                    <input aria-label="Tags, comma separated" placeholder="Tags, comma separated" value={tags} disabled={busy} onChange={(e) => setTags(e.target.value)} className={inputClass} />
                    <input aria-label="Persona" placeholder="Persona" value={persona} disabled={busy} onChange={(e) => setPersona(e.target.value)} className={inputClass} />
                    <input aria-label="Outcome metric" placeholder="Outcome metric" value={outcome} disabled={busy} onChange={(e) => setOutcome(e.target.value)} className={inputClass} />
                    <div className="flex gap-1.5">
                        <select aria-label="Risk" value={risk} disabled={busy} onChange={(e) => setRisk(e.target.value)} className={inputClass}>
                            <option value="">Risk</option>
                            {RISK_LEVELS.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <input aria-label="Effort points" placeholder="Effort" type="number" min={0} step={1} value={effort} disabled={busy} onChange={(e) => setEffort(e.target.value)} className={inputClass} />
                    </div>
                    <input aria-label="Definition of done" placeholder="Definition of done" value={dod} disabled={busy} onChange={(e) => setDod(e.target.value)} className={inputClass} />
                </>
            ) : (
                <>
                    <input aria-label="Code area" placeholder="Code area" value={codeArea} disabled={busy} onChange={(e) => setCodeArea(e.target.value)} className={inputClass} />
                    {detail.envRequirements !== null ? <LinesField label="Environment, one per line" value={env} onChange={setEnv} busy={busy} /> : null}
                    <LinesField label="Blocking on, one per line" value={blocking} onChange={setBlocking} busy={busy} />
                    <LinesField label="Produces, one per line" value={produces} onChange={setProduces} busy={busy} />
                </>
            )}
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

/** A story's tags (chips) and its persona, outcome, risk, effort and definition of done: an icon each, few words. */
function Facts({ detail }: { detail: BoardDetail }) {
    const facts: Array<{ icon: string; label: string; value: string; data?: Record<string, string> }> = [];
    if (detail.persona !== null) facts.push({ icon: 'user', label: 'Persona', value: detail.persona });
    if (detail.outcomeMetric !== null) facts.push({ icon: 'target', label: 'Outcome metric', value: detail.outcomeMetric });
    if (detail.riskLevel !== null) facts.push({ icon: 'triangle-alert', label: 'Risk', value: detail.riskLevel });
    if (detail.effortPoints !== null) facts.push({ icon: 'gauge', label: 'Effort points', value: String(detail.effortPoints), data: { 'data-tynn-detail-effort': String(detail.effortPoints) } });
    if (detail.dodReference !== null) facts.push({ icon: 'list-checks', label: 'Definition of done', value: detail.dodReference });
    if (facts.length === 0 && detail.tags.length === 0) return null;
    return (
        <section className="flex flex-col gap-1">
            {detail.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                    {detail.tags.map((t) => <span key={t} data-tynn-tag={t} className="rounded-full bg-[var(--bg-2)] px-1.5 py-0.5 text-[11px] text-[var(--fg-2)]">{t}</span>)}
                </div>
            ) : null}
            {facts.map((f) => (
                <p key={f.label} title={f.label} aria-label={`${f.label}: ${f.value}`} className="flex items-center gap-1.5 text-[12px] text-[var(--fg-1)]" {...(f.data ?? {})}>
                    <Icon name={f.icon} size="xs" className="shrink-0 text-[var(--fg-3)]" /> <span className="min-w-0 truncate">{f.value}</span>
                </p>
            ))}
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
                    <Facts detail={detail} />
                    <List title="Environment" items={detail.envRequirements ?? []} mark="server" />
                    <List title="Blocking on" items={detail.blockingOn} mark="ban" />
                    <List title="Produces" items={detail.produces} mark="package" />
                    <List title="Tasks" items={detail.tasks.map((t) => [t.number, t.title, `(${t.status})`].filter(Boolean).join(' '))} mark="square-check" />
                    <List title="Features" items={detail.features} mark="tag" />
                </>
            )}
        </aside>
    );
}

/** Live, getting there, or the link dropped — an icon named for a screen reader; nothing when the board is not live. */
export function LiveMark({ live }: { live: LiveState | undefined }) {
    if (live === undefined || live === 'off') return null;
    const look = live === 'live'
        ? { label: 'Live: following Tynn', className: 'text-[var(--success)]', glyph: <Icon name="radio" size="xs" /> }
        : live === 'reconnecting'
            ? { label: 'Reconnecting to Tynn', className: 'text-[var(--warning)]', glyph: <Icon name="wifi-off" size="xs" /> }
            : { label: 'Connecting to Tynn', className: 'text-[var(--fg-3)]', glyph: <Icon name="loader" size="xs" className="animate-spin" /> };
    return <span data-tynn-live={live} role="img" aria-label={look.label} title={look.label} className={`inline-flex p-1 ${look.className}`}>{look.glyph}</span>;
}

function Board({ state, onScope, onAction, onRefresh, onRetry, claimants, onLoadClaimants, live }: { state: Extract<TynnBoardState, { state: 'ready' }>; onScope: TynnBoardPanelProps['onScope']; onAction: TynnBoardPanelProps['onAction']; onRefresh?: (() => void) | undefined; onRetry?: (() => void) | undefined; claimants?: TynnBoardPanelProps['claimants']; onLoadClaimants?: (() => void) | undefined; live?: LiveState | undefined }) {
    const { view, refused = null, detail = null, detailRefused = null, op = null } = state;
    // Held across renders, so a live update does not hand every card a new claim object (and redraw them all).
    const claimRef = useRef<ClaimProps | null>(null);
    if (claimRef.current === null || claimRef.current.claims !== view.claims || claimRef.current.claimants !== claimants) claimRef.current = { claims: view.claims, claimants, onLoadClaimants };
    const claim = claimRef.current;
    const claimOp = op !== null && CLAIM_OP.test(op.action) ? op : null;
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
                        <LiveMark live={live} />
                        {onRefresh ? <IconButton icon="refresh-cw" label="Refresh" onClick={onRefresh} data={{ 'data-tynn-refresh': '' }} /> : null}
                    </span>
                </div>
                {claimOp ? <OpLine op={claimOp} onRetry={onRetry} /> : null}
                {refused ? <p data-tynn-board-refused="" role="alert" className="rounded bg-[var(--warning)]/10 px-2 py-1 text-[12px] text-[var(--warning)]">{refused}</p> : null}
                {detailRefused ? <p data-tynn-detail-refused="" role="alert" className="rounded bg-[var(--warning)]/10 px-2 py-1 text-[12px] text-[var(--warning)]">{detailRefused}</p> : null}
                <Kanban onCardMove={move} className="flex min-h-0 flex-1 items-start gap-2 overflow-x-auto">
                    {view.columns.map((col) => <Column key={col.status} column={col} view={view} scope={scope} override={shift} composer={col.status === start ? composer : null} onScope={onScope} onAction={onAction} claim={claim} />)}
                </Kanban>
            </div>
            {detail ? <Detail key={detail.id} detail={detail} op={op} onClose={() => onScope(scope)} onAction={onAction} onRetry={onRetry} /> : null}
        </div>
    );
}

export function TynnBoardPanel({ state, onScope, onAction, onRefresh, onRetry, claimants, onLoadClaimants, live }: TynnBoardPanelProps) {
    if (state.state === 'ready') return <Board state={state} onScope={onScope} onAction={onAction} onRefresh={onRefresh} onRetry={onRetry} claimants={claimants} onLoadClaimants={onLoadClaimants} live={live} />;
    const line = state.state === 'loading'
        ? <><Icon name="loader" size="xs" /> Reading Tynn…</>
        : state.state === 'not-linked'
            ? 'This workspace has no Tynn project.'
            : state.reason;
    return <p data-tynn-board-state={state.state} className="flex items-center gap-1.5 p-4 text-[12px] text-[var(--fg-3)]">{line}</p>;
}

/** Create, edit and the claim actions report their progress; workflow steps, drags and deletes keep the refused line. */
const REPORTS_PROGRESS = /\.(create|edit|claim-start|unclaim|assign)$/;
const CLAIM_START = /^(story|task)\.claim-start$/;

/** The tab: keeps the scope, reads the board, acts, and reads it again — a refused step stays on screen in Tynn's words. */
export function TynnBoardTab({ workspaceId, host }: { workspaceId: string; host: TynnBoardHost }) {
    const [scope, setScope] = useState<BoardScope>({});
    const [state, setState] = useState<TynnBoardState>({ state: 'loading' });
    const [op, setOp] = useState<BoardOp | null>(null);
    const [lastInput, setLastInput] = useState<BoardActionInput | null>(null);
    const [claimants, setClaimants] = useState<readonly Claimant[] | 'loading' | null>(null);
    const loadClaimants = useCallback(async () => {
        setClaimants('loading');
        const r = await host.act(workspaceId, { action: 'board.claimants', ids: {} });
        // A list Tynn will not show reads as nobody to assign, never a spinner that does not end.
        setClaimants(r.ok ? (r.claimants ?? []) : []);
    }, [host, workspaceId]);
    // Row B4: where the board is up to (its read's cursor, then each applied answer's), the scope and state as of now.
    const cursorRef = useRef<string | null>(null);
    const scopeRef = useRef(scope);
    scopeRef.current = scope;
    const stateRef = useRef(state);
    stateRef.current = state;
    const [live, setLive] = useState<LiveState | undefined>(undefined);
    const read = useCallback(async (at: BoardScope, refused: string | null = null) => {
        const r = await host.read(workspaceId, at);
        if (r.ok) cursorRef.current = r.view.cursor;
        if (r.ok) setState({ state: 'ready', view: r.view, refused, detail: r.detail ?? null, detailRefused: r.detailRefused ?? null });
        else setState(r.state === 'not-linked' ? { state: 'not-linked' } : r.state === 'signed-out' ? { state: 'signed-out', reason: r.reason } : { state: 'error', reason: r.reason });
    }, [host, workspaceId]);
    useEffect(() => { void read(scope); }, [read, scope]);
    const changeScope = (next: BoardScope) => { setOp(null); setScope(next); };
    const changeScopeRef = useRef(changeScope);
    changeScopeRef.current = changeScope;
    // LIVE (row B4): every ring is a doorbell — ask what changed since the cursor, apply only that. Never the whole board.
    useEffect(() => {
        const { watch, changes } = host;
        if (!watch || !changes) return undefined;
        let detail: BoardDetailRow | null | undefined;
        const follower = new BoardFollower({
            cursor: () => cursorRef.current,
            fetch: async (cursor, ids) => {
                const r = await changes(workspaceId, scopeRef.current, cursor, ids);
                if (!r.ok) return { ok: false, state: r.state, reason: r.reason };
                detail = r.detail;
                return { ok: true, changes: r.changes };
            },
            apply: (answer: BoardChanges) => {
                cursorRef.current = answer.cursor;
                const now = stateRef.current;
                const fresh = detail;
                detail = undefined;
                setState((s) => {
                    if (s.state !== 'ready') return s;
                    const r = applyBoardChanges(s.view, answer);
                    if (r.view === s.view && fresh === undefined) return s;
                    return { ...s, view: r.view, ...(fresh !== undefined && fresh !== null ? { detail: fresh, detailRefused: null } : {}) };
                });
                return now.state === 'ready' ? applyBoardChanges(now.view, answer).missing : [];
            },
            refused: (refusal) => {
                // A scope Tynn no longer shows (its story or version was deleted): one level up. Anything else: the
                // board's own read says what is wrong. A dropped connection is not a refusal; the next ring retries.
                if (refusal.state === 'error') return;
                const now = stateRef.current;
                const at = scopeRef.current;
                if (now.state === 'ready' && (at.story !== undefined || at.version !== undefined)) changeScopeRef.current(now.view.up ?? {});
                else void read(at);
            },
            schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        });
        const stop = watch(workspaceId, (signal) => {
            if ('state' in signal) setLive(signal.state);
            else follower.ring(signal.ring.ids, signal.ring.catchUp);
        });
        return () => { stop(); follower.stop(); setLive(undefined); };
    }, [host, workspaceId, read]);
    const act = async (input: BoardActionInput) => {
        const tracked = REPORTS_PROGRESS.test(input.action);
        if (tracked) setLastInput(input);
        const claimStart = CLAIM_START.exec(input.action);
        const r = claimStart
            ? await performClaimThenStart(host, workspaceId, claimStart[1] as 'story' | 'task', input.ids, setOp)
            : tracked ? await performBoardAction(host, workspaceId, input, setOp) : await host.act(workspaceId, input);
        if (!r.ok && (r.state === 'not-linked' || r.state === 'signed-out')) {
            setState(r.state === 'not-linked' ? { state: 'not-linked' } : { state: 'signed-out', reason: r.reason });
            return;
        }
        // A tracked action's failure is said by its own line (with Retry); the others keep the board's refused line.
        // The scope as it is NOW (a memoised card may hold an older handler).
        await read(scopeRef.current, r.ok || tracked ? null : r.reason);
    };
    const shown: TynnBoardState = state.state === 'ready' ? { ...state, op } : state;
    return (
        <TynnBoardPanel
            state={shown}
            onScope={changeScope}
            onAction={(input) => { void act(input); }}
            onRefresh={() => { void read(scope); }}
            onRetry={lastInput ? () => { void act(lastInput); } : undefined}
            claimants={claimants}
            onLoadClaimants={() => { void loadClaimants(); }}
            live={live}
        />
    );
}
