import { useEffect, useState, type ReactNode } from 'react';
import { Action, Heading, Icon, Input, Modal, Select, Text } from '@particle-academy/react-fancy';
import TynnProvisionPanel from '../TynnProvisionPanel';
import type {
    WorkspaceRow,
    WorkspaceDocHealth,
    EnvelopeRepoView,
    KnowledgeFolderView,
    IssuewatchGranularity,
    IssuewatchPolicy,
    IssuewatchPolicyBuckets,
    WorkspaceAgentAccess,
} from '../../lib/genie';
import { api } from '../../lib/genie';

/** The all-on + upstream-issues+prs defaults — the optimistic value shown until
 *  the workspace's stored granularity loads (and the fallback on a read error). */
const DEFAULT_GRANULARITY: IssuewatchGranularity = {
    own: { issues: true, pulls: true, security: true },
    upstream: 'issues+prs',
};

/** Report-only for every bucket — the optimistic value shown until the stored
 *  per-bucket remediation policy loads (and the fallback on a read error). */
const DEFAULT_POLICY: IssuewatchPolicyBuckets = {
    security: 'surface',
    issue: 'surface',
    pr: 'surface',
};

/** The remediation choices offered for each bucket (shared by all three selects). */
const POLICY_OPTIONS = [
    { value: 'surface', label: 'Surface only — report, wait for me (default)' },
    { value: 'fix', label: 'Fix when idle — fix the root cause, report before shipping' },
    { value: 'fix-and-ship', label: 'Fix & ship when idle — remediate and ship right away' },
];

/**
 * Per-workspace settings, opened from the workspace context menu. The single
 * home for EVERYTHING about one workspace: its display name, its linked Tynn
 * project (+ agent provisioning), the `.agi` envelope's member repos and `.ai/`
 * knowledge folders, doc health, the Ops panels, and the approval gates.
 * Envelope-only sections (repos / knowledge) hide themselves for a plain-folder
 * workspace. Genuinely global/app settings still live in the Settings window.
 */
export default function WorkspaceSettingsModal({
    workspace,
    onClose,
}: {
    workspace: WorkspaceRow;
    onClose: () => void;
}) {
    // Editable workspace display name (the rail label). Persisted to the DB row;
    // the rename broadcasts so the sidebar updates live.
    const [name, setName] = useState(workspace.project_name);
    const [savingName, setSavingName] = useState(false);
    const [nameSaved, setNameSaved] = useState(false);
    // Per-workspace "require approval before an agent starts a process".
    const [processApproval, setProcessApproval] = useState<boolean | null>(null);
    // Per-workspace "require approval before an agent spawns a terminal /
    // launches a coding agent" (the higher-power manageTerminals / runAgent gate).
    const [terminalApproval, setTerminalApproval] = useState<boolean | null>(null);
    // Per-workspace IssueWatch remediation policy, PER BUCKET (security/issue/pr).
    // Null until the resolved value loads; we render the defaults optimistically.
    const [iwPolicy, setIwPolicy] = useState<IssuewatchPolicyBuckets | null>(null);
    // Per-workspace IssueWatch granularity (what to watch + ping about). Null
    // until the resolved value loads; we render the defaults optimistically.
    const [granularity, setGranularity] = useState<IssuewatchGranularity | null>(null);

    const saveName = async () => {
        const next = name.trim();
        if (!next || next === workspace.project_name) return;
        setSavingName(true);
        setNameSaved(false);
        try {
            await api().workspaces.update(workspace.id, {
                project_name: next,
                tynn_project_name: next,
            });
            setNameSaved(true);
            setTimeout(() => setNameSaved(false), 1800);
        } finally {
            setSavingName(false);
        }
    };

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const ws = (await api().workspaces.list()).find((w) => w.id === workspace.id);
                if (alive) {
                    setProcessApproval(ws ? ws.process_approval !== 0 : true);
                    setTerminalApproval(ws ? ws.terminal_approval !== 0 : true);
                }
            } catch {
                if (alive) {
                    setProcessApproval(true);
                    setTerminalApproval(true);
                }
            }
            try {
                const p = await api().workspaces.getIssuewatchPolicy(workspace.id);
                if (alive) setIwPolicy(p);
            } catch {
                if (alive) setIwPolicy(DEFAULT_POLICY);
            }
            try {
                const g = await api().workspaces.getIssuewatchGranularity(workspace.id);
                if (alive) setGranularity(g);
            } catch {
                if (alive) setGranularity(DEFAULT_GRANULARITY);
            }
        })();
        return () => {
            alive = false;
        };
    }, [workspace.id]);

    const toggleProcessApproval = async (require: boolean) => {
        setProcessApproval(require); // optimistic
        try {
            await api().workspaces.setProcessApproval(workspace.id, require);
        } catch {
            setProcessApproval((prev) => !prev); // revert
        }
    };

    const toggleTerminalApproval = async (require: boolean) => {
        setTerminalApproval(require); // optimistic
        try {
            await api().workspaces.setTerminalApproval(workspace.id, require);
        } catch {
            setTerminalApproval((prev) => !prev); // revert
        }
    };

    // Persist ONE bucket's remediation policy optimistically, reverting on
    // failure. Sends the FULL next buckets object (mirrors saveGranularity), so a
    // single-bucket edit never drops the other two buckets' stored values.
    const changeIwPolicy = async (
        bucket: keyof IssuewatchPolicyBuckets,
        mode: IssuewatchPolicy,
    ) => {
        const prev = iwPolicy ?? DEFAULT_POLICY;
        const next = { ...prev, [bucket]: mode };
        setIwPolicy(next); // optimistic
        try {
            await api().workspaces.setIssuewatchPolicy(workspace.id, next);
        } catch {
            setIwPolicy(prev); // revert
        }
    };

    // Persist a granularity change optimistically, reverting on failure. Takes
    // the full next granularity so the caller composes the own/upstream edit.
    const saveGranularity = async (next: IssuewatchGranularity) => {
        const prev = granularity;
        setGranularity(next); // optimistic
        try {
            await api().workspaces.setIssuewatchGranularity(workspace.id, next);
        } catch {
            setGranularity(prev); // revert
        }
    };

    // The granularity shown while the stored value loads (and the safe fallback).
    const g = granularity ?? DEFAULT_GRANULARITY;
    // The per-bucket remediation policy shown while the stored value loads.
    const pol = iwPolicy ?? DEFAULT_POLICY;
    const setOwnKind = (kind: 'issues' | 'pulls' | 'security', on: boolean) =>
        void saveGranularity({ ...g, own: { ...g.own, [kind]: on } });

    return (
        <Modal open onClose={onClose} size="xl">
            <div className="ws-settings">
                <div className="ws-settings-head">
                    <Heading as="h2" size="sm">
                        Workspace settings
                    </Heading>
                    {workspace.path && (
                        <Text size="xs" className="text-zinc-500">
                            {workspace.path}
                        </Text>
                    )}
                </div>

                <Section
                    title="Name"
                    action={
                        nameSaved ? (
                            <Text size="xs" style={{ color: 'var(--emerald-600)' }}>
                                <Icon name="check" size="xs" /> Renamed
                            </Text>
                        ) : undefined
                    }
                >
                    <div className="ws-name-row">
                        <Input
                            value={name}
                            onValueChange={setName}
                            placeholder="Workspace name"
                            onKeyDown={(e: React.KeyboardEvent) => {
                                if (e.key === 'Enter') void saveName();
                            }}
                        />
                        <Action
                            size="sm"
                            color="blue"
                            icon="check"
                            disabled={
                                savingName ||
                                !name.trim() ||
                                name.trim() === workspace.project_name
                            }
                            onClick={saveName}
                        >
                            {savingName ? 'Saving…' : 'Rename'}
                        </Action>
                    </div>
                </Section>

                <TynnProvisionPanel workspaceId={workspace.id} />

                {workspace.path && <EnvelopeReposPanel workspacePath={workspace.path} />}

                {workspace.path && <KnowledgeFoldersPanel workspacePath={workspace.path} />}

                <WorkspaceDocsPanel workspaceId={workspace.id} />

                {workspace.path && <OpsReposPanel workspacePath={workspace.path} />}

                {workspace.path && <OpsWorkspacesPanel workspacePath={workspace.path} />}

                <Section title="Agent behavior">
                    <Row
                        label="Remediation — Security alerts"
                        sub="How agents act on Dependabot / code-scanning / secret-scanning pings"
                        vertical
                    >
                        <Select
                            value={pol.security}
                            disabled={iwPolicy === null}
                            onValueChange={(v) =>
                                void changeIwPolicy('security', v as IssuewatchPolicy)
                            }
                            list={POLICY_OPTIONS}
                        />
                    </Row>
                    <Row
                        label="Remediation — Issues"
                        sub="How agents act on open-issue pings"
                        vertical
                    >
                        <Select
                            value={pol.issue}
                            disabled={iwPolicy === null}
                            onValueChange={(v) =>
                                void changeIwPolicy('issue', v as IssuewatchPolicy)
                            }
                            list={POLICY_OPTIONS}
                        />
                    </Row>
                    <Row
                        label="Remediation — Pull requests"
                        sub="How agents act on open-PR pings"
                        vertical
                    >
                        <Select
                            value={pol.pr}
                            disabled={iwPolicy === null}
                            onValueChange={(v) =>
                                void changeIwPolicy('pr', v as IssuewatchPolicy)
                            }
                            list={POLICY_OPTIONS}
                        />
                    </Row>
                    <Row
                        label="Watch — Issues"
                        sub="Open issues on this workspace's repos"
                    >
                        <input
                            type="checkbox"
                            checked={g.own.issues}
                            disabled={granularity === null}
                            onChange={(e) => setOwnKind('issues', e.target.checked)}
                            aria-label="Watch issues on this workspace's repos"
                        />
                    </Row>
                    <Row
                        label="Watch — Pull Requests"
                        sub="Open PRs on this workspace's repos"
                    >
                        <input
                            type="checkbox"
                            checked={g.own.pulls}
                            disabled={granularity === null}
                            onChange={(e) => setOwnKind('pulls', e.target.checked)}
                            aria-label="Watch pull requests on this workspace's repos"
                        />
                    </Row>
                    <Row
                        label="Watch — Security alerts"
                        sub="Dependabot, code-scanning & secret-scanning alerts"
                    >
                        <input
                            type="checkbox"
                            checked={g.own.security}
                            disabled={granularity === null}
                            onChange={(e) => setOwnKind('security', e.target.checked)}
                            aria-label="Watch security alerts on this workspace's repos"
                        />
                    </Row>
                    <Row
                        label="Watch — Upstream (forks)"
                        sub="For a forked repo, also watch its parent repo"
                        vertical
                    >
                        <Select
                            value={g.upstream}
                            onValueChange={(v) =>
                                void saveGranularity({
                                    ...g,
                                    upstream: v as IssuewatchGranularity['upstream'],
                                })
                            }
                            list={[
                                { value: 'none', label: 'None — ignore the upstream' },
                                { value: 'issues', label: 'Issues — watch the upstream’s issues' },
                                { value: 'issues+prs', label: 'Issues + PRs — watch upstream issues and PRs (default)' },
                            ]}
                        />
                    </Row>
                    <Row
                        label="IssueWatch handlers"
                        sub="Which agents get pinged when a watched item changes"
                        vertical
                    >
                        <IssueWatchHandlersPanel workspaceId={workspace.id} />
                    </Row>
                    <Row
                        label="Agent access"
                        sub="Which other workspaces' agents may join this workspace's channels and see its agents"
                        vertical
                    >
                        <AgentAccessPanel workspaceId={workspace.id} />
                    </Row>
                    <Row
                        label="Background process approval"
                        sub="Approve before an agent starts a process (manageProcess)"
                    >
                        <input
                            type="checkbox"
                            checked={processApproval ?? true}
                            disabled={processApproval === null}
                            onChange={(e) => void toggleProcessApproval(e.target.checked)}
                            aria-label="Require approval before an agent starts a process"
                        />
                    </Row>
                    <Row
                        label="Terminal & agent approval"
                        sub="Approve before an agent runs a terminal or launches an agent (manageTerminals / runAgent)"
                    >
                        <input
                            type="checkbox"
                            checked={terminalApproval ?? true}
                            disabled={terminalApproval === null}
                            onChange={(e) => void toggleTerminalApproval(e.target.checked)}
                            aria-label="Require approval before an agent runs a terminal or launches an agent"
                        />
                    </Row>
                </Section>
            </div>
        </Modal>
    );
}

/** Dense section: a slim heading (+ optional one-line sub / right-aligned
 *  action) over its rows. Reuses the shared .set-section primitives. */
function Section({
    title,
    sub,
    action,
    children,
}: {
    title: string;
    sub?: ReactNode;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="set-section">
            <div className="set-section-head">
                <h2>{title}</h2>
                {sub && <span className="set-section-desc">{sub}</span>}
                {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
            </div>
            {children}
        </section>
    );
}

/** One dense row: label (+ optional one-line sub) on the left, control on the
 *  right — or full-width underneath when `vertical`. */
function Row({
    label,
    sub,
    vertical,
    children,
}: {
    label: ReactNode;
    sub?: ReactNode;
    vertical?: boolean;
    children: ReactNode;
}) {
    return (
        <div className={`set-row${vertical ? ' vertical' : ''}`}>
            <div className="set-row-main">
                <span className="set-row-label">{label}</span>
                {sub && <span className="set-row-desc">{sub}</span>}
            </div>
            <div className="set-row-control">{children}</div>
        </div>
    );
}

/**
 * IssueWatch handler DESIGNATION — pick which of this workspace's ping-handling
 * agents actually get pinged. Only agents that opted into "Handle IssueWatch
 * pings" (in their own Agent settings) are candidates. When NONE are checked the
 * ping fans out to EVERY handling agent (the default); checking a subset narrows
 * it to just those, so one issue doesn't wake five terminals. Persisted per
 * workspace; the ping router reads the same set when a delta lands.
 */
function IssueWatchHandlersPanel({ workspaceId }: { workspaceId: string }) {
    const [designated, setDesignated] = useState<string[] | null>(null);
    const [agents, setAgents] = useState<
        Array<{ terminalId: string; label: string; handle: boolean; action: 'notify' | 'wake' }>
    >([]);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const r = await api().workspaces.getIssuewatchHandlers(workspaceId);
                if (alive) {
                    setDesignated(r.designated);
                    setAgents(r.agents);
                }
            } catch {
                if (alive) {
                    setDesignated([]);
                    setAgents([]);
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [workspaceId]);

    const handling = agents.filter((a) => a.handle);
    const chosen = designated ?? [];

    const toggle = async (terminalId: string) => {
        const cur = designated ?? [];
        const next = cur.includes(terminalId)
            ? cur.filter((x) => x !== terminalId)
            : [...cur, terminalId];
        setDesignated(next); // optimistic
        try {
            await api().workspaces.setIssuewatchHandlers(workspaceId, next);
        } catch {
            setDesignated(cur); // revert
        }
    };

    if (designated === null) {
        return <span className="set-row-desc">Loading…</span>;
    }
    if (handling.length === 0) {
        return (
            <span className="set-row-desc">
                No agents handle IssueWatch pings yet. Turn on “Handle IssueWatch pings” in an
                agent’s settings to make it a candidate here.
            </span>
        );
    }
    return (
        <div className="agent-form-ws">
            <span className="set-row-desc">
                {chosen.length === 0
                    ? 'No designated handlers — every agent below is pinged.'
                    : 'Only the checked agents are pinged; the rest are skipped.'}
            </span>
            {handling.map((a) => (
                <label key={a.terminalId} className="agent-form-ws-row">
                    <input
                        type="checkbox"
                        checked={chosen.includes(a.terminalId)}
                        onChange={() => void toggle(a.terminalId)}
                    />
                    <span>
                        {a.label}
                        <span className="agent-form-ws-note"> ({a.action})</span>
                    </span>
                </label>
            ))}
        </div>
    );
}

const AGENT_ACCESS_OPTIONS: Array<{ value: WorkspaceAgentAccess; label: string }> = [
    { value: 'all', label: 'All — any workspace' },
    { value: 'specific', label: 'Specific workspaces' },
    { value: 'self', label: 'This workspace only' },
    { value: 'none', label: 'None — closed' },
];

const AGENT_ACCESS_DESC: Record<WorkspaceAgentAccess, string> = {
    all: 'Any agent on the workstation may join this workspace’s channels and discover its agents. This is the default and matches how channels behaved before this setting existed.',
    specific:
        'Only agents from the workspaces you check below may reach in. Everyone else sees nothing from this workspace.',
    self: 'Only this workspace’s own agents. Agents elsewhere cannot join its channels or see its agents at all.',
    none: 'Closed to every other workspace — same as “this workspace only”, stated explicitly.',
};

/**
 * The workspace's AgentInbox FRONT DOOR (the outer access tier) — who may reach
 * INTO this workspace: join/post to its channels AND discover/DM its agents.
 * Composes with each agent's own scope (in that agent's settings), which decides
 * who may DM it; a caller must clear BOTH tiers.
 *
 * Denial here OMITS this workspace's agents from an outsider's directory rather
 * than listing them as unavailable — a closed workspace shouldn't advertise its
 * roster. (Per-agent denial inside an open workspace does list-as-unavailable.)
 *
 * Defaults to `all` because channels were previously ungoverned; tightening is
 * always an explicit choice so upgrades never silently sever a working setup.
 */
export function AgentAccessPanel({ workspaceId }: { workspaceId: string }) {
    const [access, setAccess] = useState<WorkspaceAgentAccess | null>(null);
    const [allowed, setAllowed] = useState<string[]>([]);
    const [peers, setPeers] = useState<Array<{ id: string; name: string }>>([]);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const [cur, list] = await Promise.all([
                    api().workspaces.getAgentAccess(workspaceId),
                    api().workspaces.list(),
                ]);
                if (!alive) return;
                setAccess(cur.access);
                setAllowed(cur.workspaces);
                setPeers(
                    list
                        .filter((w) => w.id !== workspaceId)
                        .map((w) => ({ id: w.id, name: w.project_name })),
                );
            } catch {
                if (alive) {
                    setAccess('all'); // match the resolver's permissive default
                    setAllowed([]);
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [workspaceId]);

    const save = async (next: WorkspaceAgentAccess, nextAllowed: string[]) => {
        const prev = { access, allowed };
        setAccess(next); // optimistic
        setAllowed(nextAllowed);
        try {
            await api().workspaces.setAgentAccess(workspaceId, next, nextAllowed);
        } catch {
            setAccess(prev.access); // revert
            setAllowed(prev.allowed);
        }
    };

    const toggleWorkspace = (id: string) => {
        const next = allowed.includes(id)
            ? allowed.filter((x) => x !== id)
            : [...allowed, id];
        void save(access ?? 'all', next);
    };

    if (access === null) return <span className="set-row-desc">Loading…</span>;

    return (
        <div className="agent-form-ws" data-testid="agent-access-root">
            <Select
                value={access}
                onValueChange={(v) => void save(v as WorkspaceAgentAccess, allowed)}
                list={AGENT_ACCESS_OPTIONS}
            />
            <span className="set-row-desc">{AGENT_ACCESS_DESC[access]}</span>
            {access === 'specific' &&
                (peers.length === 0 ? (
                    <span className="set-row-desc">No other workspaces to admit yet.</span>
                ) : (
                    peers.map((w) => (
                        <label key={w.id} className="agent-form-ws-row">
                            <input
                                type="checkbox"
                                checked={allowed.includes(w.id)}
                                onChange={() => toggleWorkspace(w.id)}
                            />
                            <span>{w.name}</span>
                        </label>
                    ))
                ))}
        </div>
    );
}

/**
 * Workspace docs health + repair — per-workspace. Keeps this workspace's
 * AGENTS.md (with the Genie MCP section) and CLAUDE.md healthy. Repair is
 * idempotent and safe to re-run; a divergent CLAUDE.md is reported, never
 * overwritten. Moved here from the global Settings → Agent MCP pane, where it
 * was acting on whichever workspace happened to be active — it belongs with the
 * workspace it edits.
 */
function WorkspaceDocsPanel({ workspaceId }: { workspaceId: string }) {
    const [docHealth, setDocHealth] = useState<WorkspaceDocHealth | null>(null);
    const [repairing, setRepairing] = useState(false);
    const [repairMsg, setRepairMsg] = useState<string | null>(null);

    const refreshDocHealth = async () => {
        try {
            setDocHealth(await api().mcp.docHealth(workspaceId));
        } catch {
            setDocHealth(null);
        }
    };

    useEffect(() => {
        void refreshDocHealth();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspaceId]);

    const repairDocs = async () => {
        setRepairing(true);
        setRepairMsg(null);
        try {
            const r = await api().mcp.repairDocs(workspaceId);
            if (!r) {
                setRepairMsg('No active workspace to repair.');
            } else if (r.claudeDivergent) {
                setRepairMsg(
                    'CLAUDE.md is a separate, divergent file — left untouched so your content is preserved. ' +
                        (r.actions.length ? r.actions.join('; ') + '.' : ''),
                );
            } else {
                setRepairMsg(
                    r.actions.length
                        ? r.actions.join('; ') + '.'
                        : 'Already healthy — nothing to repair.',
                );
            }
            setDocHealth(r?.health ?? null);
        } finally {
            setRepairing(false);
        }
    };

    return (
        <Section
            title="Workspace docs"
            sub="AGENTS.md (with the Genie MCP section) + CLAUDE.md"
            action={
                <Action
                    variant="ghost"
                    size="sm"
                    icon="wrench"
                    onClick={repairDocs}
                    disabled={repairing}
                >
                    {repairing ? 'Repairing…' : 'Repair'}
                </Action>
            }
        >
            {(docHealth || repairMsg) && (
                <div className="set-row">
                    <div className="set-row-main">
                        {docHealth && (
                            <span
                                style={{
                                    fontSize: 12.5,
                                    color: docHealth.healthy
                                        ? 'var(--emerald-600)'
                                        : 'var(--amber-600)',
                                }}
                            >
                                <Icon
                                    name={docHealth.healthy ? 'check' : 'alert-triangle'}
                                    size="xs"
                                />{' '}
                                {docHealth.healthy
                                    ? 'Docs healthy'
                                    : !docHealth.hasAgents
                                        ? 'AGENTS.md missing'
                                        : !docHealth.hasGenieSection
                                            ? 'AGENTS.md missing the Genie MCP section'
                                            : docHealth.claudeDivergent
                                                ? 'CLAUDE.md diverges from AGENTS.md'
                                                : docHealth.claude === 'broken-pointer'
                                                    ? 'CLAUDE.md is a broken one-liner'
                                                    : docHealth.claude === 'missing'
                                                        ? 'CLAUDE.md missing'
                                                        : 'Needs repair'}
                            </span>
                        )}
                        {repairMsg && <span className="set-row-desc">{repairMsg}</span>}
                    </div>
                </div>
            )}
        </Section>
    );
}

/** Derive a git-safe submodule name from a repo URL (strip path + `.git`). */
function repoNameFromUrl(url: string): string {
    const last = url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
    return last.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Envelope repo management — only meaningful for a `.agi` workspace, so it
 * renders nothing for a plain folder (reposList → isEnvelope:false). Lists the
 * member repos (project.json registry ∪ on-disk submodules under `repos/`) with
 * their role, an Open (reveal in OS file manager), and a Remove; plus an Add
 * form (clone a repo as a new submodule). Mutations leave the change staged for
 * the user to commit, mirroring the Ops repo panel.
 */
function EnvelopeReposPanel({ workspacePath }: { workspacePath: string }) {
    const [repos, setRepos] = useState<EnvelopeRepoView[] | null>(null);
    const [isEnvelope, setIsEnvelope] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showAdd, setShowAdd] = useState(false);
    const [addUrl, setAddUrl] = useState('');
    const [addName, setAddName] = useState('');
    const [addNameTouched, setAddNameTouched] = useState(false);

    const load = async () => {
        try {
            const r = await api().agi.reposList(workspacePath);
            setIsEnvelope(r.isEnvelope);
            setRepos(r.repos);
        } catch {
            setRepos([]);
            setIsEnvelope(false);
        }
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspacePath]);

    if (repos === null || !isEnvelope) return null; // loading or plain folder

    const onUrlChange = (v: string) => {
        setAddUrl(v);
        if (!addNameTouched) setAddName(repoNameFromUrl(v));
    };

    const add = async () => {
        setBusy('__add__');
        setError(null);
        try {
            const r = await api().agi.repoAdd(workspacePath, addUrl, addName);
            if (!r.ok) {
                setError(r.error ?? 'Could not add the repo.');
                return;
            }
            setShowAdd(false);
            setAddUrl('');
            setAddName('');
            setAddNameTouched(false);
            await load();
        } finally {
            setBusy(null);
        }
    };

    const remove = async (repo: EnvelopeRepoView) => {
        setBusy(repo.name);
        setError(null);
        try {
            const r = await api().agi.repoRemove(workspacePath, repo.name);
            if (!r.ok) setError(r.error ?? 'Could not remove the repo.');
            await load();
        } finally {
            setBusy(null);
        }
    };

    const open = (repo: EnvelopeRepoView) => {
        void api().workspaces.reveal(workspacePath, repo.path);
    };

    return (
        <Section
            title="Repos"
            sub="Submodules under repos/, registered in project.json"
            action={
                <Action
                    size="sm"
                    variant="ghost"
                    icon="plus"
                    onClick={() => setShowAdd((s) => !s)}
                >
                    Add repo
                </Action>
            }
        >
            {repos.length === 0 ? (
                <Text size="xs" className="text-zinc-500" style={{ paddingTop: 4 }}>
                    No repos yet. Add one to register it as a submodule.
                </Text>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {repos.map((r) => (
                        <div
                            key={r.name}
                            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                        >
                            <Icon name="git-branch" size="xs" className="text-zinc-500" />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <Text size="sm" style={{ fontWeight: 600 }}>
                                    {r.name}
                                    {r.role === 'host' && (
                                        <span
                                            style={{
                                                marginLeft: 6,
                                                fontSize: 10,
                                                fontWeight: 600,
                                                color: 'var(--violet-500)',
                                            }}
                                        >
                                            host
                                        </span>
                                    )}
                                </Text>
                                <Text
                                    size="xs"
                                    className="text-zinc-500"
                                    style={{
                                        display: 'block',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {r.url ?? r.path}
                                    {!r.onDisk && ' · not cloned'}
                                    {!r.inRegistry && ' · unregistered'}
                                </Text>
                            </div>
                            <Action
                                size="sm"
                                variant="ghost"
                                icon="folder-open"
                                disabled={!r.onDisk || busy !== null}
                                onClick={() => open(r)}
                            >
                                Open
                            </Action>
                            <Action
                                size="sm"
                                variant="ghost"
                                icon="trash-2"
                                disabled={r.role === 'host' || busy !== null}
                                title={
                                    r.role === 'host'
                                        ? 'The host repo can’t be removed here'
                                        : 'Remove this repo'
                                }
                                onClick={() => void remove(r)}
                            >
                                {busy === r.name ? 'Removing…' : 'Remove'}
                            </Action>
                        </div>
                    ))}
                </div>
            )}

            {showAdd && (
                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        padding: 10,
                        borderRadius: 8,
                        background: 'var(--bg-2)',
                        border: '1px solid var(--border-1)',
                    }}
                >
                    <Input
                        label="Repository URL"
                        description="Cloned as a submodule with your existing git auth."
                        value={addUrl}
                        onValueChange={onUrlChange}
                        placeholder="git@github.com:owner/repo.git"
                    />
                    <Input
                        label="Submodule name"
                        description={`Lands at repos/${addName || '…'}/`}
                        value={addName}
                        onValueChange={(v) => {
                            setAddNameTouched(true);
                            setAddName(v);
                        }}
                        placeholder="web"
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                        <Action
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowAdd(false)}
                            disabled={busy === '__add__'}
                        >
                            Cancel
                        </Action>
                        <Action
                            size="sm"
                            color="blue"
                            icon="download"
                            disabled={busy === '__add__' || !addUrl.trim() || !addName.trim()}
                            onClick={add}
                        >
                            {busy === '__add__' ? 'Adding…' : 'Add repo'}
                        </Action>
                    </div>
                </div>
            )}

            {error && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    {error}
                </Text>
            )}
        </Section>
    );
}

/**
 * Envelope `.ai/` knowledge folders — only for a `.agi` workspace (else renders
 * nothing). A compact 2-col grid of the standard buckets (`.ai/knowledge` · N)
 * with an inline Open / Create, so it stays dense and doesn't dominate the modal.
 */
function KnowledgeFoldersPanel({ workspacePath }: { workspacePath: string }) {
    const [folders, setFolders] = useState<KnowledgeFolderView[] | null>(null);
    const [isEnvelope, setIsEnvelope] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        try {
            const r = await api().agi.knowledgeList(workspacePath);
            setIsEnvelope(r.isEnvelope);
            setFolders(r.folders);
        } catch {
            setFolders([]);
            setIsEnvelope(false);
        }
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspacePath]);

    if (folders === null || !isEnvelope) return null; // loading or plain folder

    const create = async (name: string) => {
        setBusy(name);
        setError(null);
        try {
            const r = await api().agi.knowledgeCreate(workspacePath, name);
            if (!r.ok) setError(r.error ?? 'Could not create the folder.');
            await load();
        } finally {
            setBusy(null);
        }
    };

    const open = (relPath: string) => {
        void api().workspaces.reveal(workspacePath, relPath);
    };

    return (
        <Section title="Knowledge folders" sub=".ai/ buckets — create the ones you use">
            <div className="ws-know">
                {folders.map((f) => (
                    <div className="ws-know-item" key={f.name} title={f.relPath}>
                        <span className="ws-know-name">{f.relPath}</span>
                        <span className="ws-know-meta">
                            · {f.exists ? f.entryCount : '—'}
                        </span>
                        {f.exists ? (
                            <button
                                type="button"
                                className="ws-know-act"
                                disabled={busy !== null}
                                onClick={() => open(f.relPath)}
                            >
                                Open
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="ws-know-act"
                                disabled={busy !== null}
                                onClick={() => void create(f.name)}
                            >
                                {busy === f.name ? '…' : 'Create'}
                            </button>
                        )}
                    </div>
                ))}
            </div>
            {error && (
                <Text size="xs" style={{ color: 'var(--rose-500)', marginTop: 4 }}>
                    {error}
                </Text>
            )}
        </Section>
    );
}

type OpsPlan = Awaited<ReturnType<ReturnType<typeof api>['tynn']['opsPlan']>>;

/**
 * Ops-project repo auto-management. For a workspace linked to an Ops project,
 * shows the reconcile plan (which slave `*.agi` repos to add/remove) and lets
 * the user approve it with one Apply. Renders nothing for non-Ops workspaces.
 */
function OpsReposPanel({ workspacePath }: { workspacePath: string }) {
    const [plan, setPlan] = useState<OpsPlan | null>(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);

    const load = async () => {
        try {
            setPlan(await api().tynn.opsPlan(workspacePath));
        } catch {
            setPlan(null);
        }
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspacePath]);

    if (!plan || !plan.isOps) return null; // only meaningful for Ops projects

    const inSync = plan.toAdd.length === 0 && plan.toRemove.length === 0;

    const apply = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api().tynn.opsApply(workspacePath, {
                add: plan.toAdd,
                remove: plan.toRemove.map((x) => x.name),
            });
            const parts = [];
            if (r.added.length) parts.push(`added ${r.added.length}`);
            if (r.removed.length) parts.push(`removed ${r.removed.length}`);
            if (r.errors.length) parts.push(`${r.errors.length} error(s)`);
            setMsg(parts.length ? parts.join(', ') + '.' : 'No changes applied.');
            await load();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section
            title="Ops-managed repos"
            sub="Kept in sync with governed projects' *.agi repos — you approve each sync"
        >
            {inSync ? (
                <Text size="xs" style={{ color: 'var(--emerald-600)', paddingTop: 4 }}>
                    <Icon name="check" size="xs" /> In sync.
                </Text>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {plan.toAdd.map((r) => (
                        <Text key={r.url} size="xs">
                            <span style={{ color: 'var(--emerald-600)' }}>+ add</span> {r.name}
                        </Text>
                    ))}
                    {plan.toRemove.map((r) => (
                        <Text key={r.name} size="xs">
                            <span style={{ color: 'var(--rose-500)' }}>− remove</span> {r.name}
                        </Text>
                    ))}
                    <div style={{ marginTop: 4 }}>
                        <Action size="sm" color="blue" icon="git-merge" disabled={busy} onClick={apply}>
                            {busy ? 'Applying…' : 'Apply changes'}
                        </Action>
                    </div>
                </div>
            )}

            {plan.missingLocally.length > 0 && (
                <Text size="xs" style={{ color: 'var(--amber-600)' }}>
                    {plan.missingLocally.length} governed project(s) aren&apos;t open in Genie
                    ({plan.missingLocally.map((m) => m.name).join(', ')}) — open them so Genie
                    can resolve their repos.
                </Text>
            )}

            {msg && (
                <Text size="xs" className="text-zinc-500">
                    {msg}
                </Text>
            )}
        </Section>
    );
}

type OpsProvisionPlan = Awaited<
    ReturnType<ReturnType<typeof api>['tynn']['opsProvisionPlan']>
>;

/**
 * Ops-project WORKSPACE provisioning. For an Ops workspace, lists every governed
 * child project + whether it already has a local Genie workspace, and lets the
 * user provision the missing ones (clone each child's `*.agi` repo). Mirrors the
 * Ops-managed repos panel above; renders nothing for non-Ops workspaces. Also
 * surfaces the auto-provision TOGGLE: when on, the MCP `provisionWorkspaces`
 * tool provisions directly; when off, the agent's request blocks for approval.
 */
function OpsWorkspacesPanel({ workspacePath }: { workspacePath: string }) {
    const [plan, setPlan] = useState<OpsProvisionPlan | null>(null);
    const [autoProvision, setAutoProvision] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);

    const load = async () => {
        try {
            setPlan(await api().tynn.opsProvisionPlan(workspacePath));
        } catch {
            setPlan(null);
        }
        try {
            const { on } = await api().tynn.opsAutoProvisionGet();
            setAutoProvision(on);
        } catch {
            setAutoProvision(false);
        }
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspacePath]);

    if (!plan || !plan.isOps) return null; // only meaningful for Ops projects

    const missing = plan.children.filter((c) => c.status === 'missing');
    const provisionable = missing.filter((c) => c.cloneUrl);
    const unresolved = missing.filter((c) => !c.cloneUrl);

    const toggleAuto = async (on: boolean) => {
        setAutoProvision(on); // optimistic
        try {
            await api().tynn.opsAutoProvisionSet(on);
        } catch {
            setAutoProvision((prev) => !prev); // revert
        }
    };

    const provision = async () => {
        setBusy(true);
        setMsg(null);
        try {
            const r = await api().tynn.opsProvisionApply(
                workspacePath,
                provisionable.map((c) => ({
                    projectId: c.projectId,
                    name: c.name,
                    slug: c.slug,
                    cloneUrl: c.cloneUrl as string,
                })),
            );
            const parts = [];
            if (r.provisioned.length) parts.push(`provisioned ${r.provisioned.length}`);
            if (r.errors.length) parts.push(`${r.errors.length} error(s)`);
            setMsg(parts.length ? parts.join(', ') + '.' : 'No workspaces provisioned.');
            await load();
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section
            title="Ops-managed workspaces"
            sub="Stand up a local workspace per governed child by cloning its *.agi repo"
        >
            <Row
                label="Auto-provision child workspaces"
                sub="Skip my approval (the provisionWorkspaces MCP tool acts directly)"
            >
                <input
                    type="checkbox"
                    checked={autoProvision ?? false}
                    disabled={autoProvision === null}
                    onChange={(e) => void toggleAuto(e.target.checked)}
                    aria-label="Auto-provision child workspaces"
                />
            </Row>

            {provisionable.length === 0 && unresolved.length === 0 ? (
                <Text size="xs" style={{ color: 'var(--emerald-600)' }}>
                    <Icon name="check" size="xs" /> Every governed child has a workspace.
                </Text>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {provisionable.map((c) => (
                        <Text key={c.projectId} size="xs">
                            <span style={{ color: 'var(--emerald-600)' }}>+ provision</span>{' '}
                            {c.name}
                            <span className="text-zinc-500"> · {c.cloneUrl}</span>
                        </Text>
                    ))}
                    {provisionable.length > 0 && (
                        <div style={{ marginTop: 4 }}>
                            <Action
                                size="sm"
                                color="blue"
                                icon="download"
                                disabled={busy}
                                onClick={provision}
                            >
                                {busy
                                    ? 'Provisioning…'
                                    : `Provision ${provisionable.length} workspace${
                                          provisionable.length === 1 ? '' : 's'
                                      }`}
                            </Action>
                        </div>
                    )}
                </div>
            )}

            {unresolved.length > 0 && (
                <Text size="xs" style={{ color: 'var(--amber-600)' }}>
                    {unresolved.length} governed project(s) have no resolvable{' '}
                    <code>*.agi</code> repo URL
                    ({unresolved.map((m) => m.name).join(', ')}) — can&apos;t auto-clone these.
                </Text>
            )}

            {msg && (
                <Text size="xs" className="text-zinc-500">
                    {msg}
                </Text>
            )}
        </Section>
    );
}
