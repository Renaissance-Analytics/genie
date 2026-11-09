import { Button } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { isProviderProgramProblem, providerOfProgramProblem } from '../../core/provider-program.js';

export type ProviderProgramChosen = { ok: true } | { ok: false; reason?: string };

/** The picker for a provider's .exe, offered only when the reason is a batch file Genie found nothing behind (Tynn #577). */
export function ProviderProgramChoice({ provider, reason, onChoose }: { provider: string; reason: string; onChoose: () => Promise<ProviderProgramChosen> }) {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const [chosen, setChosen] = useState(false);
    if (!isProviderProgramProblem(reason)) return null;
    const choose = (): void => {
        setBusy(true);
        setFailed(null);
        void onChoose().then(
            (r) => { setBusy(false); if (r.ok) setChosen(true); else if (r.reason) setFailed(r.reason); },
            (error: unknown) => { setBusy(false); setFailed(error instanceof Error ? error.message : String(error)); },
        );
    };
    return (
        <>
            <Button size="xs" type="button" data-action="provider-choose-program" disabled={busy} onClick={choose} className="ml-2">
                {busy ? 'Choosing…' : `Choose ${provider}.exe`}
            </Button>
            {failed !== null ? <span data-provider-choose-failed className="ml-2">{failed}</span> : null}
            {chosen ? <span data-provider-chosen className="ml-2">Chosen. Try again.</span> : null}
        </>
    );
}

/** A start refused because a batch wrapper hides the provider, on the agent's own view, with the same picker (Tynn #577). */
export function ProviderStartRefusal({ reason, onChoose }: { reason: string | null | undefined; onChoose: (provider: string) => Promise<ProviderProgramChosen> }) {
    const provider = reason ? providerOfProgramProblem(reason) : null;
    if (!reason || provider === null) return null;
    return (
        <div data-start-refusal="" className="mx-5 my-2 shrink-0 rounded-[10px] border border-[var(--danger)] bg-[var(--bg-1)] px-3 py-2 text-[12px] text-[var(--danger)]">
            <span>{reason}</span>
            <ProviderProgramChoice provider={provider} reason={reason} onChoose={() => onChoose(provider)} />
        </div>
    );
}
