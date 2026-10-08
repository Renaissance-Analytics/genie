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
import {
    canStartFirstAgent,
    workstationReadiness,
    type ReadinessLine,
} from '../../lib/workstation-readiness';
import { useGitHubAccount } from '../GitHubConnect';

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
 *  - **Everything else is REPORTED, not asked.** Owner direction: *"on a fresh workstation with no
 *    workspaces, genie is just making sure the toolchain and environment is ready for
 *    development."* So step two says what it found — driver, git, Tynn, GitHub — each a line with a
 *    route to fix it and never a gate. `workstationReadiness` owns that and is tested.
 *  - **Tynn is OPTIONAL** (owner, explicitly), and the line for it says which services it gates
 *    rather than reading as a fault. Everything that was a step is reachable where it already
 *    lives: GitHub and the toolchain wizard in Settings, the Genie OS backup through
 *    `syncGenieOs`, which Settings already calls. A deferred prompt that does not exist is not
 *    deferred, it is deleted — so each was located in source first.
 *
 * Paperclip's own onboarding, read at the owner's request, is the shape this follows: ONE question,
 * everything else derived and then said out loud with reasons, nothing gated, and it ends by
 * offering to start.
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
    onFix,
}: {
    open: boolean;
    onComplete: () => void;
    onWorkspaceAdded: (workspace: WorkspaceRow) => void;
    existingWorkspaceCount: number;
    /**
     * Take the person to where a reported gap is fixed — a ⌘K feature id, or `tynn-signin`.
     *
     * Absent means the routes are not offered, and then the lines are information only. That is a
     * legitimate shape (a window that cannot act on them should not pretend), and it is why the
     * button is conditional on the prop rather than on the line.
     */
    onFix?: (route: string) => void;
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
    /** `git` on PATH. An agent can reason without it and cannot KEEP anything it writes. */
    const [gitPresent, setGitPresent] = useState(true);
    /** The Tynn account, or null. OPTIONAL — it gates its own services and nothing else. */
    const [tynnUser, setTynnUser] = useState<string | null>(null);
    const github = useGitHubAccount();
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
        // `git` is asked for alongside the drivers because the report mentions it, and one probe
        // beats two.
        const driverTools = [
            'git' as HostToolName,
            ...(Object.values(DRIVER_TOOL).filter(Boolean) as HostToolName[]),
        ];
        void api()
            .auth.whoami('tynn')
            .then((user) => {
                if (live) setTynnUser((user as { name?: string } | null)?.name ?? null);
            })
            // A failed read means "not connected", which is a legitimate state rather than an
            // error — Tynn is optional and the line says what it gates.
            .catch(() => live && setTynnUser(null));
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
                setGitPresent(present.has('git'));
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
    /**
     * WHAT I FOUND — four lines, none of them a gate.
     *
     * `null` while the probe is in flight, which the step renders as "checking" rather than as
     * either answer: claiming a clean bill of health before looking is the one thing this report
     * must not do.
     */
    const readiness = useMemo<ReadinessLine[] | null>(
        () =>
            installed === null
                ? null
                : workstationReadiness({
                      installedDrivers: installed,
                      gitPresent,
                      tynnUser,
                      githubConnected: github.connected,
                  }),
        [installed, gitPresent, tynnUser, github.connected],
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

                    {/* WHAT I FOUND — four lines, none of them a gate.
                        Owner: "on a fresh workstation with no workspaces, genie is just making sure
                        the toolchain and environment is ready for development." So this reports and
                        offers a route; it never blocks. `null` is "still looking", which is rendered
                        as itself rather than as either answer — claiming a clean bill of health
                        before looking is the one thing a report must not do. */}
                    {readiness === null ? (
                        <Text size="xs" className="text-zinc-500">Checking this workstation…</Text>
                    ) : (
                        <div className="firstrun-readiness" data-testid="firstrun-readiness">
                            {readiness.map((line) => (
                                <div
                                    key={line.id}
                                    className="firstrun-readiness-line"
                                    data-state={line.state}
                                    data-id={line.id}
                                >
                                    <Text size="xs">{line.label}</Text>
                                    {/* A route, not a second wizard. `off` is not a problem, so its
                                        route is offered in the same quiet voice as everything else. */}
                                    {line.fix && onFix ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => onFix?.(line.fix!)}
                                        >
                                            Set up
                                        </Button>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    )}

                    {driver?.ready ? (
                        <Text size="xs" className="text-zinc-500">
                            Your first agent will run on{' '}
                            <strong>{providerDef(driver.driver as AgentTuiId).label}</strong>. You can
                            change that in Settings.
                        </Text>
                    ) : null}

                    {error && <Text size="xs" className="text-rose-500">{error}</Text>}

                    <div style={{ display: 'flex', gap: 8 }}>
                        <Button
                            color="blue"
                            // `canStartFirstAgent` is the ONE yes-or-no on this screen, and it
                            // consults the driver and nothing else — a workstation with no Tynn, no
                            // GitHub and no git can still start an agent and show somebody what this
                            // product does.
                            disabled={
                                !readiness
                                || !canStartFirstAgent(readiness)
                                || starting
                                || !prompt.trim()
                            }
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
