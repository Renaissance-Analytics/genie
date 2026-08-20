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
import path from 'node:path';
import http from 'node:http';
import { upsertAppGrant } from '../db';
import { openAppWindow } from '../apps/window';

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
                revoked: false,
            });

            openAppWindow({
                appId: APP_ID,
                slug: 'example',
                name: 'Genie App Example',
                homeUrl: url,
            });
            return { url };
        },
    };
}
