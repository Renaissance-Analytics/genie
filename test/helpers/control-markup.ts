/**
 * A control in static markup, read the way a person meets it: its opening tag (attributes in any order) and its visible
 * text. react-fancy's `<Button>` puts its label in a `<span data-react-fancy-button-label>` and renders its own
 * attributes before the forwarded ones, so a test that matched `data-x="…"[^>]*>Label</button>` was asserting the old
 * hand-rolled markup, not what the control says. This reads what it says.
 */
export interface ControlMarkup {
    tag: string;
    /** The opening tag, `<button …>`. */
    open: string;
    /** Visible text: the inner markup without tags, whitespace collapsed (aria-label and title are not visible text). */
    text: string;
    /** The inner markup, tags and all (an icon is an <svg> here). */
    inner: string;
    /** Rendered by react-fancy's Button (it marks itself `data-react-fancy-button`). */
    fancy: boolean;
}

/** The first `<button>` or `<a>` whose opening tag contains `attr` (e.g. `data-door="agent"`), or null. */
export function control(html: string, attr: string): ControlMarkup | null {
    let from = 0;
    for (;;) {
        const at = html.indexOf(attr, from);
        if (at < 0) return null;
        const start = html.lastIndexOf('<', at);
        const tag = /^<([a-z]+)\b/.exec(html.slice(start))?.[1] ?? '';
        const openEnd = html.indexOf('>', at);
        if (tag !== 'button' && tag !== 'a') {
            from = at + attr.length;
            continue;
        }
        const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
        re.lastIndex = start;
        let depth = 0;
        let end = html.length;
        for (let m = re.exec(html); m; m = re.exec(html)) {
            depth += m[0].startsWith('</') ? -1 : 1;
            if (depth === 0) {
                end = m.index;
                break;
            }
        }
        const open = html.slice(start, openEnd + 1);
        const text = html.slice(openEnd + 1, end).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        return { tag, open, inner: html.slice(openEnd + 1, end), text, fancy: /\sdata-react-fancy-button=""/.test(open) };
    }
}

/** Every `<button …>` opening tag in the markup. */
export const buttonTags = (html: string): string[] => html.match(/<button\b[^>]*>/g) ?? [];

/** The first `<button>` or `<a>` whose VISIBLE text is exactly `text`, or null. */
export function controlByText(html: string, text: string): ControlMarkup | null {
    for (const m of html.matchAll(/<(button|a)\b[^>]*>/g)) {
        const c = control(html.slice(m.index), m[0]);
        if (c && c.text === text) return c;
    }
    return null;
}
