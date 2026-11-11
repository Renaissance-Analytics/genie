import { Button, Skeleton } from '@particle-academy/react-fancy';
import type { TynnProject } from '../../core/tynn.js';

/**
 * What the host answered for the signed-in person's projects; `null` while it is asking. `added`: a project already added
 * here, by the id of its workspace (workspace-ops-host.ts listTynnProjects).
 */
export type TynnProjectsView = { ok: true; host: string; projects: readonly TynnProject[]; added?: Readonly<Record<string, string>> } | { ok: false; reason: string } | null;

/**
 * Brought into view when it appears (Tynn #688): these sections are drawn at the top of a page the person may have
 * scrolled far down. One function for every mount, so React calls it when the element appears and not at each redraw.
 */
export function bringIntoView(el: HTMLElement | null): void {
    el?.scrollIntoView?.({ block: 'nearest' });
}

/**
 * FROM TYNN, STEP ONE — PICK THE PROJECT (§6.1; Genie 1's "your Tynn projects"). The signed-in person's projects, each a
 * button that picks THAT one; then the host's folder picker and the plan. Loading, none, and Tynn's refusal each say so.
 * A project already added here stays in the list, marked "— already added" (Genie 1's AddWorkspaceModal), and opens its
 * workspace instead of starting a second clone.
 *
 * `planning` (Tynn #688): the project whose plan is being read after its folder was picked. Its row says so, and nothing
 * else can be picked until the host has answered.
 */
export function TynnProjectPicker({ state, planning, onPick, onOpen, onCancel }: { state: TynnProjectsView; planning?: string | null | undefined; onPick: (projectId: string) => void; onOpen?: ((workspaceId: string) => void) | undefined; onCancel: () => void }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-3 py-1.5 text-sm';
    return (
        <section ref={bringIntoView} data-tynn-picker="" {...(planning ? { 'data-tynn-planning': planning } : {})} className="mx-auto my-4 flex max-w-xl flex-col gap-3 rounded-xl border border-[var(--border-1)] bg-[var(--bg-1)] p-4 text-sm">
            <p className="font-semibold">Add a workspace from Tynn</p>
            {state === null ? (
                <div data-skeleton="true" className="flex flex-col gap-2">
                    <Skeleton shape="text" width="70%" />
                    <Skeleton shape="text" width="55%" />
                </div>
            ) : !state.ok ? (
                <p className="text-[var(--danger)]">{state.reason}</p>
            ) : state.projects.length === 0 ? (
                <p className="text-[var(--fg-3)]">You have no projects on Tynn yet ({state.host}). Create one there, then come back.</p>
            ) : (
                <>
                    <p className="text-xs text-[var(--fg-3)]">Your projects on <span className="font-mono">{state.host}</span>. Next you pick the parent folder, and Genie shows the plan. Nothing is written until you confirm it.</p>
                    <ul data-tynn-projects={state.projects.length} className="flex flex-col gap-1">
                        {state.projects.map((p) => {
                            const added = state.added?.[p.id];
                            const reading = planning === p.id;
                            return (
                                <li key={p.id}>
                                    <Button size="xs" labelClassName="contents"
                                        type="button"
                                        data-tynn-project={p.id}
                                        {...(added ? { 'data-tynn-added': added } : {})}
                                        loading={reading}
                                        disabled={Boolean(planning)}
                                        className="flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--bg-2)] justify-start"
                                        onClick={() => (planning ? undefined : added ? onOpen?.(added) : onPick(p.id))}
                                    >
                                        <span className="font-medium">{p.name}</span>
                                        <span className="font-mono text-xs text-[var(--fg-3)]">{p.slug}</span>
                                        {reading ? <span role="status" className="ml-auto text-xs text-[var(--fg-2)]">Reading {p.name}’s plan…</span> : null}
                                        {added ? (
                                            <>
                                                <span className="text-xs text-[var(--fg-3)]">— already added</span>
                                                <span className="ml-auto text-xs text-[var(--primary)]">Open workspace</span>
                                            </>
                                        ) : null}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
            <div><Button size="xs" type="button" data-action="cancel-tynn-pick" className={button} onClick={onCancel}>Cancel</Button></div>
        </section>
    );
}
