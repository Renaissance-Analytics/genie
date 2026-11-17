/**
 * A CLICK BELOW THE LAST LINE PUTS THE CURSOR AT THE END OF THE FILE (beta.64, the owner).
 *
 * fancy-code's editor is a `<textarea>` exactly as tall as the text, inside a panel that fills the Files tab. Under a
 * short file the rest of the panel is empty, and a click there landed on the panel, not the textarea: nothing happened,
 * not even focus. A text editor puts the caret at the end of the text for that click; so does this.
 *
 * Only a primary-button click BELOW the textarea's bottom edge: a click on the text is the editor's own (the caret goes
 * where it was clicked, a drag selects), and so is any other button.
 */

export interface TextEnd { line: number; column: number }

export interface ClickLike {
    button: number;
    clientY: number;
    target: unknown;
    preventDefault(): void;
}

export interface TextareaLike {
    getBoundingClientRect(): { bottom: number };
}

/** 1-based, as fancy-code's `setCursor` takes it: the last line, one past its last character. */
export function endOfText(value: string): TextEnd {
    const lines = value.split(/\r?\n/);
    const last = lines[lines.length - 1] ?? '';
    return { line: lines.length, column: last.length + 1 };
}

/** `true` when the click was taken: the caret is at the end, and the mousedown's own focus change was stopped. */
export function clickToEnd(click: ClickLike, textarea: TextareaLike | null, getValue: () => string, setCursor: (pos: TextEnd) => void): boolean {
    if (click.button !== 0 || !textarea || click.target === textarea) return false;
    if (click.clientY <= textarea.getBoundingClientRect().bottom) return false;
    // Without this the mousedown would move focus to the panel after `setCursor` focused the textarea.
    click.preventDefault();
    setCursor(endOfText(getValue()));
    return true;
}
