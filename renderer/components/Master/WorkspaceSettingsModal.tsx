import { useEffect, useState } from 'react';
import { Action, Heading, Icon, Input, Modal, Text } from '@particle-academy/react-fancy';
import TynnProvisionPanel from '../TynnProvisionPanel';
import type {
    WorkspaceRow,
    WorkspaceDocHealth,
    EnvelopeRepoView,
    KnowledgeFolderView,
} from '../../lib/genie';
import { api } from '../../lib/genie';

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

    return (
        <Modal open onClose={onClose} size="md">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20 }}>
                <div>
                    <Heading as="h2" size="sm" style={{ margin: 0 }}>
                        Workspace settings
                    </Heading>
                    {workspace.path && (
                        <Text size="xs" className="text-zinc-500">
                            {workspace.path}
                        </Text>
                    )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Heading as="h3" size="xs" style={{ margin: 0 }}>
                        Name
                    </Heading>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                        <div style={{ flex: 1 }}>
                            <Input
                                value={name}
                                onValueChange={setName}
                                placeholder="Workspace name"
                                onKeyDown={(e: React.KeyboardEvent) => {
                                    if (e.key === 'Enter') void saveName();
                                }}
                            />
                        </div>
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
                    {nameSaved && (
                        <Text size="xs" style={{ color: 'var(--emerald-600)' }}>
                            <Icon name="check" size="xs" /> Renamed
                        </Text>
                    )}
                </div>

                <TynnProvisionPanel workspaceId={workspace.id} />

                {workspace.path && <EnvelopeReposPanel workspacePath={workspace.path} />}

                {workspace.path && <KnowledgeFoldersPanel workspacePath={workspace.path} />}

                <WorkspaceDocsPanel workspaceId={workspace.id} />

                {workspace.path && <OpsReposPanel workspacePath={workspace.path} />}

                {workspace.path && <OpsWorkspacesPanel workspacePath={workspace.path} />}

                <div
                    style={{
                        paddingTop: 12,
                        borderTop: '1px solid var(--border-1)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                    }}
                >
                    <Heading as="h3" size="xs" style={{ margin: 0 }}>
                        Background process approval
                    </Heading>
                    <Text size="xs" className="text-zinc-500">
                        When ON, an agent that tries to start a background process
                        (via <code>manageProcess</code>) must be approved by you
                        first.
                    </Text>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={processApproval ?? true}
                            disabled={processApproval === null}
                            onChange={(e) => void toggleProcessApproval(e.target.checked)}
                        />
                        <Text size="sm">Require my approval before an agent starts a process</Text>
                    </label>
                </div>

                <div
                    style={{
                        paddingTop: 12,
                        borderTop: '1px solid var(--border-1)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                    }}
                >
                    <Heading as="h3" size="xs" style={{ margin: 0 }}>
                        Terminal &amp; agent approval
                    </Heading>
                    <Text size="xs" className="text-zinc-500">
                        When ON, an agent that tries to open a terminal, run a
                        command, or launch/drive a coding agent (via{' '}
                        <code>manageTerminals</code> / <code>runAgent</code>) must be
                        approved by you first. This is higher-power than process
                        approval — it can execute arbitrary code and spawn other
                        agents — so leave it on unless you trust the agent fully.
                    </Text>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={terminalApproval ?? true}
                            disabled={terminalApproval === null}
                            onChange={(e) => void toggleTerminalApproval(e.target.checked)}
                        />
                        <Text size="sm">
                            Require my approval before an agent runs a terminal or launches an agent
                        </Text>
                    </label>
                </div>
            </div>
        </Modal>
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
        <div
            style={{
                paddingTop: 12,
                borderTop: '1px solid var(--border-1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}
        >
            <Heading as="h3" size="xs" style={{ margin: 0 }}>
                Workspace docs
            </Heading>
            <Text size="xs" className="text-zinc-500">
                Keep this workspace&apos;s <code>AGENTS.md</code> (with the Genie MCP
                section) and <code>CLAUDE.md</code> healthy. Repair is idempotent and
                safe to re-run; a divergent <code>CLAUDE.md</code> is reported, never
                overwritten.
            </Text>
            {docHealth && (
                <Text
                    size="xs"
                    style={{
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
                                    ? 'CLAUDE.md diverges from AGENTS.md (won’t auto-overwrite)'
                                    : docHealth.claude === 'broken-pointer'
                                        ? 'CLAUDE.md is a broken one-liner'
                                        : docHealth.claude === 'missing'
                                            ? 'CLAUDE.md missing'
                                            : 'Needs repair'}
                </Text>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Action
                    variant="ghost"
                    icon="wrench"
                    onClick={repairDocs}
                    disabled={repairing}
                >
                    {repairing ? 'Repairing…' : 'Repair workspace docs'}
                </Action>
                {repairMsg && (
                    <Text size="xs" className="text-zinc-500">
                        {repairMsg}
                    </Text>
                )}
            </div>
        </div>
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
        <div
            style={{
                paddingTop: 12,
                borderTop: '1px solid var(--border-1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Heading as="h3" size="xs" style={{ margin: 0 }}>
                    Repos
                </Heading>
                <span style={{ flex: 1 }} />
                <Action
                    size="sm"
                    variant="ghost"
                    icon="plus"
                    onClick={() => setShowAdd((s) => !s)}
                >
                    Add repo
                </Action>
            </div>
            <Text size="xs" className="text-zinc-500">
                The envelope&apos;s member repos — git submodules under{' '}
                <code>repos/</code>, registered in <code>project.json</code>. Add or
                remove leaves the change staged for you to commit.
            </Text>

            {repos.length === 0 ? (
                <Text size="xs" className="text-zinc-500">
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
        </div>
    );
}

/**
 * Envelope `.ai/` knowledge folders — only for a `.agi` workspace (else renders
 * nothing). Shows the standard knowledge buckets (`.ai/knowledge`, `.ai/plans`,
 * …) with whether each exists + how many entries, an Open (reveal), and a Create
 * for a missing one. This is the envelope's knowledge-folder mapping: which
 * buckets are present and where they live.
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
        <div
            style={{
                paddingTop: 12,
                borderTop: '1px solid var(--border-1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}
        >
            <Heading as="h3" size="xs" style={{ margin: 0 }}>
                Knowledge folders
            </Heading>
            <Text size="xs" className="text-zinc-500">
                The envelope&apos;s shared-knowledge buckets under <code>.ai/</code>.
                Create the ones you use; agents read and write them as the
                project&apos;s memory.
            </Text>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {folders.map((f) => (
                    <div
                        key={f.name}
                        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                        <Icon
                            name={f.exists ? 'folder' : 'folder-plus'}
                            size="xs"
                            className="text-zinc-500"
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <Text size="sm" style={{ fontWeight: 600 }}>
                                {f.relPath}
                            </Text>
                            <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>
                                {f.exists
                                    ? `${f.entryCount} item${f.entryCount === 1 ? '' : 's'}`
                                    : 'not created'}
                            </Text>
                        </div>
                        {f.exists ? (
                            <Action
                                size="sm"
                                variant="ghost"
                                icon="folder-open"
                                disabled={busy !== null}
                                onClick={() => open(f.relPath)}
                            >
                                Open
                            </Action>
                        ) : (
                            <Action
                                size="sm"
                                variant="ghost"
                                icon="plus"
                                disabled={busy !== null}
                                onClick={() => void create(f.name)}
                            >
                                {busy === f.name ? 'Creating…' : 'Create'}
                            </Action>
                        )}
                    </div>
                ))}
            </div>
            {error && (
                <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                    {error}
                </Text>
            )}
        </div>
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
        <div
            style={{
                paddingTop: 12,
                borderTop: '1px solid var(--border-1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}
        >
            <Heading as="h3" size="xs" style={{ margin: 0 }}>
                Ops-managed repos
            </Heading>
            <Text size="xs" className="text-zinc-500">
                This Ops project governs other projects. Genie keeps its envelope&apos;s
                repos in sync with the <code>*.agi</code> repos of those projects — you
                approve each sync.
            </Text>

            {inSync ? (
                <Text size="xs" style={{ color: 'var(--emerald-600)' }}>
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
        </div>
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
        <div
            style={{
                paddingTop: 12,
                borderTop: '1px solid var(--border-1)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}
        >
            <Heading as="h3" size="xs" style={{ margin: 0 }}>
                Ops-managed workspaces
            </Heading>
            <Text size="xs" className="text-zinc-500">
                This Ops project governs other projects. Genie can stand up a local
                workspace for each governed child by cloning its <code>*.agi</code>{' '}
                repo — you approve each batch (or turn on auto-provision below).
            </Text>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                    type="checkbox"
                    checked={autoProvision ?? false}
                    disabled={autoProvision === null}
                    onChange={(e) => void toggleAuto(e.target.checked)}
                />
                <Text size="sm">
                    Auto-provision child workspaces (skip my approval)
                </Text>
            </label>

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
        </div>
    );
}
