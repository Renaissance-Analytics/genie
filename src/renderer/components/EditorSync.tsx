import { useEffect } from 'react';
import { useCodeEditor } from '@particle-academy/fancy-code';

/**
 * WORD WRAP, KEPT IN STEP (beta.33 item 15; Genie 1 WordWrapSync). fancy-code's `<CodeEditor>` seeds its wrap from the
 * `wordWrap` PROP once, on mount, and never re-reads it; a change at runtime goes through the context's `toggleWordWrap()`.
 * The panel's header toggle changes the prop, so without this the toggle did nothing after the file opened. Rendered as a
 * child of `<CodeEditor>`; renders nothing. No remount, so the cursor, the scroll and the undo history stay.
 */
export function WordWrapSync({ wrap }: { wrap: boolean }) {
    const { wordWrap, toggleWordWrap } = useCodeEditor();
    useEffect(() => { if (wordWrap !== wrap) toggleWordWrap(); }, [wrap, wordWrap, toggleWordWrap]);
    return null;
}

/** Where the caret is (Genie 1 showed fancy-code's own `Ln, Col`), and how much is selected. A child of `<CodeEditor>`. */
export function EditorCursor() {
    const { cursorPosition, selectionLength } = useCodeEditor();
    return (
        <span data-editor-cursor="">
            {`Ln ${cursorPosition.line}, Col ${cursorPosition.col}`}
            {selectionLength > 0 ? ` · ${selectionLength} selected` : ''}
        </span>
    );
}
