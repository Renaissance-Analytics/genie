import { Modal } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { agentSlug } from '../../core/agent-create.js';
import { ACP_PROVIDERS } from '../../core/engine.js';

/**
 * NEW AGENT (the owner, 2026-10-23: "it didn't give me any ux to choose name, purpose or anything that genie 1 could
 * even"). Genie 1's NewAgentModal on Genie 2: a name, shown as the folder it becomes under `.agents/`; a purpose,
 * required, which goes into the agent's AGENT.md; the provider it starts on. Creating registers a dormant agent — starting
 * it is its own, deliberate act. Model, mode and permissions are its Settings, afterwards. The host re-checks everything
 * and its refusal is said here, in its words.
 *
 * The view is hook-free (a test renders it); `NewAgentModal` holds the fields and the busy state.
 */

const button = 'rounded-md border border-[var(--border-1)] px-3 py-1 text-xs hover:bg-[var(--bg-2)] disabled:opacity-50';
const primary = 'rounded-md bg-[var(--violet-500)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--violet-400)] disabled:opacity-50';
const field = 'rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm';
const muted = 'text-xs text-[var(--fg-3)]';

export interface NewAgentViewProps {
    readonly workspaceName: string;
    readonly name: string;
    readonly purpose: string;
    readonly provider: string;
    readonly busy: boolean;
    readonly error: string | null;
    readonly onName: (value: string) => void;
    readonly onPurpose: (value: string) => void;
    readonly onProvider: (value: string) => void;
    readonly onCreate: () => void;
    readonly onCancel: () => void;
}

const PROVIDER_LABEL: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex' };

export function NewAgentView({ workspaceName, name, purpose, provider, busy, error, onName, onPurpose, onProvider, onCreate, onCancel }: NewAgentViewProps) {
    const slug = agentSlug(name);
    const ready = slug !== '' && purpose.trim() !== '' && provider !== '' && !busy;
    return (
        <div data-new-agent="" className="flex min-w-[380px] flex-col gap-3 text-sm">
            <h2 className="text-base font-semibold">New agent in {workspaceName}</h2>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Name</span>
                <input data-new-agent-field="name" className={field} value={name} placeholder="scout" autoFocus onChange={(e) => onName(e.target.value)} />
                {slug !== '' && slug !== name.trim() ? <span className={muted}>Created as <strong>{slug}</strong> — the folder name under .agents/</span> : null}
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Purpose</span>
                <input data-new-agent-field="purpose" className={field} value={purpose} placeholder="Laravel app work" onChange={(e) => onPurpose(e.target.value)} />
                <span className={muted}>What this agent is for. It goes into its AGENT.md, which is committed with the project.</span>
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Starts on</span>
                <select data-new-agent-field="provider" className={field} value={provider} onChange={(e) => onProvider(e.target.value)}>
                    {ACP_PROVIDERS.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p] ?? p}</option>)}
                </select>
                <span className={muted}>You can switch it later. Its model, mode and permissions are in its Settings once it exists.</span>
            </label>
            {error ? <p data-new-agent-error="" className="rounded-md border border-[var(--danger)] bg-[var(--danger)]/10 px-2.5 py-1.5 text-xs">{error}</p> : null}
            <div className="flex justify-end gap-2">
                <button type="button" className={button} disabled={busy} onClick={onCancel}>Cancel</button>
                <button type="button" data-action="create-agent" className={primary} disabled={!ready} onClick={onCreate}>{busy ? 'Creating…' : 'Create agent'}</button>
            </div>
        </div>
    );
}

export function NewAgentModal({ workspaceName, onCreate, onClose }: {
    readonly workspaceName: string;
    /** Resolves with the host's answer: ok closes the form; a refusal stays on it, in its words. */
    readonly onCreate: (input: { name: string; purpose: string; provider: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly onClose: () => void;
}) {
    const [name, setName] = useState('');
    const [purpose, setPurpose] = useState('');
    const [provider, setProvider] = useState<string>(ACP_PROVIDERS[0]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const create = (): void => {
        setBusy(true);
        setError(null);
        void onCreate({ name: agentSlug(name), purpose: purpose.trim(), provider })
            .then((r) => { if (r.ok) onClose(); else setError(r.reason); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
    };
    return (
        <Modal open onClose={onClose}>
            <Modal.Body>
                <NewAgentView workspaceName={workspaceName} name={name} purpose={purpose} provider={provider} busy={busy} error={error}
                    onName={setName} onPurpose={setPurpose} onProvider={setProvider} onCreate={create} onCancel={onClose} />
            </Modal.Body>
        </Modal>
    );
}
