import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { updateChip } from '../src/core/update-chip.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

/**
 * THE RUNNING VERSION, IN THE HEADER (Tynn #763 row 28; Genie 1's wordmark label). Beside "Genie" the version that is
 * running — the first thing anyone asks when something looks wrong — until there is an update to act on, when the
 * update chip says what comes next instead. Not known yet: nothing, never a guess.
 */
const bar = (version: string | null, update: ReturnType<typeof updateChip> = null) =>
    renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} update={update} onOpenUpdate={() => {}} version={version} />);

describe('the header’s version', () => {
    it('the running version beside the wordmark', () => {
        expect(bar('2.0.0-beta.31')).toMatch(/data-running-version="2\.0\.0-beta\.31"[^>]*>v2\.0\.0-beta\.31</);
    });

    it('an update to act on: the chip says what comes next, and the version gives way (CONTROL: none, it is there)', () => {
        const withUpdate = bar('2.0.0-beta.31', updateChip({ phase: 'available', version: '2.0.0-beta.32', percent: null }));
        expect(withUpdate).not.toContain('data-running-version');
        expect(withUpdate).toContain('data-update-chip="available"');
    });

    it('not known yet: nothing', () => {
        expect(bar(null)).not.toContain('data-running-version');
    });
});

describe('where it comes from', () => {
    it('main gives the features its own version; the Shell hands it to the title bar', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/appVersion: \(\) => app\.getVersion\(\)/);
        const ipc = readFileSync('src/main/feature-ipc.ts', 'utf8');
        expect(ipc).toMatch(/version: ports\.appVersion \? ports\.appVersion\(\) : null,/);
        const shell = readFileSync('src/renderer/Shell.tsx', 'utf8');
        expect(shell).toMatch(/version=\{features\.version \?\? null\}/);
    });
});
