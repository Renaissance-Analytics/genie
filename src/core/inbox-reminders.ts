/**
 * UNREAD REMINDERS THAT NEVER FIRE MID-TURN (§6.4) — pure. An agent with uncollected mail is reminded
 * through its own session, but only while IDLE (a reminder landing mid-turn derails the turn), only
 * once per `REMINDER_GAP_MS`, and only while something is unread. A mid-turn moment does not consume the
 * gap: the reminder fires the first time the agent is idle again. The text says how many and how to
 * collect. This book decides; the caller sends.
 */

export const REMINDER_GAP_MS = 5 * 60_000;

export interface ReminderInput {
    readonly agentId: string;
    readonly unread: number;
    readonly idle: boolean;
    readonly now: number;
}

export function reminderText(unread: number): string {
    return unread === 1
        ? 'You have 1 unread AgentInbox message; collect it with agentinbox receive.'
        : `You have ${unread} unread AgentInbox messages; collect them with agentinbox receive.`;
}

export class ReminderBook {
    readonly #lastSent = new Map<string, number>();

    /** The reminder to send now, or `null`. Recording happens only when something is due. */
    due(input: ReminderInput): string | null {
        if (input.unread <= 0 || !input.idle) return null;
        const last = this.#lastSent.get(input.agentId);
        if (last !== undefined && input.now - last < REMINDER_GAP_MS) return null;
        this.#lastSent.set(input.agentId, input.now);
        return reminderText(input.unread);
    }

    /** Collected mail resets the gap, so the next unread message is announced at once. */
    collected(agentId: string): void {
        this.#lastSent.delete(agentId);
    }
}
