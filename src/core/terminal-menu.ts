/**
 * THE TERMINAL'S MENU GIVES THE KEYBOARD BACK (beta.64, the owner: pasting from the context menu must return focus to
 * the terminal).
 *
 * fancy-term draws a terminal's right-click menu itself (`TerminalContextMenu`). Picking an item focuses the menu's
 * button, runs the item, and closes the menu; the focused button is gone with it, so focus was left on nothing and the
 * next keystrokes went nowhere until the terminal was clicked again. fancy-term takes a `contextMenu` function
 * (`(ctx, defaults) => items`); this one keeps its default items exactly and makes each action, once it has run, hand
 * focus back to the terminal. Before the menu closes, so focus never passes through the page.
 *
 * Paste reads the clipboard asynchronously; focus does not wait for it: xterm's `paste` writes to the pty whether or not
 * the terminal is focused, and the keys typed meanwhile already go to the terminal.
 */

export interface MenuItemLike<C> {
    id: string;
    onSelect?: ((ctx: C) => void) | undefined;
}

export function refocusingMenu(focus: () => void) {
    return <C, I extends MenuItemLike<C>>(_ctx: C, defaults: I[]): I[] =>
        defaults.map((item) => {
            const run = item.onSelect;
            return run ? { ...item, onSelect: (c: C) => { run(c); focus(); } } : item;
        });
}
