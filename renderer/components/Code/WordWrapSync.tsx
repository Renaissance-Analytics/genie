import { useEffect } from 'react';
import { useCodeEditor } from '@particle-academy/fancy-code';

/**
 * WordWrapSync — bridges Genie's word-wrap toggle into fancy-code's editor.
 *
 * fancy-code's `<CodeEditor>` seeds its internal wrap state from the `wordWrap`
 * PROP only once, on mount (`useState(wordWrapProp)`), and never re-reads it —
 * runtime changes must go through the context's `toggleWordWrap()`. Genie drives
 * word-wrap from its OWN header button (persisted in the view meta), which only
 * changes the prop, so toggling did nothing after mount.
 *
 * Rendered as a child of `<CodeEditor>`, this reads the editor's live `wordWrap`
 * from context and calls `toggleWordWrap()` whenever it diverges from Genie's
 * desired `wrap` — keeping the editor in sync without a remount (no lost cursor /
 * scroll / undo). The initial `wordWrap` prop still seeds the correct value, so
 * this never fires spuriously on mount. Renders nothing.
 */
export default function WordWrapSync({ wrap }: { wrap: boolean }) {
    const { wordWrap, toggleWordWrap } = useCodeEditor();

    useEffect(() => {
        if (wordWrap !== wrap) toggleWordWrap();
    }, [wrap, wordWrap, toggleWordWrap]);

    return null;
}
