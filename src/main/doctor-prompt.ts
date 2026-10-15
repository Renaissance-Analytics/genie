import type { AgentId } from '../core/identity.js';
import { attachmentsFromRenderer } from '../core/prompt-content.js';
import type { SessionHost } from './session-host.js';

/**
 * THE DOCTOR WINDOW'S PROMPT, WITH ITS FILES. The doctor's composer is Genie's (`ChatFlyout`), so it takes picked,
 * dropped and — since react-fancy 5.39.0 — pasted images. Its IPC carried text only, so every one of those was
 * thrown away with nothing on screen saying so: a screenshot pasted into doctor mode to show genie the problem never
 * reached it. The files take the same road as Genie's composer (`genie:prompt` → `promptWith` → content blocks).
 *
 * Kept out of `doctor.ts`, which imports Electron, so it can be tested without one.
 */
export function doctorPrompt(host: Pick<SessionHost, 'promptWith'>, agentId: AgentId, text: unknown, files: unknown): boolean {
    const attachments = attachmentsFromRenderer(files);
    if (typeof text !== 'string' || attachments === null) return false;
    if (text.trim() === '' && attachments.length === 0) return false;
    return host.promptWith(agentId, text, attachments, 'you').ok;
}
