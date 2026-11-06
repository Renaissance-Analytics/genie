import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as service from '../src/main/keyring-service.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { signedOutGithubView } from '../src/core/github.js';

/**
 * A RESTART THE PERSON SEES (Tynn story #388, the owner's visible-progress rule): when unlocking the keyring restarts a
 * Genie browser that was already running (it read "locked" at its own start), the screen says so — "Restarting Genie's
 * browser to use your unlocked keyring…", then that it did — not only the host log. No browser running: nothing is said.
 *
 * Reached loosely ON PURPOSE: before these exist the tests are red by assertion, not by an import error.
 */
type Watch = (input: {
    keyring: { state(): string; onChange(l: () => void): () => void };
    browser: { restartForKeyring(): boolean; onDown(l: () => void): () => void };
    notice: (text: string | null) => void;
    schedule?: (fn: () => void, ms: number) => void;
}) => () => void;

function rig(browserRunning: boolean) {
    let state = 'refused';
    const changed = new Set<() => void>();
    const down = new Set<() => void>();
    const notices: Array<string | null> = [];
    const later: Array<() => void> = [];
    let restarts = 0;
    const watch = (service as Record<string, unknown>)['restartBrowserOnUnlock'] as Watch | undefined;
    expect(watch, 'restartBrowserOnUnlock in keyring-service.ts').toBeTypeOf('function');
    watch!({
        keyring: { state: () => state, onChange: (l) => { changed.add(l); return () => changed.delete(l); } },
        browser: { restartForKeyring: () => { if (!browserRunning) return false; restarts += 1; return true; }, onDown: (l) => { down.add(l); return () => down.delete(l); } },
        notice: (t) => notices.push(t),
        schedule: (fn) => later.push(fn),
    });
    return {
        notices, restarts: () => restarts,
        unlock: () => { state = 'ready'; for (const l of [...changed]) l(); },
        browserGone: () => { for (const l of [...down]) l(); },
        runLater: () => { for (const fn of later.splice(0)) fn(); },
    };
}

describe('the restart is said on screen', () => {
    it('a running browser: "Restarting…", then that it restarted, then the notice clears (COUNTED: one restart)', () => {
        const r = rig(true);
        r.unlock();
        expect(r.restarts()).toBe(1);
        expect(r.notices).toEqual(['Restarting Genie’s browser to use your unlocked keyring…']);
        r.browserGone();
        expect(r.notices.at(-1)).toBe('Genie’s browser restarted with your unlocked keyring.');
        r.runLater();
        expect(r.notices.at(-1)).toBeNull();
    });

    it('CONTROL: no browser running — no restart, nothing said', () => {
        const r = rig(false);
        r.unlock();
        expect(r.restarts()).toBe(0);
        expect(r.notices).toEqual([]);
    });
});

const integrations = (keyringNotice: string | null): NonNullable<FeatureData['integrations']> => ({
    tynnSignedIn: false,
    tynn: { host: 'https://tynn.ai', user: null, signInUrl: null, message: null },
    github: signedOutGithubView(null),
    gated: [],
    lastSync: null,
    mcp: { url: null, verified: null },
    keyring: null,
    keyringNotice,
} as unknown as NonNullable<FeatureData['integrations']>);
const page = (notice: string | null) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote: null, integrations: integrations(notice) }} onAction={() => {}} onNavigate={() => {}} section="tynn" workspaces={[]} />);

describe('the notice, drawn', () => {
    it('shown where the keyring card is, as a status (control: none when there is no notice)', () => {
        const html = page('Restarting Genie’s browser to use your unlocked keyring…');
        expect(html).toMatch(/data-keyring-notice=""[^>]*>Restarting Genie’s browser to use your unlocked keyring…</);
        expect(html).toMatch(/data-keyring-notice=""[^>]*role="status"|role="status"[^>]*data-keyring-notice=""/);
        expect(page(null)).not.toContain('data-keyring-notice');
    });
});
