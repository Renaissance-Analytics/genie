import { useCallback, useEffect, useState } from 'react';
import { Action, Input, Select, Text } from '@particle-academy/react-fancy';
import { IconX } from './icons';
import { api, hasGenieBridge, type WorkspaceRow, type WorkspaceShareLink } from '../../lib/genie';
import { classifyConnectLink } from '../../../main/tynn/connect-link';
import {
    DEFAULT_SHARE_LINK_EXPIRY_DAYS,
    SHARE_LINK_EXPIRY_CHOICES,
} from '../../../main/tynn/share-link-options';

/**
 * SHARING — the one place that answers "what have I given away, and to whom?"
 *
 * The owner asked for this surface specifically, as the global counterpart to
 * the per-workspace right-click: a header icon that opens *"a global overview of
 * all shared workspaces and link lists with actions, plus workstation sharing
 * controls, plus a Connect to.. button."*
 *
 * The shape follows from one fact about links: a link is a credential you cannot
 * unsend, so the only real control over one is being able to SEE it and revoke
 * it. That makes this a roster first and a minting form second — the opposite
 * emphasis to the Share modal, which exists to hand one workspace to one person
 * and ends the moment they arrive.
 *
 * Three sections, in the order the owner listed them:
 *
 *  1. SHARED WORKSPACES — every workspace with a live link, and revoke on each.
 *  2. THIS WORKSTATION — mint a link over several workspaces, or the machine.
 *  3. CONNECT TO… — the inbound half. Takes either kind of link; the classifier
 *     (`main/tynn/connect-link.ts`) decides which, and says so when it is
 *     neither rather than failing silently.
 */
interface WorkspaceLinks {
    workspace: WorkspaceRow;
    links: WorkspaceShareLink[];
}

const CAPABILITY_OPTIONS = [
    { value: 'readonly', label: 'Read only — they can look, not drive' },
    { value: 'control', label: 'Control — they can use the terminals' },
];

const EXPIRY_OPTIONS = SHARE_LINK_EXPIRY_CHOICES.map((days) => ({
    value: String(days),
    label: days === 1 ? 'Expires in 1 day' : `Expires in ${days} days`,
}));

export default function SharingFlyout({
    open,
    onClose,
    workspaces,
    tynnHost,
    onShareWorkspace,
}: {
    open: boolean;
    onClose: () => void;
    workspaces: WorkspaceRow[];
    /** Where this Genie is signed in — a link for anywhere else is refused. */
    tynnHost: string;
    /** Open the per-workspace Share modal, so the overview can hand off rather
     *  than grow a second minting form for the thing that already has one. */
    onShareWorkspace?: (workspaceId: string) => void;
}) {
    const [enrolled, setEnrolled] = useState<
        { enrolled: true } | { enrolled: false; reason: string } | null
    >(null);
    const [rows, setRows] = useState<WorkspaceLinks[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // --- the workstation minting form ---------------------------------------
    const [capability, setCapability] = useState<'control' | 'readonly'>('readonly');
    const [expiresInDays, setExpiresInDays] = useState(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
    const [allWorkspaces, setAllWorkspaces] = useState(false);
    const [picked, setPicked] = useState<string[]>([]);
    const [minting, setMinting] = useState(false);
    const [fresh, setFresh] = useState<WorkspaceShareLink | null>(null);
    const [copied, setCopied] = useState(false);

    // --- connect to… ---------------------------------------------------------
    const [pasted, setPasted] = useState('');
    const [connectNote, setConnectNote] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!hasGenieBridge()) return;
        setLoading(true);
        try {
            setEnrolled(await api().workspaces.shareLinkAvailability());
            // One call per workspace: Tynn's list is per-machine and narrowed
            // client-side, so there is no cheaper shape available here. Only on
            // open, never on a timer.
            const all = await Promise.all(
                workspaces.map(async (workspace) => ({
                    workspace,
                    links: await api().workspaces.listShareLinks(workspace.id),
                })),
            );
            setRows(all.filter((r) => r.links.length > 0));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [workspaces]);

    useEffect(() => {
        if (!open) return;
        void load();
    }, [open, load]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const revoke = async (id: string) => {
        setError(null);
        const res = await api().workspaces.revokeShareLink(id);
        if (!res.ok) setError(res.error ?? 'Could not invalidate that link.');
        // Re-read either way. Pruning optimistically on a FAILED revoke would
        // show a live link as gone, which is the one lie this surface cannot
        // afford — the whole point of it is knowing what is still out there.
        await load();
    };

    const mintWorkstation = async () => {
        if (minting) return;
        setMinting(true);
        setError(null);
        try {
            const res = await api().workspaces.mintWorkstationShareLink({
                capability,
                expiresInDays,
                ...(allWorkspaces ? { allWorkspaces: true } : { workspaces: picked }),
            });
            if (!res.ok) {
                setError(res.error);
                return;
            }
            setFresh(res.link);
            setCopied(false);
            await load();
        } finally {
            setMinting(false);
        }
    };

    const copy = async (url: string) => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
        } catch {
            setCopied(false);
            setError('Could not reach the clipboard — select the link above and copy it.');
        }
    };

    const connect = async () => {
        // Classified here only to refuse an obvious paste without a round trip —
        // MAIN is where it is actually routed, because only main can hand a
        // `genie://` link to the protocol router, and the renderer must not be
        // the thing that decides what leaves the app.
        const local = classifyConnectLink(pasted, tynnHost);
        if (local.kind === 'unknown') {
            setConnectNote(local.reason);
            return;
        }
        setConnectNote(null);
        const res = await api().workspaces.connectLink(pasted);
        setConnectNote(res.note);
    };

    const canMint = allWorkspaces || picked.length > 0;

    return (
        <div className={`docs-flyout-root${open ? ' open' : ''}`} aria-hidden={!open}>
            <div className="docs-scrim" onClick={onClose} />
            <aside
                className="docs-flyout sharing-flyout"
                role="dialog"
                aria-modal="true"
                aria-label="Sharing"
            >
                <div className="docs-head">
                    <span className="docs-title">Sharing</span>
                    <span className="grow" />
                    <button type="button" className="gicon" aria-label="Close" onClick={onClose}>
                        <IconX size={14} />
                    </button>
                </div>

                <div className="sharing-body">
                    {enrolled && !enrolled.enrolled ? (
                        <Text size="sm" style={{ color: 'var(--fg-3)' }}>
                            {enrolled.reason}
                        </Text>
                    ) : (
                        <>
                            {/* 1. WHAT IS ALREADY SHARED ----------------------- */}
                            <section className="sharing-section">
                                <h3 className="sharing-h">Shared workspaces</h3>
                                {loading && rows.length === 0 ? (
                                    <Text size="xs" style={{ color: 'var(--fg-3)' }}>
                                        Checking…
                                    </Text>
                                ) : rows.length === 0 ? (
                                    <Text size="xs" style={{ color: 'var(--fg-3)' }}>
                                        Nothing is shared. Right-click a workspace to share it.
                                    </Text>
                                ) : (
                                    rows.map(({ workspace, links }) => (
                                        <div key={workspace.id} className="sharing-ws">
                                            <div className="sharing-ws-head">
                                                <span className="sharing-ws-name">
                                                    {workspace.project_name}
                                                </span>
                                                {onShareWorkspace && (
                                                    <Action
                                                        size="sm"
                                                        icon="link"
                                                        onClick={() => onShareWorkspace(workspace.id)}
                                                    >
                                                        New link
                                                    </Action>
                                                )}
                                            </div>
                                            {links.map((link) => (
                                                <div key={link.id} className="sharing-link">
                                                    <Text size="xs">
                                                        {link.capability === 'control'
                                                            ? 'Control'
                                                            : 'Read only'}
                                                        {link.expires_at
                                                            ? ` · expires ${new Date(
                                                                  link.expires_at,
                                                              ).toLocaleDateString()}`
                                                            : ''}
                                                    </Text>
                                                    <span style={{ marginLeft: 'auto' }}>
                                                        <Action
                                                            size="sm"
                                                            color="red"
                                                            icon="trash"
                                                            onClick={() => void revoke(link.id)}
                                                        >
                                                            Invalidate
                                                        </Action>
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    ))
                                )}
                            </section>

                            {/* 2. THE WHOLE MACHINE ---------------------------- */}
                            <section className="sharing-section">
                                <h3 className="sharing-h">This workstation</h3>
                                <Text size="xs" style={{ color: 'var(--fg-3)' }}>
                                    One link that reaches more than one workspace. Claimed by
                                    whoever opens it first.
                                </Text>
                                <label className="sharing-check">
                                    <input
                                        type="checkbox"
                                        checked={allWorkspaces}
                                        onChange={(e) => setAllWorkspaces(e.target.checked)}
                                    />
                                    <span>
                                        Every workspace, including ones I add later
                                    </span>
                                </label>
                                {!allWorkspaces && (
                                    <div className="sharing-picklist">
                                        {workspaces.map((w) => (
                                            <label key={w.id} className="sharing-check">
                                                <input
                                                    type="checkbox"
                                                    checked={picked.includes(w.id)}
                                                    onChange={(e) =>
                                                        setPicked((cur) =>
                                                            e.target.checked
                                                                ? [...cur, w.id]
                                                                : cur.filter((id) => id !== w.id),
                                                        )
                                                    }
                                                />
                                                <span>{w.project_name}</span>
                                            </label>
                                        ))}
                                    </div>
                                )}
                                <div className="sharing-row">
                                    <Select
                                        value={capability}
                                        onValueChange={(v: string) =>
                                            setCapability(v as 'control' | 'readonly')
                                        }
                                        list={CAPABILITY_OPTIONS}
                                        aria-label="What the link grants"
                                    />
                                    <Select
                                        value={String(expiresInDays)}
                                        onValueChange={(v: string) => setExpiresInDays(Number(v))}
                                        list={EXPIRY_OPTIONS}
                                        aria-label="Link expiry"
                                    />
                                    <Action
                                        size="sm"
                                        color="blue"
                                        icon="link"
                                        disabled={minting || !canMint}
                                        onClick={mintWorkstation}
                                    >
                                        {minting ? 'Creating…' : 'Create link'}
                                    </Action>
                                </div>
                                {fresh?.url && (
                                    <div className="ws-tools" data-testid="workstation-link">
                                        <Text size="xs" style={{ color: 'var(--amber-400)' }}>
                                            Copy this now — it is shown once and never again.
                                        </Text>
                                        <Input
                                            value={fresh.url}
                                            readOnly
                                            aria-label="Workstation link URL"
                                        />
                                        <Action
                                            size="sm"
                                            color="blue"
                                            icon={copied ? 'check' : 'copy'}
                                            onClick={() => void copy(fresh.url as string)}
                                        >
                                            {copied ? 'Copied' : 'Copy link'}
                                        </Action>
                                    </div>
                                )}
                            </section>

                            {/* 3. THE INBOUND HALF ----------------------------- */}
                            <section className="sharing-section">
                                <h3 className="sharing-h">Connect to…</h3>
                                <Text size="xs" style={{ color: 'var(--fg-3)' }}>
                                    Paste a link somebody sent you — a workspace or a whole
                                    workstation.
                                </Text>
                                <div className="sharing-row">
                                    <Input
                                        value={pasted}
                                        onChange={(e) => setPasted(e.target.value)}
                                        placeholder="https://… or genie://…"
                                        aria-label="Genie link to connect to"
                                    />
                                    <Action size="sm" color="blue" onClick={() => void connect()}>
                                        Connect
                                    </Action>
                                </div>
                                {connectNote && (
                                    <Text size="xs" style={{ color: 'var(--fg-3)' }}>
                                        {connectNote}
                                    </Text>
                                )}
                            </section>
                        </>
                    )}

                    {error && (
                        <Text size="xs" style={{ color: 'var(--rose-400)' }}>
                            {error}
                        </Text>
                    )}
                </div>
            </aside>
        </div>
    );
}
