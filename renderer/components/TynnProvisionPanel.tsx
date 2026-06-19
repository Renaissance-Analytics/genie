import { useEffect, useState } from 'react';
import { Action, Heading, Icon, Select, Text } from '@particle-academy/react-fancy';
import { api } from '../lib/genie';

/**
 * Tynn auto-provisioning — per-workspace panel.
 *
 * Surfaces where a workspace stands: unlinked (pick a Tynn project), signed-out
 * (sign in on the Connections tab), or linked (agent token written into
 * .mcp.json, with a Re-provision/refresh). Provisioning itself is "auto on
 * open"; this panel is the manual control + status mirror. Reused by both
 * Settings → Agent MCP (active workspace) and the per-workspace settings modal.
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

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Heading as="h3" size="xs" style={{ margin: 0 }}>
                Tynn agent (auto-provisioned)
            </Heading>
            <Text size="xs" className="text-zinc-500">
                When this workspace is linked to a Tynn project and you&apos;re
                signed in, Genie mints an MCP agent token and writes the{' '}
                <code>tynn</code> server into <code>.mcp.json</code> automatically
                on open — so agents here can manage work in Tynn. The token never
                touches <code>project.json</code> (only the link does).
            </Text>

            {!workspaceId || !path ? (
                <Text size="xs" className="text-zinc-500">
                    Open a workspace to manage its Tynn agent.
                </Text>
            ) : status === 'signed-out' ? (
                <Text size="xs" style={{ color: 'var(--amber-600)' }}>
                    Linked to a Tynn project, but you&apos;re not signed in. Sign in
                    on the <strong>Connections</strong> tab — Genie will provision on
                    the next open.
                </Text>
            ) : status === 'unlinked' ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
                        {status === 'already' ? ' — agent token in .mcp.json' : ''}
                    </Text>
                    <span style={{ flex: 1 }} />
                    <Action size="sm" variant="ghost" icon="refresh-cw" disabled={busy} onClick={reprovision}>
                        {busy ? 'Re-provisioning…' : 'Re-provision'}
                    </Action>
                </div>
            )}

            {msg && (
                <Text size="xs" className="text-zinc-500">
                    {msg}
                </Text>
            )}
        </div>
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
