import { beforeEach, describe, expect, it, vi } from 'vitest';
import { closePreview, openPreview, permissionsFingerprint, sweepPreviewWorkspaces } from '../preview-run';
import { forgetPreview, listPreviews, livePreview } from '../preview-registry';
import { PREVIEW_APP_KIND } from '../preview';
import type { PreviewIO } from '../preview-run';

const MANIFEST = {
    id: 'com.example.trader',
    slug: 'trader',
    name: 'Example Trader',
    version: '1.0.0',
    frontend: { repo: 'web', serve: { mode: 'static', root: 'dist' } },
    permissions: { scope: 'self', capabilities: ['hosting'] },
};

/**
 * A preview's whole world, faked.
 *
 * Same shape as the install harness and for the same reason: the assertions that
 * matter here are about calls that must NOT happen — no workspace when consent is
 * refused, no `removeWorkspace` on a row this preview does not own — and a call
 * that did not happen is only assertable if the call is visible.
 */
function io(over: Partial<PreviewIO> = {}): PreviewIO & {
    workspaces: Map<string, { id: string; app_kind: string | null; path: string }>;
    panels: string[];
    sites: Record<string, unknown>;
    windows: unknown[];
} {
    const workspaces = new Map<string, { id: string; app_kind: string | null; path: string }>();
    const panels: string[] = [];
    const sites: Record<string, unknown> = {};
    const windows: unknown[] = [];
    let next = 0;

    const base: PreviewIO = {
        readManifest: () => JSON.stringify(MANIFEST),
        exists: () => true,
        machine: async () => ({ installed: new Set<string>(), canInstall: () => true }),
        ask: async (questions) => ({
            cancelled: false,
            answers: questions.map((q) => ({
                header: q.header,
                question: '',
                selected: [q.options[0]!.label],
                note: '',
            })),
        }),
        rememberedConsent: () => null,
        recordConsent: () => {},
        createWorkspace: (input) => {
            const id = `preview-ws-${++next}`;
            workspaces.set(id, { id, app_kind: PREVIEW_APP_KIND, path: input.path });
            return { workspaceId: id };
        },
        workspaceRow: (id) => workspaces.get(id) ?? null,
        removeWorkspace: (id) => {
            workspaces.delete(id);
        },
        listWorkspaceRows: () => [...workspaces.values()],
        countPanels: () => panels.length,
        createPanel: (_appId, _ws, panel) => {
            panels.push(panel.label);
        },
        // A preview starts REAL agents, so it meets the real cap. Allowed here so
        // no assertion in this file turns on the limit — that is covered where the
        // cap lives (panels.test.ts + gapp-agents-launch.test.ts).
        mayStartAgents: () => ({ allowed: true }),
        removePanels: () => {
            panels.length = 0;
        },
        panelsChanged: () => {},
        persistSites: (ws, s) => {
            sites[ws] = s;
        },
        startSite: async () => ({ ok: true }),
        stopSite: async () => {},
        clearStorage: async () => {},
        openWindow: (opts) => {
            windows.push(opts);
        },
        closeWindow: () => {},
    };

    return Object.assign(base, over, { workspaces, panels, sites, windows });
}

beforeEach(() => {
    for (const live of listPreviews()) forgetPreview(live.identity.appId);
});

describe('opening a preview', () => {
    it('refuses a folder that is not a Genie App, and creates nothing', async () => {
        const deps = io({ readManifest: () => null });

        const result = await openPreview('C:/dev/nothing', deps);

        expect(result.ok).toBe(false);
        expect(result.errors?.[0]).toMatch(/not a Genie App/i);
        expect(deps.workspaces.size).toBe(0);
        expect(deps.windows).toEqual([]);
    });

    it('refuses a manifest that would not install either', async () => {
        const deps = io({ readManifest: () => JSON.stringify({ ...MANIFEST, slug: 'NOT A SLUG' }) });

        const result = await openPreview('C:/dev/trader', deps);

        expect(result.ok).toBe(false);
        expect(deps.workspaces.size).toBe(0);
    });

    it('refuses a front end that has not been built', async () => {
        // The check exists and previewing is exactly when it earns its keep: an
        // unbuilt `dist` serves a blank page, and a blank page in a real-looking
        // window is the single most misleading thing a previewer could show.
        const deps = io({ exists: (p) => !p.includes('dist') });

        const result = await openPreview('C:/dev/trader', deps);

        expect(result.ok).toBe(false);
        expect(result.errors?.join(' ')).toMatch(/dist/);
        expect(deps.windows).toEqual([]);
    });

    it('previews an app that is already installed at that slug', async () => {
        // The folder check calls an app's own address taken when another app holds
        // it. A preview is not claiming that address — it serves at
        // `<slug>.preview.gen` — so treating a collision as an error here would
        // make "preview the app I have installed" impossible, which is the single
        // most likely thing a developer wants to do.
        const deps = io();

        const result = await openPreview('C:/dev/trader', deps);

        expect(result.ok).toBe(true);
        expect(result.homeUrl).toBe('https://trader.preview.gen/');
    });

    it('creates absolutely nothing when the modal is dismissed', async () => {
        const deps = io({ ask: async () => ({ cancelled: true, answers: [] }) });

        const result = await openPreview('C:/dev/trader', deps);

        expect(result.ok).toBe(false);
        expect(deps.workspaces.size).toBe(0);
        expect(deps.panels).toEqual([]);
        expect(deps.sites).toEqual({});
        expect(deps.windows).toEqual([]);
        expect(listPreviews()).toEqual([]);
    });

    it('opens the window on the PREVIEW manifest, so every derived surface follows', async () => {
        const deps = io();

        await openPreview('C:/dev/trader', deps);

        const opened = deps.windows[0] as { appId: string; slug: string; manifest: { id: string } };
        expect(opened.appId).toBe('com.example.trader~preview');
        expect(opened.slug).toBe('trader.preview');
        expect(opened.manifest.id).toBe('com.example.trader~preview');
    });

    it('lays out the agent panels the manifest declared', async () => {
        // THE headline requirement. `panels.agents` has been validated and bounded
        // since the manifest work and carried into the tab model, and an app
        // declaring three panels still got one. A previewer that inherited that
        // would be showing developers a window their users do not get.
        const deps = io({
            readManifest: () =>
                JSON.stringify({ ...MANIFEST, panels: { agents: 3, kinds: ['terminal', 'files'] } }),
        });

        await openPreview('C:/dev/trader', deps);

        expect(deps.panels).toEqual(['Terminal', 'Files', 'Terminal']);
    });

    it('marks its workspace as a preview so teardown can recognise it', async () => {
        const deps = io();

        const result = await openPreview('C:/dev/trader', deps);

        const row = deps.workspaces.get(result.workspaceId!);
        expect(row?.app_kind).toBe(PREVIEW_APP_KIND);
        // On the developer's OWN folder — a preview shows live source, never a copy.
        expect(row?.path).toBe('C:/dev/trader');
    });

    it('opens the window even when the site will not come up', async () => {
        // The Agent tab is Genie's own and needs no hosting at all, so a machine
        // with no dev-server stack still gets the half of the window this feature
        // exists for. Reported as a warning rather than swallowed: an app tab
        // showing nothing, with no explanation, reads as a bug in the app.
        const deps = io({ startSite: async () => ({ ok: false, error: 'no caddy here' }) });

        const result = await openPreview('C:/dev/trader', deps);

        expect(result.ok).toBe(true);
        expect(deps.windows).toHaveLength(1);
        expect(result.warnings?.join(' ')).toMatch(/no caddy here/);
    });

    it('tears the previous preview down before opening another', async () => {
        const deps = io();

        const first = await openPreview('C:/dev/trader', deps);
        const second = await openPreview('C:/dev/trader', deps);

        expect(second.workspaceId).not.toBe(first.workspaceId);
        // The first preview's throwaway workspace must not survive the second.
        expect(deps.workspaces.has(first.workspaceId!)).toBe(false);
        expect(listPreviews()).toHaveLength(1);
    });
});

describe('remembering the answer', () => {
    it('asks again when the app changed what it asks FOR', async () => {
        // The whole reason to remember an answer is that re-asking on every preview
        // is friction on the loop this feature exists to speed up. The whole reason
        // to forget one is that a changed permission set is exactly when the screen
        // has something new to say — which is also the moment a developer most
        // wants to see how their own ask reads.
        const wider = { ...MANIFEST, permissions: { scope: 'self', capabilities: ['terminals'] } };

        expect(permissionsFingerprint(MANIFEST as never)).not.toBe(
            permissionsFingerprint(wider as never),
        );
    });

    it('does not care about the order capabilities were written in', async () => {
        const a = { ...MANIFEST, permissions: { scope: 'self', capabilities: ['hosting', 'terminals'] } };
        const b = { ...MANIFEST, permissions: { scope: 'self', capabilities: ['terminals', 'hosting'] } };

        expect(permissionsFingerprint(a as never)).toBe(permissionsFingerprint(b as never));
    });

    it('skips the modal when the same folder asks for the same things', async () => {
        const ask = vi.fn(async () => ({ cancelled: true, answers: [] }));
        const deps = io({
            ask,
            rememberedConsent: () => ({
                fingerprint: permissionsFingerprint(MANIFEST as never),
                consent: { scope: 'self', capabilities: ['hosting'] },
            }),
        });

        const result = await openPreview('C:/dev/trader', deps);

        expect(ask).not.toHaveBeenCalled();
        expect(result.ok).toBe(true);
        expect(livePreview('com.example.trader~preview')?.grant.capabilities).toEqual(['hosting']);
    });

    it('asks anyway when what the app wants has moved on', async () => {
        const ask = vi.fn(async () => ({ cancelled: true, answers: [] }));
        const deps = io({
            ask,
            rememberedConsent: () => ({
                fingerprint: 'from-an-older-manifest',
                consent: { scope: 'self', capabilities: ['hosting'] },
            }),
        });

        await openPreview('C:/dev/trader', deps);

        expect(ask).toHaveBeenCalled();
    });
});

describe('closing a preview', () => {
    it('removes everything it made, in an order that can succeed', async () => {
        const deps = io();
        const stopSite = vi.fn(async () => {});
        const clearStorage = vi.fn(async () => {});
        Object.assign(deps, { stopSite, clearStorage });

        const opened = await openPreview('C:/dev/trader', deps);
        await closePreview('com.example.trader~preview', deps);

        // The site first: stopping it reads the workspace's own site config, and a
        // deleted row cannot answer. Same ordering the workspace-remove IPC uses.
        expect(stopSite).toHaveBeenCalled();
        expect(deps.panels).toEqual([]);
        expect(deps.workspaces.has(opened.workspaceId!)).toBe(false);
        // A preview leaves no cookies behind either — the partition is its own, so
        // clearing it cannot touch an installed copy's.
        expect(clearStorage).toHaveBeenCalledWith('com.example.trader~preview');
        expect(listPreviews()).toEqual([]);
    });

    it('will not delete a workspace that is not the preview’s', async () => {
        // The failure this guards against would be catastrophic and silent: a
        // preview runs ON the developer's folder, and Genie may already hold a real
        // workspace row for that same directory. Closing a preview window must
        // never be able to delete their project.
        const deps = io();
        const opened = await openPreview('C:/dev/trader', deps);

        // Something else took the mark off — a reused id, a hand-edited row.
        deps.workspaces.set(opened.workspaceId!, {
            id: opened.workspaceId!,
            app_kind: null,
            path: 'C:/dev/trader',
        });

        await closePreview('com.example.trader~preview', deps);

        expect(deps.workspaces.has(opened.workspaceId!)).toBe(true);
        // Still forgotten: the preview is over either way, and leaving it in the
        // registry would keep a dead window's grant answering for the app.
        expect(listPreviews()).toEqual([]);
    });

    it('is silent about an app that is not being previewed', async () => {
        const deps = io();
        await expect(closePreview('com.example.ghost~preview', deps)).resolves.toBeUndefined();
    });
});

describe('sweeping after a crash', () => {
    it('removes preview workspaces that outlived the process', async () => {
        const deps = io();
        deps.workspaces.set('left-behind', {
            id: 'left-behind',
            app_kind: PREVIEW_APP_KIND,
            path: 'C:/dev/trader',
        });
        deps.workspaces.set('real', { id: 'real', app_kind: null, path: 'C:/dev/other' });
        deps.workspaces.set('installed', { id: 'installed', app_kind: 'app', path: 'C:/apps/x' });

        sweepPreviewWorkspaces(deps);

        expect(deps.workspaces.has('left-behind')).toBe(false);
        expect(deps.workspaces.has('real')).toBe(true);
        expect(deps.workspaces.has('installed')).toBe(true);
    });
});

describe('a closing window’s teardown is scoped to ITS preview', () => {
    it('a stale close callback cannot destroy the preview that replaced it', async () => {
        /**
         * A real race, and a nasty one.
         *
         * Re-previewing tears the previous preview down first — which asks Electron
         * to close its window. `closed` fires ASYNCHRONOUSLY, and `openPreview`
         * awaits the site start in between, so the old window's teardown callback
         * routinely runs AFTER the new preview has been registered under the same
         * app id. Unscoped, it would find the new preview and dismantle it: the
         * developer presses preview, the window appears, and its panels and
         * workspace vanish underneath it for no visible reason.
         */
        const deps = io();

        const first = await openPreview('C:/dev/trader', deps);
        const second = await openPreview('C:/dev/trader', deps);

        // The first window's `closed` finally fires, long after its preview was
        // replaced. It names the workspace IT opened.
        await closePreview('com.example.trader~preview', deps, first.workspaceId);

        expect(listPreviews()).toHaveLength(1);
        expect(livePreview('com.example.trader~preview')?.workspaceId).toBe(second.workspaceId);
        expect(deps.workspaces.has(second.workspaceId!)).toBe(true);
        expect(deps.panels.length).toBeGreaterThan(0);
    });

    it('still tears down when the callback names the preview that IS live', async () => {
        const deps = io();
        const opened = await openPreview('C:/dev/trader', deps);

        await closePreview('com.example.trader~preview', deps, opened.workspaceId);

        expect(listPreviews()).toEqual([]);
        expect(deps.workspaces.has(opened.workspaceId!)).toBe(false);
    });
});
