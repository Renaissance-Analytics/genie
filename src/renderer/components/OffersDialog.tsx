import { Button, Modal } from '@particle-academy/react-fancy';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CloneOffer } from '../../core/clone-offers.js';
import { offersDialogView, type OffersDialogView } from '../../core/offers-dialog-view.js';

/**
 * THE OFFERS (Tynn #756, the offers UI): what a clone's repo brings that this machine does not have yet, each with what the repo
 * says and, where this machine has its own, that beside it. A new one has an Apply; a changed one never does (Genie does not
 * replace it). Before the workspace is trusted a command offer shows what it would run and the trust button instead.
 *
 * The view is hook-free (a test renders it); `OffersDialog` loads the offers, applies one and asks again.
 */

const muted = 'text-xs text-[var(--fg-3)]';
const side = 'min-w-0 whitespace-pre-wrap break-all font-mono text-[11px] text-[var(--fg-2)]';

export interface OffersViewProps {
    readonly workspaceName: string;
    readonly view: OffersDialogView;
    readonly onApply: (offerId: string) => void;
    readonly onTrust: () => void;
    readonly onClose: () => void;
}

export function OffersView({ workspaceName, view, onApply, onTrust, onClose }: OffersViewProps) {
    const needsTrust = view.rows.some((r) => r.needsTrust);
    return (
        <div data-offers-dialog="" className="flex min-w-[460px] max-w-[640px] flex-col gap-3 text-sm">
            <h2 className="text-base font-semibold">What the repo of {workspaceName} brings</h2>
            {view.loading ? <p data-offers-loading="" className={muted}>Looking at the repo…</p> : null}
            {view.error ? <p data-offers-error="" role="alert" className="rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-xs">{view.error}</p> : null}
            {view.empty ? <p data-offers-empty="" className={muted}>Nothing new: this machine has what the repo has.</p> : null}
            {view.rows.map((row) => (
                <div key={row.id} data-offer={row.id} data-offer-change={row.change} className="flex flex-col gap-1 rounded-md border border-[var(--border-1)] px-2.5 py-2">
                    <span className="text-xs font-medium">{row.summary}</span>
                    <div className="flex items-start gap-2">
                        <span className={muted}>Repo</span>
                        <code data-offer-incoming="" className={side}>{row.incoming}</code>
                    </div>
                    {row.local !== null ? (
                        <div className="flex items-start gap-2">
                            <span className={muted}>Here</span>
                            <code data-offer-local="" className={side}>{row.local}</code>
                        </div>
                    ) : null}
                    {row.commands.length > 0 ? (
                        <div data-offer-commands="" className="flex flex-col gap-0.5">
                            <span className={muted}>Applying it would run</span>
                            {row.commands.map((command) => <code key={command} className="break-all font-mono text-[11px] text-[var(--fg-1)]">{command}</code>)}
                        </div>
                    ) : null}
                    {row.note ? <p data-offer-note="" className={muted}>{row.note}</p> : null}
                    {row.change === 'new' && !row.needsTrust ? (
                        <div className="flex justify-end">
                            <Button size="xs" type="button" data-action="apply-offer" disabled={!row.canApply} loading={row.busy} onClick={() => onApply(row.id)}>Apply</Button>
                        </div>
                    ) : null}
                </div>
            ))}
            {needsTrust ? (
                <div data-offers-trust="" className="flex flex-col gap-1.5">
                    <p className={muted}>Some of these run commands, so they wait until you trust this workspace. Once you do, it stays trusted until you untrust it.</p>
                    <div><Button size="xs" type="button" icon="shield-check" data-action="trust-workspace" onClick={onTrust}>Trust this workspace</Button></div>
                </div>
            ) : null}
            <div className="flex justify-end">
                <Button size="xs" type="button" data-action="offers-close" onClick={onClose}>Close</Button>
            </div>
        </div>
    );
}

type Reply = { ok: true; offers: CloneOffer[]; trusted: boolean } | { ok: false; reason: string };

export function OffersDialog({ workspaceName, load, apply, trust, onClose, onChanged }: {
    readonly workspaceName: string;
    readonly load: () => Promise<Reply>;
    readonly apply: (offerId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /** The workspace's trust step: asks the person, resolves once they have answered. */
    readonly trust: () => Promise<unknown>;
    readonly onClose: () => void;
    /** Told how many offers are left, so the dashboard's count follows. */
    readonly onChanged?: (count: number) => void;
}) {
    const [offers, setOffers] = useState<CloneOffer[] | null>(null);
    const [trusted, setTrusted] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notes, setNotes] = useState<Record<string, string>>({});
    const refresh = useCallback(async (): Promise<void> => {
        try {
            const r = await load();
            if (r.ok) { setOffers(r.offers); setTrusted(r.trusted); setError(null); onChanged?.(r.offers.length); } else { setOffers((o) => o ?? []); setError(r.reason); }
        } catch (e: unknown) { setOffers((o) => o ?? []); setError(e instanceof Error ? e.message : String(e)); }
    }, [load, onChanged]);
    useEffect(() => { void refresh(); }, [refresh]);
    const view = useMemo(() => offersDialogView({ offers, trusted, busy, error, notes }), [offers, trusted, busy, error, notes]);
    const onApply = (offerId: string): void => {
        setBusy(offerId);
        void apply(offerId)
            .then((r) => setNotes((n) => { const next = { ...n }; if (r.ok) delete next[offerId]; else next[offerId] = r.reason; return next; }), (e: unknown) => setNotes((n) => ({ ...n, [offerId]: e instanceof Error ? e.message : String(e) })))
            .then(() => refresh())
            .finally(() => setBusy(null));
    };
    const onTrust = (): void => { void trust().then(() => refresh(), () => refresh()); };
    return (
        <Modal open onClose={onClose}>
            <Modal.Body>
                <OffersView workspaceName={workspaceName} view={view} onApply={onApply} onTrust={onTrust} onClose={onClose} />
            </Modal.Body>
        </Modal>
    );
}
