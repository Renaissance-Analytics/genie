import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TitleBar } from '../src/renderer/components/TitleBar.js';
import { RemoteRefusalBar } from '../src/renderer/components/RemoteRefusalBar.js';

/**
 * THE REMOTE BADGE (§6.8) — driving another machine is LOUD: `● REMOTE — <host>` in the title bar,
 * with who holds the baton and the lock beside it. Absent entirely when this window is on its own
 * machine; a badge that is sometimes quietly wrong is worse than none.
 */

const render = (remote: Parameters<typeof TitleBar>[0]['remote']) =>
    renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} remote={remote} onNavigate={() => {}} onOpenPalette={() => {}} />);

describe('the REMOTE badge', () => {
    it('is absent on the local machine', () => {
        expect(render(null)).not.toContain('data-remote-badge');
        expect(render(undefined)).not.toContain('data-remote-badge');
    });

    it('names the host and says who is driving — you, someone else by label, or nobody — and whether the host is locked', () => {
        const mine = render({ host: 'studio', driver: 'laptop', driving: true, locked: false });
        expect(mine).toContain('data-remote-badge');
        expect(mine).toMatch(/● REMOTE — studio/);
        expect(mine).toMatch(/you are driving/);
        expect(render({ host: 'studio', driver: 'phone', driving: false, locked: false })).toMatch(/phone is driving/);
        expect(render({ host: 'studio', driver: null, driving: false, locked: false })).toMatch(/nobody is driving/);
        expect(render({ host: 'studio', driver: null, driving: false, locked: true })).toMatch(/locked/);
    });
});

/**
 * TAKE CONTROL (Tynn #529): the owner, driving a drone from a Pilot, had no control anywhere to take the baton. The badge
 * offers it whenever this window is not driving and the host is not locked, naming who holds it; a refusal for lack of the
 * baton is shown with the same control right beside it.
 */
describe('Take control', () => {
    const take = () => {};
    const withTake = (remote: { host: string; driver: string | null; driving: boolean; locked: boolean; lostTo?: string | null }) =>
        renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} remote={{ ...remote, onTakeControl: take } as never} onNavigate={() => {}} onOpenPalette={() => {}} />);

    it('is offered when nobody drives, and names who drives when someone else does', () => {
        const nobody = withTake({ host: 'aion', driver: null, driving: false, locked: false });
        expect(nobody).toContain('data-action="take-control"');
        expect(nobody).toMatch(/>Take control</);
        const other = withTake({ host: 'aion', driver: 'desk', driving: false, locked: false });
        expect(other).toMatch(/Take control from desk/);
    });

    it('says who took control from this window', () => {
        expect(withTake({ host: 'aion', driver: 'desk', driving: false, locked: false, lostTo: 'desk' })).toMatch(/desk took control/);
    });

    it('CONTROL: not offered while this window drives, nor on a locked host', () => {
        expect(withTake({ host: 'aion', driver: 'laptop', driving: true, locked: false })).not.toContain('data-action="take-control"');
        expect(withTake({ host: 'aion', driver: null, driving: false, locked: true })).not.toContain('data-action="take-control"');
    });

    it('a refusal for lack of the baton is shown with Take control right there; any other refusal is shown without it', () => {
        const baton = renderToStaticMarkup(<RemoteRefusalBar refusal="nobody is driving aion; take the baton to make changes" needsBaton driver={null} onTakeControl={take} onDismiss={() => {}} />);
        expect(baton).toContain('data-remote-refusal');
        expect(baton).toContain('nobody is driving aion; take the baton to make changes');
        expect(baton).toContain('data-action="take-control"');
        const other = renderToStaticMarkup(<RemoteRefusalBar refusal="takeOver opens a window on aion; do it there" needsBaton={false} driver={null} onTakeControl={take} onDismiss={() => {}} />);
        expect(other).toContain('takeOver opens a window on aion; do it there');
        expect(other).not.toContain('data-action="take-control"');
        expect(renderToStaticMarkup(<RemoteRefusalBar refusal={null} needsBaton={false} driver={null} onTakeControl={take} onDismiss={() => {}} />)).toBe('');
    });
});
