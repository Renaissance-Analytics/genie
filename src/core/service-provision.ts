import type { AdoptedSlice, EngineAdmin } from './services.js';

/**
 * A WORKSPACE'S SLICE OF A SHARED ENGINE (§6.6, hosting ship line H3) — the pure half: the commands that carve it.
 *
 * Genie 1's model, kept: a SHARED Postgres / MySQL / MariaDB becomes many isolated workspaces because each one gets
 * its own DATABASE and a ROLE that can reach nothing else, and a shared Redis gets an ACL USER pinned to its own key
 * prefix. All are named `ws_<slug>` (core/v1-services.ts `workspaceSqlIdentifier`) — the same names Genie 1 created,
 * so an engine taken over from Genie 1 and a new one carve their slices identically. Each runs as the engine's own
 * client INSIDE its container (`docker exec`), as the engine's superuser, which Genie generated once and keeps.
 * A shared SeaweedFS (hosting ship line H7) gets a BUCKET and an access key admitted to it alone, both `ws-<slug>`
 * (`workspaceDnsName`), with the workspace's own secret — Genie 1's S3 isolation. Its identities live in the filer,
 * inside the data volume, so unlike Redis's they survive a restart.
 *
 * Ported from Genie 1 (repos/genie main/dev-server/services/provision.ts + redis-acl.ts); what changed is said there.
 *
 * ## Idempotent
 *
 * The role branch ALTERs when the role exists (which also repairs a drifted credential), `CREATE DATABASE` tolerates
 * "already exists", MySQL has IF NOT EXISTS for all three, and the Redis user starts from `reset`. Running a slice's
 * steps twice converges on the same engine state.
 *
 * ## Redis ACLs are memory-only
 *
 * `ACL SETUSER` does not survive a restart of the engine (no aclfile — see below). So a Redis slice is put back every
 * time Genie starts the engine and every time Genie finds it already running at boot (Docker's `unless-stopped`
 * restarts it on a reboot without asking Genie). NOT an aclfile: measured by Genie 1 against a real `redis:7-alpine`
 * (genie#771), a missing file aborts startup and `ACL SAVE` writes back `user default on nopass` — the aclfile route
 * silently disables `requirepass`.
 *
 * ## Injection
 *
 * Not escaping. The identifier is DERIVED (closed alphabet) and passwords are generated base64url; both are asserted
 * here, so the day a user-supplied value is threaded through, it fails loudly instead of becoming SQL injection.
 */

export interface ProvisionStep {
    /** Which part of provisioning this is, so a failure names it. */
    readonly label: string;
    /** Literal argv, run INSIDE the engine container (`docker exec <container> …argv`). */
    readonly argv: readonly string[];
    /** Engine output that means the postcondition already holds. */
    readonly tolerate?: RegExp;
    /**
     * Output the step must print to count as done. `redis-cli` exits 0 on an error reply (Genie 1 measured 7.4.7,
     * genie#643), so its exit code alone does not carry the server's answer.
     */
    readonly expect?: RegExp;
}

/** The engines a shared instance is carved into per-workspace slices on. */
export const SLICED_ENGINES: ReadonlySet<string> = new Set(['postgres', 'mysql', 'mariadb', 'redis', 'seaweedfs']);

const SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const GENERATED_PASSWORD = /^[A-Za-z0-9_-]{8,128}$/;
/** Genie 1's DNS_NAME (provision.ts): a bucket name is a DNS label — the SQL identifier's underscores are illegal there. */
const DNS_NAME = /^[a-z][a-z0-9-]{2,62}$/;

export function assertSliceIdentifier(value: string): string {
    if (!SQL_IDENTIFIER.test(value)) throw new Error(`refusing to provision with the identifier ${JSON.stringify(value)}: it is not a derived workspace name`);
    return value;
}

export function assertBucketName(value: string): string {
    if (!DNS_NAME.test(value)) throw new Error(`refusing to provision with the bucket name ${JSON.stringify(value)}: it is not a derived workspace name`);
    return value;
}

export function assertGeneratedPassword(value: string, whose: string): string {
    if (!GENERATED_PASSWORD.test(value)) throw new Error(`refusing to provision with a ${whose} password that is not a generated one`);
    return value;
}

/**
 * Commands a workspace's Redis user must NOT have (Genie 1's REDIS_DENIED, verbatim): the key pattern scopes commands
 * that name a KEY, and says nothing about the keyspace or the server — FLUSHALL, SWAPDB and FUNCTION reach every
 * workspace's data without naming a key; CONFIG and ACL change the rules themselves.
 */
export const REDIS_DENIED: readonly string[] = ['-flushall', '-flushdb', '-swapdb', '-function', '-shutdown', '-config', '-acl', '-debug', '-replicaof', '-slaveof', '-module'];

/** What a workspace's Redis user may do — on, its password, its own key and channel prefix, everything else minus the deny-list. */
export function redisUserAclRule(identifier: string, password: string): string[] {
    return ['on', `>${password}`, `~${identifier}:*`, `&${identifier}:*`, '+@all', ...REDIS_DENIED];
}

/**
 * The engine's client asking whether the SERVER is up, over TCP on 127.0.0.1 inside the container. TCP on purpose:
 * the Postgres, MySQL and MariaDB images run their first-init server with networking off (unix socket only) and then
 * restart it, so a TCP answer means the real server — the one a slice is created in — is accepting.
 */
export function readinessProbe(engine: string, admin: EngineAdmin): ProvisionStep {
    assertGeneratedPassword(admin.password, 'admin');
    switch (engine) {
        case 'postgres':
            return { label: 'engine ready', argv: ['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', admin.user] };
        case 'mysql':
            return { label: 'engine ready', argv: ['mysqladmin', 'ping', '-h', '127.0.0.1', '-u', admin.user, `-p${admin.password}`, '--silent'] };
        case 'mariadb':
            // MariaDB 11's image ships `mariadb-admin` and no `mysqladmin`; 10.x ships both.
            return { label: 'engine ready', argv: ['mariadb-admin', 'ping', '-h', '127.0.0.1', '-u', admin.user, `-p${admin.password}`, '--silent'] };
        case 'redis':
            return { label: 'engine ready', argv: ['redis-cli', '-h', '127.0.0.1', '-a', admin.password, '--no-auth-warning', 'PING'], expect: /^PONG$/m };
        case 'seaweedfs':
            // Genie 1's real-container test waited on exactly this: the S3 gateway accepting on its port inside the container.
            return { label: 'engine ready', argv: ['sh', '-c', 'nc -z 127.0.0.1 8333'] };
        default:
            throw new Error(`${engine} is not carved into per-workspace slices`);
    }
}

/** Where SeaweedFS's S3 identity config lives inside its container (Genie 1's catalog.ts). */
export const SEAWEED_CONFIG_PATH = '/etc/seaweedfs/s3.json';

/**
 * SeaweedFS's admin identity, as `-s3.config` reads it. `identities` is PLURAL: a singular `identity` loads as an empty
 * config, which denies every request with nothing pointing at the mistake (auth_credentials.go, via Genie 1).
 */
export function seaweedAdminConfig(adminPassword: string): string {
    return JSON.stringify({
        identities: [{ name: 'genie', credentials: [{ accessKey: 'genie', secretKey: assertGeneratedPassword(adminPassword, 'admin') }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }],
    });
}

/**
 * The script SeaweedFS's container runs (`--entrypoint sh` … `-c <this>`): write the admin identity, THEN exec the
 * image's own `/entrypoint.sh` (which fixes /data ownership for its unprivileged user) with `-s3.config`. One step, so
 * there is no window in which the S3 gateway is up without authentication. Genie 1's entrypoint, verbatim in effect;
 * `-dir=/data` comes from the image entrypoint's own `server` case.
 */
export function seaweedEntrypointScript(adminPassword: string): string {
    return `mkdir -p /etc/seaweedfs && printf '%s' '${seaweedAdminConfig(adminPassword)}' > ${SEAWEED_CONFIG_PATH} && `
        + `exec /entrypoint.sh server -master.port=9333 -filer -filer.port=8888 -s3 -s3.port=8333 -s3.config=${SEAWEED_CONFIG_PATH}`;
}

/**
 * SeaweedFS: one bucket and one credential admitted to that bucket alone (Genie 1's seaweedSteps, ported). The access
 * key IS the bucket name. `s3.configure`, not `s3.user.provision` (which generates a key Genie could never learn);
 * `-actions` excludes Admin (an Admin reaches every bucket); `-apply` or nothing is written. `s3.bucket.create` is not
 * convergent, so the bucket step tolerates exactly "already exists" and nothing else. `weed shell` reads its commands
 * on stdin, so each step is a `sh -c`; the only values in it are the asserted bucket name and generated password.
 */
function seaweedSteps(admin: EngineAdmin, bucket: string, password: string): ProvisionStep[] {
    assertGeneratedPassword(admin.password, 'admin');
    const weed = 'weed shell -master=localhost:9333 -filer=localhost:8888';
    return [
        {
            label: 'bucket',
            argv: ['sh', '-c', `out=$(printf '%s\\n' 's3.bucket.create -name ${bucket}' | ${weed} 2>&1) && exit 0; printf '%s\\n' "$out" >&2; case "$out" in *'already exists'*) exit 0 ;; esac; exit 1`],
        },
        {
            label: 'user',
            argv: ['sh', '-c', `printf '%s\\n' 's3.configure -user ${bucket} -access_key ${bucket} -secret_key ${password} -buckets ${bucket} -actions Read,Write,List,Tagging -apply' | ${weed}`],
        },
    ];
}

/** What an extension name may look like, whatever list it came from: it becomes a quoted identifier run as superuser (Genie 1's extensions.ts EXTENSION_NAME). */
const EXTENSION_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

export function assertExtensionName(value: string): string {
    if (!EXTENSION_NAME.test(value)) throw new Error(`refusing to create the extension ${JSON.stringify(value)}: it is not a bare extension name`);
    return value;
}

/**
 * `CREATE EXTENSION` for what the engine's VARIANT carries (pgvector's `vector`), as the engine's SUPERUSER, in the
 * WORKSPACE's database — Genie 1's postgresExtensionSteps (repos/genie main/dev-server/services/provision.ts, genie#526),
 * ported. Superuser because `vector` is not a trusted extension (pgvector's vector.control sets no `trusted`; pgvector#288,
 * #1017): the workspace role cannot create it, and must not be made a superuser of an engine other workspaces share.
 * In the workspace's database, because an extension lives in one database. LAST, after the grants, so the database is
 * the workspace's. `IF NOT EXISTS`: a second provisioning converges, and the app's own `CREATE EXTENSION IF NOT EXISTS
 * vector` afterwards is a no-op that succeeds.
 */
function postgresExtensionSteps(admin: EngineAdmin, database: string, extensions: readonly string[]): ProvisionStep[] {
    const uri = `postgresql://${admin.user}:${admin.password}@127.0.0.1:5432/${database}`;
    return extensions.map((extension) => {
        const name = assertExtensionName(extension);
        return { label: `extension ${name}`, argv: ['psql', uri, '-v', 'ON_ERROR_STOP=1', '-q', '-tAc', `CREATE EXTENSION IF NOT EXISTS "${name}"`] };
    });
}

function postgresSteps(admin: EngineAdmin, name: string, password: string, extensions: readonly string[] = []): ProvisionStep[] {
    // A URI rather than the unix socket: no assumption about the image's pg_hba.conf; base64url needs no escaping.
    const uri = `postgresql://${admin.user}:${admin.password}@127.0.0.1:5432/postgres`;
    const psql = (sql: string): string[] => ['psql', uri, '-v', 'ON_ERROR_STOP=1', '-q', '-tAc', sql];
    return [
        {
            label: 'role',
            // Postgres has no CREATE ROLE IF NOT EXISTS; the ELSE branch repairs a drifted credential.
            argv: psql(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
    CREATE ROLE "${name}" LOGIN PASSWORD '${password}';
  ELSE
    ALTER ROLE "${name}" WITH LOGIN PASSWORD '${password}';
  END IF;
END $$;`),
        },
        {
            label: 'database',
            // CREATE DATABASE cannot run in a DO block or a transaction: "already there" is a tolerated error.
            argv: psql(`CREATE DATABASE "${name}" OWNER "${name}"`),
            tolerate: /already exists/i,
        },
        {
            label: 'grants',
            // THE load-bearing statement: Postgres grants CONNECT on every new database to PUBLIC, so without this REVOKE
            // workspace A's role can open workspace B's database.
            argv: psql(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC; GRANT ALL PRIVILEGES ON DATABASE "${name}" TO "${name}"; ALTER DATABASE "${name}" OWNER TO "${name}";`),
        },
        ...postgresExtensionSteps(admin, name, extensions),
    ];
}

function mysqlSteps(client: 'mysql' | 'mariadb', admin: EngineAdmin, name: string, password: string): ProvisionStep[] {
    return [
        {
            label: 'database and user',
            argv: [
                client, '-h', '127.0.0.1', `-u${admin.user}`, `-p${admin.password}`, '-e',
                // The GRANT is scoped to this schema — never `ON *.*` — which is what keeps one workspace out of another's tables.
                'CREATE DATABASE IF NOT EXISTS `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; '
                    + `CREATE USER IF NOT EXISTS '${name}'@'%' IDENTIFIED BY '${password}'; `
                    + `ALTER USER '${name}'@'%' IDENTIFIED BY '${password}'; `
                    + 'GRANT ALL PRIVILEGES ON `' + name + "`.* TO '" + name + "'@'%'; FLUSH PRIVILEGES;",
            ],
        },
    ];
}

function redisSteps(admin: EngineAdmin, name: string, password: string): ProvisionStep[] {
    return [
        {
            label: 'acl user',
            // `reset` first: a re-provision is a full redefinition — the only way this converges after a restart dropped it.
            argv: ['redis-cli', '-h', '127.0.0.1', '-a', admin.password, '--no-auth-warning', 'ACL', 'SETUSER', name, 'reset', ...redisUserAclRule(name, password)],
            expect: /^OK$/m,
        },
        {
            // The postcondition itself: the credential the workspace is handed authenticates.
            label: 'workspace credential',
            argv: ['redis-cli', '-h', '127.0.0.1', '--user', name, '--pass', password, '--no-auth-warning', 'PING'],
            expect: /^PONG$/m,
        },
    ];
}

/**
 * The commands that carve one workspace's slice out of a shared engine, as its superuser. `extensions`: Postgres only —
 * what the engine's variant carries and a workspace role cannot create (core/services.ts `variantExtensions`).
 */
export function provisionSteps(engine: string, admin: EngineAdmin, slice: Pick<AdoptedSlice, 'identifier' | 'password' | 'bucket'>, options: { readonly extensions?: readonly string[] } = {}): ProvisionStep[] {
    const name = assertSliceIdentifier(slice.identifier);
    const password = assertGeneratedPassword(slice.password, 'workspace');
    assertGeneratedPassword(admin.password, 'admin');
    if ((options.extensions ?? []).length > 0 && engine !== 'postgres') throw new Error(`${engine} has no extensions; only a Postgres creates them`);
    switch (engine) {
        case 'postgres':
            return postgresSteps(admin, name, password, options.extensions ?? []);
        case 'mysql':
            return mysqlSteps('mysql', admin, name, password);
        case 'mariadb':
            // MariaDB 11's image ships `mariadb` and no `mysql` client; 10.x ships both.
            return mysqlSteps('mariadb', admin, name, password);
        case 'redis':
            return redisSteps(admin, name, password);
        case 'seaweedfs':
            return seaweedSteps(admin, assertBucketName(slice.bucket ?? ''), password);
        default:
            throw new Error(`${engine} is not carved into per-workspace slices`);
    }
}

/** Did a step do what it says? Exit 0 and (where the client's exit code lies) the expected output — or a tolerated answer. */
export function stepSucceeded(step: ProvisionStep, result: { readonly stdout: string; readonly exitCode: number }): boolean {
    if (result.exitCode === 0 && (!step.expect || step.expect.test(result.stdout))) return true;
    return step.tolerate?.test(result.stdout) === true;
}
