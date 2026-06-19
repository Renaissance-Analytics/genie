import { useEffect, useState } from 'react';
import { Heading, Modal, Text } from '@particle-academy/react-fancy';
import TynnProvisionPanel from '../TynnProvisionPanel';
import type { WorkspaceRow } from '../../lib/genie';
import { api } from '../../lib/genie';

/**
 * Per-workspace settings, opened from the workspace context menu. Edits the
 * settings that belong to ONE workspace — attaching a Tynn project (and its
 * auto-provisioned agent token) and the background-process-approval gate.
 * Global/app settings still live in the Settings window.
 */
export default function WorkspaceSettingsModal({
    workspace,
    onClose,
}: {
    workspace: WorkspaceRow;
    onClose: () => void;
}) {
    // Per-workspace "require approval before an agent starts a process".
    const [processApproval, setProcessApproval] = useState<boolean | null>(null);

    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const ws = (await api().workspaces.list()).find((w) => w.id === workspace.id);
                if (alive) setProcessApproval(ws ? ws.process_approval !== 0 : true);
            } catch {
                if (alive) setProcessApproval(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [workspace.id]);

    const toggleProcessApproval = async (require: boolean) => {
        setProcessApproval(require); // optimistic
        try {
            await api().workspaces.setProcessApproval(workspace.id, require);
        } catch {
            setProcessApproval((prev) => !prev); // revert
        }
    };

    return (
        <Modal open onClose={onClose} size="md">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 4 }}>
                <div>
                    <Heading as="h2" size="sm" style={{ margin: 0 }}>
                        Workspace settings
                    </Heading>
                    <Text size="xs" className="text-zinc-500">
                        {workspace.project_name}
                        {workspace.path ? ` · ${workspace.path}` : ''}
                    </Text>
                </div>

                <TynnProvisionPanel workspaceId={workspace.id} />

                <div
                    style={{
                        paddingTop: 12,
                        borderTop: '1px solid var(--border-1)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                    }}
                >
                    <Heading as="h3" size="xs" style={{ margin: 0 }}>
                        Background process approval
                    </Heading>
                    <Text size="xs" className="text-zinc-500">
                        When ON, an agent that tries to start a background process
                        (via <code>manageProcess</code>) must be approved by you
                        first.
                    </Text>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={processApproval ?? true}
                            disabled={processApproval === null}
                            onChange={(e) => void toggleProcessApproval(e.target.checked)}
                        />
                        <Text size="sm">Require my approval before an agent starts a process</Text>
                    </label>
                </div>
            </div>
        </Modal>
    );
}
