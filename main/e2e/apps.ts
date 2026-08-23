/**
 * Genie Apps E2E harness — the window a GApp actually gets (Tynn #250).
 *
 * WHY THIS EXISTS
 * ---------------
 * The unit suite proves the DECISIONS: what the window options are, which
 * navigations are allowed, which calls are refused. What it structurally cannot
 * prove is that a real Electron window built from those options behaves the way
 * the options claim — and the single most important property of this whole
 * feature is a negative: **`window.genie` is ABSENT inside a GApp's page.**
 *
 * A negative like that cannot be established by reading code. Genie's own preload
 * is one path string away, `contextIsolation` is one boolean away, and either
 * mistake would leave the unit tests entirely green while handing a third-party
 * page the whole desktop API. So this opens the REAL window, with the REAL
 * preload, over the REAL bridge, and lets a spec ask the page what it can see.
 *
 * HOW IT'S WIRED
 * --------------
 * Under `GENIE_E2E=1` only. It serves the SHIPPED example app's front end
 * (`apps/example/web`) from loopback and opens a window on it, so the page under
 * test is the same code the reference app ships rather than a fixture written to
 * pass. A grant row goes into the real sqlite, so `me()` and every refusal travel
 * the production path: preload → IPC → window registry → `decideAppCall`.
 *
 * The grant is deliberately PARTIAL — `hosting` granted, `terminals` declared and
 * withheld — because "an ungranted call is refused, in words" is the other half of
 * the security claim and needs a real refusal to observe.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { deleteTerminalSpec, getWorkspace, listTerminalSpecs, upsertAppGrant } from '../db';
import { killTerminalById } from '../terminal/ipc';
import { openAppWindow, appViewWebContents } from '../apps/window';
import { scaffoldApp, slugify } from '../apps/scaffold';
import { validateAppFolder, type AppFolderReport } from '../apps/validate';
import { installAppFromFolder, type AppInstallResult } from '../apps/install';
import { ensureAppAgentPanels, installIO, previewIO } from '../apps/ipc';
import { closePreview, openPreview } from '../apps/preview-run';
import { livePreview } from '../apps/preview-registry';
import { appsList } from '../apps/manage';
import {
    APP_AGENTS_DIR,
    APP_MANIFEST_FILENAME,
    validateAppManifest,
    type AppAgentDecl,
    type AppPanels,
} from '../apps/manifest';

const APP_ID = 'com.genie.example';

/** Serve the example app's front end on loopback, on whatever port is free. */
async function serveExample(root: string): Promise<string> {
    const server = http.createServer((req, res) => {
        const rel = (req.url ?? '/').split('?')[0];
        const file = path.join(root, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
        // Never serve outside the root. This is a test harness, but a path
        // traversal here would be one in the shape the real static server has.
        if (!file.startsWith(root) || !fs.existsSync(file)) {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.end(fs.readFileSync(file));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}/`;
}

/**
 * Where the example app's front end lives at runtime.
 *
 * `__dirname` is the compiled main bundle (`app/`), so the repo's `apps/example`
 * sits two levels up. Tried in order rather than assumed, because a spec that
 * fails with "cannot find index.html" is far easier to act on than one that
 * silently serves a 404 page and reports "no genieApp".
 */
function exampleWebRoot(): string {
    const candidates = [
        path.join(__dirname, '..', 'apps', 'example', 'web'),
        path.join(__dirname, '..', '..', 'apps', 'example', 'web'),
        path.join(process.cwd(), 'apps', 'example', 'web'),
    ];
    const found = candidates.find((c) => fs.existsSync(path.join(c, 'index.html')));
    if (!found) {
        throw new Error(
            `Genie Apps E2E: no example front end found. Looked in:\n${candidates.join('\n')}`,
        );
    }
    return path.resolve(found);
}

export function registerAppsE2E(): void {
    (globalThis as Record<string, unknown>).__GENIE_E2E_APPS__ = {
        /**
         * Install a partial grant for the shipped example app and open its window.
         * Returns the URL so the spec can assert same-origin behaviour against it.
         */
        async openExample(): Promise<{ url: string; viewId: number }> {
            const url = await serveExample(exampleWebRoot());

            upsertAppGrant({
                appId: APP_ID,
                workspaceId: 'e2e-app-ws',
                name: 'Genie App Example',
                version: '1.0.0',
                slug: 'example',
                scope: 'self',
                workspaces: [],
                // Partial ON PURPOSE: one granted, one withheld, so the spec can
                // observe both an allowed call and a real refusal.
                capabilities: ['hosting'],
                manifestJson: JSON.stringify({
                    permissions: { scope: 'self', capabilities: ['hosting', 'terminals'] },
                }),
                installPath: exampleWebRoot(),
                source: { kind: 'folder', origin: exampleWebRoot() },
                revoked: false,
                devMode: false,
            });

            // The window is GENIE'S now — its first tab is Genie's own panel
            // management, and the app lives in an embedded view. So the harness
            // hands back the APP VIEW's webContents id: that is the surface the
            // isolation claims are about, and asserting them against the shell
            // would be asserting them against the wrong thing entirely.
            const manifest = validateAppManifest({
                id: APP_ID,
                slug: 'example',
                name: 'Genie App Example',
                version: '1.0.0',
                frontend: { repo: 'web', serve: { mode: 'static', root: '.' } },
                permissions: { scope: 'self', capabilities: ['hosting'] },
                tabs: [{ title: 'Example', path: '/' }],
            });
            if (!manifest.ok) throw new Error(manifest.errors.join('; '));

            openAppWindow({
                appId: APP_ID,
                slug: 'example',
                name: 'Genie App Example',
                homeUrl: url,
                manifest: manifest.value,
            });

            const view = appViewWebContents(APP_ID)[0];
            if (!view) throw new Error('the GApp window created no app view');
            // Point it at the harness server rather than https://example.gen,
            // which has no hosting behind it on a CI box.
            await view.loadURL(url);
            return { url, viewId: view.id };
        },

        /** Run an expression INSIDE the app's embedded view and hand back the result. */
        evalInAppView: async (appId: string, expression: string) => {
            const view = appViewWebContents(appId)[0];
            if (!view) throw new Error('no app view');
            return view.executeJavaScript(expression, true);
        },

        scaffoldCheckInstall: () => scaffoldCheckInstall(),
        previewScaffolded: (panels: AppPanels) => previewScaffolded(panels),
        seedAgentPanelsTwice: (appId: string, panels: AppPanels, agents?: AppAgentDecl[]) =>
            seedAgentPanelsTwice(appId, panels, agents),
        killAppPanels: (appId: string) => killAppPanels(appId),
        // The installed-apps list, read through the SAME function the panel
        // uses. Exposed here because the compiled main is one bundle — a spec
        // cannot `require` a module out of it.
        listInstalled: () => appsList(),
    };
}

/**
 * Scaffold → check → install, over the REAL I/O chain.
 *
 * Everything the unit tests must fake — envelope creation, the file copy, the
 * project.json write, the grant row, starting the service and the site — happens
 * here for real. The ONLY substitution is the OS consent modal, which would block
 * a headless run forever; what it decides is covered exhaustively by the
 * consent-plan unit tests, and what it CANNOT cover is this: whether an install
 * actually lands on disk.
 *
 * Site and service start may well fail on a CI box with no hosting stack. That is
 * the point of asserting them as WARNINGS: the app must still be installed.
 */
export async function scaffoldCheckInstall(): Promise<{
    folder: string;
    report: AppFolderReport;
    install: AppInstallResult;
    /** Where the install actually put the app's envelope, read back from the db. */
    workspacePath: string | null;
}> {
    const name = 'Harness Thing';
    // Its own throwaway parent: an install writes a real envelope, and a spec that
    // reached into the developer's folders to do it would be a spec nobody runs
    // twice.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gapp-e2e-'));
    const folder = path.join(parent, slugify(name));
    for (const file of scaffoldApp({ name, id: 'com.genie.harness' })) {
        const target = path.join(folder, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.contents, 'utf8');
    }

    const report = validateAppFolder(folder, {
        readManifest: (dir) => {
            const file = path.join(dir, APP_MANIFEST_FILENAME);
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        },
        exists: (p) => fs.existsSync(p),
        slugTaken: () => false,
    });

    const install = await installAppFromFolder(folder, {
        ...installIO(),
        // The one substitution. Answer exactly as a user who said yes and granted
        // nothing — which is what the scaffold asks for anyway.
        ask: async () => ({
            cancelled: false,
            answers: [{ header: 'Install', question: '', selected: ['Install'], note: '' }],
        }),
    });

    // Read the workspace back out of the real database rather than reporting what
    // the installer intended: the claim under test is where the envelope LANDED.
    const workspacePath = install.workspaceId
        ? (getWorkspace(install.workspaceId)?.path ?? null)
        : null;

    return { folder, report, install, workspacePath };
}

/**
 * Lay a real app's declared panels out in its real workspace — twice.
 *
 * The unit suite proves the arithmetic against a fake workspace. What it cannot
 * reach is the half that only exists here: a real `terminal_specs` table, a real
 * workspace row, and the question of whether the SECOND open sees the first one's
 * work. That is the property the whole design turns on — a GApp's panels are
 * workspace state, so a seeder that could not see what it had already written
 * would hand somebody N more terminals every time they opened the app.
 *
 * `panels` comes from the caller so a spec can exercise a multi-panel declaration
 * without a second scaffolded app to carry one.
 */
/**
 * Tear an app's panels down — ptys included. The spec's own cleanup.
 *
 * Not housekeeping: a GApp's agent panels are REAL agent terminals with REAL
 * ptys, and Genie's default is a DETACHED pty-host that deliberately outlives the
 * app so terminals survive a restart. Every E2E spec shares one profile directory
 * (`E2E_USERDATA`) and they run serially, so ptys this spec leaves running are
 * still there — and still holding ports and MCP endpoints — while every LATER
 * spec boots its own Genie over the same profile. A spec that starts agents has
 * to stop them, or it is a landmine for whatever runs next.
 */
export function killAppPanels(appId: string): number {
    const app = appsList().find((a) => a.id === appId);
    if (!app) return 0;
    let killed = 0;
    for (const spec of listTerminalSpecs()) {
        if (spec.workspace_id !== app.workspaceId) continue;
        try {
            // Kill BEFORE delete: a pty whose spec has gone is one nothing owns.
            killTerminalById(spec.id);
            deleteTerminalSpec(spec.id);
            killed += 1;
        } catch {
            /* best-effort — one stubborn pty must not abort the sweep */
        }
    }
    return killed;
}

export function seedAgentPanelsTwice(
    appId: string,
    panels: AppPanels,
    agents?: AppAgentDecl[],
): {
    first: string[];
    second: string[];
    /** What each panel is BOUND to, in slot order — `[agent name, persona path]`
     *  for a declared agent, `null` for a plain panel (genie#245). */
    bindings: Array<[string, string] | null>;
    /** Which TUI each bound panel launched, so a spec can check the WORKSTATION
     *  provider decided it. */
    providers: Array<string | null>;
} {
    const app = appsList().find((a) => a.id === appId);
    if (!app) throw new Error(`no such installed app: ${appId}`);

    const own = () =>
        listTerminalSpecs().filter(
            (s) => s.workspace_id === app.workspaceId && s.type !== 'process',
        );
    const labels = (): string[] => own().map((s) => s.label);

    // Start from an EMPTY workspace. The seeder converges on what is already
    // there, so a spec that ran before this one would leave its panels behind and
    // this call would correctly create nothing — making the next assertion pass or
    // fail on test ORDER rather than on behaviour. The harness owns this workspace,
    // so clearing it is the honest reset; the idempotency this function exists to
    // prove is still proved, by the two seeds below.
    for (const spec of own()) {
        killTerminalById(spec.id);
        deleteTerminalSpec(spec.id);
    }

    // The personas the roster names, put where an INSTALL would have copied them
    // (`appCopyPlan` carries `.agents/` into the workspace). The scaffold ships no
    // agents of its own, and the seeder refuses a persona that is not on disk —
    // rightly, since a TUI briefed with a missing file is an agent with no
    // instructions. So the harness lays down what the roster claims.
    const workspacePath = getWorkspace(app.workspaceId)?.path;
    if (workspacePath) {
        for (const agent of agents ?? []) {
            const persona = path.join(workspacePath, APP_AGENTS_DIR, ...agent.persona.split('/'));
            fs.mkdirSync(path.dirname(persona), { recursive: true });
            fs.writeFileSync(persona, `# ${agent.name}\n`);
        }
    }

    ensureAppAgentPanels(appId, panels, agents);
    const first = labels();
    ensureAppAgentPanels(appId, panels, agents);
    const second = labels();

    return {
        first,
        second,
        bindings: own().map((s) =>
            s.meta.gapp_agent
                ? [String(s.meta.gapp_agent), String(s.meta.gapp_persona ?? '')]
                : null,
        ),
        providers: own().map((s) => s.meta.agent ?? null),
    };
}

/**
 * Open a REAL preview window over a scaffolded folder, and report what it did.
 *
 * This is the piece the unit suite structurally cannot reach. `preview-run.test.ts`
 * proves the decisions against fakes: it asserts that a manifest declaring three
 * agent panels produces three `createPanel` calls. What it cannot prove is that
 * three panels then EXIST — in a real `terminal_specs` table, in a real workspace
 * row, for a folder that was never installed. Between the decision and the rows
 * sit the database, the workspace registry and the window, and that gap is exactly
 * where "the field is validated and nothing lays it out" lived in the first place.
 *
 * So this runs the ACTUAL chain — `openPreview` over the real `previewIO()` — with
 * the OS consent modal as the ONLY substitution, the same treatment
 * `scaffoldCheckInstall` gets and for the same reason: a modal would block a
 * headless run forever, and what it decides is covered exhaustively by the
 * consent-plan unit tests.
 *
 * It reports the three claims the previewer stands or falls on:
 *   - the panels the manifest declared are really there,
 *   - NOTHING was installed,
 *   - and closing it leaves nothing behind.
 */
export async function previewScaffolded(panels: AppPanels): Promise<{
    ok: boolean;
    errors: string[];
    appId: string | null;
    /** The throwaway workspace the preview ran in, captured BEFORE teardown. */
    workspaceId: string;
    /** What `genieApp.me()` answered inside the preview's own view. */
    identity: unknown;
    /** Panel labels in the preview's workspace, in order. */
    panels: string[];
    /** Installed app ids at the moment the preview was open. */
    installedWhileOpen: string[];
    /** After closing: the workspace row, and any specs still pointing at it. */
    afterClose: { workspace: boolean; specs: number };
}> {
    const name = 'Preview Thing';
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gapp-preview-e2e-'));
    const folder = path.join(parent, slugify(name));
    for (const file of scaffoldApp({ name, id: 'com.genie.previewed' })) {
        const target = path.join(folder, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.contents, 'utf8');
    }

    // The scaffold asks for one panel. Rewrite the manifest so the spec can assert
    // a MULTI-panel declaration — the case that was broken, and the only one where
    // "it laid out what was declared" says anything.
    const manifestFile = path.join(folder, APP_MANIFEST_FILENAME);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, panels }, null, 4), 'utf8');

    const result = await openPreview(folder, {
        ...previewIO(),
        // The one substitution. Answers exactly as someone who said yes and
        // granted nothing — which is all the scaffold asks for anyway.
        ask: async (questions) => ({
            cancelled: false,
            answers: [
                {
                    header: questions[0]!.header,
                    question: '',
                    selected: [questions[0]!.options[0]!.label],
                    note: '',
                },
            ],
        }),
        // Hosting is not what this proves, and a CI box has no `.gen` stack. The
        // Agent tab is Genie's own and needs none — which is the whole reason a
        // site that will not start is a warning rather than a failure.
        startSite: async () => ({ ok: true }),
        stopSite: async () => {},
    });

    const live = result.appId ? livePreview(result.appId) : null;
    const workspaceId = live?.workspaceId ?? result.workspaceId ?? '';

    // THE BRIDGE, asked from inside the preview's own embedded view.
    //
    // A preview deliberately has no grant ROW — that is what "installs nothing"
    // means — so `me()` and `call()` answer from the live registry instead. Wiring
    // that touched two lookups (the bridge, and the MCP caller resolver), and
    // teaching one and not the other produces an app that looks alive and can do
    // nothing: `me()` answering while every call resolves to no workspace. Only
    // asking the real page can tell those apart.
    //
    // The view is pointed at loopback because `<slug>.preview.gen` has no hosting
    // behind it on a CI box — the same substitution `openExample` makes, and for
    // the same reason. What is under test is the bridge, not the address.
    let identity: unknown = null;
    if (result.appId) {
        const view = appViewWebContents(result.appId)[0];
        if (view) {
            await view.loadURL(await serveExample(path.join(folder, 'web')));
            identity = await view.executeJavaScript(
                'window.genieApp ? window.genieApp.me() : null',
                true,
            );
        }
    }
    const labels = listTerminalSpecs()
        .filter((s) => s.workspace_id === workspaceId && s.type !== 'process')
        .map((s) => s.label);
    const installedWhileOpen = appsList().map((a) => a.id);

    if (result.appId) {
        await closePreview(result.appId, { ...previewIO(), stopSite: async () => {} });
    }

    return {
        ok: result.ok,
        errors: result.errors ?? [],
        appId: result.appId ?? null,
        workspaceId,
        identity,
        panels: labels,
        installedWhileOpen,
        afterClose: {
            workspace: Boolean(workspaceId && getWorkspace(workspaceId)),
            specs: listTerminalSpecs().filter((s) => s.workspace_id === workspaceId).length,
        },
    };
}
