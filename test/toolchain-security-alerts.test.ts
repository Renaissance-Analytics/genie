import { describe, expect, it } from 'vitest';
import { toolchainSecurityAlerts } from '../src/core/toolchain-alerts.js';
import { toolStatus } from '../src/core/toolchain.js';
import { runsOnPhp } from '../src/core/toolchain-risk.js';

/**
 * THE DRIFT WATCHER RAISES THE ALARM (the owner, 2026-10-22: "make sure we having something in our drift watcher that
 * catches these security issues right away"). The toolchain probe runs at boot and every six hours; the moment a probe
 * reports a tool under its security floor, the window raises ONE alert for it — sound and notification, the same path a
 * GitHub security alert takes — and not again while it stays that way. These are new functions, so on the base this
 * file fails at its imports: nothing of it exists yet.
 */

const probe = (installed: string, latest: string | null) => toolStatus({ tool: 'php', installed, latest, source: latest ? 'php.net releases' : null });

describe('toolchainSecurityAlerts', () => {
    it('raises ONE alert the first time a tool is seen needing a security update, none while it stays that way, none once fixed', () => {
        const unsafe = [probe('8.4.24', '8.4.27')];
        const first = toolchainSecurityAlerts(null, unsafe);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ kind: 'ghsecurity', agent: 'Toolchain', detail: expect.stringContaining('PHP 8.4.24') });
        expect(toolchainSecurityAlerts(unsafe, unsafe)).toEqual([]);
        expect(toolchainSecurityAlerts(unsafe, [probe('8.4.27', '8.4.27')])).toEqual([]);
        // Control: a merely outdated tool raises nothing.
        expect(toolchainSecurityAlerts(null, [toolStatus({ tool: 'node', installed: '22.0.0', latest: '22.24.0', source: 'nodejs.org index' })])).toEqual([]);
    });
});

describe('runsOnPhp — which of Genie’s processes execute PHP', () => {
    it('php, php-cgi and artisan commands do; node ones do not', () => {
        expect(runsOnPhp('php artisan serve --host=127.0.0.1 --port=4143')).toBe(true);
        expect(runsOnPhp('"C:\\Users\\x\\AppData\\Roaming\\genie\\toolchain\\php\\8.4.24\\php-cgi.exe" -b 127.0.0.1:9000')).toBe(true);
        expect(runsOnPhp('php artisan queue:work --tries=1')).toBe(true);
        expect(runsOnPhp('npm run dev')).toBe(false);
    });
});
