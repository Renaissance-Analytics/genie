import { useState } from 'react';
import { Badge, Drawer, Editor } from '@particle-academy/react-fancy';
import FrontMatterDrawer from './FrontMatterDrawer';
import { frontMatterPill } from '../../lib/front-matter';

/**
 * The Document plugin's editor surface — react-fancy's compound `Editor`
 * (WYSIWYG whose OUTPUT model is a MARKDOWN string) with a document-shaped
 * toolbar. Wrapped in its own module (instead of lazy-importing `Editor`
 * directly in the host) because the compound's statics (Editor.Toolbar /
 * Editor.Content) aren't reachable through a React.lazy wrapper — this whole
 * module is what the host lazy-loads.
 *
 * `valueFormat="markdown"` (react-fancy ≥4.10, shipped for Genie's ask in
 * react-fancy#10) declares the value's format explicitly — the file type says
 * it's markdown, so the editor must never SNIFF it: dev markdown routinely
 * mentions `<code>`/`<table`, which used to flip the sniff to 'html' and
 * render the raw markdown as one collapsed wall.
 *
 * `value` here is the document BODY, never the whole file: a `.md`/`.mdc` file's
 * YAML front matter is split off upstream (PluginEditorBody + `lib/front-matter`)
 * and reaches this component as `frontMatter`, edited through the fm pill and
 * the drawer that falls from the top. The Fancy `Editor` is untouched — the
 * pill, the drawer and the split are all genie-side chrome.
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
    frontMatter,
    onFrontMatterChange,
}: {
    /** The document BODY as MARKDOWN (front matter, if any, arrives separately). */
    value: string;
    onChange: (v: string) => void;
    /**
     * The file's YAML front matter — `''` for an empty block, `null` when the
     * file has none. Omit entirely for file types that cannot carry one
     * (`.docx`); the fm pill then stays off.
     */
    frontMatter?: string | null;
    onFrontMatterChange?: (v: string | null) => void;
}) {
    const [drawerOpen, setDrawerOpen] = useState(false);
    const canEditFrontMatter = frontMatter !== undefined && !!onFrontMatterChange;
    const pill = frontMatterPill(frontMatter ?? null);

    const editor = (
        <Editor
            value={value}
            onChange={onChange}
            valueFormat="markdown"
            outputFormat="markdown"
            className="h-full flex flex-col rounded-none border-0"
        >
            <Editor.Toolbar actions={ACTIONS} />
            <Editor.Content className="flex-1 overflow-y-auto" />
        </Editor>
    );

    if (!canEditFrontMatter) return editor;

    return (
        <Drawer.Container className="doc-shell">
            <div className="doc-chrome">
                <button
                    type="button"
                    className="fm-pill"
                    onClick={() => setDrawerOpen((o) => !o)}
                    title={pill.title}
                    aria-expanded={drawerOpen}
                >
                    <Badge
                        size="sm"
                        variant={pill.present ? 'soft' : 'outline'}
                        color={pill.present ? 'violet' : 'zinc'}
                        dot={pill.present}
                    >
                        {pill.label}
                    </Badge>
                </button>
            </div>
            {editor}
            <FrontMatterDrawer
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                value={frontMatter ?? null}
                onChange={onFrontMatterChange!}
            />
        </Drawer.Container>
    );
}
