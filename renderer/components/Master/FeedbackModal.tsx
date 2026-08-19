import { useState } from 'react';
import { Action, Modal, Text, Textarea } from '@particle-academy/react-fancy';
import { api, type WorkspaceRow } from '../../lib/genie';

/**
 * Send feedback about GENIE ITSELF to the workspace's Tynn project (Tynn #249).
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
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentId, setSentId] = useState<string | null>(null);

    const projectId = workspace.tynn_project_id || workspace.project_id || '';

    const send = async () => {
        const text = message.trim();
        if (!text || sending) return;
        setSending(true);
        setError(null);
        const res = await api().tynn.submitFeedback(
            projectId,
            text,
            { workspace: workspace.project_name },
            workspace.backend === 'aionima' ? 'aionima' : 'tynn',
        );
        setSending(false);
        if (res.ok) {
            setSentId(res.id ?? 'sent');
            setMessage('');
        } else {
            // Shown, never swallowed: feedback that silently failed is worse than
            // feedback never written, because the person believes it was filed.
            setError(res.error ?? 'Could not send that.');
        }
    };

    const close = () => {
        setSentId(null);
        setError(null);
        onClose();
    };

    return (
        <Modal open={open} onClose={close} title="Send feedback">
            {!projectId ? (
                <Text size="sm">
                    This workspace isn&rsquo;t connected to a Tynn project, so there&rsquo;s nowhere
                    to send feedback yet. Connect it in Workspace settings.
                </Text>
            ) : sentId ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Text size="sm">
                        Sent. It&rsquo;s in <strong>{workspace.project_name}</strong>&rsquo;s feedback
                        list in Tynn, where it can be triaged or turned into a wish.
                    </Text>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Action size="sm" onClick={() => setSentId(null)}>
                            Send another
                        </Action>
                        <Action size="sm" variant="ghost" onClick={close}>
                            Done
                        </Action>
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Text size="sm" className="text-zinc-500">
                        About Genie itself — something confusing, something that behaved
                        unexpectedly, something missing. Goes to{' '}
                        <strong>{workspace.project_name}</strong> in Tynn. Your Genie version and
                        workspace are attached automatically.
                    </Text>
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
                    <div style={{ display: 'flex', gap: 8 }}>
                        <Action
                            size="sm"
                            color="blue"
                            disabled={sending || message.trim().length === 0}
                            onClick={() => void send()}
                        >
                            {sending ? 'Sending…' : 'Send feedback'}
                        </Action>
                        <Action size="sm" variant="ghost" onClick={close}>
                            Cancel
                        </Action>
                    </div>
                </div>
            )}
        </Modal>
    );
}
