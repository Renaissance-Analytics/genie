import { Window } from 'happy-dom';

/**
 * The text of some markup, read with a real HTML parser (happy-dom) instead of a regex over tags.
 *
 * A tag-stripping regex such as `html.replace(/<[^>]*>/g, '')` is what CodeQL flags as an incomplete multi-character
 * sanitization (#114–#117). The tests only used it to read text, never to sanitize anything, but the parser is the complete
 * answer: entities decoded, comments and attributes never mistaken for text, nesting understood.
 *
 * This runs in either vitest environment (node or happy-dom): it uses a Window of its own, never the global document.
 */
let window: Window | null = null;

/** Markup (as renderToStaticMarkup gives it), parsed into a detached `<div>`. */
export function markupRoot(html: string): HTMLElement {
    window ??= new Window();
    const host = window.document.createElement('div');
    host.innerHTML = html;
    return host as unknown as HTMLElement;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TEXT = 3;
const ELEMENT = 1;
const COMMENT = 8;

/**
 * The text inside a node. `tagGap` is what each tag stands for, as `replace(/<[^>]*>/g, tagGap)` had it: `''` (the default)
 * is `textContent`; `' '` keeps words in neighbouring elements apart. An element counts its opening and closing tag (a void
 * element only its one), and a comment counts as one tag.
 */
export function nodeText(node: Node, tagGap = ''): string {
    let out = '';
    const walk = (parent: Node): void => {
        for (const child of Array.from(parent.childNodes)) {
            if (child.nodeType === TEXT) out += (child as Text).data;
            else if (child.nodeType === COMMENT) out += tagGap;
            else if (child.nodeType === ELEMENT) {
                out += tagGap;
                walk(child);
                if (!VOID.has((child as Element).localName)) out += tagGap;
            }
        }
    };
    walk(node);
    return out;
}

/** The text of some markup; see nodeText for `tagGap`. */
export function markupText(html: string, tagGap = ''): string {
    return nodeText(markupRoot(html), tagGap);
}
