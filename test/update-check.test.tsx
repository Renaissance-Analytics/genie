import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { canCheckNow, updateStatusLine } from '../src/core/update-status.js';
import { AUTO_CHECK } from '../src/main/updater.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';
import type { UpdateState } from '../src/renderer/bridge.js';

/**
 * CHECK FOR UPDATES, WHERE YOU CAN FIND IT. The owner, 2026-10-13: "where even is the check for
 * updates button? And it should not be every 4 hours, that is too long." There was no control —
 * only `updates.check` over IPC and the remote bridge — and the automatic check ran every four
 * hours. Now: Settings → General leads with an Updates block (status line + "Check for updates"),
 * the tray has the same verb, and the automatic check runs every half hour. Nothing downloads by
 * itself (unchanged).
 */
vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() }, Tray: vi.fn(), nativeImage: { createFromBuffer: vi.fn() } }));

const clock = (ms: number) => `T${ms}`;
const st = (over: Partial<UpdateState>): UpdateState => ({ phase: 'idle', version: null, percent: null, error: null, checkedAt: null, ...over });

describe('updateStatusLine', () => {
    it('never asked: null and idle-without-checkedAt both say "Not checked yet"', () => {
        expect(updateStatusLine(null, clock)).toBe('Not checked yet');
        expect(updateStatusLine(st({ phase: 'idle' }), clock)).toBe('Not checked yet');
    });

    it('idle or none with a checkedAt is up to date, naming when — through the clock it was given', () => {
        expect(updateStatusLine(st({ phase: 'idle', checkedAt: 42 }), clock)).toBe('Up to date — checked T42');
        expect(updateStatusLine(st({ phase: 'none', checkedAt: 7 }), clock)).toBe('Up to date — checked T7');
    });

    it('each live phase reads as itself', () => {
        expect(updateStatusLine(st({ phase: 'checking' }), clock)).toBe('Checking for updates…');
        expect(updateStatusLine(st({ phase: 'available', version: '2.0.0-beta.21' }), clock)).toBe('Genie 2.0.0-beta.21 is available');
        expect(updateStatusLine(st({ phase: 'downloading', version: '2.0.0-beta.21', percent: 41.6 }), clock)).toBe('Downloading Genie 2.0.0-beta.21 42%');
        expect(updateStatusLine(st({ phase: 'downloading', version: '2.0.0-beta.21', percent: null }), clock)).toBe('Downloading Genie 2.0.0-beta.21');
        expect(updateStatusLine(st({ phase: 'downloaded', version: '2.0.0-beta.21' }), clock)).toBe('Genie 2.0.0-beta.21 is ready — restart to install');
        expect(updateStatusLine(st({ phase: 'installing', version: '2.0.0-beta.21' }), clock)).toBe('Installing Genie 2.0.0-beta.21…');
    });

    it('an error says it could not check, with the reason or "unknown error"', () => {
        expect(updateStatusLine(st({ phase: 'error', error: 'feed unreachable' }), clock)).toBe('Could not check: feed unreachable');
        expect(updateStatusLine(st({ phase: 'error', error: null }), clock)).toBe('Could not check: unknown error');
    });
});

describe('canCheckNow', () => {
    it('refuses only while checking, downloading or installing', () => {
        const phases: UpdateState['phase'][] = ['idle', 'checking', 'none', 'available', 'downloading', 'downloaded', 'installing', 'error'];
        expect(phases.filter(canCheckNow)).toEqual(['idle', 'none', 'available', 'downloaded', 'error']);
    });
});

describe('the automatic check', () => {
    it('runs every half hour, not every four hours', () => {
        expect(AUTO_CHECK.intervalMs).toBe(30 * 60 * 1000);
    });
});

const render = (update?: { state: UpdateState | null; onCheck: () => void }) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} } }} onAction={() => {}} onNavigate={() => {}} group="general" {...(update ? { update } : {})} />);

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('Settings → General: Updates', () => {
    it('shows ONE "Check for updates" button and the status line when the window has an updates bridge', () => {
        const html = render({ state: st({ phase: 'none', checkedAt: 0 }), onCheck: () => {} });
        expect(count(html, 'data-action="update-check"')).toBe(1);
        expect(html).toContain('data-update-status');
        expect(html).toMatch(/Up to date — checked /);
        expect(html).toContain('Check for updates');
        expect(html).not.toMatch(/data-action="update-check"[^>]*disabled/);
    });

    it('the block comes before the General settings rows', () => {
        const html = render({ state: null, onCheck: () => {} });
        expect(html).toContain('Not checked yet');
        expect(html.indexOf('data-action="update-check"')).toBeLessThan(html.indexOf('data-setting="'));
    });

    it('while checking the button is disabled and says "Checking…"', () => {
        const html = render({ state: st({ phase: 'checking' }), onCheck: () => {} });
        const button = html.slice(html.lastIndexOf('<button', html.indexOf('data-action="update-check"')), html.indexOf('</button>', html.indexOf('data-action="update-check"')));
        expect(button).toMatch(/disabled=""/);
        expect(button).toContain('Checking…');
        expect(button).not.toContain('Check for updates');
    });

    it('CONTROL: without an updates bridge there is no update-check control at all', () => {
        const html = render(undefined);
        expect(html).toContain('data-setting="');
        expect(count(html, 'data-action="update-check"')).toBe(0);
        expect(html).not.toContain('data-update-status');
    });
});

describe('tray', () => {
    it('offers "Check for updates" between Settings and Quit, wired to onCheckUpdates alone', async () => {
        const { trayMenuTemplate } = await import('../src/main/tray.js');
        const onOpen = vi.fn();
        const onSettings = vi.fn();
        const onCheckUpdates = vi.fn();
        const onQuit = vi.fn();
        const menu = trayMenuTemplate({ onOpen, onSettings, onCheckUpdates, onQuit });
        expect(menu.map((m) => m.label)).toEqual(['Open Genie', 'Settings…', 'Check for updates', 'Quit Genie']);
        menu[2]!.click!();
        expect(onCheckUpdates).toHaveBeenCalledTimes(1);
        expect(onOpen).not.toHaveBeenCalled();
        expect(onSettings).not.toHaveBeenCalled();
        expect(onQuit).not.toHaveBeenCalled();
    });
});
