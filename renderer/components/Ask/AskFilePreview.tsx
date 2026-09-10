import { CodeEditor, resolveFileKind } from '@particle-academy/fancy-code';
import { ContentRenderer } from '@particle-academy/react-fancy';
import WordWrapSync from '../Code/WordWrapSync';

/**
 * The BODY of the ForceTheQuestion file drawer — the file a question names,
 * shown beside the question (Tynn story #272).
 *
 * It used to be `<FileViewer>`, and it had drifted from the file editor in all
 * three ways the owner reported (genie#603): nothing scrolled, nothing wrapped,
 * and a `.md` file was a code buffer with line numbers down the side. Their
 * instruction was to use the same logic as the file editor, "except it doesn't
 * need a plugin to render the markdown files" — so this is the editor's OWN
 * composition (`components/Code/CodePanel.tsx`: `<CodeEditor>` + `Panel` +
 * `WordWrapSync`), read-only, with the editor's plugin path replaced by a
 * direct render.
 *
 * ## Why not keep `<FileViewer>`
 *
 * FileViewer is `<CodeEditor><CodeEditor.Panel/></CodeEditor>` plus a MEDIA
 * branch — and the media branch is unreachable here. It needs a `src` URL, the
 * drawer has only text, and `files:read` refuses binary before a byte of it
 * could arrive (`main/files/ipc.ts`). So the wrapper contributed one dead branch
 * and one extra element in the height chain, which is precisely the element the
 * drawer's stylesheet forgot to size (see `.ask-file-view` in globals.css).
 * Dropping it removes a link from that chain and puts this surface on the same
 * two elements the editor already styles.
 *
 * ## Markdown, without the plugin
 *
 * The editor opens `.md` through the bundled **Document** plugin's WYSIWYG
 * (`main/plugins/official.ts`). The drawer is a READER, and per the owner it
 * must not need a plugin installed to show prose as prose — so it renders
 * through react-fancy's `<ContentRenderer format="markdown">`: a full CommonMark
 * + GFM parse, sanitised, and already what Docs, Knowledge, the question body
 * above this drawer and the plugin editor's own preview all use. Nothing
 * markdown-shaped is written in Genie and no library is vendored for it.
 *
 * Rendering prose does hide the source, and a question that names
 * `plans/x.md:42` is pointing at a LINE — so `source` flips this back to the
 * code buffer and the drawer's head offers it. Prose is the default because
 * that is what was asked for.
 *
 * ## What this cannot decide
 *
 * Whether any of it is on screen. The drawer's height chain lives in
 * `renderer/styles/globals.css` under `.ask-file-view`, and a correct
 * composition inside a clipped container looks exactly like a broken one — the
 * whole of genie#603's first bug. The two are tested together:
 * `renderer/components/__tests__/ask-file-preview.test.ts` for what is rendered,
 * `renderer/lib/__tests__/ask-file-drawer.test.ts` for whether it can be seen.
 */

/**
 * The extensions the drawer renders as prose.
 *
 * Exactly what the editor's Document plugin claims, minus `.docx`: that one is
 * binary and `files:read` refuses binary, so it can never reach this drawer. The
 * list is deliberately NOT fancy-code's own markdown aliases (`.mkd`, `.mdx`) —
 * matching the editor is the point, and `.mdx` is JSX whose component tags a
 * sanitising renderer would silently swallow. Both stay readable as source.
 */
const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdc'];

/** Whether `path` is a file this drawer shows as rendered prose. */
export function isMarkdownPath(path: string): boolean {
    const name = path.split(/[\\/]/).pop() ?? path;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return false;
    return MARKDOWN_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

interface Props {
    /** The file's path or name — what the language and the prose test read. */
    filename: string;
    /** The text `files:read` returned. */
    content: string;
    /** Show a markdown file's SOURCE instead of rendering it. Ignored for code. */
    source?: boolean;
}

export default function AskFilePreview({ filename, content, source }: Props) {
    if (isMarkdownPath(filename) && !source) {
        return (
            <div className="ask-file-md">
                <ContentRenderer value={content} format="markdown" />
            </div>
        );
    }

    // `resolveFileKind` is fancy-code's own filename → language mapping, the one
    // `<FileViewer>` used internally. Its media verdict is unreachable here (see
    // the note above), so a `media` answer still renders as text rather than
    // handing a MediaViewer a `src` the drawer does not have.
    const kind = resolveFileKind({ filename });
    const language = kind.kind === 'text' ? kind.language : 'plaintext';

    return (
        <CodeEditor
            value={content}
            language={language}
            readOnly
            lineNumbers
            wordWrap
            // Unchanged from what `<FileViewer>` defaulted to. fancy-code's
            // "auto" reads the OS `prefers-color-scheme`, NOT Genie's own `.dark`
            // class, so a user who PINS a theme against their OS gets an editor
            // that disagrees with the window around it. That is true of every
            // fancy-code surface in Genie and predates this drawer; it is not
            // one of genie#603's three bugs and is not quietly changed here.
            theme="auto"
        >
            <CodeEditor.Panel />
            {/* Wrap is fixed ON and nothing in this drawer can toggle it, so the
                mount-time seed is currently enough on its own. This is the guard
                for the day that stops being true: fancy-code seeds its wrap state
                from the prop ONCE and never re-reads it, which is the trap the
                editor needed a whole component for. See WordWrapSync's docblock. */}
            <WordWrapSync wrap />
        </CodeEditor>
    );
}
