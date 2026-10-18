import { Modal } from '@particle-academy/react-fancy';
import type { FormEvent } from 'react';
import { feedbackOutcomeWords, type FeedbackView } from '../../core/feedback.js';

/**
 * THE FEEDBACK WINDOW (Tynn #760; Genie 1's FeedbackModal). Opened by the global key (Ctrl+Shift+W), the tray's "Send
 * feedback…", from wherever the person is: where it goes — the Tynn projects their workspaces are linked to, the one
 * they are in first — what to say, Send. After: where it went, with Send another and Done. Nowhere to send it (not
 * signed in, nothing linked) is a sentence with where to fix it, never an empty picker.
 */
export interface FeedbackWindowProps {
    /** `undefined` until main has said anything: closed. */
    view: FeedbackView | undefined;
    onSend: (workspaceId: string, message: string) => void;
    onClose: () => void;
    onAgain: () => void;
}

export function FeedbackWindow(props: FeedbackWindowProps) {
    if (!props.view?.open) return null;
    return (
        <Modal open onClose={props.onClose} size="md">
            <Modal.Header>Send feedback</Modal.Header>
            <Modal.Body>
                <FeedbackBody {...props} view={props.view} />
            </Modal.Body>
        </Modal>
    );
}

export function FeedbackBody({ view, onSend, onClose, onAgain }: FeedbackWindowProps & { view: FeedbackView }) {
    if (!view.signedIn) {
        return <p data-feedback-window="signed-out" className="text-sm text-[var(--fg-2)]">Genie is not signed in to Tynn, so there is nowhere to file it. Sign in to Tynn in Settings → General.</p>;
    }
    if (view.targets.length === 0) {
        return <p data-feedback-window="unlinked" className="text-sm text-[var(--fg-2)]">No workspace here is linked to a Tynn project yet, so there is nowhere to file it.</p>;
    }
    const sent = view.outcome?.ok === true;
    if (sent) {
        return (
            <div data-feedback-window="sent" className="flex flex-col gap-3 text-sm">
                <p>{feedbackOutcomeWords(view.outcome!)}</p>
                <div className="flex justify-end gap-2">
                    <button type="button" data-action="feedback-again" onClick={onAgain} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5">Send another</button>
                    <button type="button" data-action="feedback-done" onClick={onClose} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 font-medium text-white">Done</button>
                </div>
            </div>
        );
    }
    const submit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        onSend(String(form.get('target') ?? ''), String(form.get('message') ?? ''));
    };
    return (
        <form data-feedback-window="open" onSubmit={submit} className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--fg-3)]">File it in</span>
                <select name="target" defaultValue={view.targets[0]!.workspaceId} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1.5">
                    {view.targets.map((t) => <option key={t.workspaceId} value={t.workspaceId}>{t.name}</option>)}
                </select>
            </label>
            <textarea data-feedback-text name="message" rows={6} aria-label="Your feedback" placeholder="What did you notice? The first line becomes its title." className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1.5" />
            {view.outcome && !view.outcome.ok ? <p data-feedback-refusal className="text-xs text-[var(--danger)]">{feedbackOutcomeWords(view.outcome)}</p> : null}
            <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose} className="rounded-lg border border-[var(--border-1)] px-3 py-1.5">Cancel</button>
                <button type="submit" data-action="feedback-send" className="rounded-lg bg-[var(--primary)] px-3 py-1.5 font-medium text-white">Send</button>
            </div>
        </form>
    );
}
