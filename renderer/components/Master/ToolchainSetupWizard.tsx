import { useCallback, useEffect, useMemo, useState } from 'react';
import { Action, Heading, Icon, Modal, Select, Text } from '@particle-academy/react-fancy';
import {
    api,
    type HostToolName,
    type ToolchainInspection,
    type ToolchainInstallResult,
    type ToolchainPackageManager,
    type ToolchainStepStatus,
} from '../../lib/genie';

/**
 * First-run toolchain setup (Tynn #240) — the guided step that turns a fresh
 * machine into one you can create on. It asks the tested backend what is here
 * (`devServer.toolchainInspect`), shows what is missing, lets the user pick the
 * package manager (the recommended one preselected), and — before ANYTHING runs
 * — shows the exact plan and its costs (elevation, reboot) to approve.
 *
 * INSPECT installs nothing; it is a pure probe, safe to open and re-run. The
 * install-execution step (streaming per-tool progress) is wired to
 * `devServer.toolchainInstall` once the platform primitives land; until then the
 * consent step is the terminal one, and the wizard never claims to have installed
 * something it did not.
 */

const TOOL_LABEL: Record<HostToolName, string> = {
    git: 'Git',
    node: 'Node.js',
    npm: 'npm',
    php: 'PHP',
    composer: 'Composer',
    docker: 'Docker',
    'claude-code': 'Claude Code',
    codex: 'Codex',
    // Named for what it IS to the user, not by its package id: the row appears
    // only on Windows, and only because PHP cannot start without it.
    vcredist: 'Visual C++ runtime (for PHP)',
};

const PM_LABEL: Record<ToolchainPackageManager | 'direct', string> = {
    winget: 'winget (Windows Package Manager)',
    brew: 'Homebrew',
    apt: 'apt',
    dnf: 'dnf',
    direct: 'Direct download (no package manager)',
};

const METHOD_LABEL: Record<string, string> = {
    pm: 'package manager',
    direct: 'direct download',
    'npm-global': 'npm install -g',
};

/** How one tool's live install status reads while / after a run. */
function statusLabel(live?: 'start' | 'succeeded' | 'failed' | 'skipped'): string {
    switch (live) {
        case 'start':
            return 'installing…';
        case 'succeeded':
            return 'installed';
        case 'failed':
            return 'failed';
        case 'skipped':
            return 'skipped (a prerequisite failed)';
        default:
            return 'waiting…';
    }
}
function statusClass(live?: 'start' | 'succeeded' | 'failed' | 'skipped'): string {
    if (live === 'failed') return 'text-red-500';
    if (live === 'skipped') return 'text-amber-500';
    if (live === 'succeeded') return 'text-zinc-400';
    return 'text-zinc-500';
}
function statusGlyph(live?: 'start' | 'succeeded' | 'failed' | 'skipped') {
    if (live === 'succeeded') return <Icon name="check" size="xs" className="text-green-500" />;
    if (live === 'failed') return <Icon name="x" size="xs" className="text-red-500" />;
    if (live === 'skipped') return <Icon name="minus" size="xs" className="text-amber-500" />;
    if (live === 'start') return <Icon name="loader" size="xs" className="text-blue-500" />;
    return null;
}

type Step = 'inspecting' | 'review' | 'installing' | 'done' | 'error';
/** Per-tool live status: `start` while running, then the settled outcome. */
type LiveStatus = 'start' | ToolchainStepStatus;

export function ToolchainSetupWizard({
    open,
    onClose,
    wanted,
}: {
    open: boolean;
    onClose: () => void;
    /** First-run onboarding installs only the base tools + selected drivers. */
    wanted?: HostToolName[];
}) {
    const [insp, setInsp] = useState<ToolchainInspection | null>(null);
    const [step, setStep] = useState<Step>('inspecting');
    const [error, setError] = useState<string | null>(null);
    // The manager the user picked (drives a re-plan). undefined ⇒ follow the
    // machine's recommendation from the first inspection.
    const [pmChoice, setPmChoice] = useState<ToolchainPackageManager | 'direct' | undefined>(undefined);
    // Live per-tool status while installing, and the final outcome.
    const [progress, setProgress] = useState<Record<string, LiveStatus>>({});
    const [result, setResult] = useState<ToolchainInstallResult | null>(null);

    const inspect = useCallback(
        async (choice?: ToolchainPackageManager | 'direct') => {
            setStep('inspecting');
            setError(null);
            try {
                const result = await api().devServer.toolchainInspect(choice, wanted);
                setInsp(result);
                setStep('review');
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                setStep('error');
            }
        },
        [wanted],
    );

    useEffect(() => {
        if (open) void inspect(pmChoice);
        // Re-inspect only on open / explicit pm change (below), not every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const onPickPm = (choice: ToolchainPackageManager | 'direct') => {
        setPmChoice(choice);
        void inspect(choice);
    };

    const runInstall = async () => {
        setStep('installing');
        setProgress({});
        setResult(null);
        setError(null);
        // Stream per-tool status; main re-plans and runs its OWN plan, so the
        // choice is the only thing sent.
        const off = api().on.toolchainProgress((p) => {
            setProgress((prev) => ({
                ...prev,
                [p.tool]: p.phase === 'start' ? 'start' : (p.status ?? 'succeeded'),
            }));
        });
        try {
            const r = await api().devServer.toolchainInstall(pmChoice, wanted);
            setResult(r);
            setStep('done');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStep('error');
        } finally {
            off();
        }
    };

    // The managers to offer: those detected, plus the always-available direct path.
    const pmOptions = useMemo(() => {
        const available = insp?.packageManagers.available ?? [];
        const opts = available.map((pm) => ({ value: pm, label: PM_LABEL[pm] }));
        opts.push({ value: 'direct' as ToolchainPackageManager, label: PM_LABEL.direct });
        return opts;
    }, [insp]);

    if (!open) return null;

    const missing = insp?.report.missing ?? [];
    const present = insp?.report.present ?? [];
    const nothingToDo = step === 'review' && missing.length === 0;

    return (
        <Modal open onClose={onClose} size="lg">
            <Modal.Header>
                <Heading as="h3" size="xs">
                    <Icon name="sparkles" size="sm" className="text-violet-500" /> Set up your toolchain
                </Heading>
            </Modal.Header>

            <div className="ws-settings toolchain-wizard">
                {step === 'inspecting' && (
                    <div className="tcw-loading">
                        <Text size="sm" className="text-zinc-500">
                            Checking what this machine already has…
                        </Text>
                    </div>
                )}

                {step === 'error' && (
                    <div className="set-note bad">
                        Couldn’t inspect the toolchain: {error}
                        <div style={{ marginTop: 8 }}>
                            <Action size="sm" variant="ghost" icon="refresh" onClick={() => void inspect(pmChoice)}>
                                Try again
                            </Action>
                        </div>
                    </div>
                )}

                {step === 'review' && insp && (
                    <>
                        {/* What's already here */}
                        {present.length > 0 && (
                            <section className="tcw-section">
                                <Text size="xs" className="text-zinc-500">
                                    Already installed
                                </Text>
                                <div className="tcw-chips">
                                    {present.map((t) => {
                                        const probe = insp.report.probes.find((p) => p.name === t);
                                        return (
                                            <span key={t} className="tcw-chip on" title={probe?.version}>
                                                <Icon name="check" size="xs" /> {TOOL_LABEL[t]}
                                                {probe?.version ? ` ${probe.version}` : ''}
                                                {t === 'docker' && probe && probe.running === false
                                                    ? ' (not running)'
                                                    : ''}
                                            </span>
                                        );
                                    })}
                                </div>
                            </section>
                        )}

                        {nothingToDo ? (
                            <section className="tcw-section">
                                <Text size="sm">
                                    Everything Genie needs is already installed — you’re ready to create.
                                </Text>
                            </section>
                        ) : (
                            <>
                                {/* Package-manager choice */}
                                <section className="tcw-section">
                                    <label className="site-field">
                                        <span>Install the rest with</span>
                                        <Select
                                            value={pmChoice ?? insp.pmChoice}
                                            onValueChange={(v) => onPickPm(v as ToolchainPackageManager | 'direct')}
                                            list={pmOptions}
                                            aria-label="Package manager to install with"
                                        />
                                        {insp.packageManagers.recommended && !pmChoice && (
                                            <small className="site-field-hint">
                                                {PM_LABEL[insp.packageManagers.recommended]} is recommended for this
                                                machine.
                                            </small>
                                        )}
                                    </label>
                                </section>

                                {/* The plan + costs to approve */}
                                <section className="tcw-section">
                                    <Text size="xs" className="text-zinc-500">
                                        Genie will install ({insp.plan.length})
                                    </Text>
                                    <ul className="tcw-plan">
                                        {insp.plan.map((s) => (
                                            <li key={s.tool} className="tcw-plan-row">
                                                <span className="tcw-plan-tool">{TOOL_LABEL[s.tool]}</span>
                                                <span className="tcw-plan-method text-zinc-500">
                                                    {METHOD_LABEL[s.method] ?? s.method}
                                                    {s.packageManager ? ` · ${s.packageManager}` : ''}
                                                </span>
                                                <span className="tcw-plan-flags">
                                                    {s.requiresElevation && (
                                                        <span className="tcw-flag" title="Needs an admin prompt">
                                                            <Icon name="shield" size="xs" /> admin
                                                        </span>
                                                    )}
                                                    {s.requiresRestart && (
                                                        <span className="tcw-flag" title="Needs a restart to finish">
                                                            <Icon name="refresh" size="xs" /> restart
                                                        </span>
                                                    )}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                    {(insp.consent.requiresElevation || insp.consent.requiresRestart) && (
                                        <div className="set-note">
                                            {insp.consent.requiresElevation && (
                                                <div>
                                                    <Icon name="shield" size="xs" /> Some steps need an administrator
                                                    prompt ({insp.consent.elevated.map((t) => TOOL_LABEL[t]).join(', ')}
                                                    ).
                                                </div>
                                            )}
                                            {insp.consent.requiresRestart && (
                                                <div>
                                                    <Icon name="refresh" size="xs" /> A restart is needed to finish{' '}
                                                    {insp.consent.restarts.map((t) => TOOL_LABEL[t]).join(', ')} (Docker
                                                    on Windows sets up WSL2).
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </section>
                            </>
                        )}
                    </>
                )}

                {(step === 'installing' || step === 'done') && insp && (
                    <section className="tcw-section">
                        <Text size="xs" className="text-zinc-500">
                            {step === 'installing' ? 'Installing…' : 'Result'}
                        </Text>
                        <ul className="tcw-plan">
                            {insp.plan.map((s) => {
                                const live = progress[s.tool];
                                // WHY it failed. The executor already reports a
                                // per-tool reason ("Genie can't install a zip
                                // artifact automatically yet…", "spawn npm
                                // ENOENT"); rendering only "failed" turns an
                                // actionable message into a dead end.
                                const why = result?.results.find((r) => r.tool === s.tool)?.error;
                                return (
                                    <li key={s.tool} className="tcw-plan-row">
                                        <span className="tcw-plan-tool">{TOOL_LABEL[s.tool]}</span>
                                        <span className={`tcw-plan-method ${statusClass(live)}`}>
                                            {statusLabel(live)}
                                        </span>
                                        <span className="tcw-plan-flags">{statusGlyph(live)}</span>
                                        {why && (
                                            <span
                                                className="tcw-plan-why text-zinc-500"
                                                data-testid={`tcw-why-${s.tool}`}
                                            >
                                                {why}
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                        {step === 'done' && result && (
                            <div className={`set-note${result.ok ? '' : ' bad'}`}>
                                {result.ok
                                    ? 'All set — your toolchain is ready.'
                                    : 'Some tools didn’t install. You can re-run setup, or install the rest manually.'}
                                {result.restartRequired && (
                                    <div>
                                        <Icon name="refresh" size="xs" /> Restart your machine to finish the Docker /
                                        WSL2 setup.
                                    </div>
                                )}
                            </div>
                        )}
                    </section>
                )}

                <div className="set-actions">
                    {step === 'review' && insp && !nothingToDo && (
                        <Action size="sm" color="blue" icon="download" onClick={() => void runInstall()}>
                            Install {insp.plan.length} tool{insp.plan.length === 1 ? '' : 's'}
                        </Action>
                    )}
                    {step === 'done' && result && !result.ok && (
                        <Action size="sm" variant="ghost" icon="refresh" onClick={() => void inspect(pmChoice)}>
                            Re-check
                        </Action>
                    )}
                    <Action size="sm" variant="ghost" onClick={onClose} disabled={step === 'installing'}>
                        {step === 'done' || nothingToDo ? 'Done' : 'Close'}
                    </Action>
                </div>
            </div>
        </Modal>
    );
}
