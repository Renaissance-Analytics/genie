import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import { useCodeEditor } from '@particle-academy/fancy-code';

/**
 * EditorWand — a selection-anchored floating toolbar for the Code editor.
 *
 * Adapts react-fancy's `MagicWand` (the `✦` pill that floats above a text
 * selection) to fancy-code's `<CodeEditor>`. The stock MagicWand wraps its
 * OWN `<Textarea>` and assumes every action returns replacement text; the
 * editor is a different surface and some actions (Copy / Select All) don't
 * replace anything. So we keep MagicWand's floating-pill UX + caret geometry
 * but source the selection from the live editor via `useCodeEditor()`.
 *
 * MUST be rendered as a child of `<CodeEditor>` (it reads the editor context).
 *
 * For now the pill holds Copy / Paste / Select All. The action list is
 * data-driven (`WandAction[]`) so richer actions — including AI-backed text
 * transforms once Genie grows an LLM path — slot in later without reworking
 * the geometry/visibility plumbing.
 */
interface WandAction {
    id: string;
    label: string;
    title: string;
    /** Run the action. Receives the current selection text. */
    run: (selection: string) => void | Promise<void>;
    /** Hide the pill after running (default true). */
    hideAfter?: boolean;
}

/**
 * Selection geometry: mirror the textarea into a hidden div, measure the
 * selected substring's rect, and return VIEWPORT coordinates of the
 * selection's top-centre (the pill renders `position: fixed`). Lifted from
 * MagicWand's `caretRect`, adjusted to viewport space.
 */
function selectionAnchor(
    ta: HTMLTextAreaElement,
    start: number,
    end: number,
): { x: number; y: number } | null {
    const div = document.createElement('div');
    const style = getComputedStyle(ta);
    const props = [
        'boxSizing',
        'width',
        'height',
        'overflowX',
        'overflowY',
        'borderTopWidth',
        'borderRightWidth',
        'borderBottomWidth',
        'borderLeftWidth',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'fontStyle',
        'fontVariant',
        'fontWeight',
        'fontStretch',
        'fontSize',
        'fontSizeAdjust',
        'lineHeight',
        'fontFamily',
        'textAlign',
        'textTransform',
        'textIndent',
        'letterSpacing',
        'wordSpacing',
        'tabSize',
    ] as const;
    for (const p of props)
        (div.style as unknown as Record<string, string>)[p] = (
            style as unknown as Record<string, string>
        )[p];
    div.style.position = 'absolute';
    div.style.top = '-9999px';
    div.style.left = '-9999px';
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordWrap = 'break-word';

    const value = ta.value;
    div.textContent = value.substring(0, start);
    const span = document.createElement('span');
    span.textContent = value.substring(start, end) || '.';
    div.appendChild(span);

    document.body.appendChild(div);
    const taRect = ta.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();
    const divRect = div.getBoundingClientRect();
    const offsetX = spanRect.left - divRect.left;
    const offsetY = spanRect.top - divRect.top;
    document.body.removeChild(div);

    const x = taRect.left + offsetX + spanRect.width / 2;
    const y = taRect.top + offsetY - ta.scrollTop;
    // Drop the pill if the anchor scrolled out of the textarea's box.
    if (y < taRect.top - 4 || y > taRect.bottom + 4) return null;
    return { x, y };
}

export default function EditorWand() {
    const editor = useCodeEditor();
    const { textareaRef, getSelection, replaceSelection, focus } = editor;

    const wandRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const hide = useCallback(() => {
        setPos(null);
        setBusy(null);
    }, []);

    const measure = useCallback(() => {
        const ta = textareaRef.current;
        if (!ta || document.activeElement !== ta) {
            setPos(null);
            return;
        }
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? 0;
        if (start === end) {
            setPos(null);
            return;
        }
        setPos(selectionAnchor(ta, start, end));
    }, [textareaRef]);

    // Track selection changes on the editor's textarea. `selectionchange`
    // fires for textarea caret/selection moves and is simpler than juggling
    // keyup/mouseup/select on a ref that may not exist on first render.
    useEffect(() => {
        document.addEventListener('selectionchange', measure);
        return () => document.removeEventListener('selectionchange', measure);
    }, [measure]);

    // Auto-hide on scroll (the anchor would drift) and on click-away.
    useEffect(() => {
        if (!pos) return;
        const onScroll = () => hide();
        const onDown = (e: MouseEvent) => {
            if (wandRef.current?.contains(e.target as Node)) return;
            if (textareaRef.current?.contains(e.target as Node)) return;
            hide();
        };
        window.addEventListener('scroll', onScroll, true);
        document.addEventListener('mousedown', onDown);
        return () => {
            window.removeEventListener('scroll', onScroll, true);
            document.removeEventListener('mousedown', onDown);
        };
    }, [pos, hide, textareaRef]);

    // Keep the pill clamped on-screen horizontally once it renders.
    useLayoutEffect(() => {
        const el = wandRef.current;
        if (!el || !pos) return;
        const rect = el.getBoundingClientRect();
        const pad = 6;
        let nx = pos.x;
        if (rect.left < pad) nx += pad - rect.left;
        else if (rect.right > window.innerWidth - pad)
            nx -= rect.right - (window.innerWidth - pad);
        if (nx !== pos.x) setPos((p) => (p ? { ...p, x: nx } : p));
    }, [pos]);

    const actions: WandAction[] = [
        {
            id: 'copy',
            label: 'Copy',
            title: 'Copy selection',
            run: async (sel) => {
                try {
                    await navigator.clipboard.writeText(sel);
                } catch {
                    /* clipboard unavailable — silent */
                }
            },
        },
        {
            id: 'paste',
            label: 'Paste',
            title: 'Paste over selection',
            run: async () => {
                try {
                    const text = await navigator.clipboard.readText();
                    replaceSelection(text);
                } catch {
                    /* clipboard unavailable — silent */
                }
            },
        },
        {
            id: 'selectAll',
            label: 'Select All',
            title: 'Select the whole document',
            hideAfter: false,
            run: () => {
                textareaRef.current?.select();
                focus();
            },
        },
    ];

    const onAction = useCallback(
        async (action: WandAction) => {
            const sel = getSelection();
            setBusy(action.id);
            try {
                await action.run(sel);
            } finally {
                if (action.hideAfter === false) {
                    setBusy(null);
                    // Re-measure: Select All grows the selection, so the pill
                    // should re-anchor rather than vanish.
                    measure();
                } else {
                    hide();
                }
            }
        },
        [getSelection, measure, hide],
    );

    if (!pos) return null;

    return (
        <div
            ref={wandRef}
            className="editor-wand"
            style={{ left: pos.x, top: pos.y }}
            // Don't let the textarea lose its selection when clicking the pill.
            onMouseDown={(e) => e.preventDefault()}
        >
            <span className="editor-wand-mark" aria-hidden>
                ✦
            </span>
            {actions.map((a) => (
                <button
                    key={a.id}
                    type="button"
                    className="editor-wand-btn"
                    title={a.title}
                    disabled={busy !== null}
                    onClick={() => void onAction(a)}
                >
                    {busy === a.id ? '…' : a.label}
                </button>
            ))}
        </div>
    );
}
