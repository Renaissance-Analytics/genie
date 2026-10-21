import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isGenHost, siteNameProblem } from '../src/core/gen-name.js';
import { serviceEnvFor, type ServiceInstance } from '../src/core/services.js';

/**
 * MAILPIT AT mail.gen (the owner, 2026-10-21, FTQ q_0c257fbb: "give Mailpit a .gen name — mail.gen and make sure that
 * is one of the protected names so other workspace agents don't try using that for their sites. That url should also be
 * used for the connection info to the mailpit (subdomains are ok if needed like mail.mail.gen etc)").
 *
 * - The Genie browser window opens `.gen` sites only, so Open inbox at `http://127.0.0.1:<port>` was refused. Now a
 *   Mailpit's web inbox is served by the front door at its own name: the shared one at `mail.gen`, a workspace's own at
 *   `<workspace>.mail.gen`; Open inbox (the UI and the agents' tool) goes to `https://<name>/`.
 * - `mail` and everything under it are kept for Genie — no site may take them (nor `websockets`, the other name Genie
 *   serves itself). Kept from SITES only: the router still serves `mail.gen`.
 * - The connection info names it too: MAIL_HOST is the Mailpit's name (the hosts file points it at this machine).
 *   A Mailpit with no web inbox published has no name, and keeps 127.0.0.1 — never a name nothing resolves.
 */
const naming = () => import('../src/core/mailpit-name.js') as Promise<Record<string, any>>;

const mailpit = (over: Partial<ServiceInstance> = {}): ServiceInstance => ({
    id: 'svc_mail', engine: 'mailpit', version: '1.30', scope: { kind: 'shared' }, publishedPort: 54325, credentials: {}, active: true,
    publishedPorts: { ui: 54326 }, ...over,
}) as ServiceInstance;

describe('a Mailpit’s name', () => {
    it('the shared one is mail.gen; a workspace’s own is <workspace>.mail.gen', async () => {
        const { mailpitHostOf } = await naming();
        expect(mailpitHostOf(mailpit())).toBe('mail.gen');
        expect(mailpitHostOf(mailpit({ scope: { kind: 'dedicated', workspaceId: 'tynn' } }))).toBe('tynn.mail.gen');
        expect(mailpitHostOf(mailpit({ scope: { kind: 'dedicated', workspaceId: 'Acme Shop_2' } }))).toBe('acme-shop-2.mail.gen');
    });

    it('each Mailpit with a web inbox is a front-door route to that inbox; one without is none (counted)', async () => {
        const { mailpitRoutes } = await naming();
        const routes = mailpitRoutes([
            mailpit(),
            mailpit({ id: 'svc_t', scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPorts: { ui: 54400 } }),
            mailpit({ id: 'svc_x', scope: { kind: 'dedicated', workspaceId: 'bare' }, publishedPorts: {} }),
            { ...mailpit({ id: 'svc_pg' }), engine: 'postgres', publishedPorts: { ui: 1 } } as ServiceInstance,
        ]);
        expect(routes).toEqual([{ host: 'mail.gen', target: '127.0.0.1:54326' }, { host: 'tynn.mail.gen', target: '127.0.0.1:54400' }]);
    });

    it('the router still serves the name (kept from SITES, not from routing)', () => {
        expect(isGenHost('mail.gen')).toBe(true);
        expect(isGenHost('tynn.mail.gen')).toBe(true);
    });
});

describe('the names are Genie’s: no site takes them', () => {
    it('mail, anything under it, and websockets are refused for a site — in words', () => {
        for (const name of ['mail', 'mail.gen', 'MAIL.gen', 'shop.mail', 'mail.mail.gen', 'websockets', 'websockets.gen']) {
            expect(siteNameProblem(name), name).toMatch(/kept for Genie/);
        }
    });

    it('CONTROL: names that only look alike are a site’s to take', () => {
        for (const name of ['mailer', 'gmail', 'mail-app', 'mail2', 'mailbox.shop', 'websocket']) expect(siteNameProblem(name), name).toBeNull();
    });
});

describe('the connection info and Open inbox use the name', () => {
    it('MAIL_HOST is the Mailpit’s name; the SMTP port is its own', () => {
        const own = { scope: { kind: 'dedicated' as const, workspaceId: 'tynn' } };
        const env = serviceEnvFor([mailpit(own)], 'tynn');
        expect(env).toMatchObject({ MAIL_MAILER: 'smtp', MAIL_HOST: 'tynn.mail.gen', MAIL_PORT: '54325' });
    });

    it('CONTROL: a Mailpit that publishes no web inbox has no name, and keeps 127.0.0.1', () => {
        expect(serviceEnvFor([mailpit({ scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPorts: {} })], 'tynn').MAIL_HOST).toBe('127.0.0.1');
    });

    it('Open inbox is https://<name>/ — the UI and the agents’ tool read the same rule', async () => {
        const { mailpitInboxUrl } = await naming();
        expect(mailpitInboxUrl(mailpit())).toBe('https://mail.gen/');
        expect(mailpitInboxUrl(mailpit({ publishedPorts: {} }))).toBeNull();
        const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
        expect(src('../src/renderer/components/FeatureSurfaces.tsx')).toMatch(/mailpitInboxUrl\(i\)/);
        expect(src('../src/main/mcp-tools-hosting.ts')).toMatch(/inbox: mailpitInboxUrl\(i\)/);
        expect(src('../src/main/mcp-tools-hosting.ts')).not.toMatch(/inbox: `http:\/\/127\.0\.0\.1/);
    });

    it('the front door routes them (compose), beside the sites and the WebSockets server', () => {
        const compose = readFileSync(new URL('../src/main/compose.ts', import.meta.url), 'utf8');
        expect(compose).toMatch(/const routes = \(\) => \[\.\.\.sites\.routes\(\), \.\.\.websocketRoutes\(engines\.list\(\)\), \.\.\.mailpitRoutes\(engines\.list\(\)\)\];/);
    });
});
