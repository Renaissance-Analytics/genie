import { Button, Icon, Modal, Select } from '@particle-academy/react-fancy';
import { useState } from 'react';
import type { ConnectProgress } from '../../core/connect-machine.js';
import type { ShareLink } from '../../main/tynn-share-links.js';
import { CopyAnnounce, copyWords, useCopyText } from './CopyText.js';

/**
 * SHARE THIS WORKSPACE THROUGH TYNN (Tynn #839; Genie 1's ShareWorkspaceModal, v1 inventory rows 111-116). Control or
 * read-only, for how long, this workspace or the whole workstation; Create link answers with the link — shown ONCE, with
 * Copy — and the links that already reach this workspace are listed, each revocable.
 *
 * A link someone has opened is CLAIMED (tynn.ai #394): one guest's single session, live until they leave or it expires.
 * Its Revoke ends that session too (audit M-c). Every Revoke shows where it stands: its step while Tynn is asked, then
 * what it did, or why it failed with Retry.
 */

const EXPIRY = [1, 7, 14, 30] as const;
const button = 'rounded-md border border-[var(--border-1)] px-2 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';

export interface ShareWorkspaceModalProps {
    readonly workspaceName: string;
    /** Links that reach this workspace; `null` = not read yet. */
    readonly links: readonly ShareLink[] | null;
    /** The link just made — its URL is served this once. */
    readonly minted: ShareLink | null;
    readonly problem: string | null;
    readonly busy: boolean;
    readonly onMint: (input: { capability: 'control' | 'readonly'; expiresInDays: number; whole: boolean }) => void;
    /** Revoke one link; the answer is shown on its row (working, then done, or failed with Retry). */
    readonly onRevoke: (link: ShareLink) => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly onClose: () => void;
}

function linkWords(l: ShareLink): string {
    const reach = l.whole ? 'the whole workstation' : 'this workspace';
    const until = l.expiresAt ? ` until ${new Date(l.expiresAt).toLocaleDateString()}` : '';
    return `${l.capability === 'readonly' ? 'Read-only' : 'Control'} · ${reach}${until}`;
}

/** The dialog: Fancy's Modal around the form. */
export function ShareWorkspaceModal(props: ShareWorkspaceModalProps) {
    return (
        <Modal open onClose={props.onClose} size="lg">
            <Modal.Header>Share {props.workspaceName} through Tynn</Modal.Header>
            <Modal.Body>
                <ShareWorkspaceForm {...props} />
            </Modal.Body>
        </Modal>
    );
}

export function ShareWorkspaceForm({ workspaceName, links, minted, problem, busy, onMint, onRevoke }: ShareWorkspaceModalProps) {
    const [capability, setCapability] = useState<'control' | 'readonly'>('control');
    const [days, setDays] = useState<number>(7);
    const [whole, setWhole] = useState(false);
    // Copied through main's clipboard, and it says whether it landed (CopyText).
    const linkCopy = useCopyText();
    // Where each row's Revoke stands, and what the last one that worked did.
    const [revoking, setRevoking] = useState<Readonly<Record<string, ConnectProgress>>>({});
    const [revoked, setRevoked] = useState<string | null>(null);
    const revoke = (l: ShareLink) => {
        if (revoking[l.id]?.kind === 'working') return;
        setRevoked(null);
        setRevoking((now) => ({ ...now, [l.id]: { kind: 'working', step: l.claimed ? 'Revoking: ending the guest’s session…' : 'Revoking…' } }));
        const settle = (r: { ok: true } | { ok: false; reason: string }) => {
            setRevoking((now) => {
                const next = { ...now };
                if (r.ok) delete next[l.id];
                else next[l.id] = { kind: 'failed', reason: r.reason };
                return next;
            });
            if (r.ok) setRevoked(l.claimed ? 'Revoked: the guest’s session was ended.' : 'Revoked: the link no longer opens.');
        };
        onRevoke(l).then(settle, (error: unknown) => settle({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
    };
    return (
                <div data-share-form="" className="flex flex-col gap-4 text-sm">
                    <p className="text-[var(--fg-3)]">Whoever opens the link signs in to Tynn and reaches this machine over the Tynn relay — only what the link allows.</p>
                    <div className="flex flex-wrap items-end gap-3">
                        <label data-share-capability="" className="flex flex-col gap-1">
                            <span className="font-medium">Access</span>
                            <Select aria-label="Access" list={[{ value: 'control', label: 'Control — can drive agents' }, { value: 'readonly', label: 'Read-only — can watch' }]} value={capability} onValueChange={(v) => setCapability(v === 'readonly' ? 'readonly' : 'control')} />
                        </label>
                        <label data-share-expiry="" className="flex flex-col gap-1">
                            <span className="font-medium">Expires after</span>
                            <Select aria-label="Expires after" list={EXPIRY.map((d) => ({ value: String(d), label: d === 1 ? '1 day' : `${d} days` }))} value={String(days)} onValueChange={(v) => setDays(Number(v))} />
                        </label>
                        <label data-share-reach="" className="flex flex-col gap-1">
                            <span className="font-medium">Reaches</span>
                            <Select aria-label="Reaches" list={[{ value: 'workspace', label: `${workspaceName} only` }, { value: 'whole', label: 'The whole workstation' }]} value={whole ? 'whole' : 'workspace'} onValueChange={(v) => setWhole(v === 'whole')} />
                        </label>
                        <Button size="xs" type="button" data-action="mint-share-link" disabled={busy} onClick={() => { linkCopy.reset(); onMint({ capability, expiresInDays: days, whole }); }} className={button}>Create link</Button>
                    </div>
                    {minted?.url ? (
                        <div data-share-minted="" className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-1)] px-3 py-2">
                            <code className="min-w-0 flex-1 truncate font-mono text-xs">{minted.url}</code>
                            <Button size="xs" type="button" data-action="copy-share-link" data-copy-state={linkCopy.state} onClick={() => { void linkCopy.copy(minted.url!); }} className={button}>{copyWords(linkCopy.state, 'Copy')}</Button>
                            <CopyAnnounce state={linkCopy.state} />
                            <span className="basis-full text-xs text-[var(--fg-3)]">Shown this once — Tynn keeps no copy you can read back. {linkWords(minted)}.</span>
                        </div>
                    ) : null}
                    {problem ? <p data-problem="share" className="text-xs text-[var(--danger)]">{problem}</p> : null}
                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium text-[var(--fg-3)]">Links that reach {workspaceName}</span>
                        {revoked ? <span data-share-revoked="" role="status" className="flex items-center gap-1.5 text-xs text-[var(--fg-2)]"><Icon name="check" size="xs" />{revoked}</span> : null}
                        {links === null ? (
                            <span className="text-xs text-[var(--fg-4)]">Asking Tynn…</span>
                        ) : links.length === 0 ? (
                            <span className="text-xs text-[var(--fg-4)]">None.</span>
                        ) : (
                            <ul className="flex flex-col gap-1">
                                {links.map((l) => {
                                    const state = revoking[l.id] ?? { kind: 'idle' as const };
                                    return (
                                        <li key={l.id} data-share-link-row={l.id} {...(l.claimed ? { 'data-share-claimed': '' } : {})} className="flex flex-col gap-1 rounded-lg border border-[var(--border-1)] px-3 py-2 text-[13px]">
                                            <div className="flex items-center gap-2">
                                                <span>{linkWords(l)}</span>
                                                {l.claimed ? <span title="Someone opened this link: their one session is live until they leave or it expires" className="inline-flex items-center gap-1 rounded-full bg-[var(--primary)]/10 px-1.5 py-px text-[11px] font-medium text-[var(--primary)]"><Icon name="user-check" size="xs" />Claimed</span> : null}
                                                <Button type="button" size="sm" color="red" variant="ghost" icon="x" data-action="revoke-share-link" disabled={busy || state.kind === 'working'} onClick={() => revoke(l)} className="ml-auto" title={l.claimed ? 'Revoke the link and end the guest’s session' : 'Revoke the link'}>Revoke</Button>
                                            </div>
                                            {state.kind === 'working' ? (
                                                <span data-share-revoke-step="" className="flex items-center gap-1.5 text-xs text-[var(--fg-3)]"><Icon name="loader" size="xs" className="animate-spin" />{state.step}</span>
                                            ) : state.kind === 'failed' ? (
                                                <span data-problem="share-revoke" className="flex flex-wrap items-center gap-2 text-xs text-[var(--danger)]">
                                                    <span>{state.reason}</span>
                                                    <Button type="button" size="xs" icon="refresh-cw" data-action="retry-revoke-share-link" onClick={() => revoke(l)}>Retry</Button>
                                                </span>
                                            ) : null}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
    );
}
