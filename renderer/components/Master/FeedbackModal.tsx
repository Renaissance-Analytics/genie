import { useEffect, useState } from 'react';
import { Action, Modal, Select, Text, Textarea } from '@particle-academy/react-fancy';
import { api, type TynnProject, type WorkspaceRow } from '../../lib/genie';
import { feedbackProjectFor, feedbackProjectOptions } from '../../lib/feedback-target';

/**
 * Send feedback to a Tynn project (Tynn #249).
 *
 * The human half of the feature; `submitFeedback` is the agent half. Both land in
 * the same Tynn feedback pipeline, where they can be triaged, quick-accepted or
 * converted to a wish — so a rough edge noticed mid-task reaches the place the
 * work is planned instead of a chat log that scrolls away.
 *
 * In-app rather than a link out to Tynn, deliberately: the standing rule is that
 * Genie drives the action rather than handing over a URL, and leaving the app is
 * exactly the friction that stops feedback being written at all.
 *
 * Opened from a workspace's menu, or from anywhere with the global hotkey for the
 * ACTIVE workspace (genie#675). Either way the workspace's Tynn project is
 * preselected, and the person can pick another. A workspace with no Tynn project
 * says so and asks, rather than guessing.
 *
 * The context — Genie version, workspace — is attached automatically. Asking a
 * person to type their build number is asking them not to bother.
 */
export default function FeedbackModal({
    workspace,
    open,
    onClose,
}: {
    workspace: WorkspaceRow;
    open: boolean;
    onClose: () => void;
}) {
    const linkedProjectId = feedbackProjectFor(workspace);
    const [projectId, setProjectId] = useState(linkedProjectId);
    const [projects, setProjects] = useState<TynnProject[]>([]);
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentTo, setSentTo] = useState<string | null>(null);

    // Re-seed when the modal is reused for a different workspace.
    useEffect(() => setProjectId(linkedProjectId), [linkedProjectId]);

    useEffect(() => {
        if (!open) return;
        let live = true;
        api()
            .tynn.projects()
            .then((ps) => {
                if (live) setProjects(ps);
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [open]);

    const linkedName = workspace.tynn_project_name || workspace.project_name;
    const options = feedbackProjectOptions(
        projects,
        projectId,
        projectId === linkedProjectId ? linkedName : '',
    );
    const projectName = options.find((o) => o.value === projectId)?.label ?? '';

    const send = async () => {
        const text = message.trim();
        if (!text || !projectId || sending) return;
        setSending(true);
        setError(null);
        const res = await api().tynn.submitFeedback(
            projectId,
            text,
            { workspace: workspace.project_name },
            'tynn',
        );
        setSending(false);
        if (res.ok) {
            setSentTo(projectName);
            setMessage('');
        } else {
            // Shown, never swallowed: feedback that silently failed is worse than
            // feedback never written, because the person believes it was filed.
            setError(res.error ?? 'Could not send that.');
        }
    };

    const close = () => {
        setSentTo(null);
        setError(null);
        onClose();
    };

    return (
        <Modal open={open} onClose={close}>
            <Modal.Header>Send feedback</Modal.Header>
            <Modal.Body>
                {sentTo !== null ? (
                    <Text size="sm">
                        Sent. It&rsquo;s in <strong>{sentTo}</strong>&rsquo;s feedback list in Tynn,
                        where it can be triaged or turned into a wish.
                    </Text>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <Text size="sm" className="text-zinc-500">
                            {linkedProjectId
                                ? 'Something confusing, something that behaved unexpectedly, something missing. Your Genie version and workspace are attached automatically.'
                                : `${workspace.project_name} isn’t connected to a Tynn project. Choose where to send this.`}
                        </Text>
                        <Select
                            label="Project"
                            value={projectId}
                            onValueChange={setProjectId}
                            list={options}
                            placeholder="Choose a project"
                        />
                        <Textarea
                            value={message}
                            onValueChange={setMessage}
                            rows={5}
                            autoFocus
                            placeholder="What happened? What did you expect instead?"
                        />
                        {error && (
                            <Text size="xs" style={{ color: 'var(--rose-500)' }}>
                                {error}
                            </Text>
                        )}
                    </div>
                )}
            </Modal.Body>
            <Modal.Footer>
                {sentTo !== null ? (
                    <>
                        <Action size="sm" onClick={() => setSentTo(null)}>
                            Send another
                        </Action>
                        <Action size="sm" variant="ghost" onClick={close}>
                            Done
                        </Action>
                    </>
                ) : (
                    <>
                        <Action
                            size="sm"
                            color="blue"
                            disabled={sending || !projectId || message.trim().length === 0}
                            onClick={() => void send()}
                        >
                            {sending ? 'Sending…' : 'Send feedback'}
                        </Action>
                        <Action size="sm" variant="ghost" onClick={close}>
                            Cancel
                        </Action>
                    </>
                )}
            </Modal.Footer>
        </Modal>
    );
}
