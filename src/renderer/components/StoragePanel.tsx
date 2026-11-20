import { Button, Icon } from '@particle-academy/react-fancy';
import { useEffect, useRef, useState } from 'react';
import {
    CATEGORY_LABEL, CLEANUP_GROUPS, STORAGE_CATEGORIES, WORKTREE_STATE_LABEL, approvalFor, cleanupGroup, formatBytes, itemKind, originLabel, suggestedCleanup, uniqueItems,
    type StorageCategory, type StorageView,
} from '../../core/workspace-storage.js';
import type { ActOutcome, FeatureAction } from '../features.js';

/**
 * THE WORKSPACE'S STORAGE TAB (Tynn #697): how much disk the workspace takes, by category; Move to .trash on what may be
 * reclaimed, the reason in words on what may not; what is in .trash, where each thing came from, and Restore; and Empty
 * trash, which deletes for good, only after a confirmation that names every entry and the total.
 */
const ICON: Readonly<Record<StorageCategory, string>> = { repos: 'git-branch', worktrees: 'folder', 'ci-artifacts': 'package', 'chat-files': 'image', dirty: 'inbox', trash: 'trash-2' };

export function StoragePanel({ workspaceId, view, onAction: send }: { workspaceId: string; view: StorageView | null; onAction: (action: FeatureAction) => void | Promise<ActOutcome | void> }) {
    const [confirming, setConfirming] = useState(false);
    const [cleaning, setCleaning] = useState(false);
    // The host's refusal of an action itself (another Move still running, a workspace not open): drawn here, never only in
    // the console (Tynn #947).
    const [refusal, setRefusal] = useState<string | null>(null);
    const onAction = (action: FeatureAction): void => {
        setRefusal(null);
        void Promise.resolve(send(action)).then((answer) => { if (answer && !answer.ok) setRefusal(answer.reason); }, (error: unknown) => setRefusal(error instanceof Error ? error.message : String(error)));
    };
    const progress = view?.progress ?? null;
    const busy = progress !== null;
    const failures = view?.failures ?? [];
    // Never measured here yet: ask once, when the tab opens.
    const asked = useRef(false);
    useEffect(() => {
        if (asked.current || view?.report || view?.measuring) return;
        asked.current = true;
        onAction({ kind: 'storage.measure', workspaceId });
    }, [view, onAction, workspaceId]);

    const report = view?.report ?? null;
    // The one-click clean-up preselects only what is safe (core/workspace-storage.ts suggestedCleanup); the host checks again.
    // Each item once, however often it was sent (Tynn #946: repos/genie2-vm was listed twice).
    const listed = report ? uniqueItems(report.items) : [];
    const suggestedIds = report ? suggestedCleanup(listed, report.measuredAt) : [];
    const suggested = listed.filter((i) => suggestedIds.includes(i.id));
    // The confirmation, grouped by kind with each group's size (Tynn #946).
    const groups = CLEANUP_GROUPS.map((g) => ({ name: g, list: suggested.filter((i) => cleanupGroup(i) === g) })).filter((g) => g.list.length > 0);
    const suggestedBytes = suggested.reduce((n, i) => n + i.bytes, 0);
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    return (
        <section data-storage="" className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-semibold">Storage</h2>
                {view?.measuring ? <span className="text-xs text-[var(--fg-3)]">Measuring…</span> : null}
                {report ? <span className="text-xs text-[var(--fg-3)]">{`Measured ${new Date(report.measuredAt).toLocaleString()}${report.truncated ? ' (some folders were too large to finish: at least these sizes)' : ''}`}</span> : null}
                <Button size="xs" type="button" icon="refresh-cw" data-action="storage-measure" className={`${button} justify-start`} disabled={view?.measuring === true} onClick={() => onAction({ kind: 'storage.measure', workspaceId })}>Measure again</Button>
            </div>
            {/* What the host is doing and what it did, kept in view above a list that can be hundreds of rows (Tynn #947). */}
            {view?.error || refusal || progress || view?.outcome || failures.length > 0 ? (
                <div data-storage-status="" aria-live="polite" className="sticky top-0 z-10 flex flex-col gap-1.5 rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] p-3">
                    {view?.error ? <p data-storage-error="" className="text-sm text-[var(--danger)]">{view.error}</p> : null}
                    {refusal ? <p data-storage-refusal="" role="alert" className="text-sm text-[var(--danger)]">{refusal}</p> : null}
                    {progress ? (
                        <div data-storage-progress="" className="flex flex-col gap-1 text-sm">
                            <span>{`${progress.action === 'move' ? 'Moving to .trash' : 'Emptying .trash'}: ${progress.done} of ${progress.total} (${formatBytes(progress.bytes)})`}</span>
                            <progress className="h-1.5 w-full" max={Math.max(progress.total, 1)} value={progress.done} aria-label={progress.action === 'move' ? 'Moving to .trash' : 'Emptying .trash'} />
                            {progress.current ? <span className="truncate font-mono text-xs text-[var(--fg-3)]">{progress.current}</span> : null}
                        </div>
                    ) : null}
                    {view?.outcome ? <p data-storage-outcome="" className="text-sm text-[var(--fg-2)]">{view.outcome}</p> : null}
                    {failures.length > 0 ? (
                        <ul data-storage-failures="" className="max-h-40 list-disc overflow-auto pl-5 text-xs">
                            {failures.map((f, n) => <li key={`${f.label}-${n}`} data-storage-failure=""><span className="font-mono">{f.label}</span>{`: ${f.reason}`}</li>)}
                        </ul>
                    ) : null}
                </div>
            ) : null}
            {!report ? (view?.measuring || !view ? <p className="text-sm text-[var(--fg-3)]">Measuring this workspace…</p> : null) : (
                <>
                    <div className="flex flex-wrap gap-2">
                        {STORAGE_CATEGORIES.map((c) => (
                            <div key={c} data-storage-total={c} className="flex items-center gap-2 rounded-lg border border-[var(--border-1)] px-3 py-2 text-sm">
                                <Icon name={ICON[c]} size="sm" />
                                <span>{CATEGORY_LABEL[c]}</span>
                                <span className="font-mono text-[var(--fg-2)]">{formatBytes(report.totals[c])}</span>
                            </div>
                        ))}
                        <div data-storage-reclaimable="" className="flex items-center gap-2 rounded-lg bg-[var(--bg-2)] px-3 py-2 text-sm">
                            <span>Can be moved to .trash</span>
                            <span className="font-mono">{formatBytes(report.reclaimableBytes)}</span>
                        </div>
                    </div>
                    {suggested.length > 0 && !cleaning ? (
                        <div><Button size="xs" type="button" icon="sparkles" data-action="storage-cleanup" disabled={busy} className={`${button} justify-start`} onClick={() => setCleaning(true)}>{`Clean up merged worktrees and old test results (${suggested.length}, ${formatBytes(suggestedBytes)})`}</Button></div>
                    ) : null}
                    {cleaning && suggested.length > 0 ? (
                        <div data-storage-confirm-cleanup="" role="alertdialog" aria-label="Clean up" className="flex flex-col gap-2 rounded-lg border border-[var(--border-1)] p-3 text-sm">
                            <p className="font-medium">{`Move ${suggested.length} ${suggested.length === 1 ? 'item' : 'items'} (${formatBytes(suggestedBytes)}) to .trash? Nothing is deleted until you empty the trash.`}</p>
                            {groups.map((g) => (
                                <div key={g.name} data-cleanup-group={g.name} className="flex flex-col gap-1">
                                    <h4 className="text-xs font-semibold text-[var(--fg-2)]">{`${g.name} · ${g.list.length} · ${formatBytes(g.list.reduce((n, i) => n + i.bytes, 0))}`}</h4>
                                    <ul className="list-disc pl-5 text-xs">
                                        {g.list.map((i) => <li key={i.id}><span className="font-mono">{`${i.label} · ${formatBytes(i.bytes)}`}</span>{` · ${itemKind(i)}`}</li>)}
                                    </ul>
                                </div>
                            ))}
                            <div className="flex gap-2">
                                <Button size="xs" type="button" icon="archive" data-action="storage-cleanup-confirm" disabled={busy} className={`${button} justify-start`} onClick={() => { setCleaning(false); onAction({ kind: 'storage.cleanUp', workspaceId, itemIds: suggested.map((i) => i.id) }); }}>Move to .trash</Button>
                                <Button size="xs" type="button" icon="x" data-action="storage-cleanup-cancel" className={`${button} justify-start`} onClick={() => setCleaning(false)}>Cancel</Button>
                            </div>
                        </div>
                    ) : null}
                    {STORAGE_CATEGORIES.filter((c) => c !== 'trash').map((c) => {
                        const list = listed.filter((i) => i.category === c);
                        if (list.length === 0) return null;
                        return (
                            <div key={c} data-storage-category={c} className="flex flex-col gap-1">
                                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-[var(--fg-3)]"><Icon name={ICON[c]} size="xs" />{CATEGORY_LABEL[c]}<span className="font-mono normal-case">{` · ${list.length} · ${formatBytes(list.reduce((n, i) => n + i.bytes, 0))}`}</span></h3>
                                {list.map((i) => (
                                    <div key={i.id} data-storage-item={i.id} className="flex flex-wrap items-center gap-3 text-sm">
                                        <span className="min-w-0 truncate font-mono text-xs">{i.label}</span>
                                        <span data-storage-kind="" className="text-xs text-[var(--fg-2)]">{itemKind(i)}</span>
                                        <span className="font-mono text-xs text-[var(--fg-3)]">{`${formatBytes(i.bytes)}${i.truncated ? '+' : ''}`}</span>
                                        {i.state ? <span data-worktree-state={i.state} className="text-xs text-[var(--fg-2)]">{WORKTREE_STATE_LABEL[i.state]}{i.external ? ' · outside this workspace' : ''}</span> : null}
                                        {i.reclaimable ? (
                                            <Button size="xs" type="button" icon="archive" data-action="storage-trash" disabled={busy} data-item={i.id} className={`${button} justify-start`} onClick={() => onAction({ kind: 'storage.trash', workspaceId, itemId: i.id })}>Move to .trash</Button>
                                        ) : i.refusal ? <span className="text-xs text-[var(--warning)]">{i.refusal}</span> : null}
                                    </div>
                                ))}
                            </div>
                        );
                    })}
                    <div data-storage-category="trash" className="flex flex-col gap-1">
                        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase text-[var(--fg-3)]"><Icon name="trash-2" size="xs" />.trash</h3>
                        {report.trash.length === 0 ? <p className="text-xs text-[var(--fg-3)]">Empty.</p> : null}
                        {report.trash.map((t) => (
                            <div key={t.id} data-trash-entry={t.id} className="flex flex-wrap items-center gap-3 text-sm">
                                <span className="min-w-0 truncate font-mono text-xs">{originLabel(t.origin)}</span>
                                <span className="font-mono text-xs text-[var(--fg-3)]">{formatBytes(t.bytes)}</span>
                                {t.origin.kind !== 'unknown' ? (
                                    <Button size="xs" type="button" icon="rotate-ccw" data-action="storage-restore" disabled={busy} data-item={t.id} className={`${button} justify-start`} onClick={() => onAction({ kind: 'storage.restore', workspaceId, trashId: t.id })}>Restore</Button>
                                ) : null}
                            </div>
                        ))}
                        {report.trash.length > 0 && !confirming ? (
                            <div><Button size="xs" type="button" icon="trash-2" data-action="storage-empty-trash" disabled={busy} className={`${button} justify-start`} onClick={() => setConfirming(true)}>Empty trash</Button></div>
                        ) : null}
                        {confirming && report.trash.length > 0 ? (
                            <div data-storage-confirm-empty="" role="alertdialog" aria-label="Empty trash" className="flex flex-col gap-2 rounded-lg border border-[var(--danger)] p-3 text-sm">
                                <p className="font-medium">{`Delete ${report.trash.length} ${report.trash.length === 1 ? 'item' : 'items'} (${formatBytes(report.totals.trash)}) from .trash for good? This cannot be undone.`}</p>
                                <ul className="list-disc pl-5 font-mono text-xs">
                                    {report.trash.map((t) => <li key={t.id}>{`${originLabel(t.origin)} · ${formatBytes(t.bytes)}`}</li>)}
                                </ul>
                                <div className="flex gap-2">
                                    <Button size="xs" type="button" icon="trash-2" data-action="storage-empty-confirm" disabled={busy} className={`${button} justify-start border-[var(--danger)] text-[var(--danger)]`} onClick={() => { setConfirming(false); onAction({ kind: 'storage.emptyTrash', workspaceId, approval: approvalFor(report.trash) }); }}>Delete for good</Button>
                                    <Button size="xs" type="button" icon="x" data-action="storage-empty-cancel" className={`${button} justify-start`} onClick={() => setConfirming(false)}>Cancel</Button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </>
            )}
        </section>
    );
}
