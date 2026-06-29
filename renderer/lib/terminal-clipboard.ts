import type {
    TerminalContextMenuConfig,
    TerminalContextMenuContext,
    TerminalContextMenuItem,
} from '@particle-academy/fancy-term';

export interface ClipboardMenuHandlers {
    /** Write the current selection to the SYSTEM clipboard (Electron-main IPC). */
    copy: (selection: string) => void;
    /** Read the system clipboard and paste it into the terminal. */
    paste: () => void;
}

/**
 * Build the terminal's right-click menu with Copy/Paste routed through the host's
 * Electron-main clipboard (via IPC) instead of fancy-term's `navigator.clipboard`
 * defaults — which fail SILENTLY in a sandboxed Electron window (no permission /
 * lost user-gesture), so terminal copy never reached the OS clipboard. The
 * package's other built-in items (Select all / Clear) are preserved.
 *
 * Pure (no React / no Electron) → unit-testable.
 */
export function buildClipboardMenu(
    handlers: ClipboardMenuHandlers,
): TerminalContextMenuConfig {
    return (
        ctx: TerminalContextMenuContext,
        defaults: TerminalContextMenuItem[],
    ): TerminalContextMenuItem[] => {
        // Drop the package's navigator.clipboard Copy/Paste; keep the rest.
        const rest = defaults.filter((d) => d.id !== 'copy' && d.id !== 'paste');
        return [
            {
                id: 'copy',
                label: 'Copy',
                disabled: !ctx.hasSelection,
                onSelect: (c) => handlers.copy(c.selection),
            },
            {
                id: 'paste',
                label: 'Paste',
                disabled: ctx.readOnly,
                onSelect: () => handlers.paste(),
            },
            ...rest,
        ];
    };
}
