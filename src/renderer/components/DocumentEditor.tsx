import { useState } from 'react';
import { Badge, Drawer, Editor } from '@particle-academy/react-fancy';
import { frontMatterPill } from '../../core/front-matter.js';
import { FrontMatterDrawer } from './FrontMatterDrawer.js';
import { genieClipboardWriter } from '../clipboard.js';

/**
 * THE DOCUMENT PLUGIN'S EDITOR (beta.33 item 14; Genie 1 renderer/components/Plugins/DocumentEditor.tsx). The owner: "why am
 * I seeing raw markdown". react-fancy's compound `Editor` — a WYSIWYG whose value AND output are a MARKDOWN string — with a
 * document toolbar and its own Source toggle. `valueFormat="markdown"` because the file type says so: the editor must never
 * SNIFF it (dev markdown mentions `<code>` / `<table`, which used to flip the sniff to HTML — react-fancy#10).
 *
 * `value` is the document BODY, never the whole file: a `.md` / `.mdc` file's YAML front matter is split off upstream
 * (core/front-matter.ts) and arrives as `frontMatter`, edited through the fm pill and the drawer that drops from the top —
 * never typed into the page, where the WYSIWYG would render it as prose and rewrite it on the first keystroke.
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

export function DocumentEditor({ value, onChange, frontMatter, onFrontMatterChange, readOnly = false }: {
    /** The document BODY as markdown (front matter, if any, arrives separately). */
    value: string;
    onChange: (value: string) => void;
    /** The file's YAML front matter: `''` an empty block, `null` none. Omit for a type that cannot carry one (.docx): no pill. */
    frontMatter?: string | null | undefined;
    onFrontMatterChange?: ((value: string | null) => void) | undefined;
    readOnly?: boolean | undefined;
}) {
    const [drawerOpen, setDrawerOpen] = useState(false);
    const pill = frontMatterPill(frontMatter ?? null);

    const editor = (
        // Read-only, react-fancy 5.68 renders it through ContentRenderer with a copy button on each code block and table, and
        // forwards the writer: every copy goes through main's clipboard (renderer/clipboard.ts), as the chat's do.
        <Editor value={value} onChange={onChange} valueFormat="markdown" outputFormat="markdown" mode={readOnly ? 'view' : 'edit'} clipboardWriter={genieClipboardWriter} className="flex min-h-0 flex-1 flex-col rounded-none border-0">
            {readOnly ? null : <Editor.Toolbar actions={ACTIONS} showSourceToggle />}
            <Editor.Content className="min-h-0 flex-1 overflow-y-auto" />
        </Editor>
    );

    if (frontMatter === undefined || onFrontMatterChange === undefined) return <div data-document-editor="" className="flex h-full min-h-0 flex-col">{editor}</div>;

    return (
        <Drawer.Container data-document-editor="" className="flex h-full min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-2 py-1">
                <button type="button" data-fm-pill="" className="inline-flex items-center hover:brightness-110" onClick={() => setDrawerOpen((o) => !o)} title={pill.title} aria-expanded={drawerOpen}>
                    <Badge size="sm" variant={pill.present ? 'soft' : 'outline'} color={pill.present ? 'violet' : 'zinc'} dot={pill.present}>
                        {pill.label}
                    </Badge>
                </button>
            </div>
            {editor}
            <FrontMatterDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} value={frontMatter ?? null} onChange={onFrontMatterChange} />
        </Drawer.Container>
    );
}
