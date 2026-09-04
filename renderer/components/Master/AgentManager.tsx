import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    Badge,
    Button,
    Callout,
    Input,
    Select,
    Tabs,
    Text,
    Textarea,
} from '@particle-academy/react-fancy';
import { api, type AgentManagerState, type AgentMode, type SidecarAction } from '../../lib/genie';
/* A ZERO-RUNTIME-IMPORT leaf, like `agents/registry` and `agent-manager-types`
   next to it — see `renderer/lib/__tests__/renderer-main-boundary.test.ts`. The
   labels and the framing sentence come FROM the module that hands them to the
   agent, so what a human is shown here and what the agent is actually told
   cannot drift apart. */
import {
    AGENT_MODES,
    agentModeLabel,
    agentModeSummary,
    attentionNudgeMode,
} from '../../../main/agents/agent-mode';
import {
    agentManagerTabs,
    mcpDriftNotice,
    mcpManagedNote,
    mcpRowAction,
    personaDraftFrom,
    personaEditFrom,
    personaIsDirty,
    sidecarMatchNote,
    sidecarSummary,
    type AgentManagerTabId,
    type PersonaDraft,
} from '../../lib/agent-manager';
import { agentTerminalTypes } from '../../lib/terminal-types';

/**
 * The AGENT MANAGER — Tynn #709, story #263.
 *
 * The owner asked on 2026-09-02 for "a full agent manager with agent prompt and
 * rules and MCP management" and opened *Agent settings — moic* to a driver
 * picker, a purpose field and two checkboxes. Everything the real surface needs
 * already existed with no way to reach it: `main/agents/agent-file.ts` reads and
 * writes `AGENT.md`, and `main/mcp/agent-config.ts` composes the MCP entries.
 * This is the missing UI over working plumbing, not a redesign — the identity
 * controls that were there are kept, and three tabs are added beside them.
 *
 *   Identity      — driver, workspace default, purpose, reachability, IssueWatch
 *   Prompt & rules — the agent's `AGENT.md`, front matter AND body
 *   MCP           — the servers this agent actually gets, and what may change
 *   Sidecar       — start / stop / restart
 *
 * Every judgement call lives in `renderer/lib/agent-manager.ts`, which is where
 * they are tested — the renderer has no DOM harness, so a decision left inline
 * here is a decision nobody can assert on.
 *
 * Two rules this surface will not bend:
 *
 *  - **A failed save is REPORTED.** Not a toast that fades and not a silent
 *    catch: the error sits on the tab until it is addressed. Genie's own MCP
 *    writers are best-effort on purpose (a locked file must not break
 *    provisioning), which is right for a background sync and wrong for a person
 *    who just pressed Save.
 *  - **The `genie` server cannot be removed.** An agent without it starts, draws
 *    a square and looks healthy, and can no longer report that it finished or
 *    ask anything. That is a footgun, so the control says no and says why.
 */

/** A labelled block, so the four tabs read as one surface. */
function Field({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: ReactNode;
    children: ReactNode;
}) {
    return (
        <label style={{ display: 'grid', gap: 4 }}>
            <Text size="sm" weight="medium">
                {label}
            </Text>
            {children}
            {hint && (
                <Text size="xs" color="muted">
                    {hint}
                </Text>
            )}
        </label>
    );
}

export default function AgentManager({
    agentId,
    identity,
    onChanged,
}: {
    agentId: string;
    /** The identity controls that already existed — driver switcher, workspace
     *  default, purpose, reachability, IssueWatch. Passed in rather than moved,
     *  so this replaces the surface without shrinking it. */
    identity: ReactNode;
    /** The roster changed underneath — rebuild the grid. */
    onChanged?: () => void;
}) {
    const [state, setState] = useState<AgentManagerState | null>(null);
    const [tab, setTab] = useState<AgentManagerTabId>('identity');
    const [draft, setDraft] = useState<PersonaDraft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState<string | null>(null);
    const [newServer, setNewServer] = useState({ name: '', url: '' });

    const load = useCallback(async () => {
        try {
            const next = await api().agents.managerState(agentId);
            setState(next);
            // The draft is re-seeded on every load, which is what makes Save →
            // reload leave a CLEAN form rather than one that still looks dirty
            // against the values it just wrote.
            if (next.persona) setDraft(personaDraftFrom(next.persona));
            if (!next.ok) setError(next.error ?? 'Could not read this agent.');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [agentId]);

    useEffect(() => {
        void load();
    }, [load]);

    const tabs = useMemo(
        () => (state ? agentManagerTabs(state) : []),
        [state],
    );
    const dirty = !!state?.persona && !!draft && personaIsDirty(state.persona, draft);

    /** One place that runs a write, reports its failure, and reloads. */
    const run = async (
        action: () => Promise<{ ok: boolean; error?: string }>,
        success: string,
    ): Promise<void> => {
        setBusy(true);
        setError(null);
        setSaved(null);
        try {
            const result = await action();
            if (!result.ok) {
                // NOT swallowed and NOT a fading toast. A write that did not
                // land has to stay on screen.
                setError(result.error ?? 'That did not work, and Genie was not told why.');
                return;
            }
            setSaved(success);
            await load();
            onChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    if (!state) {
        return (
            <Text size="sm" color="muted">
                Reading the agent…
            </Text>
        );
    }

    const persona = state.persona;
    const mcp = state.mcp;
    const sidecar = state.sidecar;
    const drift = mcp ? mcpDriftNotice(mcp) : null;
    const drivers = agentTerminalTypes();

    return (
        <div className="agent-manager">
            <Tabs
                activeTab={tab}
                onTabChange={(next) => setTab(next as AgentManagerTabId)}
                variant="underline"
            >
                <Tabs.List>
                    {tabs.map((t) => (
                        <Tabs.Tab key={t.id} value={t.id} data-testid={`agent-manager-tab-${t.id}`}>
                            {t.label}
                            {t.badge && (
                                <>
                                    {' '}
                                    <Badge size="sm" variant="soft">
                                        {t.badge}
                                    </Badge>
                                </>
                            )}
                        </Tabs.Tab>
                    ))}
                </Tabs.List>

                <Tabs.Panels className="agent-manager-panels">
                    {/* ── Identity — everything the old form did, unchanged ── */}
                    <Tabs.Panel value="identity">{identity}</Tabs.Panel>

                    {/* ── Prompt & rules — the agent's AGENT.md ───────────── */}
                    <Tabs.Panel value="prompt">
                        {persona && draft ? (
                            <div style={{ display: 'grid', gap: 12, paddingTop: 8 }}>
                                <Text size="xs" color="muted">
                                    {persona.exists ? (
                                        <>
                                            <code>{persona.path}</code> — committed with the
                                            project, so a teammate cloning it gets this agent.
                                        </>
                                    ) : (
                                        <>
                                            This agent has no <code>AGENT.md</code> yet. Saving
                                            writes one at <code>{persona.path}</code>.
                                        </>
                                    )}
                                </Text>

                                <Field
                                    label="Purpose"
                                    hint="What this agent is for. Written to the file's front matter and mirrored onto the record."
                                >
                                    <Input
                                        data-testid="agent-manager-purpose"
                                        value={draft.purpose}
                                        onChange={(e) =>
                                            setDraft({ ...draft, purpose: e.target.value })
                                        }
                                    />
                                </Field>

                                <Field
                                    label="Mode"
                                    hint={agentModeSummary(draft.mode)}
                                >
                                    <Select
                                        data-testid="agent-manager-mode"
                                        value={draft.mode}
                                        onValueChange={(next: string) =>
                                            setDraft({ ...draft, mode: next as AgentMode })
                                        }
                                        list={AGENT_MODES.map((mode) => ({
                                            value: mode,
                                            label: agentModeLabel(mode),
                                        }))}
                                    />
                                </Field>

                                {/* The exact sentence, not a paraphrase of it.
                                    The wording IS the feature, so a human
                                    choosing between the two modes is shown what
                                    their agent will actually be handed. */}
                                <Callout color="slate">
                                    <Text size="xs">
                                        Genie’s notices to this agent — the upgrade
                                        announcement, AgentInbox notices, attention nudges and
                                        the boot prompt — will carry:{' '}
                                        <em>{attentionNudgeMode(draft.mode)}</em> This changes
                                        how Genie <strong>words</strong> what it tells the
                                        agent. It is not a permission boundary: what an agent
                                        is allowed to do is decided by the approval gates on{' '}
                                        <code>runAgent</code>, <code>manageProcess</code> and
                                        the rest, whichever mode it is in.
                                    </Text>
                                </Callout>

                                <Field
                                    label="Scope"
                                    hint="A workspace-relative folder the agent boots in. Leave empty for the whole workspace."
                                >
                                    <Input
                                        value={draft.scope}
                                        placeholder="repos/genie"
                                        onChange={(e) =>
                                            setDraft({ ...draft, scope: e.target.value })
                                        }
                                    />
                                </Field>

                                <Field
                                    label="Drivers this agent may run under"
                                    hint="An agent is not its TUI. Leave every box clear to place no restriction."
                                >
                                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                        {drivers.map((d) => {
                                            const id = String(d.agent);
                                            const on = draft.tuis.includes(id);
                                            return (
                                                <label
                                                    key={id}
                                                    style={{
                                                        display: 'flex',
                                                        gap: 6,
                                                        alignItems: 'center',
                                                    }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={on}
                                                        onChange={() =>
                                                            setDraft({
                                                                ...draft,
                                                                tuis: on
                                                                    ? draft.tuis.filter(
                                                                          (t) => t !== id,
                                                                      )
                                                                    : [...draft.tuis, id],
                                                            })
                                                        }
                                                    />
                                                    <Text size="sm">{d.label}</Text>
                                                </label>
                                            );
                                        })}
                                    </div>
                                </Field>

                                <Field
                                    label="Prompt and rules"
                                    hint="The agent's system prompt, verbatim. Markdown; it is the body of AGENT.md."
                                >
                                    <Textarea
                                        data-testid="agent-manager-body"
                                        value={draft.body}
                                        minRows={10}
                                        maxRows={24}
                                        spellCheck={false}
                                        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                                    />
                                </Field>

                                {persona.extra.length > 0 && (
                                    <Callout color="slate">
                                        <Text size="xs">
                                            This file also carries{' '}
                                            {persona.extra
                                                .map((x) => `${x.key}: ${x.value}`)
                                                .join(', ')}
                                            . Genie has no field for {persona.extra.length === 1
                                                ? 'it'
                                                : 'them'}{' '}
                                            and writes {persona.extra.length === 1 ? 'it' : 'them'}{' '}
                                            back untouched.
                                        </Text>
                                    </Callout>
                                )}

                                <div style={{ display: 'flex', gap: 8 }}>
                                    <Button
                                        onClick={() =>
                                            void run(
                                                () =>
                                                    api().agents.savePersona(
                                                        agentId,
                                                        personaEditFrom(persona, draft),
                                                    ),
                                                'Saved AGENT.md.',
                                            )
                                        }
                                        disabled={!dirty || busy}
                                        data-testid="agent-manager-save"
                                    >
                                        {busy ? 'Saving…' : 'Save AGENT.md'}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        onClick={() => setDraft(personaDraftFrom(persona))}
                                        disabled={!dirty || busy}
                                    >
                                        Revert
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <Text size="sm" color="muted">
                                This agent has no AGENT.md path recorded.
                            </Text>
                        )}
                    </Tabs.Panel>

                    {/* ── MCP — what this agent actually gets ─────────────── */}
                    <Tabs.Panel value="mcp">
                        {mcp ? (
                            <div style={{ display: 'grid', gap: 12, paddingTop: 8 }}>
                                <Text size="xs" color="muted">
                                    {state.agent?.tui ?? 'This agent'} reads{' '}
                                    <code>{mcp.configPath}</code>.
                                </Text>

                                {drift && drift.tone !== 'none' && (
                                    <Callout color={drift.tone === 'warn' ? 'amber' : 'slate'}>
                                        <div style={{ display: 'grid', gap: 8 }}>
                                            <Text size="sm">{drift.text}</Text>
                                            {drift.canRestart && state.agent?.terminalSpecId && (
                                                <div>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        data-testid="agent-manager-restart"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void run(async () => {
                                                                /* The GRACEFUL restart (wish #88):
                                                                   relaunches with the provider's
                                                                   RESUME grammar, so the TUI
                                                                   re-reads the MCP config and the
                                                                   conversation survives.
                                                                   `agents.start` would REATTACH a
                                                                   bound terminal — reloading
                                                                   nothing while reporting success,
                                                                   which is the silence this tab
                                                                   exists to end. */
                                                                const r =
                                                                    await api().terminalSpec.restartAgent(
                                                                        state.agent!.terminalSpecId!,
                                                                    );
                                                                return r.ok
                                                                    ? { ok: true }
                                                                    : { ok: false, error: r.error };
                                                            }, 'Relaunching the agent — it resumes where it left off.')
                                                        }
                                                    >
                                                        Restart {state.agent?.name}
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    </Callout>
                                )}

                                {mcp.servers.length === 0 ? (
                                    <Text size="sm" color="muted">
                                        No MCP servers in {mcp.configPath}. This agent has no tools
                                        beyond its own — including no way to reach Genie.
                                    </Text>
                                ) : (
                                    <div style={{ display: 'grid', gap: 6 }}>
                                        {mcp.servers.map((server) => {
                                            const action = mcpRowAction(server, mcp.editable);
                                            const note = mcpManagedNote(server);
                                            return (
                                                <div
                                                    key={server.name}
                                                    data-testid="agent-manager-mcp-row"
                                                    data-server={server.name}
                                                    style={{
                                                        display: 'flex',
                                                        gap: 8,
                                                        alignItems: 'flex-start',
                                                        justifyContent: 'space-between',
                                                    }}
                                                >
                                                    <div style={{ display: 'grid', gap: 2 }}>
                                                        <Text size="sm" weight="medium">
                                                            {server.name}
                                                            {server.required && (
                                                                <>
                                                                    {' '}
                                                                    <Badge
                                                                        size="sm"
                                                                        variant="soft"
                                                                        color="emerald"
                                                                    >
                                                                        required
                                                                    </Badge>
                                                                </>
                                                            )}
                                                        </Text>
                                                        {server.detail && (
                                                            <Text size="xs" color="muted">
                                                                <code>{server.detail}</code>
                                                            </Text>
                                                        )}
                                                        {note && (
                                                            <Text size="xs" color="muted">
                                                                {note}
                                                            </Text>
                                                        )}
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        data-testid="agent-manager-mcp-remove"
                                                        disabled={!action.canRemove || busy}
                                                        title={action.reason ?? undefined}
                                                        onClick={() =>
                                                            void run(
                                                                () =>
                                                                    api().agents.mcpRemove(
                                                                        agentId,
                                                                        server.name,
                                                                    ),
                                                                `Removed ${server.name}.`,
                                                            )
                                                        }
                                                    >
                                                        Remove
                                                    </Button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                {/* The refusal, stated where the human is standing rather
                                    than only in a disabled button's tooltip. */}
                                {mcp.servers.some((s) => s.required) && (
                                    <Text size="xs" color="muted">
                                        The <code>genie</code> server is not optional — it is how
                                        this agent tells you it has finished and asks you
                                        questions. Genie will not remove it.
                                    </Text>
                                )}

                                {mcp.editable ? (
                                    <div style={{ display: 'grid', gap: 6 }}>
                                        <Text size="sm" weight="medium">
                                            Add a server
                                        </Text>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <Input
                                                value={newServer.name}
                                                placeholder="name"
                                                onChange={(e) =>
                                                    setNewServer({
                                                        ...newServer,
                                                        name: e.target.value,
                                                    })
                                                }
                                            />
                                            <Input
                                                value={newServer.url}
                                                placeholder="https://example.com/mcp"
                                                onChange={(e) =>
                                                    setNewServer({
                                                        ...newServer,
                                                        url: e.target.value,
                                                    })
                                                }
                                            />
                                            <Button
                                                variant="ghost"
                                                disabled={
                                                    busy ||
                                                    !newServer.name.trim() ||
                                                    !newServer.url.trim()
                                                }
                                                onClick={() =>
                                                    void run(async () => {
                                                        const result = await api().agents.mcpAdd(
                                                            agentId,
                                                            {
                                                                kind: 'http',
                                                                name: newServer.name.trim(),
                                                                url: newServer.url.trim(),
                                                            },
                                                        );
                                                        if (result.ok)
                                                            setNewServer({ name: '', url: '' });
                                                        return result;
                                                    }, 'Added the server.')
                                                }
                                            >
                                                Add
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <Text size="xs" color="muted">
                                        Genie reads <code>{mcp.configPath}</code> but does not
                                        rewrite it — it only owns the fenced block it wrote. Edit
                                        that file to change this list.
                                    </Text>
                                )}
                            </div>
                        ) : null}
                    </Tabs.Panel>

                    {/* ── Sidecar ────────────────────────────────────────── */}
                    <Tabs.Panel value="sidecar">
                        {sidecar ? (
                            <div style={{ display: 'grid', gap: 12, paddingTop: 8 }}>
                                <Text size="sm" data-testid="agent-manager-sidecar-summary">
                                    {sidecarSummary(sidecar)}
                                </Text>
                                {sidecarMatchNote(sidecar) && (
                                    <Text size="xs" color="muted">
                                        {sidecarMatchNote(sidecar)}
                                    </Text>
                                )}
                                {sidecar.actions.length > 0 && (
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        {sidecar.actions.map((action) => (
                                            <Button
                                                key={action}
                                                variant={action === 'stop' ? 'ghost' : 'default'}
                                                disabled={busy}
                                                onClick={() =>
                                                    void run(
                                                        () =>
                                                            api().agents.sidecarAction(
                                                                agentId,
                                                                action as SidecarAction,
                                                            ),
                                                        `${action[0]!.toUpperCase()}${action.slice(1)}ed ${sidecar.name}.`,
                                                    )
                                                }
                                            >
                                                {action === 'start'
                                                    ? 'Start sidecar'
                                                    : action === 'stop'
                                                      ? 'Stop sidecar'
                                                      : 'Restart sidecar'}
                                            </Button>
                                        ))}
                                    </div>
                                )}
                                {sidecar.exists && (
                                    <Text size="xs" color="muted">
                                        Stopping kills the sidecar’s terminals and keeps its
                                        record, its inbox and its AGENT.md — a pause, not a delete.
                                    </Text>
                                )}
                            </div>
                        ) : null}
                    </Tabs.Panel>
                </Tabs.Panels>
            </Tabs>

            {/* A failed write STAYS on screen. */}
            {error && (
                <Callout color="red" data-testid="agent-manager-error">
                    <Text size="sm">{error}</Text>
                </Callout>
            )}
            {saved && !error && (
                <Text size="xs" color="success" data-testid="agent-manager-saved">
                    {saved}
                </Text>
            )}
        </div>
    );
}
