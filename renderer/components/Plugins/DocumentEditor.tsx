import { useState } from 'react';
import { marked } from 'marked';
import { Editor } from '@particle-academy/react-fancy';

/**
 * The Document plugin's editor surface — react-fancy's compound `Editor`
 * (WYSIWYG whose OUTPUT model is a MARKDOWN string) with a document-shaped
 * toolbar. Wrapped in its own module (instead of lazy-importing `Editor`
 * directly in the host) because the compound's statics (Editor.Toolbar /
 * Editor.Content) aren't reachable through a React.lazy wrapper — this whole
 * module is what the host lazy-loads.
 *
 * The incoming value's format is KNOWN (markdown — the file type says so), so
 * we convert it to HTML for the contentEditable OURSELVES at mount instead of
 * letting Editor's `detectFormat` sniff it: real-world dev markdown routinely
 * contains HTML-ish snippets (a literal `<code>`, `<table`, …) that flip the
 * sniff to 'html' and render the raw markdown as a single collapsed wall.
 * Editor takes an html-shaped value as-is, sanitizes it, and — with
 * `outputFormat="markdown"` — its onChange still emits markdown.
 * (Upstream ask: an explicit value-format prop on Editor.)
 */

const ACTIONS = [
    { icon: 'B', label: 'Bold', command: 'bold' },
    { icon: 'I', label: 'Italic', command: 'italic' },
    { icon: 'U', label: 'Underline', command: 'underline' },
    { icon: 'S', label: 'Strikethrough', command: 'strikeThrough' },
    { icon: 'H1', label: 'Heading 1', command: 'formatBlock', commandArg: 'H1' },
    { icon: 'H2', label: 'Heading 2', command: 'formatBlock', commandArg: 'H2' },
    { icon: 'H3', label: 'Heading 3', command: 'formatBlock', commandArg: 'H3' },
    { icon: '¶', label: 'Paragraph', command: 'formatBlock', commandArg: 'P' },
    { icon: '•', label: 'Bullet list', command: 'insertUnorderedList' },
    { icon: '1.', label: 'Numbered list', command: 'insertOrderedList' },
];

export default function DocumentEditor({
    value,
    onChange,
}: {
    /** The document as MARKDOWN (the model both .md and .docx open into). */
    value: string;
    onChange: (v: string) => void;
}) {
    // Converted ONCE at mount — the contentEditable is uncontrolled after that
    // (Editor only reads the value again when re-entering edit mode), and every
    // onChange hands back markdown, so the parent keeps a markdown model.
    const [initialHtml] = useState(() =>
        (marked.parse(value ?? '', { async: false }) as string).trim(),
    );

    return (
        <Editor
            value={initialHtml}
            onChange={onChange}
            outputFormat="markdown"
            className="h-full flex flex-col rounded-none border-0"
        >
            <Editor.Toolbar actions={ACTIONS} />
            <Editor.Content className="flex-1 overflow-y-auto" />
        </Editor>
    );
}
