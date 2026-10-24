import { Icon, Modal } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { importedAgentsOffer, type ImportedAgent } from '../../core/agent-adoption.js';

/**
 * "IT CAME WITH AGENTS" (Add workspace parity item 6; Genie 1's WorkspaceBroughtAgents + ImportedAgents, genie#459). After
 * a workspace is added, the agents it brought on disk and has not registered here — each with Adopt, or the reason it
 * cannot be adopted — and Open workspace. Offered, never automatic. Adopting reads the AGENT.md and never rewrites it, and
 * the screen says so: the file is the thing a person is afraid for.
 *
 * The view is hook-free (a test renders and presses it); `ImportedAgentsModal` holds the list and the busy state.
 */

const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';
const primary = 'flex items-center gap-1.5 rounded-md bg-[var(--violet-500)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--violet-400)] disabled:opacity-50';
const muted = 'text-xs text-[var(--fg-3)]';

/**
 * The `.agents/*` with no registration here — ONE list for both screens (the offer after an add, the workspace's roster):
 * each with its button, or the reason Genie will not take it and no button. `verb` is the screen's word for it. Called as a
 * function, not mounted as a component: the views stay one hook-free tree a test can walk and press.
 */
function unregisteredAgentList({ agents, busy, verb, onAct }: { agents: readonly ImportedAgent[]; busy: string | null; verb: { action: string; label: string; busyLabel: string }; onAct: (name: string) => void }) {
    if (agents.length === 0) return null;
    return (
        <ul className="flex flex-col gap-1.5">
            {agents.map((a) => (
                <li key={a.name} data-imported-agent={a.name} className="flex items-start justify-between gap-3 rounded-md border border-[var(--border-1)] px-2.5 py-1.5">
                    <div className="flex min-w-0 flex-col">
                        <span className="font-mono text-xs font-semibold">{a.name}{a.provider ? <span className="ml-2 font-sans font-normal text-[var(--fg-3)]">{a.provider}</span> : null}</span>
                        <span className={`${muted} font-mono`}>{a.instructions}</span>
                        {a.refusal ? <span data-adopt-refusal="" className="text-xs text-[var(--danger)]">{a.refusal}</span> : null}
                    </div>
                    {a.refusal === null ? (
                        <button type="button" data-action={verb.action} data-agent={a.name} disabled={busy !== null} onClick={() => onAct(a.name)} className={button}>{busy === a.name ? verb.busyLabel : verb.label}</button>
                    ) : null}
                </li>
            ))}
        </ul>
    );
}

export interface ImportedAgentsViewProps {
    readonly workspaceName: string;
    readonly path: string | null;
    /** What is still unregistered. Empty once all are adopted: the screen stays, as the confirmation it worked. */
    readonly agents: readonly ImportedAgent[];
    /** The agent being adopted now; every Adopt waits for it. */
    readonly busy: string | null;
    readonly notice: string | null;
    readonly error: string | null;
    readonly onAdopt: (name: string) => void;
    readonly onOpen: () => void;
}

export function ImportedAgentsView({ workspaceName, path, agents, busy, notice, error, onAdopt, onOpen }: ImportedAgentsViewProps) {
    const offer = importedAgentsOffer(agents);
    return (
        <div data-imported-agents="" className="flex flex-col gap-3 text-sm">
            <div>
                <h2 className="text-base font-semibold">{workspaceName} is ready — and it came with agents</h2>
                <p className={muted}>
                    {path ? <>It is at <span className="font-mono">{path}</span>. </> : null}
                    Adopt an agent to have it back as it was. Skip, and its files stay in <span className="font-mono">.agents/</span>, unregistered.
                </p>
            </div>
            {offer.offer ? (
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold">{offer.headline}</span>
                    <span className={muted}>Their AGENT.md files came with the project; the registry that names them lives on each machine, so they arrive here unregistered. Adopt one to get it back — Genie reads its file, it never rewrites it — and you do not have to create a new agent to have it.</span>
                </div>
            ) : null}
            {error ? <p data-imported-agents-error="" className="rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-xs">{error}</p> : null}
            {notice ? <p data-imported-agents-notice="" role="status" className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1.5 text-xs">{notice}</p> : null}
            {unregisteredAgentList({ agents, busy, verb: { action: 'adopt-agent', label: 'Adopt', busyLabel: 'Adopting…' }, onAct: onAdopt })}
            <div className="flex items-center justify-end gap-2">
                <button type="button" data-action="open-workspace" disabled={busy !== null} onClick={onOpen} className={primary}><Icon name="check" size="xs" />Open workspace</button>
            </div>
        </div>
    );
}

export interface AgentRosterViewProps {
    /** The agents registered in this workspace. */
    readonly registered: readonly { readonly id: string; readonly name: string; readonly provider: string }[];
    /** Its `.agents/*` with no registration here; `null` = not read yet. */
    readonly onDisk: readonly ImportedAgent[] | null;
    /** The agent being reattached now; every Reattach waits for it. */
    readonly busy: string | null;
    readonly notice: string | null;
    readonly error: string | null;
    readonly onReattach: (name: string) => void;
}

/**
 * THE WORKSPACE'S AGENT ROSTER (agent management parity item 2; Genie 1's WorkspaceAgentRoster / AgentRosterList):
 * Registered, and On disk only — an agent unmounted from Genie, or one the workspace came with — each with Reattach, or the
 * reason it cannot come back. Reattaching is adoption: the same rules, the file read and never rewritten. Hook-free, so a
 * test renders and presses it; the list and the busy state live with whoever draws it (App.tsx).
 */
export function AgentRosterView({ registered, onDisk, busy, notice, error, onReattach }: AgentRosterViewProps) {
    return (
        <div data-agent-roster="" className="flex flex-col gap-3">
            <div data-roster-registered="" className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Registered</span>
                {registered.length === 0 ? (
                    <span className={muted}>No agents are registered here.</span>
                ) : (
                    <ul className="flex flex-wrap gap-1.5">
                        {registered.map((a) => (
                            <li key={a.id} data-roster-agent={a.name} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 font-mono text-xs">{a.name}<span className="ml-2 font-sans text-[var(--fg-3)]">{a.provider}</span></li>
                        ))}
                    </ul>
                )}
            </div>
            <div data-roster-on-disk="" className="flex flex-col gap-1">
                <span className="text-xs font-semibold">On disk only</span>
                <span className={muted}>An <span className="font-mono">.agents/&lt;name&gt;/AGENT.md</span> Genie has no registration for — unmounted, or brought by the project. Reattach reads its file; it never rewrites it.</span>
                {error ? <p data-imported-agents-error="" className="rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-xs">{error}</p> : null}
                {notice ? <p data-imported-agents-notice="" role="status" className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2.5 py-1.5 text-xs">{notice}</p> : null}
                {onDisk === null ? (
                    <span data-roster-on-disk-loading="" className={muted}>Reading .agents/…</span>
                ) : onDisk.length === 0 ? (
                    <span data-roster-on-disk-empty="" className={muted}>None: every agent file here is registered.</span>
                ) : (
                    unregisteredAgentList({ agents: onDisk, busy, verb: { action: 'reattach-agent', label: 'Reattach', busyLabel: 'Reattaching…' }, onAct: onReattach })
                )}
            </div>
        </div>
    );
}

export interface ImportedAgentsApi {
    adopt(workspaceId: string, name: string): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string }>;
}

/** The screen after an add, over the workspace it opened: adopt as many as wanted, then Open workspace (or close). */
export function ImportedAgentsModal({ shown, api, onClose }: { shown: { workspaceId: string; name: string; path: string | null; agents: readonly ImportedAgent[] } | null; api: ImportedAgentsApi; onClose: () => void }) {
    const [adopted, setAdopted] = useState<readonly string[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [forWorkspace, setForWorkspace] = useState<string | null>(null);
    if (!shown) return null;
    // A new workspace's screen starts clean.
    if (forWorkspace !== shown.workspaceId) { setForWorkspace(shown.workspaceId); setAdopted([]); setNotice(null); setError(null); setBusy(null); }
    const left = shown.agents.filter((a) => !adopted.includes(a.name));
    const close = () => { if (busy === null) onClose(); };
    return (
        <Modal open onClose={close} size="lg">
            <Modal.Header><span className="flex items-center gap-2"><Icon name="users" size="sm" />Agents in this workspace</span></Modal.Header>
            <Modal.Body>
                <ImportedAgentsView
                    workspaceName={shown.name}
                    path={shown.path}
                    agents={left}
                    busy={busy}
                    notice={notice}
                    error={error}
                    onOpen={close}
                    onAdopt={(name) => {
                        setBusy(name);
                        setError(null);
                        setNotice(null);
                        void api.adopt(shown.workspaceId, name)
                            .then((r) => {
                                if (!r.ok) { setError(r.reason); return; }
                                setAdopted((a) => [...a, name]);
                                // Name what happened and what it did NOT do.
                                setNotice(`${name} is registered. Its .agents/${name}/AGENT.md was read, not rewritten.`);
                            }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                            .finally(() => setBusy(null));
                    }}
                />
            </Modal.Body>
        </Modal>
    );
}
