import { describe, expect, it } from 'vitest';
import { engineSpecFor } from '../catalog';
import { provisionSteps } from '../provision';
import { redisUserAclRule } from '../redis-acl';

/**
 * A DEDICATED REDIS KEEPS ITS WORKSPACE USER ACROSS A CONTAINER RESTART
 * (genie#771, reopening genie#643).
 *
 * `ACL SETUSER` is IN-MEMORY state. `--appendonly yes` persists the keyspace,
 * not the ACLs, so any container restart — Docker Desktop, a reboot, an engine
 * hiccup — dropped the `ws_<id>` user while the workspace `.env` went on naming
 * it. The keyspace survived, which is exactly why it never looked like a
 * credentials problem: the port answered, the data was there, and the container
 * logged "Ready to accept connections".
 *
 * It cost the owner a working day, and the blast radius was far wider than the
 * queue workers people blamed: `ThrottleRequests` → `RateLimiter` → `RedisStore`
 * throws, so every route behind a `throttle:` middleware 500s.
 *
 * THE FIX IS NOT AN ACLFILE, and that is worth recording because the issue
 * proposed one. Measured against a real `redis:7-alpine`:
 *
 *   1. `--aclfile /data/users.acl` with no file present makes Redis ABORT
 *      STARTUP — "Aborting Redis startup because of ACL errors". Every
 *      dedicated Redis would have failed to come up.
 *   2. Worse, once the file exists, loading it RESETS the default user and
 *      `ACL SAVE` writes back `user default on nopass ~* &* +@all`. After a
 *      restart the container then accepts UNAUTHENTICATED connections with full
 *      admin rights, including `ACL LIST`, which dumps the workspace credential
 *      hash. The aclfile route silently disables `requirepass`.
 *
 * So the user is declared AT LAUNCH instead, beside `--requirepass`. It needs no
 * file, it cannot abort startup, it leaves the admin password intact, and it
 * survives by construction: the definition is in the container's own command, so
 * every start re-applies it — including the start that ADOPTS an existing
 * container and never runs `runProvisionSteps` at all, which is the gap
 * genie#643 asked for and did not get.
 */
const REDIS = engineSpecFor('redis');

const SLICE = { identifier: 'ws_abc', dnsName: 'ws-abc', password: 'w0rkpass' };
const ADMIN = { engine: 'redis', version: '7', workspaceId: null, password: 'adminpass' } as never;

const command = (dedicated = true) =>
    REDIS.command!('adminpass', { identifier: SLICE.identifier, password: SLICE.password, dedicated });

describe('the launch command carries the workspace user', () => {
    it('declares it with --user, so a restart re-applies it', () => {
        // THE fix. Without this the ACL exists only until the container stops.
        const argv = command();
        const at = argv.indexOf('--user');
        expect(at).toBeGreaterThan(-1);
        expect(argv[at + 1]).toBe('ws_abc');
    });

    it('keeps --requirepass, so the admin is still behind a password', () => {
        // The property the aclfile route destroyed. An unauthenticated `default`
        // with `~* &* +@all` is a container anyone on the host can read.
        const argv = command();
        expect(argv).toContain('--requirepass');
        expect(argv[argv.indexOf('--requirepass') + 1]).toBe('adminpass');
    });

    it('never asks for an aclfile', () => {
        // Measured: with no file Redis aborts startup, and with one it writes
        // `default on nopass` back and drops `requirepass` on the next boot.
        expect(command()).not.toContain('--aclfile');
    });

    it('still persists the keyspace', () => {
        // POSITIVE CONTROL: the fix adds to the command, it does not rewrite it.
        // Losing `--appendonly` would empty every workspace's cache on restart —
        // a different version of the same bug.
        expect(command()).toContain('--appendonly');
    });

    it('grants exactly what provisioning grants', () => {
        // The REASON this cannot rot. Two places now define the workspace user —
        // the launch command and the `ACL SETUSER` step — and a drift between
        // them would mean the permissions silently change at the first restart.
        // Both read the same rule, and this is the assertion that keeps it so.
        const argv = command();
        const rule = redisUserAclRule('ws_abc', 'w0rkpass', { dedicated: true });
        expect(argv.slice(argv.indexOf('--user') + 2)).toEqual(rule);
    });

    it('scopes keys and channels to the workspace prefix', () => {
        const argv = command();
        expect(argv).toContain('~ws_abc:*');
        expect(argv).toContain('&ws_abc:*');
    });

    it('still forbids what a workspace user must not run', () => {
        // A launch-declared user that quietly granted more than the provisioned
        // one would be a privilege escalation that only appears after a reboot.
        const argv = command();
        expect(argv).toContain('-flushall');
    });

    it('allows flushdb only for a DEDICATED container', () => {
        // Unchanged rule, restated at the launch seam: Laravel's `cache:clear`
        // needs FLUSHDB, and it is only safe when the container is this
        // workspace's alone. Checked in both directions so the flag is live.
        expect(command(true)).not.toContain('-flushdb');
        expect(command(false)).toContain('-flushdb');
    });

    it('is omitted entirely when there is no slice to declare', () => {
        // A container created before the slice is known must still start, with
        // the admin password and nothing else — not with a half-written `--user`.
        const argv = REDIS.command!('adminpass');
        expect(argv).not.toContain('--user');
        expect(argv).toContain('--requirepass');
    });
});

describe('provisioning and the launch command agree', () => {
    it('SETUSER applies the same rule the command declares', () => {
        // Provisioning still runs — it is what converges a container that was
        // created before this fix, and what applies a rotated password without a
        // recreate. It must not grant anything different.
        const steps = provisionSteps('redis', ADMIN, SLICE, { dedicated: true });
        const setuser = steps.find((s) => s.argv.includes('SETUSER'));
        expect(setuser).toBeDefined();
        const after = setuser!.argv.slice(setuser!.argv.indexOf('ws_abc') + 1);
        // `reset` leads the provisioning form and only that form: a re-provision
        // is a full redefinition, while the launch form defines the user fresh
        // every time by definition.
        expect(after[0]).toBe('reset');
        expect(after.slice(1)).toEqual(redisUserAclRule('ws_abc', 'w0rkpass', { dedicated: true }));
    });

    it('still verifies the credential it just handed out', () => {
        // genie#643's third acceptance item, already present and pinned here so
        // it cannot be dropped: "provisioned" must mean the workspace password
        // authenticates, not that the admin's command was sent.
        const steps = provisionSteps('redis', ADMIN, SLICE, { dedicated: true });
        const check = steps.find((s) => s.argv.includes('--user') && s.argv.includes('ws_abc'));
        expect(check).toBeDefined();
        expect(check!.argv).toContain('w0rkpass');
    });
});

describe('readiness exercises the credential it hands out', () => {
    it('pings as the WORKSPACE user, not as admin', () => {
        // genie#643's third item. A readiness probe that authenticates as admin
        // reports `ready` in front of a dead workspace credential — which is
        // exactly what happened, twice. Through Predis the failure then surfaces
        // as `ConnectionException: Error while reading line from the server`, a
        // READ error, so the client does not say `WRONGPASS` either.
        const argv = REDIS.readyExec!('adminpass', {
            identifier: SLICE.identifier,
            password: SLICE.password,
        });
        expect(argv).toContain('--user');
        expect(argv[argv.indexOf('--user') + 1]).toBe('ws_abc');
        expect(argv).toContain('w0rkpass');
        expect(argv).not.toContain('adminpass');
    });

    it('falls back to the admin ping when no slice is known', () => {
        // A shared engine, or a probe before the slice exists, still has to have
        // an answer — "cannot check" must not become "not ready".
        const argv = REDIS.readyExec!('adminpass');
        expect(argv).toContain('adminpass');
        expect(argv).not.toContain('--user');
    });
});
