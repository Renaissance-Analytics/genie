import { useEffect, useState } from 'react';
import { Action, Icon, Select, Text } from '@particle-academy/react-fancy';
import { api } from '../lib/genie';

/**
 * Tynn auto-provisioning — per-workspace panel (the workspace settings modal).
 *
 * Surfaces where a workspace stands: unlinked (pick a Tynn project), signed-out
 * (sign in on the Connections tab), or linked (agent token written into
 * .mcp.json, with a Re-provision / Unlink). Provisioning itself is "auto on
 * open"; this panel is the manual control + status mirror. Dense `.set-section`.
 */
export default function TynnProvisionPanel({ workspaceId }: { workspaceId?: string }) {
    const [path, setPath] = useState<string | null>(null);
    const [status, setStatus] = useState<
        'unlinked' | 'signed-out' | 'already' | 'provision' | null
    >(null);
    const [link, setLink] = useState<{ owner?: string; project?: string } | null>(null);
    const [projects, setProjects] = useState<
        Array<{ id: string; name: string; slug: string; owner_name?: string }>
    >([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);

    const refresh = async () => {
        setMsg(null);
        if (!workspaceId) {
            setPath(null);
            setStatus(null);
            return;
        }
        const ws = (await api().workspaces.list()).find((w) => w.id === workspaceId);
        const wsPath = ws?.path ?? null;
        setPath(wsPath);
        if (!wsPath) return;
        try {
            const s = await api().tynn.provisionStatus(wsPath);
            setStatus(s.status);
            setLink(s.link);
            if (s.status === 'unlinked') {
                setProjects(await api().tynn.projects());
            }
        } catch {
            setStatus(null);
        }
    };

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspaceId]);

    const host = async () => {
        try {
            return await api().tynnHost.get();
        } catch {
            return undefined;
        }
    };

    const linkAndProvision = async () => {
        if (!path || !picked) return;
        const proj = projects.find((p) => p.id === picked);
        if (!proj) return;
        setBusy(true);
        setMsg(null);
        try {
            await api().tynn.link(path, {
                host: await host(),
                owner: proj.owner_name,
                project: proj.slug,
                projectId: proj.id,
            });
            setMsg(provisionMessage(await api().tynn.provision(path, true)));
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    const reprovision = async () => {
        if (!path) return;
        setBusy(true);
        setMsg(null);
        try {
            setMsg(provisionMessage(await api().tynn.provision(path, true)));
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    const unlink = async () => {
        if (!path) return;
        setBusy(true);
        setMsg(null);
        try {
            await api().tynn.unlink(path);
            setMsg('Unlinked from the Tynn project.');
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="set-section">
            <div className="set-section-head">
                <h2>Tynn agent</h2>
                <span className="set-section-desc">
                    Auto-provisions an MCP agent token into .mcp.json on open
                </span>
            </div>

            {!workspaceId || !path ? (
                <Text size="xs" className="text-zinc-500" style={{ paddingTop: 4 }}>
                    Open a workspace to manage its Tynn agent.
                </Text>
            ) : status === 'signed-out' ? (
                <Text size="xs" style={{ color: 'var(--amber-600)', paddingTop: 4 }}>
                    Linked, but not signed in — sign in on the{' '}
                    <strong>Connections</strong> tab.
                </Text>
            ) : status === 'unlinked' ? (
                <div
                    style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        paddingTop: 6,
                    }}
                >
                    <Select
                        value={picked}
                        onValueChange={setPicked}
                        list={[
                            { value: '', label: 'Pick a Tynn project…' },
                            ...projects.map((p) => ({
                                value: p.id,
                                label: p.owner_name ? `${p.owner_name} / ${p.name}` : p.name,
                            })),
                        ]}
                    />
                    <Action
                        size="sm"
                        color="blue"
                        icon="link"
                        disabled={!picked || busy}
                        onClick={linkAndProvision}
                    >
                        {busy ? 'Provisioning…' : 'Link & provision'}
                    </Action>
                </div>
            ) : (
                <div
                    style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        paddingTop: 6,
                    }}
                >
                    <Text size="xs" style={{ color: 'var(--emerald-600)' }}>
                        <Icon name="check" size="xs" /> Linked
                        {link?.project ? (
                            <>
                                {' '}to{' '}
                                <strong>
                                    {link.owner ? `${link.owner}/` : ''}
                                    {link.project}
                                </strong>
                            </>
                        ) : null}
                        {status === 'already' ? ' — token in .mcp.json' : ''}
                    </Text>
                    <span style={{ flex: 1 }} />
                    <Action size="sm" variant="ghost" icon="refresh-cw" disabled={busy} onClick={reprovision}>
                        {busy ? 'Re-provisioning…' : 'Re-provision'}
                    </Action>
                    <Action size="sm" variant="ghost" icon="unlink" disabled={busy} onClick={unlink}>
                        Unlink
                    </Action>
                </div>
            )}

            {msg && (
                <Text size="xs" className="text-zinc-500" style={{ marginTop: 4 }}>
                    {msg}
                </Text>
            )}
        </section>
    );
}

/** Human-readable result of a tynn:provision call. */
function provisionMessage(r: {
    status: string;
    agent?: { name: string };
    isOpsProject?: boolean;
    error?: string;
}): string {
    switch (r.status) {
        case 'provision':
            return `Provisioned agent "${r.agent?.name ?? 'Genie'}"${
                r.isOpsProject ? ' (Ops project — full access)' : ''
            } and wrote .mcp.json.`;
        case 'already':
            return 'Already provisioned — .mcp.json has the tynn server.';
        case 'signed-out':
            return 'Not signed in to Tynn — sign in on the Connections tab.';
        case 'unlinked':
            return 'This workspace isn’t linked to a Tynn project.';
        case 'error':
            return `Couldn’t provision: ${r.error ?? 'unknown error'}.`;
        default:
            return '';
    }
}
