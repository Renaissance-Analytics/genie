import { FancyDiff } from '@particle-academy/fancy-diff';
import { CodeView, Icon, JsonEditor } from '@particle-academy/react-fancy';
import type { InspectorContent } from '../../core/inspector.js';
import type { DiffHeader } from '../../core/agent-view.js';

/**
 * THE INSPECTOR — what one tool call actually did.
 *
 * ## It lives INSIDE the body
 *
 * It competes with the Stream's height, never with the right edge, and **it never pushes the
 * Stream sideways** — the Stream shrinks. A panel that shoves the conversation left when a row
 * is selected moves the thing the reader was reading.
 *
 * ## Nothing here is hand-rolled
 *
 * `FancyDiff` in `variant="compare"` for a diff — read-only, with the accept/reject UX
 * stripped. Accepting a hunk belongs to the workspace file panel's conflict flow, where the
 * human owns the file; here the edit has already happened and the question is only what it was.
 * `JsonEditor` read-only for arguments, `CodeView` for content and plain text.
 */

export interface InspectorProps {
    content: InspectorContent;
    onClose: () => void;
    /** Inside the Agent view's ONE right column (the board): no width or border of its own; it fills the top half. */
    embedded?: boolean | undefined;
    /** The board's diff header: counts from the edit itself, its time, its place among the session's edits. */
    header?: DiffHeader | null | undefined;
    /** The footer door `Open in workspace files` — the route it opens; absent = no footer. */
    filesRoute?: string | null | undefined;
    onNavigate?: ((route: string) => void) | undefined;
}

/** `14:08:31`, in the viewer's own locale. */
const clock = (at: number | null): string | null => (at === null ? null : new Date(at).toLocaleTimeString(undefined, { hour12: false }));

export function Inspector({ content, onClose, embedded = false, header = null, filesRoute = null, onNavigate }: InspectorProps) {
    return (
        <aside
            data-inspector={content.kind}
            className={embedded ? 'flex min-h-0 flex-1 flex-col border-b border-[var(--border-1)] bg-[var(--surface)]' : 'flex min-h-0 w-[420px] shrink-0 flex-col border-l border-[var(--border-1)] bg-[var(--surface)]'}
        >
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-3">
                <Icon name="file-code" size="sm" className="shrink-0 text-[var(--fg-4)]" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--fg-3)]">
                    {'path' in content && content.path ? content.path : ''}
                </span>
                {header && content.kind === 'diff' ? (
                    <span data-diff-header="" className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-[var(--fg-4)]">
                        {header.plus !== null && header.plus > 0 ? <span className="text-[var(--success)]">+{header.plus}</span> : null}
                        {header.minus !== null && header.minus > 0 ? <span className="text-[var(--danger)]">−{header.minus}</span> : null}
                        {clock(header.at) ? <span>· {clock(header.at)}</span> : null}
                        <span>· edit {header.index} of {header.total}</span>
                    </span>
                ) : null}
                <button
                    type="button"
                    aria-label="Close inspector"
                    onClick={onClose}
                    className="flex size-5 items-center justify-center rounded text-[var(--fg-4)] hover:bg-[var(--bg-2)]"
                >
                    <Icon name="x" size="xs" />
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
                {content.kind === 'diff' ? (
                    <FancyDiff source={{ before: content.before, after: content.after }} variant="compare" mode="inline" />
                ) : null}

                {/*
                 * Not a diff, and the panel SAYS why. A `Write` reports only what it wrote, so
                 * `before: ''` would render every line as newly added — right for a new file
                 * and a confident lie about an overwrite, with nothing on the wire to tell them
                 * apart.
                 */}
                {content.kind === 'content' ? (
                    <>
                        <p data-inspector-note className="border-b border-[var(--border-1)] px-3 py-2 text-xs text-[var(--fg-3)]">
                            {content.note}
                        </p>
                        <CodeView value={content.text} readOnly />
                    </>
                ) : null}

                {content.kind === 'json' ? <JsonEditor value={content.value} readOnly /> : null}
                {content.kind === 'text' ? <CodeView value={content.text} readOnly /> : null}

                {/*
                 * A refusal with a reason, never an empty panel. An inspector that opens and
                 * then says nothing reads as a broken diff rather than as missing data.
                 */}
                {content.kind === 'none' ? (
                    <p data-inspector-note className="px-3 py-4 text-xs text-[var(--fg-3)]">{content.reason}</p>
                ) : null}
            </div>

            {/* THE FOOTER (the board): the door to the file where it lives. `Revert this edit` is a write Genie does not make yet, so it is not drawn. */}
            {content.kind === 'diff' && filesRoute ? (
                <div className="flex h-8 shrink-0 items-center gap-2 border-t border-[var(--border-1)] px-3">
                    <button type="button" data-action="open-in-files" data-nav={filesRoute} onClick={() => onNavigate?.(filesRoute)} className="text-[11px] text-[var(--fg-2)] hover:underline">Open in workspace files</button>
                </div>
            ) : null}
        </aside>
    );
}
