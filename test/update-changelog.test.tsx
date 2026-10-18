import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { releaseNotesText } from '../src/core/whats-new.js';
import { updateChip } from '../src/core/update-chip.js';
import { UpdateHost, type UpdaterPort } from '../src/main/updater.js';
import { UpdateNotes } from '../src/renderer/components/TitleBar.js';

/**
 * WHAT AN UPDATE BRINGS, BEFORE YOU TAKE IT (Tynn #762; Genie 1's changelog popover on its upgrade pill). The update chip
 * in the title bar shows, on hover, the OFFERED version's "What's new" — the release's own notes, which electron-updater
 * hands over with the check; only that section, as What's New does. No notes, no popover.
 */
const BODY = `# Genie 2.0.0-beta.32\n\n## What's new\n\n- The tray offers Task Manager.\n\n## Migration\n\nInstalls in place.\n`;

describe('the notes electron-updater hands over', () => {
    it('a string is the release body; a list is per version — this version’s note; nothing is null', () => {
        expect(releaseNotesText(BODY, '2.0.0-beta.32')).toBe(BODY);
        expect(releaseNotesText([{ version: '2.0.0-beta.31', note: 'old' }, { version: '2.0.0-beta.32', note: BODY }], '2.0.0-beta.32')).toBe(BODY);
        expect(releaseNotesText(null, '2.0.0-beta.32')).toBeNull();
        expect(releaseNotesText([{ version: '2.0.0-beta.31', note: 'old' }], '2.0.0-beta.32')).toBeNull();
    });
});

describe('the update host keeps them, through the download', () => {
    const fake = (answer: { version: string; notes?: string | null } | null) => {
        let finish: (() => void) | null = null;
        const port: UpdaterPort = {
            configure: () => {},
            check: async () => answer,
            download: () => new Promise<void>((resolve) => { finish = resolve; }),
            quitAndInstall: () => {},
        };
        return { port, finish: () => finish?.() };
    };
    const host = (port: UpdaterPort) => new UpdateHost({ port, installDir: '/opt/genie', ownPid: 1, processes: () => [], kill: () => true, clock: () => 1, caseInsensitive: false, defer: () => {} });

    it('available: the offered version’s What’s new only; downloading and ready keep it', async () => {
        const f = fake({ version: '2.0.0-beta.32', notes: BODY });
        const h = host(f.port);
        const found = await h.check();
        expect(found.notes).toBe('- The tray offers Task Manager.');
        const done = h.download();
        expect(h.state().notes).toBe('- The tray offers Task Manager.');
        f.finish();
        await done;
        expect(h.state()).toMatchObject({ phase: 'downloaded', notes: '- The tray offers Task Manager.' });
    });

    it('CONTROL: no notes, or notes with no What’s new, carry none', async () => {
        expect((await host(fake({ version: '2.0.0-beta.32' }).port).check()).notes ?? null).toBeNull();
        expect((await host(fake({ version: '2.0.0-beta.32', notes: '# x\n\n## Migration\n\nonly\n' }).port).check()).notes ?? null).toBeNull();
    });
});

describe('the chip and its popover', () => {
    it('the chip carries the notes while there is an update; none, none', () => {
        expect(updateChip({ phase: 'available', version: '2.0.0-beta.32', percent: null, notes: '- x' })?.notes).toBe('- x');
        expect(updateChip({ phase: 'downloaded', version: '2.0.0-beta.32', percent: 100, notes: '- x' })?.notes).toBe('- x');
        expect(updateChip({ phase: 'available', version: '2.0.0-beta.32', percent: null })?.notes ?? null).toBeNull();
    });

    it('the popover: what the version brings, rendered', () => {
        const html = renderToStaticMarkup(<UpdateNotes version="2.0.0-beta.32" notes="- The tray offers **Task Manager**." />);
        expect(html).toContain('data-update-notes="2.0.0-beta.32"');
        expect(html).toMatch(/What’s new in Genie 2\.0\.0-beta\.32/);
        expect(html).toMatch(/Task Manager/);
    });

    it('the title bar puts the chip in a hover popover only when there are notes', () => {
        const bar = readFileSync('src/renderer/components/TitleBar.tsx', 'utf8');
        expect(bar).toMatch(/update\.notes \? \(\s*<Popover hover placement="bottom">/);
        expect(bar).toMatch(/<UpdateNotes version=\{update\.version\} notes=\{update\.notes\} \/>/);
    });

    it('the real updater port hands the release notes over', () => {
        const port = readFileSync('src/main/electron-updater-port.ts', 'utf8');
        expect(port).toMatch(/return \{ version: result\.updateInfo\.version, notes: releaseNotesText\(result\.updateInfo\.releaseNotes, result\.updateInfo\.version\) \};/);
    });
});
