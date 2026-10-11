import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

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
