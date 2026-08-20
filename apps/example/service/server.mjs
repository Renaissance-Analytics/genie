/**
 * The Genie App Example's backend service.
 *
 * A GApp is MULTI-COMPONENT: a front end Genie serves, plus whatever it needs
 * running beside it, in whatever language. This one is Node because Node is
 * already here; the real apps this system was designed against run FastAPI. The
 * manifest declares it as a literal argv array (`["node", "server.mjs"]`) and
 * Genie supervises it as an ordinary background process.
 *
 * It binds LOOPBACK only. A service that is part of an app has no business being
 * reachable from the network, and the front end that talks to it is on the same
 * machine by construction.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8791);
const startedAt = new Date().toISOString();

const server = createServer((req, res) => {
    // The front end is served from https://example.gen; this is a different
    // origin, so it needs to say so explicitly.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.url === '/health') {
        res.end(
            JSON.stringify(
                {
                    ok: true,
                    service: 'genie-app-example',
                    startedAt,
                    note: 'This is the app’s OWN backend, supervised by Genie. Genie itself was not involved in this request.',
                },
                null,
                2,
            ),
        );
        return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`[genie-app-example] listening on http://127.0.0.1:${PORT}`);
});
