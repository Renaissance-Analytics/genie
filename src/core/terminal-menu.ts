/**
 * THE TERMINAL'S MENU GIVES THE KEYBOARD BACK (beta.64). STUB: written in GREEN.
 */

export interface MenuItemLike<C> {
    id: string;
    onSelect?: ((ctx: C) => void) | undefined;
}

export function refocusingMenu(_focus: () => void) {
    return <C, I extends MenuItemLike<C>>(_ctx: C, defaults: I[]): I[] => defaults;
}
