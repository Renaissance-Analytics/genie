import { describe, expect, it } from 'vitest';
import { installScreen } from '../src/core/install-screen.js';

/**
 * THE RESTART SCREEN (genie#1201; the owner: "We need a better UX during that time"). From the click until Genie is gone
 * the window shows ONE screen that says what is happening and what it waits for — never a frozen page. The click itself
 * shows it (before main has answered), and main's progress fills it in.
 */
describe('installScreen', () => {
    it('nothing to show when no install was asked for', () => {
        expect(installScreen(null, false)).toBeNull();
        expect(installScreen({ phase: 'downloaded', version: '2.0.0-beta.45' }, false)).toBeNull();
    });

    it('the click shows it at once, before main has said anything', () => {
        expect(installScreen({ phase: 'downloaded', version: '2.0.0-beta.45' }, true)).toEqual({
            title: 'Restarting to install Genie 2.0.0-beta.45…',
            detail: 'Getting ready…',
        });
    });

    it('says what it waits for: agents stopping (N of M left), then what runs from the install folder, then the restart', () => {
        const at = (installing: { step: 'agents' | 'processes' | 'restarting'; agents: number; left: number }) =>
            installScreen({ phase: 'installing', version: '2.0.0-beta.45', installing }, false)?.detail;
        expect(at({ step: 'agents', agents: 5, left: 3 })).toBe('Stopping agents — 3 of 5 still stopping');
        expect(at({ step: 'agents', agents: 1, left: 1 })).toBe('Stopping agents — 1 of 1 still stopping');
        expect(at({ step: 'agents', agents: 0, left: 0 })).toBe('Stopping agents');
        expect(at({ step: 'processes', agents: 5, left: 0 })).toBe('Closing what runs from Genie’s install folder');
        expect(at({ step: 'restarting', agents: 5, left: 0 })).toBe('Restarting…');
    });

    it('installing without progress (an older main) still shows the screen', () => {
        expect(installScreen({ phase: 'installing', version: '2.0.0-beta.45' }, false)).toEqual({ title: 'Restarting to install Genie 2.0.0-beta.45…', detail: 'Getting ready…' });
    });

    it('an install that failed (error) is not a restart screen: the window comes back', () => {
        expect(installScreen({ phase: 'error', version: '2.0.0-beta.45' }, true)).toBeNull();
    });
});

describe('the shell draws it (comments stripped)', () => {
    it('Shell renders the install screen from installScreen, and the click marks the install as asked', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../src/renderer/Shell.tsx', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
        expect(src).toMatch(/installScreen\(updateState, installAsked\)/);
        expect(src).toMatch(/<InstallScreen\b/);
        const clicks = src.match(/action === 'update-install'\) [^;\n]*;/g) ?? [];
        expect(clicks.length).toBeGreaterThanOrEqual(2);
        for (const c of clicks) expect(c).toMatch(/askInstall\(\)/);
    });
});
