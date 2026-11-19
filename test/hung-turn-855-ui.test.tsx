import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RunningCall } from '../src/renderer/components/RunningCall.js';

/**
 * THE CALL THE TURN IS IN, IN THE AGENT VIEW (Tynn #855): its label, command and age, and `Stop this call` only when the
 * window can act (a read-only share sees the call, not the button). Hook-free: rendered and pressed without a DOM.
 */

const MIN = 60_000;
const call = { toolCallId: 't1', label: 'Bash', command: 'gh pr create --fill', since: 0 };

describe('RunningCall (Tynn #855)', () => {
    it('names the call and its age, with Stop this call', () => {
        const html = renderToStaticMarkup(<RunningCall call={call} now={21 * MIN} onStop={() => {}} />);
        expect(html).toContain('Bash · gh pr create --fill · 21 min');
        expect(html).toContain('data-action="stop-call"');
        expect(html).toContain('Stop this call');
    });

    it('a window that cannot act sees the call and no button', () => {
        const html = renderToStaticMarkup(<RunningCall call={call} now={3 * MIN} />);
        expect(html).toContain('gh pr create --fill');
        expect(html).not.toContain('data-action="stop-call"');
    });

    it('pressing it stops that call, once', () => {
        const onStop = vi.fn();
        const el = RunningCall({ call, now: 0, onStop }) as { props: { children: unknown[] } };
        const button = (el.props.children as Array<{ props?: { onClick?: () => void } } | null>).find((c) => c?.props?.onClick);
        button!.props!.onClick!();
        expect(onStop).toHaveBeenCalledTimes(1);
    });
});
