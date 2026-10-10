/**
 * KEYS — §4.2's single-letter shortcuts, as pure decisions.
 *
 * > **An unmodified letter must never act while a human is typing.**
 *
 * Everything here is a function of a plain description of the keypress, so the rule above is
 * proven in `test/keys.test.ts` without a DOM. The renderer's one `keydown` listener translates
 * the event into that description and acts on the answer; it decides nothing itself.
 *
 * Only `E` is bound so far. §4.2 names `j`/`k`, `↵`, `Esc`, `t`, `a`/`d`, `⌘↵`, `⌘⇧T`, `L`,
 * `/` as well — each one is a deliberate addition with its own test, not a fall-through.
 */

/** The shape of an event target this module cares about. `null` when the event has none. */
export interface TargetLike {
    tagName: string;
    isContentEditable?: boolean | undefined;
}

/** Is a key pressed on this target TEXT rather than a command? */
export function isTypingTarget(target: TargetLike | null): boolean {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface KeyPress {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    /** The result of {@link isTypingTarget} for the event's target. */
    typing: boolean;
}

export type AgentViewAction = 'next-edit';

/**
 * What an unmodified key means in the Agent view, or `null`.
 *
 * `null` for anything unbound and for anything typed or modified — never a guess. A modifier
 * means the key belongs to the OS or the browser (Ctrl+E, ⌘E); a typing target means it is a
 * letter in a word.
 */
export function agentViewAction(press: KeyPress): AgentViewAction | null {
    if (press.typing || press.ctrlKey || press.metaKey || press.altKey) return null;

    switch (press.key) {
        case 'e':
        case 'E':
            return 'next-edit';
        default:
            return null;
    }
}
