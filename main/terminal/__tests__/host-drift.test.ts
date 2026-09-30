import { describe, expect, it } from 'vitest';
import { hostDrift, hostDriftNotice, hostKeyFromScriptPath } from '../host-drift';

/**
 * THE HOST THAT NEVER RESTARTS.
 *
 * The owner: *"I don't think the upgrade is upgrading the pty host at all. I'm
 * never getting the notification that terminals and all running processes will
 * be killed."*
 *
 * Both halves were right, for a reason neither of us expected. The warning does
 * not fire because on that machine it correctly should not — the host runs on
 * Genie's shipped standalone Node, so it pins nothing the installer must replace
 * and survives the update by design. That is WHY terminals live through an
 * upgrade.
 *
 * The gap is that nothing notices when surviving becomes STALE. Host code
 * changes only on a crash or a manual restart. On 2026-09-30 the live host had
 * been started by a CRASH RECOVERY at 12:28, and two upgrades later it was still
 * that process — matching the shipped version by luck, because nothing compared
 * them.
 *
 * It is not cosmetic: a fix inside `fancy-term-host` cannot reach a machine that
 * never restarts its host, and the host is exactly where the remaining terminal
 * work lives — one process owns every terminal, so a native fault takes all of
 * them.
 */
const RUNNING =
    'C:\\Users\\glenn\\AppData\\Roaming\\genie\\pty-host\\fth0.5.0-npty1.1.0\\node_modules\\@particle-academy\\fancy-term-host\\dist\\pty-host.js';

describe('reading the key a host was materialized under', () => {
    it('finds it in a Windows path', () => {
        expect(hostKeyFromScriptPath(RUNNING)).toBe('fth0.5.0-npty1.1.0');
    });

    it('finds it in a POSIX path', () => {
        // The marker is written on the host's platform and may be read on
        // another — a copied user-data dir, or these tests.
        expect(
            hostKeyFromScriptPath(
                '/home/x/.config/genie/pty-host/fth0.6.0-npty1.1.0/node_modules/a/dist/pty-host.js',
            ),
        ).toBe('fth0.6.0-npty1.1.0');
    });

    it('answers null for a host that is NOT under a keyed directory', () => {
        // A host running from the install tree or a repo checkout has no key.
        // Inventing one would manufacture a drift that is not there.
        expect(
            hostKeyFromScriptPath('C:\\Program Files\\Genie\\resources\\app\\pty-host.js'),
        ).toBeNull();
    });

    it('answers null for nothing at all', () => {
        expect(hostKeyFromScriptPath(null)).toBeNull();
        expect(hostKeyFromScriptPath('')).toBeNull();
    });
});

describe('deciding whether the running host is stale', () => {
    it('reports drift when the running key differs from the shipped one', () => {
        const d = hostDrift('fth0.6.0-npty1.1.0', RUNNING);

        expect(d.drifted).toBe(true);
        expect(d.running).toBe('fth0.5.0-npty1.1.0');
        expect(d.expected).toBe('fth0.6.0-npty1.1.0');
    });

    it('CONTROL: reports NO drift when they match', () => {
        // The state on the owner's machine today — right by luck, because a crash
        // recovery restarted the host onto the current build. Without this, "it
        // detects drift" would pass against a check that always cried stale.
        expect(hostDrift('fth0.5.0-npty1.1.0', RUNNING).drifted).toBe(false);
    });

    it('does NOT claim drift when the running key cannot be read', () => {
        // "We could not tell" must not be reported as "it is stale", or the
        // notice fires on every machine whose marker predates this check — and a
        // warning that is wrong on day one is a warning nobody reads on day two.
        const d = hostDrift('fth0.6.0-npty1.1.0', null);

        expect(d.drifted).toBe(false);
        expect(d.running).toBeNull();
    });

    it('notices a node-pty change, not just a host change', () => {
        // The key carries both, because a rebuilt node-pty is exactly the kind of
        // native change that must actually be loaded to take effect.
        expect(hostDrift('fth0.5.0-npty1.2.0', RUNNING).drifted).toBe(true);
    });
});

describe('what the owner is told', () => {
    it('says nothing when there is nothing wrong', () => {
        expect(hostDriftNotice(hostDrift('fth0.5.0-npty1.1.0', RUNNING))).toBeNull();
    });

    it('names both versions, the consequence, and does not restart anything', () => {
        const notice = hostDriftNotice(hostDrift('fth0.6.0-npty1.1.0', RUNNING))!;

        expect(notice).toContain('fth0.5.0-npty1.1.0');
        expect(notice).toContain('fth0.6.0-npty1.1.0');
        // The CONSEQUENCE. "Your host is out of date" with nothing attached is a
        // notice people learn to dismiss.
        expect(notice).toMatch(/have not reached this machine/i);
        // And the cost of acting, because ending every terminal on the machine is
        // a decision for someone who knows what is mid-flight.
        expect(notice).toMatch(/ends every terminal/i);
        expect(notice).toMatch(/not done for you/i);
    });
});
