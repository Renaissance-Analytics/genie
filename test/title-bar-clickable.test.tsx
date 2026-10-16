import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { updateChip } from '../src/core/update-chip.js';

/**
 * EVERY CONTROL IN THE TITLE BAR CAN BE CLICKED. The owner, beta.21: "the beta.21 download label appeared but I can't do
 * anything to it". The bar is the window's drag region; a control that is not `no-drag` — itself or by an ancestor —
 * hands its click to the OS as the start of a window drag, so the button never hears it. The header update chip was a
 * button without it. The old guard listed the controls it knew by name, so a NEW control was never checked: this one
 * walks the rendered bar and counts every interactive element, with the update chip in each of its states.
 */
const INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea']);

/** Each interactive element and whether it sits in a no-drag region (itself or an ancestor). */
function clickability(html: string): Array<{ tag: string; clickable: boolean }> {
    const out: Array<{ tag: string; clickable: boolean }> = [];
    const stack: boolean[] = [];
    const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'path', 'circle', 'line', 'rect', 'polyline', 'polygon']);
    for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/g)) {
        const [whole, closing, name, attrs, selfClosing] = m;
        const tag = name!.toLowerCase();
        if (closing) { stack.pop(); continue; }
        const noDrag = /-webkit-app-region:no-drag/.test(attrs!) || (stack.at(-1) ?? false);
        if (INTERACTIVE.has(tag)) out.push({ tag: whole!.slice(0, 120), clickable: noDrag });
        if (!selfClosing && !VOID.has(tag)) stack.push(noDrag);
    }
    return out;
}

describe('the title bar', () => {
    for (const phase of ['available', 'downloaded'] as const) {
        it(`every control is clickable — counted, with the update chip ${phase}`, () => {
            const update = updateChip({ phase, version: '2.0.0-beta.21', percent: null } as never);
            const html = renderToStaticMarkup(
                <TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} update={update} onUpdateAction={() => {}} />,
            );
            const controls = clickability(html);
            // Positive control: the walk finds the controls, the update chip among them.
            expect(controls.length).toBeGreaterThan(3);
            expect(controls.some((c) => c.tag.includes('data-update-chip'))).toBe(true);
            expect(controls.filter((c) => !c.clickable).map((c) => c.tag)).toEqual([]);
        });
    }
});
