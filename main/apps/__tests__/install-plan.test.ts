import { describe, expect, it } from 'vitest';
import path from 'path';
import {
    ENVELOPE_MARKER,
    appCopyPlan,
    appInstallPlan,
    componentSourceDir,
    gappSourceLayout,
} from '../install-plan';
import { validateAppManifest, type AppManifest } from '../manifest';
import { parseDevSitesValue } from '../../dev-server/sites-config';

/**
 * Turning a GApp manifest into the hosting an App Workspace actually runs
 * (Tynn #250).
 *
 * This is the step that makes "automated install with preconfigured hosting"
 * true: the installer writes exactly what a person would otherwise have set up by
 * hand in the Site Manager. It emits the envelope's OWN `DevSiteConfig` shape
 * (`dev-server/sites-config.ts`) rather than a GApp-specific one, so an installed
 * app is an ordinary Genie site from that moment on — startable, restartable,
 * loggable, and visible in the Site Manager like anything else.
 *
 * Pure, so the mapping is asserted directly instead of inferred from a workspace
 * that got created somewhere.
 */

/** The App Workspace the installer has just created for this GApp. */
const WS = 'ws-app-1';

const manifest = (over: Partial<AppManifest> = {}): AppManifest => {
    const result = validateAppManifest({
        id: 'com.example.trader',
        slug: 'trader',
        name: 'Example Trader',
        version: '1.0.0',
        frontend: { repo: 'desktop', serve: { mode: 'static', root: 'dist' } },
        permissions: { scope: 'self' },
        ...over,
    });
    if (!result.ok) throw new Error(`fixture invalid: ${result.errors.join('; ')}`);
    return result.value;
};

describe('the front end', () => {
    it('becomes a host-native site at <slug>.gen', () => {
        const plan = appInstallPlan(WS, manifest());

        expect(plan.site.name).toBe('trader');
        expect(plan.site.genName).toBe('trader.gen');
        // Host-native, not a container: a GApp runs against live source on the
        // host, which is the model the real apps already use.
        expect(plan.site.runMode).toBe('host');
        expect(plan.site.kind).toBe('http');
        expect(plan.site.enabled).toBe(true);
    });

    it('carries the repo through as a repo-relative root', () => {
        const plan = appInstallPlan(WS, manifest());
        expect(plan.site.repo).toBe('desktop');
        expect(plan.site.hostServe).toEqual({ mode: 'static', root: 'dist' });
    });

    it('serves the workspace root when the manifest names no repo', () => {
        const plan = appInstallPlan(
            WS,
            manifest({ frontend: { serve: { mode: 'static', root: 'dist' } } }),
        );
        // '' is the envelope's own spelling for "the workspace root".
        expect(plan.site.repo).toBe('');
    });

    it('keeps the SPA flag, so deep links and refreshes resolve', () => {
        const plan = appInstallPlan(
            WS,
            manifest({ frontend: { repo: 'app', serve: { mode: 'static', root: 'dist', spa: true } } }),
        );
        expect(plan.site.hostServe).toEqual({ mode: 'static', root: 'dist', spa: true });
    });

    it('points at an ALREADY-RUNNING dev server without generating a serve config', () => {
        // The Ripple Effect's shape. Genie fronts a port it did not start, so
        // there is no hostServe block at all — a generated one would be config for
        // a server Genie is not running.
        const plan = appInstallPlan(
            WS,
            manifest({ frontend: { repo: 'app', serve: { mode: 'proxy', hostPort: 5273 } } }),
        );

        expect(plan.site.hostPort).toBe(5273);
        expect(plan.site.hostServe).toBeUndefined();
    });

    it('does NOT expose the app to a real browser unless it asked', () => {
        // Reaching a real Chrome/Edge installs a certificate, edits the hosts file
        // and runs a local proxy. That is a one-time admin prompt, so it is never
        // a side effect of installing an app.
        expect(appInstallPlan(WS, manifest()).site.browserExposed).toBeUndefined();

        const exposed = appInstallPlan(
            WS,
            manifest({
                frontend: { repo: 'd', serve: { mode: 'static', root: 'dist' }, browserExposed: true },
            }),
        );
        expect(exposed.site.browserExposed).toBe(true);
    });
});

describe('backend services', () => {
    it('become supervised processes, with their argv intact', () => {
        // ORR's backend is uvicorn. The argv is passed through verbatim — Genie
        // makes no assumption about the language or the runner.
        const plan = appInstallPlan(
            WS,
            manifest({
                services: [
                    { name: 'api', repo: 'backend', command: ['uvicorn', 'app:api'], port: 8000 },
                ],
            }),
        );

        expect(plan.processes).toHaveLength(1);
        expect(plan.processes[0]).toMatchObject({
            label: 'api',
            command: ['uvicorn', 'app:api'],
            cwd: 'repos/backend',
        });
    });

    it('plans no processes when the app has no backend', () => {
        expect(appInstallPlan(WS, manifest()).processes).toEqual([]);
    });

    it('runs a service from the workspace root when it names no repo', () => {
        const plan = appInstallPlan(
            WS,
            manifest({ services: [{ name: 'worker', command: ['node', 'worker.js'] }] }),
        );
        expect(plan.processes[0]?.cwd).toBe('');
    });
});

describe('the site id', () => {
    it('is stable for the same app, so reinstalling does not orphan the old site', () => {
        expect(appInstallPlan(WS, manifest()).siteId).toBe(appInstallPlan(WS, manifest()).siteId);
    });

    it('differs between apps', () => {
        expect(appInstallPlan(WS, manifest()).siteId).not.toBe(
            appInstallPlan(WS, manifest({ id: 'com.example.other', slug: 'other' })).siteId,
        );
    });
});

describe('the plan survives the envelope, not just our own types', () => {
    it('every generated site is accepted by the envelope sanitizer, unchanged', () => {
        // The strongest check available here. project.json is UNTRUSTED and
        // AUTHORITATIVE, so every row Genie reads back goes through
        // `parseDevSitesValue`, which silently DROPS a row it cannot use — that is
        // how genie#190 erased live registrations. A plan that merely satisfies our
        // own TypeScript would install an app whose site vanishes on the next read.
        //
        // So assert the round trip on every shape the manifest can produce.
        const shapes = [
            manifest(),
            manifest({ frontend: { serve: { mode: 'static', root: 'dist', spa: true } } }),
            manifest({ frontend: { repo: 'app', serve: { mode: 'proxy', hostPort: 5273 } } }),
            manifest({
                frontend: { repo: 'd', serve: { mode: 'static', root: 'dist' }, browserExposed: true },
            }),
        ];

        for (const m of shapes) {
            const plan = appInstallPlan(WS, m);
            const parsed = parseDevSitesValue({ [plan.siteId]: plan.site });

            expect(parsed, `${m.slug} must parse as a sites map`).not.toBeNull();
            expect(
                Object.keys(parsed ?? {}),
                `${m.slug}: the row must SURVIVE, not be dropped`,
            ).toEqual([plan.siteId]);
            // And survive intact — a silently rewritten row is a site that does
            // not serve what the manifest asked for.
            expect(parsed?.[plan.siteId]).toEqual(plan.site);
        }
    });
});

/**
 * What travels with the app when it is copied into its workspace (Tynn #250).
 *
 * A GApp with named components is copied component by component — the manifest
 * says which folders are the app, and the rest of the developer's directory is
 * not. That rule is right, and it is exactly why `.agents/` has to be named here:
 * it is ENVELOPE-owned, so it is in none of the components, and an app whose
 * personas were left behind would install, pass every check, and then have nothing
 * to run its declared agents from.
 */
describe('what gets copied into the workspace', () => {
    it('copies the whole folder when the app names no components', () => {
        const plan = appCopyPlan(manifest({ frontend: { serve: { mode: 'static', root: '.' } } }));
        expect(plan.wholeFolder).toBe(true);
    });

    it('copies each named component, and the manifest itself', () => {
        // The manifest travels so its DECLARED permissions stay readable after
        // install — that is the ceiling the permissions screen narrows to.
        const plan = appCopyPlan(
            manifest({
                services: [{ name: 'api', repo: 'backend', command: ['uvicorn', 'app:api'] }],
            }),
        );

        expect(plan.wholeFolder).toBe(false);
        expect(plan.components.sort()).toEqual(['backend', 'desktop']);
        expect(plan.envelopePaths).toContain('gapp.json');
    });

    it('carries `.agents/` when the app declares agents', () => {
        // `.agents/` sits beside `repos/`, so component-by-component copying misses
        // it. The failure that would cause: a valid install whose declared agents
        // have no persona on the machine to run from.
        const plan = appCopyPlan(
            manifest({ agents: [{ name: 'Reviewer', persona: 'reviewer.md' }] }),
        );

        expect(plan.envelopePaths).toContain('.agents');
    });

    it('does NOT carry `.agents/` for an app that declared none', () => {
        // Copying a folder nobody declared would smuggle discovery back in through
        // the copier: files would land on the machine that no consent screen ever
        // described.
        expect(appCopyPlan(manifest()).envelopePaths).not.toContain('.agents');
    });
});

describe('where a component sits in the SOURCE folder', () => {
    const FOLDER = 'C:/src/app';
    const has = (...present: string[]) => {
        const set = new Set(present.map((p) => path.normalize(p)));
        return (p: string) => set.has(path.normalize(p));
    };

    it('reads a folder with a project.json as the envelope it is', () => {
        // Not a folder that will BECOME an envelope on install — one that already
        // is one, which is what a GApp Development Workspace is.
        const layout = gappSourceLayout(FOLDER, has(path.join(FOLDER, ENVELOPE_MARKER)));

        expect(layout).toBe('envelope');
        expect(componentSourceDir(FOLDER, layout, 'web')).toBe(
            path.join(FOLDER, 'repos', 'web'),
        );
    });

    it('reads a folder without one as the staging folder the scaffold writes', () => {
        const layout = gappSourceLayout(FOLDER, has(path.join(FOLDER, 'web')));

        expect(layout).toBe('staging');
        expect(componentSourceDir(FOLDER, layout, 'web')).toBe(path.join(FOLDER, 'web'));
    });

    it('decides from the MARKER, not from wherever the component happens to be', () => {
        // The rule the whole fix rests on. Resolving by "try both and take what
        // exists" cannot say where a MISSING component should have been — it only
        // learns it was in neither — so the advice it produces is guesswork. Here an
        // envelope whose component sits flat still resolves to `repos/`, and the
        // developer is told the one place their layout keeps components.
        const envelopeWithStrayFlatFolder = has(
            path.join(FOLDER, ENVELOPE_MARKER),
            path.join(FOLDER, 'web'),
        );

        expect(
            componentSourceDir(FOLDER, gappSourceLayout(FOLDER, envelopeWithStrayFlatFolder), 'web'),
        ).toBe(path.join(FOLDER, 'repos', 'web'));
    });

    it('leaves a component-less app on the folder itself, in either layout', () => {
        expect(componentSourceDir(FOLDER, 'envelope', undefined)).toBe(FOLDER);
        expect(componentSourceDir(FOLDER, 'staging', undefined)).toBe(FOLDER);
    });
});
