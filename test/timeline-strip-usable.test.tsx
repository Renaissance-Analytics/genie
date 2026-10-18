import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { StreamFilter, TimedEvent } from '../src/core/stream-view.js';
import { sessionTimeline } from '../src/core/session-timeline.js';
import { TimelineStrip, type TimelineStripProps } from '../src/renderer/components/TimelineStrip.js';

/**
 * THE STRIP IS READABLE AND ITS WORDS DO SOMETHING (the owner, 2026-10-18, a screenshot of the strip: "this UX is
 * useless. not readable at all and the next/edit labels don't even do anything").
 *
 * Measured on main: every turn segment printed a 9px `T{n}` at its left edge, so a session of thirty turns was thirty
 * labels on top of each other; the legend (`edit thought tool`) and `E next edit` were plain text.
 *
 * - a label only where there is room for it — at most eight across the strip — and every segment still names its turn
 *   when pointed at (`Turn 12`);
 * - `Next edit` is a button that goes to the next edit (what `E` does);
 * - each legend entry is a button that shows only that kind in the Stream, and pressed again shows everything.
 *
 * Clicks are fired through the element tree (the strip has no hooks): nothing here renders a DOM.
 */

const t = (id: string, event: StreamEvent, at: number): TimedEvent => ({ id, event, at });
const edit = (id: string, at: number) => t(id, { kind: 'tool', toolCallId: id, name: 'Edit', title: null, status: 'completed', toolKind: 'edit', rawInput: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }, at);
const turns = (count: number): TimedEvent[] => Array.from({ length: count }, (_, i) => [t(`turn${i}`, { kind: 'turn', n: i + 1, by: 'you' }, 1_000 + i * 100), edit(`e${i}`, 1_050 + i * 100)]).flat();

function find(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    const walk = (n: ReactNode): void => {
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (!isValidElement(n)) return;
        const el = n as ReactElement<Record<string, unknown>>;
        if (match(el)) out.push(el);
        walk(el.props.children as ReactNode);
    };
    walk(node);
    return out;
}

const props = (rows: TimedEvent[], over: Partial<TimelineStripProps> = {}): TimelineStripProps => ({
    timeline: sessionTimeline(rows, null)!,
    lanesOpen: false,
    onToggleLanes: () => {},
    onOpenRow: () => {},
    ...over,
});

describe('the turn labels', () => {
    it('thirty turns: at most eight labels, and every segment names its turn when pointed at (COUNTED)', () => {
        const timeline = sessionTimeline(turns(30), null)!;
        expect(timeline.segments).toHaveLength(30);
        const shown = timeline.segments.filter((s) => s.showLabel);
        expect(shown.length).toBeGreaterThanOrEqual(2);
        expect(shown.length).toBeLessThanOrEqual(8);
        const html = renderToStaticMarkup(<TimelineStrip {...props(turns(30))} />);
        expect(html.match(/title="Turn \d+"/g)).toHaveLength(30);
        expect(html.match(/data-segment-label=/g)).toHaveLength(shown.length);
        expect(html).not.toContain('text-[9px]');
    });

    it('CONTROL: two turns both have room, and both are labelled', () => {
        const timeline = sessionTimeline(turns(2), null)!;
        expect(timeline.segments.map((s) => s.showLabel)).toEqual([true, true]);
    });
});

describe('Next edit', () => {
    it('is a button, and pressing it goes to the next edit', () => {
        let pressed = 0;
        const tree = TimelineStrip(props(turns(3), { onNextEdit: () => { pressed += 1; } }));
        const buttons = find(tree, (el) => el.type === 'button' && el.props['data-action'] === 'next-edit');
        expect(buttons).toHaveLength(1);
        (buttons[0]!.props.onClick as () => void)();
        expect(pressed).toBe(1);
    });

    it('CONTROL: with no edit in the session there is no button', () => {
        const rows = [t('a', { kind: 'turn', n: 1, by: 'you' }, 1_000), t('b', { kind: 'message', speaker: 'agent', peerName: null, text: 'hi' }, 2_000)];
        const tree = TimelineStrip(props(rows, { onNextEdit: () => {} }));
        expect(find(tree, (el) => el.props['data-action'] === 'next-edit')).toHaveLength(0);
    });
});

describe('the legend', () => {
    it('each kind is a button: pressed, the Stream shows only that kind; pressed again, everything', () => {
        const chosen: (readonly StreamFilter[] | null)[] = [];
        const press = (filter: readonly StreamFilter[] | null, kind: string) => {
            const tree = TimelineStrip(props(turns(3), { filter, onFilter: (next) => { chosen.push(next); } }));
            const [button] = find(tree, (el) => el.type === 'button' && el.props['data-legend'] === kind);
            expect(button, kind).toBeDefined();
            (button!.props.onClick as () => void)();
            return button!;
        };
        press(null, 'edit');
        press(null, 'thought');
        press(null, 'tool');
        const on = press(['edits'], 'edit');
        expect(chosen).toEqual([['edits'], ['thoughts'], ['tools'], null]);
        expect(on.props['aria-pressed']).toBe(true);
    });
});
