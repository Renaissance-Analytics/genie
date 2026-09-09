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
    agentRunControl,
    driverRows,
    driverSummary,
    mcpDriftNotice,
    mcpManagedNote,
    mcpRowAction,
    personaDraftFrom,
    personaEditFrom,
    personaIsDirty,
    sidecarActionLabel,
    sidecarDoneMessage,
    sidecarMatchNote,
    sidecarSummary,
    type AgentManagerTabId,
    type PersonaDraft,
} from '../../lib/agent-manager';
import { agentTerminalTypes } from '../../lib/terminal-types';
import { canResumeTui } from '../../../main/agents/registry';
import type { RestartMode } from '../../../main/agents/restart-options';

/**
 * The AGENT MANAGER — Tynn #709, story #263.
 *
 * The owner asked on 2026-09-02 for "a full agent manager with agent prompt and
 * rules and MCP management" and opened *Agent settings — moic* to a driver
 * picker, a purpose field and two checkboxes. Everything the real surface needs
 * already existed with no way to reach it: `main/agents/agent-file.ts` reads and
 * writes `AGENT.md`, and `main/mcp/agent-config.ts` composes the MCP entries.
 * This is the missing UI over working plumbing, not a redesign — the identity
 * controls that were there are kept, and four tabs are added beside them.
 *
 *   Identity      — workspace default, purpose, reachability, IssueWatch
 *   Driver        — what it runs under, its sidecars, its mark, and its RUN
 *   Prompt & rules — the agent's `AGENT.md`, front matter AND body
 *   MCP           — the servers this agent actually gets, and what may change
 *   Sidecar       — the `<name>-slave` AGENT: start / stop / restart
 *
 * The Driver tab is genie#463 and #474: `switchTui` and `stop` were verbs an
 * agent had over MCP and a human had nowhere. The driver picker that used to sit
 * in the Identity row moved here rather than being duplicated — this is the one
 * place in the manager that answers "what is this agent running under, and is it
 * running".
 *
 * A NOTE ON THE WORD SIDECAR, which this modal now uses for two different things
 * because the product does. On the Driver tab it is a parked TUI RUNTIME of THIS
 * agent (`runAgent switchTui`'s meaning, and `protocol.ts`'s). On the Sidecar tab
 * it is a separate AGENT named `<name>-slave` (`sidecar-control.ts`'s meaning).
 * The copy on each tab says which; renaming either concept is a bigger change
 * than these issues.
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

/**
 * THE DRIVER PANEL — genie#463 and #474.
 *
 * Two verbs an agent has had over MCP since v55 and a human had nowhere:
 * `switchTui` and `stop`. The manager's four tabs did not include a driver at
 * all, so the only place a person ever picked a TUI was `NewAgentModal` — at
 * creation, once, and never again; and the only control pointing the other way
 * from Start was Delete, which is a different verb with a different consequence.
 *
 * Two rules this panel holds to:
 *
 *  - **It never offers a switch the host would refuse.** The rows come from
 *    `driverRows`, which is `decideTuiSwitch` — the SAME decision
 *    `runAgent switchTui` and `agentRecordAddRuntime` make. An agent whose
 *    `AGENT.md` lists `tuis:` gets the host's own reason where the button would
 *    have been. An EMPTY list is "no opinion", not "none".
 *  - **Switching is ONE action.** Flipping to a parked driver and adding one it
 *    has never run are the same gesture; the row's state is what tells you
 *    whether a conversation is waiting on the other side. Nothing here stops
 *    anything — that is what the run control above is for, and it says so.
 *
 * Presentational and EXPORTED so it can be rendered in a test, the same reason
 * `AgentRosterList` is: the renderer has no DOM harness, and this is a surface
 * with four genuinely different row shapes.
 */
export function AgentDriverPanel({
    agent,
    drivers,
    busy,
    avatar,
    avatarError,
    onAvatarChange,
    onSwitch,
    onRun,
}: {
    agent: NonNullable<AgentManagerState['agent']>;
    drivers: { tui: string; label: string }[];
    busy: boolean;
    /** The agent's own mark, as the form holds it. */
    avatar: string;
    avatarError: string | null;
    onAvatarChange: (next: string) => void;
    onSwitch: (tui: string) => void;
    onRun: (action: 'stop' | 'start') => void;
}) {
    const rows = driverRows({
        drivers,
        runtimes: agent.runtimes,
        allowed: agent.allowedTuis,
        // `state.agent.tui` is main's `effectiveTui` — the fronted runtime, else
        // the record. An agent that has never started has no runtime at all,
        // and its recorded driver is still the one it will come up under.
        current: agent.tui,
    });
    const run = agentRunControl(agent);

    return (
        <div style={{ display: 'grid', gap: 14, paddingTop: 8 }}>
            {/* ── The RUN — is this agent up, and the one verb for the other
                 direction that is not Delete (genie#474). ───────────────── */}
            <div style={{ display: 'grid', gap: 6 }}>
                <Text size="sm" data-testid="driver-run-summary">
                    {driverSummary(agent, drivers)}
                </Text>
                <div>
                    <Button
                        variant={run.action === 'stop' ? 'ghost' : 'default'}
                        disabled={busy}
                        data-testid={`driver-run-${run.action}`}
                        onClick={() => onRun(run.action)}
                    >
                        {run.label}
                    </Button>
                </div>
                <Text size="xs" color="muted">
                    {run.note}
                </Text>
            </div>

            {/* ── The DRIVERS ─────────────────────────────────────────────── */}
            <div style={{ display: 'grid', gap: 6 }}>
                <Text size="sm" weight="medium">
                    Drivers
                </Text>
                {rows.map((row) => (
                    <div
                        key={row.tui}
                        data-testid={`driver-row-${row.tui}`}
                        style={{
                            display: 'flex',
                            gap: 8,
                            alignItems: 'flex-start',
                            justifyContent: 'space-between',
                        }}
                    >
                        <div style={{ display: 'grid', gap: 2 }}>
                            <Text size="sm" weight="medium">
                                {row.label}
                                {row.state === 'active' && (
                                    <>
                                        {' '}
                                        <Badge size="sm" variant="soft" color="emerald">
                                            active
                                        </Badge>
                                    </>
                                )}
                                {row.state === 'sidecar' && (
                                    <>
                                        {' '}
                                        <Badge size="sm" variant="soft">
                                            sidecar
                                        </Badge>
                                    </>
                                )}
                            </Text>
                            <Text size="xs" color="muted">
                                {row.state === 'active'
                                    ? 'The driver in the chair.'
                                    : row.state === 'sidecar'
                                      ? 'Parked, with its own conversation waiting.'
                                      : 'Never run under this driver.'}
                            </Text>
                            {/* The HOST's refusal, verbatim, where the button
                                would have been. An Adopt-style dead control is
                                worse than none. */}
                            {row.refusal && (
                                <Text size="xs" color="muted" data-testid={`driver-refusal-${row.tui}`}>
                                    {row.refusal}
                                </Text>
                            )}
                        </div>
                        {row.action && (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                data-testid={`driver-switch-${row.tui}`}
                                onClick={() => onSwitch(row.tui)}
                            >
                                {row.action.label}
                            </Button>
                        )}
                    </div>
                ))}
                <Text size="xs" color="muted">
                    An agent is not its TUI. Switching keeps this agent — its identity, inbox,
                    history and <code>AGENT.md</code> — and the driver it leaves keeps its own
                    pty and conversation as a sidecar you can flip straight back to.{' '}
                    <strong>Nothing is stopped by a switch.</strong>
                </Text>
            </div>

            {/* ── The agent's own MARK ────────────────────────────────────── */}
            <div style={{ display: 'grid', gap: 6 }}>
                <Field
                    label="Avatar"
                    hint="One emoji, shown wherever this agent appears. It belongs here because the mark it overrides is the driver’s own logo — the thing the control above changes. Clear it to go back to that."
                >
                    <Input
                        data-testid="driver-avatar"
                        value={avatar}
                        placeholder="Emoji — empty uses the driver’s logo"
                        spellCheck={false}
                        onChange={(e) => onAvatarChange(e.target.value)}
                    />
                </Field>
                {/* Main REJECTS more than one glyph rather than truncating. The
                    refusal is shown as a refusal, not as muted helper text: a
                    silently dropped mark reads as a dead field, and this
                    surface's rule is that a failed write STAYS on screen. */}
                {avatarError && (
                    <Callout color="red" data-testid="driver-avatar-error">
                        <Text size="sm">{avatarError}</Text>
                    </Callout>
                )}
            </div>
        </div>
    );
}

export default function AgentManager({
    agentId,
    identity,
    onChanged,
}: {
    agentId: string;
    /** The identity controls that already existed — workspace default, purpose,
     *  reachability, IssueWatch. Passed in rather than moved, so this replaces
     *  the surface without shrinking it. The driver switcher that used to sit
     *  here is now the Driver tab, which is a control and not a popover. */
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
    const [avatar, setAvatar] = useState('');
    const [avatarError, setAvatarError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const next = await api().agents.managerState(agentId);
            setState(next);
            setAvatar(next.agent?.avatar ?? '');
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
    // WHICH restart this banner's button performs. Resume where the provider has
    // a grammar for it; fresh otherwise, because a button that can only be
    // refused is the bug genie#443 is about, and a fresh relaunch reloads the MCP
    // config just the same. This surface does not know whether a session was
    // captured, so a resumable provider that has none still gets the host's
    // refusal — which now names the operation that works.
    const restartMode: RestartMode = canResumeTui(state.agent?.tui) ? 'resume' : 'fresh';
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

                    {/* ── Driver — what it runs under, and whether it is up ── */}
                    <Tabs.Panel value="driver">
                        {state.agent && (
                            <AgentDriverPanel
                                agent={state.agent}
                                drivers={drivers.map((d) => ({
                                    tui: String(d.agent),
                                    label: d.label,
                                }))}
                                busy={busy}
                                avatar={avatar}
                                avatarError={avatarError}
                                onAvatarChange={(next) => {
                                    setAvatar(next);
                                    setAvatarError(null);
                                    // Main REJECTS more than one glyph rather
                                    // than truncating, so the reason is shown;
                                    // a silently dropped mark reads as a dead
                                    // field.
                                    void api()
                                        .agents.setAvatar(state.agent!.id, next)
                                        .then((r) => {
                                            if (!r.ok) {
                                                setAvatarError(
                                                    r.error ?? 'Could not save that avatar.',
                                                );
                                            } else onChanged?.();
                                        })
                                        .catch(() =>
                                            setAvatarError('Could not save that avatar.'),
                                        );
                                }}
                                onSwitch={(tui) =>
                                    void run(
                                        () => api().agents.addRuntime(state.agent!.id, tui),
                                        // NAMES what did not happen. The whole
                                        // model is that a switch costs nothing,
                                        // and a person who has just moved a
                                        // running agent needs to be told that.
                                        `${state.agent!.name} now runs under ${
                                            drivers.find((d) => String(d.agent) === tui)?.label ??
                                            tui
                                        }. The driver it left keeps its conversation as a sidecar — nothing was stopped.`,
                                    )
                                }
                                onRun={(action) =>
                                    void run(
                                        () =>
                                            action === 'stop'
                                                ? api().agents.stop(state.agent!.id)
                                                : api().agents.start(
                                                      state.agent!.workspaceId,
                                                      state.agent!.name,
                                                  ),
                                        action === 'stop'
                                            ? `${state.agent!.name} is stopped. Its identity, AGENT.md, inbox and history are kept — Start brings the same agent back.`
                                            : `${state.agent!.name} is starting.`,
                                    )
                                }
                            />
                        )}
                    </Tabs.Panel>

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

                                <Field label="Mode" hint={agentModeSummary(draft.mode)}>
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
                                        announcement, AgentInbox notices, attention nudges,
                                        IssueWatch pings and the boot prompt — will carry:{' '}
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
                            /* Not "this agent has no AGENT.md path recorded" —
                               that state no longer exists (genie#570): a save
                               derives the path. Reaching here means the HOST
                               could not read the agent at all, so say what it
                               said rather than a guess about a filename. */
                            <Text size="sm" color="muted">
                                {state.error ?? 'Genie could not read this agent.'}
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
                                                                   exists to end.

                                                                   A provider with NO resume grammar
                                                                   gets the FRESH restart instead
                                                                   (genie#443). Sending `resume` there
                                                                   is a button that can only ever be
                                                                   refused — and this banner's whole
                                                                   job is to get the MCP config
                                                                   reloaded, which a fresh relaunch
                                                                   does too. It says which it will do
                                                                   rather than implying the kinder
                                                                   one. */
                                                                const r =
                                                                    await api().terminalSpec.restartAgent(
                                                                        state.agent!.terminalSpecId!,
                                                                        restartMode,
                                                                    );
                                                                return r.ok
                                                                    ? { ok: true }
                                                                    : { ok: false, error: r.error };
                                                            }, restartMode === 'resume'
                                                                ? 'Relaunching the agent — it resumes where it left off.'
                                                                : 'Relaunching the agent — this provider cannot resume, so it starts a new conversation.')
                                                        }
                                                    >
                                                        {restartMode === 'resume'
                                                            ? `Restart ${state.agent?.name}`
                                                            : `Restart ${state.agent?.name} (fresh)`}
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
                                                variant={
                                                    action === 'stop' || action === 'restart-fresh'
                                                        ? 'ghost'
                                                        : 'default'
                                                }
                                                disabled={busy}
                                                onClick={() =>
                                                    void run(
                                                        () =>
                                                            api().agents.sidecarAction(
                                                                agentId,
                                                                action as SidecarAction,
                                                            ),
                                                        sidecarDoneMessage(action, sidecar.name),
                                                    )
                                                }
                                            >
                                                {sidecarActionLabel(action)}
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
