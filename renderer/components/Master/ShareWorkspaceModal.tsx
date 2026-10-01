import { useCallback, useEffect, useRef, useState } from 'react';
import { Action, Heading, Input, Modal, Select, Text } from '@particle-academy/react-fancy';
import { api, type BatonParticipant, type MobilePeer, type WorkspaceShareLink } from '../../lib/genie';
import { hostSessionRoster, type HostSessionRosterEntry } from '../../lib/host-session-roster';
import { shareInviteNote, shareInviteState } from '../../lib/share-invite-state';
import { shareModalView } from '../../lib/share-modal-view';
import {
    DEFAULT_SHARE_LINK_EXPIRY_DAYS,
    SHARE_LINK_EXPIRY_CHOICES,
} from '../../../main/tynn/share-link-options';

/**
 * SHARE ONE WORKSPACE — the modal the workspace's right-click menu opens.
 *
 * The owner asked for this surface by name: *"I should see a Share Workspace
 * option in the workspace menu when I right click on it"*, opening a modal that
 * creates the link, then shows a **waiting on connection** view with
 * click-to-copy. Everything it needs already existed and was reachable only from
 * two clicks inside Workspace settings, which is why the feature read as missing.
 *
 * It is deliberately NOT the link manager. Settings owns the list of live links
 * and revoking them — a roster you go and look at. This is the thing you do when
 * you want to hand one workspace to one person right now, and it ends the moment
 * they arrive.
 *
 * ONE property shapes it: the URL is served exactly once, on the mint response,
 * and Tynn's list never re-serves it. So the mint form disappears after a
 * successful mint (a second click would replace an unrecoverable URL), and the
 * copy control survives the guest arriving — see `share-modal-view.ts`, where
 * both rules are tested.
 */
const CAPABILITY_OPTIONS = [
    { value: 'readonly', label: 'Read only — they can look, not drive' },
    { value: 'control', label: 'Control — they can use the terminals' },
];

const EXPIRY_OPTIONS = SHARE_LINK_EXPIRY_CHOICES.map((days) => ({
    value: String(days),
    label: days === 1 ? 'Expires in 1 day' : `Expires in ${days} days`,
}));

/** How often the waiting view asks the host whether anyone has arrived.
 *
 *  There is no push for this — `mobile:status` is the only source and it is
 *  polled by the session overlay too. Rather than add a second standing timer,
 *  this one runs ONLY while the modal is open AND waiting, and stops the moment
 *  somebody connects. A `guests:changed` broadcast would retire it; until one
 *  exists, a bounded ask beats a waiting view that never notices. */
const WATCH_MS = 2_000;

export default function ShareWorkspaceModal({
    workspace,
    onClose,
    onManageLinks,
}: {
    workspace: { id: string; project_name: string };
    onClose: () => void;
    /** Open Workspace settings, where live links are listed and revoked. */
    onManageLinks?: () => void;
}) {
    const [availability, setAvailability] = useState<
        { enrolled: true } | { enrolled: false; reason: string } | null
    >(null);
    const [capability, setCapability] = useState<'control' | 'readonly'>('readonly');
    const [expiresInDays, setExpiresInDays] = useState<number>(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
    const [minting, setMinting] = useState(false);
    const [link, setLink] = useState<WorkspaceShareLink | null>(null);
    const [roster, setRoster] = useState<HostSessionRosterEntry[]>([]);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const state = shareInviteState(link, workspace.project_name, roster);
    const view = shareModalView(state);
    const note = shareInviteNote(state);

    useEffect(() => {
        void (async () => {
            try {
                setAvailability(await api().workspaces.shareLinkAvailability());
            } catch {
                // An availability check that failed is not "not enrolled" — it is
                // "we could not ask". Leaving it null keeps the form, and a mint
                // that genuinely cannot work reports Tynn's own words instead.
                setAvailability(null);
            }
        })();
    }, []);

    // Who is connected. Read once on open, then only while WAITING — the state
    // machine owns that decision (`view.watching`) so the rule is tested rather
    // than buried in an effect.
    const readRoster = useCallback(async () => {
        try {
            const s = await api().mobile.status();
            setRoster(
                hostSessionRoster(
                    (s.participants ?? []) as BatonParticipant[],
                    (s.peers ?? []) as MobilePeer[],
                    !!s.locked,
                ),
            );
        } catch {
            /* A host that cannot be asked is not a host with nobody on it, so the
               view stays where it is rather than claiming the guest left. */
        }
    }, []);

    const watching = view.watching;
    const timer = useRef<ReturnType<typeof setInterval> | null>(null);
    useEffect(() => {
        void readRoster();
        if (!watching) return;
        timer.current = setInterval(() => void readRoster(), WATCH_MS);
        return () => {
            if (timer.current) clearInterval(timer.current);
            timer.current = null;
        };
    }, [watching, readRoster]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const mint = async () => {
        if (minting) return;
        setMinting(true);
        setError(null);
        try {
            const res = await api().workspaces.mintShareLink(workspace.id, {
                capability,
                expiresInDays,
            });
            if (!res.ok) {
                setError(res.error);
                return;
            }
            setLink(res.link);
            setCopied(false);
        } finally {
            setMinting(false);
        }
    };

    const copy = async (url: string) => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
        } catch {
            // Denied. The URL is on screen and selectable, so the link is still
            // obtainable — saying "Copied" when it was not is the failure here.
            setCopied(false);
            setError('Could not reach the clipboard — select the link above and copy it.');
        }
    };

    if (availability && !availability.enrolled) {
        return (
            <Modal open onClose={onClose} size="md">
                <div className="ws-settings">
                    <div className="ws-settings-head">
                        <Heading as="h2" size="sm">
                            Share {workspace.project_name}
                        </Heading>
                    </div>
                    <Text size="sm" style={{ color: 'var(--fg-3)' }}>
                        {availability.reason}
                    </Text>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                        <Action size="sm" onClick={onClose}>
                            Close
                        </Action>
                    </div>
                </div>
            </Modal>
        );
    }

    return (
        <Modal open onClose={onClose} size="md">
            <div className="ws-settings" data-testid="share-workspace-modal">
                <div className="ws-settings-head">
                    <Heading as="h2" size="sm">
                        {view.title} — {workspace.project_name}
                    </Heading>
                    <Text size="xs" className="text-zinc-500">
                        Opens THIS workspace in their Genie. Claimed by whoever opens it first.
                    </Text>
                </div>

                {view.showMintForm && (
                    <div
                        style={{
                            display: 'flex',
                            gap: 8,
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            marginTop: 12,
                        }}
                    >
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
                            disabled={minting}
                            onClick={mint}
                        >
                            {minting ? 'Creating…' : 'Create link'}
                        </Action>
                    </div>
                )}

                {view.canCopy && link?.url && (
                    <div className="ws-tools" data-testid="share-link" style={{ marginTop: 12 }}>
                        <Text size="xs" style={{ color: 'var(--amber-400)' }}>
                            Copy this now — it is shown once and never again.
                        </Text>
                        <Input value={link.url} readOnly aria-label="Share link URL" />
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <Action
                                size="sm"
                                color="blue"
                                icon={copied ? 'check' : 'copy'}
                                onClick={() => void copy(link.url as string)}
                            >
                                {copied ? 'Copied' : 'Copy link'}
                            </Action>
                            {note && (
                                <Text size="xs" style={{ color: 'var(--fg-3)' }}>
                                    {note}
                                </Text>
                            )}
                        </div>
                    </div>
                )}

                {error && (
                    <Text size="xs" style={{ color: 'var(--rose-400)', marginTop: 8 }}>
                        {error}
                    </Text>
                )}

                <div
                    style={{
                        display: 'flex',
                        gap: 8,
                        justifyContent: 'flex-end',
                        marginTop: 16,
                    }}
                >
                    {onManageLinks && (
                        <Action size="sm" onClick={onManageLinks}>
                            Manage links…
                        </Action>
                    )}
                    <Action size="sm" onClick={onClose}>
                        Done
                    </Action>
                </div>
            </div>
        </Modal>
    );
}
