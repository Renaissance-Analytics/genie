import { Editor } from '@particle-academy/react-fancy';

/**
 * The Document plugin's editor surface — react-fancy's compound `Editor`
 * (WYSIWYG over a MARKDOWN string model) with a document-shaped toolbar.
 * Wrapped in its own module (instead of lazy-importing `Editor` directly in
 * PluginEditorHost) because the compound's statics (Editor.Toolbar /
 * Editor.Content) aren't reachable through a React.lazy wrapper — this whole
 * module is what the host lazy-loads.
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
    value: string;
    onChange: (v: string) => void;
}) {
    return (
        <Editor
            value={value}
            onChange={onChange}
            outputFormat="markdown"
            className="h-full flex flex-col rounded-none border-0"
        >
            <Editor.Toolbar actions={ACTIONS} />
            <Editor.Content className="flex-1 overflow-y-auto" />
        </Editor>
    );
}
