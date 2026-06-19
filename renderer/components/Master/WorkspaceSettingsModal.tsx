import { useEffect, useState } from 'react';
import { Action, Heading, Icon, Modal, Text } from '@particle-academy/react-fancy';
import TynnProvisionPanel from '../TynnProvisionPanel';
import type { WorkspaceRow } from '../../lib/genie';
import { api } from '../../lib/genie';

/**
 * Per-workspace settings, opened from the workspace context menu. Edits the
 * settings that belong to ONE workspace — attaching a Tynn project (and its
 * auto-provisioned agent token) and the background-process-approval gate.
 * Global/app settings still live in the Settings window.
 */
export default function WorkspaceSettingsModal({
    workspace,
    onClose,
}: {
    workspace: WorkspaceRow;
    onClose: () => void;
}) {
    // Per-workspace "require approval before an agent starts a process".
    const [processApproval, setProcessApproval] = useState<boolean | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const ws = (await api().workspaces.list()).find((w) => w.id === workspace.id);
                if (alive) setProcessApproval(ws ? ws.process_approval !== 0 : true);
            } catch {
                if (alive) setProcessApproval(true);
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

    return (
        <Modal open onClose={onClose} size="md">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 4 }}>
                <div>
                    <Heading as="h2" size="sm" style={{ margin: 0 }}>
                        Workspace settings
                    </Heading>
                    <Text size="xs" className="text-zinc-500">
                        {workspace.project_name}
                        {workspace.path ? ` · ${workspace.path}` : ''}
                    </Text>
                </div>

                <TynnProvisionPanel workspaceId={workspace.id} />

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
            </div>
        </Modal>
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
