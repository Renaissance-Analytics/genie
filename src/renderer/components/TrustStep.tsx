import { Button } from '@particle-academy/react-fancy';
import { useState, type ReactNode } from 'react';
import type { ActOutcome, TrustStepView } from '../features.js';

/**
 * THE TRUST STEP (the owner: "A workspace is untrusted until the person says so. Trusting it shows what would run. Changes
 * ask again."). Everything the workspace's own files say would run, whole, and the person's yes. Words kept to what is needed.
 */
export type TrustPhase = { kind: 'idle' } | { kind: 'pending' } | { kind: 'failed'; reason: string };

function Group({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div data-trust-group={label}>
            <div className="text-xs font-medium text-[var(--fg-3)]">{label}</div>
            <ul className="mt-1 space-y-1">{children}</ul>
        </div>
    );
}

const Code = ({ children }: { children: ReactNode }) => <code className="break-all font-mono text-[var(--fg-1)]">{children}</code>;

export function TrustStepBody({ step, phase, onTrust }: { step: TrustStepView; phase: TrustPhase; onTrust: () => void }) {
    const { sites, hooks, servers, gitKeys, approvals } = step.list;
    const nothing = sites.length + hooks.length + servers.length + gitKeys.length + approvals.length === 0;
    const busy = phase.kind === 'pending';
    return (
        <section data-trust-step={step.workspaceId} className="flex max-h-[45vh] shrink-0 flex-col gap-2 overflow-auto border-b border-[var(--border-1)] px-4 py-3 text-sm">
            {step.changed
                ? <p data-trust-changed className="text-[var(--warning)]">Changed since you trusted it. Agents here restart before new work and keep their conversations.</p>
                : <p data-trust-first>Not trusted yet. Nothing here runs until you trust it.</p>}
            {nothing ? <p data-trust-nothing-listed className="text-[var(--fg-3)]">Its files name nothing to run.</p> : null}
            {sites.length > 0 ? (
                <Group label="Sites">
                    {sites.map((site) => (
                        <li key={site.key}>
                            <Code>{site.runs}</Code> in <Code>{site.folder}</Code>
                            {site.npmScript !== null ? <> runs <Code>{site.npmScript}</Code></> : null}
                        </li>
                    ))}
                </Group>
            ) : null}
            {sites.some((site) => site.npmScript !== null) ? <p data-trust-npm-note className="text-xs text-[var(--fg-3)]">Only the npm script is shown, not what it calls.</p> : null}
            {hooks.length > 0 ? <Group label="Hooks and settings">{hooks.map((hook) => <li key={`${hook.file}\n${hook.event}\n${hook.command}`}><span className="text-[var(--fg-3)]">{hook.file} · {hook.event}</span> <Code>{hook.command}</Code></li>)}</Group> : null}
            {servers.length > 0 ? <Group label="Servers">{servers.map((server) => <li key={`${server.file}\n${server.name}`}><span className="text-[var(--fg-3)]">{server.file} · {server.name}</span> <Code>{server.command}</Code></li>)}</Group> : null}
            {gitKeys.length > 0 ? <Group label="Git settings">{gitKeys.map((entry) => <li key={`${entry.key}\n${entry.value}`}><Code>{entry.key}</Code> <Code>{entry.value}</Code></li>)}</Group> : null}
            {approvals.length > 0 ? <Group label="Commands already approved here">{approvals.map((approval) => <li key={approval}><Code>{approval}</Code></li>)}</Group> : null}
            <p data-trust-agents-note className="text-xs text-[var(--fg-3)]">Until then, agents here can't read its instructions or their personas.</p>
            {phase.kind === 'failed' ? (
                <div role="alert" className="flex items-center gap-2 text-[var(--danger)]">
                    <span>{phase.reason}</span>
                    <Button type="button" size="xs" icon="rotate-ccw" data-action="trust-workspace-retry" onClick={onTrust}>Retry</Button>
                </div>
            ) : (
                <div className="flex items-center gap-2">
                    <Button type="button" size="sm" icon="shield-check" data-action="trust-workspace" loading={busy} disabled={busy} onClick={onTrust}>Trust this workspace</Button>
                    {busy ? <span data-trust-busy className="text-[var(--fg-3)]">Trusting…</span> : null}
                </div>
            )}
        </section>
    );
}

/** Success is the step going away: the next snapshot no longer has it. */
export function TrustStep({ step, onTrust }: { step: TrustStepView; onTrust: () => Promise<ActOutcome | unknown> }) {
    const [phase, setPhase] = useState<TrustPhase>({ kind: 'idle' });
    const press = (): void => {
        if (phase.kind === 'pending') return;
        setPhase({ kind: 'pending' });
        void Promise.resolve().then(onTrust).then(
            (outcome) => {
                const refused = typeof outcome === 'object' && outcome !== null && 'ok' in outcome && outcome.ok === false && 'reason' in outcome ? String(outcome.reason) : null;
                setPhase(refused === null ? { kind: 'idle' } : { kind: 'failed', reason: refused });
            },
            (error: unknown) => { setPhase({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) }); },
        );
    };
    return <TrustStepBody step={step} phase={phase} onTrust={press} />;
}
