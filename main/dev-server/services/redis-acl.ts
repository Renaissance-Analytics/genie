/**
 * The Redis workspace user — the ONE definition of who it is and what it may do.
 *
 * A LEAF module on purpose. Two callers need it and they sit on opposite sides
 * of an existing dependency: `provision.ts` applies it with `ACL SETUSER`, and
 * `catalog.ts` declares it on the container's launch command. `provision.ts"
 * already imports `catalog.ts`, so leaving the rule in either would make the two
 * import each other.
 */

/**
 * Commands a workspace user must NOT have.
 *
 * Deliberately an explicit deny-list rather than `-@dangerous`: that category
 * also removes `KEYS`, `INFO` and `CLIENT`, which developers use constantly in
 * a dev cache. These are the ones that would either reach outside the key
 * prefix (`FLUSHALL`, and `FLUSHDB` on a legacy shared engine), end the engine for every other
 * workspace (`SHUTDOWN`), or change the rules themselves (`CONFIG`, `ACL`).
 *
 * The key pattern (`~ws_x:*`) is what scopes everything else, and the limit of
 * it is the reason this list is longer than it looks like it should be: a
 * pattern constrains commands that address a KEY, and says nothing about
 * commands that address the KEYSPACE or the server. `SWAPDB` moves every
 * workspace's keys between logical databases without naming one, and the
 * FUNCTION library is server-global — `FUNCTION FLUSH` empties it for everybody
 * and `FUNCTION LOAD REPLACE` overwrites what another workspace loaded. Neither
 * is caught by the prefix, and both destroy other workspaces' data as thoroughly
 * as `FLUSHALL` does (Tynn #250, step 4).
 *
 * `-function` is the whole container command, read-only subcommands included,
 * and that cost is real: a workspace cannot use Redis Functions on a SHARED
 * engine. It is the honest answer rather than a gap, because the library has no
 * per-user namespace to scope — anything one workspace loads, every workspace
 * gets. A project that genuinely needs them flips `dedicated` and has its own
 * server to load into.
 */
export const REDIS_DENIED = [
    '-flushall',
    '-flushdb',
    '-swapdb',
    '-function',
    '-shutdown',
    '-config',
    '-acl',
    '-debug',
    '-replicaof',
    '-slaveof',
    '-module',
];

/**
 * What a workspace's Redis user is allowed to do — the ONE definition of it.
 *
 * Shared by the two places that declare the user, which is the whole point
 * (genie#771): `ACL SETUSER` at provisioning time, and `--user` on the container's
 * own launch command. The launch copy is what makes the user survive a container
 * restart — `ACL SETUSER` is in-memory state and `--appendonly yes` persists the
 * keyspace, not the ACLs, so a restart used to drop the credential while the
 * workspace `.env` went on naming it.
 *
 * Two declarations that could disagree would mean the permissions silently
 * change at the first reboot, which is a privilege change nobody would see
 * happen. Reading both from here is what stops that, and the test asserts the
 * launch command's tail IS this list.
 *
 * NOT an `aclfile`, which is what genie#771 first proposed. Measured against a
 * real `redis:7-alpine`: with no file present Redis aborts startup outright, and
 * once the file exists `ACL SAVE` writes back `user default on nopass ~* &* +@all`
 * — so after a restart the container accepts UNAUTHENTICATED admin connections.
 * The aclfile route silently disables `requirepass`.
 */
export function redisUserAclRule(
    identifier: string,
    password: string,
    options: { dedicated: boolean },
): string[] {
    return [
        'on',
        `>${password}`,
        // Key patterns apply across every logical DB index, so the prefix is the
        // isolation whether or not the client SELECTs.
        `~${identifier}:*`,
        `&${identifier}:*`,
        '+@all',
        ...REDIS_DENIED.filter((command) => !(options.dedicated && command === '-flushdb')),
    ];
}
