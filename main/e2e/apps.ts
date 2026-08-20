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
import { upsertAppGrant } from '../db';
import { openAppWindow } from '../apps/window';
import { scaffoldApp, slugify } from '../apps/scaffold';
import { validateAppFolder, type AppFolderReport } from '../apps/validate';
import { installAppFromFolder, type AppInstallResult } from '../apps/install';
import { installIO } from '../apps/ipc';
import { appsList } from '../apps/manage';
import { APP_MANIFEST_FILENAME } from '../apps/manifest';

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
        async openExample(): Promise<{ url: string }> {
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

            openAppWindow({
                appId: APP_ID,
                slug: 'example',
                name: 'Genie App Example',
                homeUrl: url,
            });
            return { url };
        },

        scaffoldCheckInstall: () => scaffoldCheckInstall(),
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

    return { folder, report, install };
}
