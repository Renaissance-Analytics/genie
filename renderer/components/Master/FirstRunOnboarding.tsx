import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Action, Card, Heading, Icon, Modal, Text } from '@particle-academy/react-fancy';
import { agentProviders, providerDef, type AgentProviderId } from '../../../main/agents/registry';
import { api, type BackendUser, type HostToolName, type WorkspaceRow } from '../../lib/genie';
import { GitHubConnect, OwnerSelect, useGitHubAccount } from '../GitHubConnect';
import AddWorkspaceModal from '../AddWorkspaceModal';
import { ToolchainSetupWizard } from './ToolchainSetupWizard';
import { canFinishFirstRun } from '../../lib/workspace-onboarding';

type Step = 'welcome' | 'drivers' | 'toolchain' | 'tynn' | 'github' | 'os' | 'workspace';

const DRIVER_TOOL: Partial<Record<AgentProviderId, HostToolName>> = {
    claude: 'claude-code',
    codex: 'codex',
};

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
    const [step, setStep] = useState<Step>('welcome');
    const [drivers, setDrivers] = useState<AgentProviderId[]>(['claude']);
    const [primary, setPrimary] = useState<AgentProviderId>('claude');
    const [tynnUser, setTynnUser] = useState<BackendUser | null>(null);
    const [signingIn, setSigningIn] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [osPath, setOsPath] = useState('');
    const [osOwner, setOsOwner] = useState('');
    const [osSyncing, setOsSyncing] = useState(false);
    const [osSynced, setOsSynced] = useState(false);
    const github = useGitHubAccount();
    const finish = () => {
        localStorage.setItem('genie-onboarding-complete', '1');
        onComplete();
    };

    const wanted = useMemo<HostToolName[]>(() => {
        const tools: HostToolName[] = ['git', 'node', 'npm'];
        for (const driver of drivers) {
            const tool = DRIVER_TOOL[driver];
            if (tool && !tools.includes(tool)) tools.push(tool);
        }
        return tools;
    }, [drivers]);

    useEffect(() => {
        if (!open) return;
        const refresh = () => void api().auth.whoami('tynn').then((user) => {
            setTynnUser(user as BackendUser | null);
            if (user) setSigningIn(false);
        });
        refresh();
        return api().on.authChanged(refresh);
    }, [open]);

    useEffect(() => {
        if (open) void api().app.genieOsWorkspace().then((result) => setOsPath(result.path));
    }, [open]);

    if (!open) return null;
    if (step === 'toolchain') {
        return (
            <ToolchainSetupWizard
                open
                wanted={wanted}
                onClose={() => setStep('tynn')}
            />
        );
    }
    if (step === 'workspace') {
        return (
            <AddWorkspaceModal
                onClose={() => {
                    if (existingWorkspaceCount > 0) finish();
                }}
                onAdded={(workspace) => {
                    onWorkspaceAdded(workspace);
                    finish();
                }}
            />
        );
    }

    const continueFromDrivers = async () => {
        if (!drivers.length) return;
        await api().settings.set({ agent_default: primary });
        setStep('toolchain');
    };

    const startTynn = async () => {
        setError(null);
        setSigningIn(true);
        try {
            await api().auth.startSignIn('tynn');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setSigningIn(false);
        }
    };

    return (
        <>
            <Modal open onClose={() => {
                if (existingWorkspaceCount > 0) finish();
            }} size="lg">
                <Modal.Header>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name="sparkles" size="sm" /> Getting the Workstation Ready
                    </span>
                </Modal.Header>
                <Modal.Body>
                    {step === 'welcome' && (
                        <OnboardingPage
                            title="A working agent workstation, one step at a time"
                            body="Genie will connect your model driver, Tynn account, optional GitHub access, and first managed workspace. You can change any of it later in Settings."
                        >
                            <Action color="blue" onClick={() => setStep('drivers')}>Get started</Action>
                        </OnboardingPage>
                    )}

                    {step === 'drivers' && (
                        <OnboardingPage
                            title="Choose your model drivers"
                            body="Pick every TUI you want available. Choose one as the default for Workspace Agents and the built-in Genie workstation operator."
                        >
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                {agentProviders().filter((id) => id !== 'custom').map((id) => {
                                    const selected = drivers.includes(id);
                                    const def = providerDef(id);
                                    return (
                                        <Card key={id} style={{ padding: 12, borderColor: selected ? 'var(--violet-500)' : undefined }}>
                                            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={selected}
                                                    onChange={() => {
                                                        setDrivers((current) => selected
                                                            ? current.filter((driver) => driver !== id)
                                                            : [...current, id]);
                                                        if (selected && primary === id) {
                                                            const next = drivers.find((driver) => driver !== id);
                                                            if (next) setPrimary(next);
                                                        }
                                                    }}
                                                />
                                                <span>
                                                    <strong>{def.label}</strong>
                                                    <Text size="xs" className="text-zinc-500" style={{ display: 'block' }}>{def.hint}</Text>
                                                </span>
                                            </label>
                                            {selected && (
                                                <Action size="sm" variant={primary === id ? 'default' : 'ghost'} onClick={() => setPrimary(id)} style={{ marginTop: 8 }}>
                                                    {primary === id ? 'Default driver' : 'Make default'}
                                                </Action>
                                            )}
                                        </Card>
                                    );
                                })}
                            </div>
                            <Action color="blue" disabled={!drivers.length || !drivers.includes(primary)} onClick={() => void continueFromDrivers()}>
                                Check toolchain
                            </Action>
                        </OnboardingPage>
                    )}

                    {step === 'tynn' && (
                        <OnboardingPage
                            title="Sign in to Tynn"
                            body="Tynn is the shared account and workspace service Genie uses. This step is required; your source code still stays in Git."
                        >
                            {tynnUser ? (
                                <Text size="sm">✓ Connected as <strong>{tynnUser.name}</strong></Text>
                            ) : (
                                <Action color="blue" disabled={signingIn} onClick={() => void startTynn()}>
                                    {signingIn ? 'Waiting for browser sign-in…' : 'Sign in to Tynn…'}
                                </Action>
                            )}
                            {error && <Text size="xs" className="text-rose-500">{error}</Text>}
                            <Action color="blue" disabled={!tynnUser} onClick={() => setStep('github')}>Continue</Action>
                        </OnboardingPage>
                    )}

                    {step === 'github' && (
                        <OnboardingPage
                            title="Connect GitHub"
                            body="Optional. Connect now to import private repositories and let Genie create or fork repositories for you."
                        >
                            <GitHubConnect account={github} />
                            <div style={{ display: 'flex', gap: 8 }}>
                                <Action color="blue" onClick={() => setStep('os')}>
                                    {github.connected ? 'Continue' : 'Skip for now'}
                                </Action>
                                {existingWorkspaceCount > 0 && (
                                    <Action variant="ghost" onClick={() => setStep('workspace')}>
                                        Add another workspace
                                    </Action>
                                )}
                            </div>
                        </OnboardingPage>
                    )}

                    {step === 'os' && (
                        <OnboardingPage
                            title="Set up Genie OS"
                            body="Genie has its own private AGI workspace and memory. It operates this workstation, never your project folders. You can optionally back that workspace up to a private GitHub repository."
                        >
                            <Text size="xs" className="text-zinc-500">Workspace: <code>{osPath || 'Preparing…'}</code></Text>
                            {github.connected && !osSynced && (
                                <>
                                    <OwnerSelect account={github} value={osOwner} onChange={setOsOwner} />
                                    <Action variant="ghost" disabled={osSyncing} onClick={async () => {
                                        setOsSyncing(true);
                                        setError(null);
                                        try {
                                            const created = await api().github.createRepo({
                                                name: 'genie-os.agi', owner: osOwner || null,
                                                ownerId: osOwner ? github.installations.find((item) => item.login === osOwner)?.id ?? null : null,
                                                description: 'Private Genie OS workspace and memory', private: true,
                                            });
                                            await api().app.syncGenieOs(created.clone_url);
                                            setOsSynced(true);
                                        } catch (cause) {
                                            setError(cause instanceof Error ? cause.message : String(cause));
                                        } finally {
                                            setOsSyncing(false);
                                        }
                                    }}>{osSyncing ? 'Creating private backup…' : 'Back up Genie OS to GitHub'}</Action>
                                </>
                            )}
                            {osSynced && <Text size="sm">✓ Genie OS workspace is synced.</Text>}
                            {error && <Text size="xs" className="text-rose-500">{error}</Text>}
                            <Action color="blue" onClick={() => {
                                if (canFinishFirstRun({ existingWorkspaceCount, setupComplete: true })) finish();
                                else setStep('workspace');
                            }}>{existingWorkspaceCount > 0 ? 'Finish setup' : 'Add first workspace'}</Action>
                        </OnboardingPage>
                    )}
                </Modal.Body>
            </Modal>

        </>
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
