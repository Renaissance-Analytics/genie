import { describe, expect, it } from 'vitest';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager } from '../src/main/site-manager.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * A REMOVED SITE LEAVES NO PROCESS ROW (#242's `supervisor.forget`). Removing a site used to `stop` its
 * processes, which KEEPS a stopped supervisor entry: the Processes tab went on listing a ghost `<name>.gen
 * server` whose Restart would bring back a site that no longer exists. A STOPPED site keeps its rows (it
 * is still a site); a removed one forgets them.
 */

const pty: PtyPort = {
    open: (o) => ({ id: `t_${o.command ?? ''}`, pid: 1, shell: 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};

function make() {
    const supervisor = new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} });
    let port = 4100;
    const sites = new SiteManager({ supervisor, allocatePort: () => ++port, caddyBin: '/opt/caddy', configDir: '/cfg', writeConfig: () => {} });
    return { supervisor, sites };
}

describe('removing a site', () => {
    it('forgets every process of the site — the php worker and the server — so no ghost row is left', () => {
        const { supervisor, sites } = make();
        sites.create({ name: 'shop', workspaceId: 'acme', repoPath: '/w/acme/repos/shop', serve: { mode: 'php', root: 'public' } });
        // Positive control: the scan finds both of the site's processes while it exists.
        // Changed 2026-10-21 (genie#1043): a PHP site runs several workers (test/php-fast.test.ts).
        expect(supervisor.list().map((p) => p.id).sort()).toEqual(['site_shop', 'site_shop-fcgi', 'site_shop-fcgi-2', 'site_shop-fcgi-3', 'site_shop-fcgi-4']);
        expect(sites.remove('site_shop')).toBe(true);
        expect(supervisor.list().map((p) => p.id)).toEqual([]);
    });

    it('a STOPPED site keeps its rows, stopped — it is still a site', () => {
        const { supervisor, sites } = make();
        sites.create({ name: 'docs', workspaceId: 'acme', repoPath: '/w/acme/repos/docs', serve: { mode: 'static', root: 'dist', spa: true } });
        sites.stop('site_docs');
        expect(supervisor.list().map((p) => [p.id, p.state])).toEqual([['site_docs', 'stopped']]);
    });
});
