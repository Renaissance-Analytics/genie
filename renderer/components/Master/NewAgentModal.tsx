import { useState } from 'react';
import { Button, Input, Modal, Select, Text } from '@particle-academy/react-fancy';
import { api } from '../../lib/genie';
import { agentTerminalTypes } from '../../lib/terminal-types';

/**
 * Create an AGENT — a record and its `AGENT.md`, never a terminal.
 *
 * Creating an agent was MCP-only until now. The form for it existed in the
 * renderer and was unreachable: `panelLauncherTypes()` filters out every
 * specialized type, so the "New Agent…" button it fed had no caller. Right-
 * clicking the workspace is where a person actually looks for this.
 *
 * Deliberately NOT a terminal launcher. Registering is cheap and reversible;
 * starting one spends tokens and is gated by an approval modal and the
 * agent-terminal cap. Those are different decisions and this makes only the
 * first — the agent appears in the grid as dormant, and starting it is its own,
 * deliberate act.
 */
export default function NewAgentModal({
    workspaceId,
    workspaceName,
    onClose,
    onCreated,
}: {
    workspaceId: string;
    workspaceName: string;
    onClose: () => void;
    onCreated: () => void;
}) {
    const [name, setName] = useState('');
    const [purpose, setPurpose] = useState('');
    // Labelled, not raw ids: the list already exists and already knows what to
    // call each driver.
    const tuis = agentTerminalTypes();
    const [tui, setTui] = useState<string>(tuis[0]?.agent ?? 'claude');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The name becomes a folder under `.agents/`, so it is normalized here as
    // well as in main — showing someone the slug they are about to create beats
    // silently rewriting what they typed after they commit to it.
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const ready = slug.length > 0 && purpose.trim().length > 0 && !busy;

    const submit = async (): Promise<void> => {
        if (!ready) return;
        setBusy(true);
        setError(null);
        try {
            const result = await api().agents.create({
                workspaceId,
                name: slug,
                purpose: purpose.trim(),
                agent: tui,
            });
            if (!result.ok) {
                setError(result.error ?? 'Could not create the agent.');
                return;
            }
            onCreated();
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal open onClose={onClose} title={`New agent in ${workspaceName}`}>
            <div style={{ display: 'grid', gap: 12, minWidth: 380 }}>
                <label style={{ display: 'grid', gap: 4 }}>
                    <Text size="sm">Name</Text>
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="tynn"
                        autoFocus
                    />
                    {slug && slug !== name.trim() && (
                        <Text size="xs" color="muted">
                            Created as <strong>{slug}</strong> — the folder name under .agents/
                        </Text>
                    )}
                </label>

                <label style={{ display: 'grid', gap: 4 }}>
                    <Text size="sm">Purpose</Text>
                    <Input
                        value={purpose}
                        onChange={(e) => setPurpose(e.target.value)}
                        placeholder="Laravel app work"
                    />
                    <Text size="xs" color="muted">
                        What this agent is for. It goes into its AGENT.md, which is committed
                        with the project.
                    </Text>
                </label>

                <label style={{ display: 'grid', gap: 4 }}>
                    <Text size="sm">Starting TUI</Text>
                    <Select
                        value={tui}
                        onValueChange={setTui}
                        list={tuis.map((t) => ({ value: t.agent as string, label: t.label }))}
                    />
                    <Text size="xs" color="muted">
                        An agent is not its TUI — you can switch it later, and the one it
                        leaves keeps its conversation as a sidecar.
                    </Text>
                </label>

                {error && (
                    <Text size="sm" color="danger">
                        {error}
                    </Text>
                )}

                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button onClick={() => void submit()} disabled={!ready}>
                        {busy ? 'Creating…' : 'Create agent'}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
