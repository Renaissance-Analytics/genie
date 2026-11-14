// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installScreen, type InstallScreenInput } from '../src/core/install-screen.js';
import { InstallScreen } from '../src/renderer/components/InstallScreen.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ''; });
const waiting = (reason: 'upgrade' | 'quit'): InstallScreenInput => ({ phase: 'installing', version: '2.0.0-beta.62', installing: { step: 'waiting', agents: 3, left: 2, reason, waiting: [{ id: 'a', name: 'atlas' }, { id: 'b', name: 'bolt' }], deadline: 120_000 } });

describe('the visible safe-point wait (#616)', () => {
    it.each(['upgrade', 'quit'] as const)('%s names the waiting agents, states the two-minute bound and offers the matching escape', (reason) => {
        const screen = installScreen(waiting(reason), false)!;
        expect(screen.detail).toMatch(/atlas/); expect(screen.detail).toMatch(/bolt/);
        expect(screen.detail).toMatch(/120 seconds|2 minutes/);
        expect(screen.forceLabel).toBe(reason === 'quit' ? 'Quit now' : 'Upgrade now');
        if (reason === 'quit') expect(screen.title).toMatch(/Quitting Genie/);
    });

    it('Upgrade now is a real clickable button, with exactly one force call', async () => {
        const force = vi.fn(); const box = document.createElement('div'); document.body.append(box);
        const root = createRoot(box);
        try {
            await act(async () => { root.render(<InstallScreen screen={installScreen(waiting('upgrade'), false)!} onForce={force} />); });
            const button = box.querySelector('button');
            expect(button?.textContent).toBe('Upgrade now');
            await act(async () => { button!.click(); }); expect(force).toHaveBeenCalledTimes(1);
        } finally { await act(async () => root.unmount()); }
    });

    it('once stopping begins the escape is gone and any interrupted names are said plainly', () => {
        const screen = installScreen({ phase: 'installing', version: '2.0.0-beta.62', installing: { step: 'agents', agents: 1, left: 1, interrupted: [{ id: 'a', name: 'atlas' }] } }, false)!;
        expect(screen.detail).toMatch(/mid-turn.*atlas|atlas.*mid-turn/i);
        expect(renderToStaticMarkup(<InstallScreen screen={screen} />)).not.toContain('<button');
    });
});
