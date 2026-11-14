/**
 * DO NOT DISTURB, IN THE HEADER (Tynn #655). The owner: "it should be obvious to the user when they have DND turned on.
 * in fact, that should be a toggle in the app header, not buried in settings."
 *
 * One setting, not two: the header reads and writes Settings → General's own `do_not_disturb` (the host's), so the two
 * are in sync by construction — every window draws the host's settings snapshot, which is pushed on any change.
 *
 * What DND holds back is defined elsewhere and unchanged here: no approval pop-ups (core/approval-toasts.ts), no question
 * window (main/question-window.ts), no alert sounds except a question's chime when `dnd_question_sound` is on
 * (core/alerts.ts), and an agent that asks is told `dnd_reply` at once (main/attention-store.ts). The tooltip says so.
 *
 * Genie 1 kept its DND switch inside the question inbox flyout (renderer/components/Master/QuestionInboxFlyout.tsx);
 * there was no header toggle to port, so this one is new.
 */
export const DND_SETTING = 'do_not_disturb' as const;

export interface DndHeaderView {
    readonly on: boolean;
    readonly icon: 'bell' | 'bell-off';
    /** The control's accessible name: its state. */
    readonly label: string;
    /** What it holds back, and what a click does. */
    readonly tooltip: string;
}

/** The header's reading of the host's settings; `null` = not known yet (no control, never a guessed "off"). */
export function dndHeader(values: Readonly<Record<string, boolean | string>> | null): DndHeaderView | null {
    if (values === null) return null;
    if (values[DND_SETTING] !== true) {
        return { on: false, icon: 'bell', label: 'Do not disturb is off', tooltip: 'Do not disturb is off. Click to hold back pop-ups and sounds.' };
    }
    const sounds = values.dnd_question_sound === true ? 'sounds (questions still chime)' : 'sounds';
    const reply = typeof values.dnd_reply === 'string' && values.dnd_reply.trim() !== '' ? ` “${values.dnd_reply.trim()}”` : ' your away reply';
    return {
        on: true,
        icon: 'bell-off',
        label: 'Do not disturb is on',
        tooltip: `Do not disturb is on: no pop-ups, no ${sounds}. An agent that asks is told${reply}. Click to turn it off.`,
    };
}

/** The write a click makes: the same `settings.set` Settings → General's switch sends. */
export function dndToggleAction(on: boolean): { kind: 'settings.set'; key: typeof DND_SETTING; value: boolean } {
    return { kind: 'settings.set', key: DND_SETTING, value: !on };
}
