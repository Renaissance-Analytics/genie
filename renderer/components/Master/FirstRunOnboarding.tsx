import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Card, Heading, Icon, Modal, Text, Textarea } from '@particle-academy/react-fancy';
import { agentCliToolByProvider } from '../../../main/agents/agent-cli-catalog';
import { providerDef, type AgentTuiId } from '../../../main/agents/registry';
import { api, type HostToolName, type WorkspaceRow } from '../../lib/genie';
import AddWorkspaceModal from '../AddWorkspaceModal';
import {
    FIRST_AGENT_PRESETS,
    canFinishFirstRun,
    firstAgentDriver,
    type FirstAgentPreset,
} from '../../lib/workspace-onboarding';

/**
 * FIRST RUN, IN TWO STEPS: pick a folder, then meet an agent.
 *
 * It was seven gates — welcome, drivers, toolchain, Tynn, GitHub, Genie OS, workspace — with
 * sign-in and GitHub in front of ever seeing an agent do anything. The plan's target is *"first
 * agent reply in under 2 minutes, 2 decisions"*, and the honest version of that is not a shorter
 * wizard: it is asking only what Genie cannot work out for itself.
 *
 *  - **The folder** is the one thing Genie cannot guess, so it is step one, unchanged
 *    (`AddWorkspaceModal` already does this well).
 *  - **The driver** is checked, not chosen. `firstAgentDriver` picks the configured default if it
 *    is installed, falls back to anything that is, and reports NOT READY only when the machine
 *    has nothing — which is the one case that genuinely blocks a first agent, and now surfaces
 *    where it can be acted on instead of as a gate in front of everything.
 *  - **Everything else is deferred to where it already lives.** Each was located in source before
 *    its step was deleted: Tynn is enforced by `master.tsx` refusing to render signed out, GitHub
 *    and the toolchain wizard are in Settings, and the Genie OS backup is `syncGenieOs`, which
 *    Settings already calls. A deferred prompt that does not exist is not deferred, it is
 *    deleted.
 *
 * The three presets come from the plan and each ends by calling `imDone` with a handoff, so the
 * first run teaches the loop the product is built on rather than teaching that Genie is a chat
 * window. The prompt is EDITABLE before it is sent — a pre-filled prompt nobody can change is a
 * demo, not a start.
 */

/** Which host tool each provider's driver IS, so a probe can say whether it is installed. */
const DRIVER_TOOL: Partial<Record<AgentTuiId, HostToolName>> = agentCliToolByProvider();

type Step = 'workspace' | 'agent';

export function FirstRunOnboarding({
    open,
    onComplete,
    onWorkspaceAdded,
    existingWorkspaceCount,
}: {
    open: boolean;
    onComplete: () => void;
    onWorkspaceAdded: (workspace: WorkspaceRow) => void;
    existingWorkspaceCount: number;
}) {
    /**
     * A workstation that already has a workspace starts at the agent step.
     *
     * The folder question is the only reason step one exists, and asking it again of someone who
     * has already answered it is how a two-step flow becomes a three-step one.
     */
    const [step, setStep] = useState<Step>(existingWorkspaceCount > 0 ? 'agent' : 'workspace');
    const [workspace, setWorkspace] = useState<WorkspaceRow | null>(null);
    const [installed, setInstalled] = useState<readonly string[] | null>(null);
    const [configured, setConfigured] = useState<string | null>(null);
    const [preset, setPreset] = useState<FirstAgentPreset>(FIRST_AGENT_PRESETS[0]!);
    const [prompt, setPrompt] = useState(FIRST_AGENT_PRESETS[0]!.prompt);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const finish = () => {
        localStorage.setItem('genie-onboarding-complete', '1');
        onComplete();
    };

    /**
     * WHICH DRIVERS ARE ACTUALLY ON THE MACHINE.
     *
     * `toolchainInspect` reports `present` / `missing` per host tool, so the question "can an
     * agent run here" is answered by a probe rather than by asking the user to tick boxes about
     * software they may not have. `null` while it is in flight means "not known yet", and the
     * step says so instead of claiming either answer.
     */
    useEffect(() => {
        if (!open) return;
        let live = true;
        void api()
            .settings.get()
            .then((settings) => {
                if (live) setConfigured(settings.agent_default ?? null);
            })
            .catch(() => {});
        const driverTools = Object.values(DRIVER_TOOL).filter(Boolean) as HostToolName[];
        void api()
            .devServer.toolchainInspect(undefined, driverTools)
            .then((inspection) => {
                if (!live) return;
                const present = new Set<string>(inspection.report.present);
                setInstalled(
                    Object.entries(DRIVER_TOOL)
                        .filter(([, tool]) => tool && present.has(tool))
                        .map(([providerId]) => providerId),
                );
            })
            // A failed probe must not block the step: it reports "cannot tell" and still offers
            // to start, because the start itself will say what went wrong far better than a
            // guess here would.
            .catch(() => live && setInstalled([]));
        return () => {
            live = false;
        };
    }, [open]);

    const driver = useMemo(
        () => (installed === null ? null : firstAgentDriver({ configured, installed })),
        [installed, configured],
    );

    if (!open) return null;

    if (step === 'workspace') {
        return (
            <AddWorkspaceModal
                onClose={() => {
                    // Closing without adding is allowed once there IS one — otherwise this is the
                    // only thing standing between the user and an empty Deck.
                    if (canFinishFirstRun({ existingWorkspaceCount, setupComplete: true })) finish();
                }}
                onAdded={(added) => {
                    onWorkspaceAdded(added);
                    setWorkspace(added);
                    setStep('agent');
                }}
            />
        );
    }

    const startFirstAgent = async () => {
        if (!driver?.ready) return;
        const wsId = workspace?.id;
        if (!wsId) {
            // Nothing to start in. Reached only when an existing workspace was never handed to
            // this component — say so rather than appearing to do nothing.
            setError('Pick a workspace first.');
            return;
        }
        setStarting(true);
        setError(null);
        try {
            const name = 'Scout';
            const created = await api().agents.create({
                workspaceId: wsId,
                name,
                purpose: 'Your first agent',
                agent: driver.driver,
            });
            if (!created.ok) throw new Error(created.error ?? 'Genie could not create the agent.');
            const started = await api().agents.start(wsId, name);
            if (!started.ok) throw new Error(started.error ?? 'Genie could not start the agent.');
            // THE PROMPT, delivered through the session write path — `agentSession.prompt` reaches
            // an ACP session, which is what a claude agent is now. A pty agent gets it typed in by
            // the same host routine that types its launch line.
            if (started.id) {
                await api().agentSession.prompt(started.id, prompt).catch(() => {});
            }
            finish();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setStarting(false);
        }
    };

    return (
        <Modal
            open
            onClose={() => {
                if (canFinishFirstRun({ existingWorkspaceCount, setupComplete: true })) finish();
            }}
            size="lg"
        >
            <Modal.Header>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon name="sparkles" size="sm" /> Meet your first agent
                </span>
            </Modal.Header>
            <Modal.Body>
                <OnboardingPage
                    title="Give it something real to do"
                    body="Pick one of these, change the wording if you like, and Genie will start an agent in your workspace and send it. Everything else — Tynn, GitHub, your toolchain — is in Settings when you want it."
                >
                    <div style={{ display: 'grid', gap: 8 }}>
                        {FIRST_AGENT_PRESETS.map((item) => (
                            <Card
                                key={item.id}
                                style={{
                                    padding: 10,
                                    borderColor: preset.id === item.id ? 'var(--violet-500)' : undefined,
                                    cursor: 'pointer',
                                }}
                                onClick={() => {
                                    setPreset(item);
                                    setPrompt(item.prompt);
                                }}
                            >
                                <strong>{item.label}</strong>
                            </Card>
                        ))}
                    </div>

                    {/* EDITABLE. A pre-filled prompt nobody can change is a demo, not a start. */}
                    <Textarea
                        rows={4}
                        value={prompt}
                        onChange={(e: { target: { value: string } }) => setPrompt(e.target.value)}
                    />

                    {/* THE DRIVER, reported rather than chosen. Three states and no fourth: not
                        known yet, ready and named, or genuinely absent — which is the only case
                        that stops a first agent, and it says what to do about it. */}
                    {driver === null ? (
                        <Text size="xs" className="text-zinc-500">Checking which agent CLI is installed…</Text>
                    ) : driver.ready ? (
                        <Text size="xs" className="text-zinc-500">
                            Using <strong>{providerDef(driver.driver as AgentTuiId).label}</strong>, which is
                            already installed. You can change this in Settings.
                        </Text>
                    ) : (
                        <Text size="sm" className="text-amber-500">
                            No agent CLI is installed on this machine yet. Settings → Toolchain will
                            install one, and then this takes a few seconds.
                        </Text>
                    )}

                    {error && <Text size="xs" className="text-rose-500">{error}</Text>}

                    <div style={{ display: 'flex', gap: 8 }}>
                        <Button
                            color="blue"
                            disabled={!driver?.ready || starting || !prompt.trim()}
                            onClick={() => void startFirstAgent()}
                        >
                            {starting ? 'Starting…' : 'Start the agent'}
                        </Button>
                        {/* A way past it. Someone who wants to look around first should not have
                            to start an agent to be allowed in — that is the gate this whole
                            change is removing. */}
                        <Button variant="ghost" onClick={finish}>
                            I will do this later
                        </Button>
                    </div>
                </OnboardingPage>
            </Modal.Body>
        </Modal>
    );
}

function OnboardingPage({
    title,
    body,
    children,
}: {
    title: string;
    body: string;
    children: ReactNode;
}) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
                <Heading as="h2" size="md">{title}</Heading>
                <Text size="sm" className="text-zinc-500" style={{ display: 'block', marginTop: 6, lineHeight: 1.55 }}>{body}</Text>
            </div>
            {children}
        </div>
    );
}
