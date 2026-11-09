import { Button } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { isProviderProgramProblem } from '../../core/provider-program.js';

export type ProviderProgramChosen = { ok: true } | { ok: false; reason?: string };

/** The picker for a provider's .exe, offered only when the reason is a batch file Genie found nothing behind (Tynn #577). */
export function ProviderProgramChoice({ provider, reason, onChoose }: { provider: string; reason: string; onChoose: () => Promise<ProviderProgramChosen> }) {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    if (!isProviderProgramProblem(reason)) return null;
    const choose = (): void => {
        setBusy(true);
        setFailed(null);
        void onChoose().then(
            (r) => { setBusy(false); if (!r.ok && r.reason) setFailed(r.reason); },
            (error: unknown) => { setBusy(false); setFailed(error instanceof Error ? error.message : String(error)); },
        );
    };
    return (
        <>
            <Button size="xs" type="button" data-action="provider-choose-program" disabled={busy} onClick={choose} className="ml-2">
                {busy ? 'Choosing…' : `Choose ${provider}.exe`}
            </Button>
            {failed !== null ? <span data-provider-choose-failed className="ml-2">{failed}</span> : null}
        </>
    );
}
