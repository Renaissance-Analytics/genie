import { engineSpecFor } from './catalog';
import type { ServiceEngine } from './catalog';
import type { ContainerRuntime } from '../container-runtime';

/**
 * PROVISIONING — how an engine is carved into a per-workspace slice, or given a
 * workspace-only credential when the engine itself must be dedicated.
 *
 * This is where the owner's service model stops being a diagram: a shared
 * Postgres becomes twenty isolated workspaces because each one gets its own
 * DATABASE and a ROLE that can reach nothing else. The statements that decide
 * that are built PURELY here, so they can be read and asserted without a
 * database to run them against — the same discipline, and for a stronger
 * reason, as `../argv.ts`.
 *
 * ## Idempotence is not optional
 *
 * Provisioning runs on every ACQUIRE, not once at creation. A workspace that
 * reopens, a Genie that restarts, an engine that was recreated after a version
 * bump — all of them land here again, and all of them must converge. So the
 * role branch ALTERs when it already exists (which also repairs a workspace
 * whose stored credential and server credential have drifted apart), the
 * database create tolerates "already exists", and the Redis ACL starts from
 * `reset`. Redis in particular has no choice: its ACLs live in memory unless an
 * aclfile is configured, so they are gone after an engine restart and this is
 * what puts them back.
 *
 * ## The injection story
 *
 * NOT escaping. Identifiers are DERIVED from the workspace id (`catalog.ts`)
 * and passwords are generated base64url (`services-config.ts`), so both come
 * from closed alphabets that contain no quote, backslash or semicolon. That is
 * asserted here rather than assumed — the day someone threads a user-supplied
 * name through this, it fails loudly instead of quietly becoming a SQL
 * injection.
 */

// --- what a step is ---------------------------------------------------------

export interface ProvisionStep {
    /** Names the part of provisioning this is, so a failure says WHICH broke. */
    label: string;
    /** Literal argv, run inside the ENGINE container. */
    argv: string[];
    /** Engine output that means the postcondition already holds. */
    tolerate?: RegExp;
}

/** The engine's superuser, as the manager holds it. */
export interface EngineAdmin {
    user: string;
    password: string;
}

/** One workspace's derived slice of an engine. */
export interface WorkspaceSlice {
    /** SQL identifier / ACL user / index prefix (`ws_acme_1a2b3c4d`). */
    identifier: string;
    /** The DNS-safe form, for an S3 bucket (`ws-acme-1a2b3c4d`). */
    dnsName: string;
    /** The workspace's own credential on this engine. */
    password: string;
}

// --- guards -----------------------------------------------------------------

/** Exactly what `workspaceSqlIdentifier` produces, and nothing else. */
const SQL_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

/** Exactly what `generateServicePassword` produces, and nothing else. */
const GENERATED_PASSWORD = /^[A-Za-z0-9_-]{8,128}$/;

/** Exactly what `workspaceDnsName` produces — an S3 bucket label. */
const DNS_NAME = /^[a-z][a-z0-9-]{2,62}$/;

/**
 * EXPORTED so everything that puts a slice on a command line asserts the SAME
 * thing. `backup.ts` builds `pg_dump` argv from the same identifier and password
 * this file builds `CREATE ROLE` from; two copies of "what a derived name looks
 * like" is how one of them ends up out of date.
 */
export function assertSliceIdentifier(value: string): string {
    return assertIdentifier(value);
}

/** See {@link assertSliceIdentifier}. */
export function assertSlicePassword(value: string, whose = 'workspace'): string {
    return assertPassword(value, whose);
}

function assertIdentifier(value: string): string {
    if (!SQL_IDENTIFIER.test(value)) {
        throw new Error(
            `dev-server: refusing to provision with the identifier ${JSON.stringify(value)} — ` +
                'it is not a derived workspace slug',
        );
    }
    return value;
}

function assertDnsName(value: string): string {
    if (!DNS_NAME.test(value)) {
        throw new Error(
            `dev-server: refusing to provision with the bucket name ${JSON.stringify(value)} — ` +
                'it is not a derived workspace name',
        );
    }
    return value;
}

function assertPassword(value: string, whose: string): string {
    if (!GENERATED_PASSWORD.test(value)) {
        throw new Error(
            `dev-server: refusing to provision with a ${whose} password that is not a generated one`,
        );
    }
    return value;
}

// --- per-engine steps -------------------------------------------------------

/** The admin connection string psql is handed.
 *
 *  A URI rather than `-U postgres` over the unix socket, deliberately: it makes
 *  no assumption about what the image wrote into `pg_hba.conf`, and the
 *  password is base64url so it needs no URL-escaping. */
function postgresAdminUri(admin: EngineAdmin): string {
    return `postgresql://${admin.user}:${admin.password}@127.0.0.1:5432/postgres`;
}

function postgresSteps(admin: EngineAdmin, slice: WorkspaceSlice): ProvisionStep[] {
    const name = assertIdentifier(slice.identifier);
    const password = assertPassword(slice.password, 'workspace');
    // The admin credential goes into a URI, where a stray `@` or `/` would
    // re-point the connection at another host entirely.
    assertPassword(admin.password, 'admin');
    const uri = postgresAdminUri(admin);
    const psql = (sql: string) => [
        'psql',
        uri,
        '-v',
        'ON_ERROR_STOP=1',
        '-q',
        '-tAc',
        sql,
    ];

    return [
        {
            label: 'role',
            // A DO block because Postgres has no CREATE ROLE IF NOT EXISTS, and
            // the ELSE branch is what makes a re-provision repair a drifted
            // credential rather than fail.
            argv: psql(
                `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
    CREATE ROLE "${name}" LOGIN PASSWORD '${password}';
  ELSE
    ALTER ROLE "${name}" WITH LOGIN PASSWORD '${password}';
  END IF;
END $$;`,
            ),
        },
        {
            label: 'database',
            // CREATE DATABASE cannot run inside a DO block or a transaction, so
            // "already there" is expressed as a tolerated error rather than a
            // conditional.
            argv: psql(`CREATE DATABASE "${name}" OWNER "${name}"`),
            tolerate: /already exists/i,
        },
        {
            label: 'grants',
            // THE load-bearing statement of the shared model. Postgres grants
            // CONNECT on every new database to PUBLIC, so without this REVOKE
            // workspace A's role can open workspace B's database — the whole
            // isolation claim rests on this line.
            argv: psql(
                `REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC; ` +
                    `GRANT ALL PRIVILEGES ON DATABASE "${name}" TO "${name}"; ` +
                    `ALTER DATABASE "${name}" OWNER TO "${name}";`,
            ),
        },
    ];
}

function mysqlSteps(admin: EngineAdmin, slice: WorkspaceSlice): ProvisionStep[] {
    const name = assertIdentifier(slice.identifier);
    const password = assertPassword(slice.password, 'workspace');
    assertPassword(admin.password, 'admin');

    return [
        {
            label: 'database and user',
            argv: [
                'mysql',
                '-h',
                '127.0.0.1',
                `-u${admin.user}`,
                `-p${admin.password}`,
                '-e',
                // MySQL has IF NOT EXISTS for all three, so one script converges.
                // The GRANT is scoped to this schema — never `ON *.*` — which is
                // what keeps one workspace out of another's tables.
                'CREATE DATABASE IF NOT EXISTS `' +
                    name +
                    '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; ' +
                    `CREATE USER IF NOT EXISTS '${name}'@'%' IDENTIFIED BY '${password}'; ` +
                    `ALTER USER '${name}'@'%' IDENTIFIED BY '${password}'; ` +
                    'GRANT ALL PRIVILEGES ON `' +
                    name +
                    "`.* TO '" +
                    name +
                    "'@'%'; FLUSH PRIVILEGES;",
            ],
        },
    ];
}

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
const REDIS_DENIED = [
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

function redisSteps(
    admin: EngineAdmin,
    slice: WorkspaceSlice,
    options: { dedicated?: boolean } = {},
): ProvisionStep[] {
    const name = assertIdentifier(slice.identifier);
    const password = assertPassword(slice.password, 'workspace');
    assertPassword(admin.password, 'admin');

    return [
        {
            label: 'acl user',
            argv: [
                'redis-cli',
                '-h',
                '127.0.0.1',
                '-a',
                admin.password,
                '--no-auth-warning',
                'ACL',
                'SETUSER',
                name,
                // `reset` first: a re-provision is a full redefinition, which is
                // the only way this converges after an engine restart has
                // dropped the in-memory ACL.
                'reset',
                'on',
                `>${password}`,
                // Key patterns apply across every logical DB index, so the
                // prefix is the isolation whether or not the client SELECTs.
                `~${name}:*`,
                `&${name}:*`,
                '+@all',
                ...REDIS_DENIED.filter((command) => !(options.dedicated && command === '-flushdb')),
            ],
        },
    ];
}

/**
 * The policy that admits a MinIO user to its OWN bucket and nothing else.
 *
 * ONE document for every workspace, because `${aws:username}` is resolved by
 * MinIO at request time: a user named `ws-acme-1a2b3c4d` reaches the bucket of
 * that name, and no other. That is what makes this constant — no derived value
 * is interpolated into it, so unlike the SQL statements there is not even a
 * closed alphabet to reason about. It also means a re-provision writes the same
 * bytes, which is how the step converges.
 *
 * Compact and single-quote-free on purpose: it is written from a `printf` inside
 * a single-quoted `sh -c`.
 */
const MINIO_WORKSPACE_POLICY =
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],' +
    '"Resource":["arn:aws:s3:::${aws:username}","arn:aws:s3:::${aws:username}/*"]}]}';

/** Where the policy document is staged inside the engine container. */
const MINIO_POLICY_PATH = '/tmp/genie-workspace-policy.json';

/** The name the policy is registered under, on the engine. */
const MINIO_POLICY_NAME = 'genie-workspace';

/**
 * MinIO: an IAM user per workspace, admitted to one bucket.
 *
 * This engine used to be NAMESPACE-isolated — a bucket name per workspace and
 * the engine's ROOT credential to reach it with. Separation by name is not a
 * boundary: any workspace holding root could `mc rb --force` any other
 * workspace's bucket, an installed Genie App's included (Tynn #250, step 4).
 *
 * The user's access key is the workspace's DNS name (which is also its bucket,
 * so the policy variable lines up) and its secret is the same generated password
 * every other engine already uses. Nothing here needs to be read back out of the
 * engine, which is why MinIO can adopt this and Meilisearch — whose key values
 * are generated server-side — cannot without a way to capture step output.
 *
 * Every step converges: `mb --ignore-existing`, `policy create` overwrites,
 * `user add` resets the secret (which also repairs a drifted credential, exactly
 * as the Postgres role branch does), and re-attaching an attached policy is a
 * no-op. Verified against a real `minio/minio` rather than assumed.
 */
function minioSteps(admin: EngineAdmin, slice: WorkspaceSlice): ProvisionStep[] {
    const bucket = assertDnsName(slice.dnsName);
    const password = assertPassword(slice.password, 'workspace');
    // It goes into an `mc alias set` URL, where a stray character would re-point
    // the client at another host entirely — the same reason postgres asserts it.
    assertPassword(admin.password, 'admin');

    const alias = 'genie';
    const mc = (...argv: string[]) => ['mc', ...argv];

    return [
        {
            label: 'engine alias',
            argv: mc('alias', 'set', alias, 'http://127.0.0.1:9000', admin.user, admin.password),
        },
        {
            label: 'bucket',
            argv: mc('mb', '--ignore-existing', `${alias}/${bucket}`),
        },
        {
            label: 'policy',
            // A file is the only shape `mc admin policy create` takes, so this is
            // the one step that needs a shell. Safe by construction rather than
            // by escaping: everything inside the single quotes is a CONSTANT.
            argv: [
                'sh',
                '-c',
                `printf '%s' '${MINIO_WORKSPACE_POLICY}' > ${MINIO_POLICY_PATH} && ` +
                    `mc admin policy create ${alias} ${MINIO_POLICY_NAME} ${MINIO_POLICY_PATH}`,
            ],
        },
        {
            label: 'user',
            argv: mc('admin', 'user', 'add', alias, bucket, password),
        },
        {
            label: 'policy attachment',
            argv: mc('admin', 'policy', 'attach', alias, MINIO_POLICY_NAME, '--user', bucket),
        },
    ];
}

/**
 * PURE. The commands that carve a workspace's slice out of an engine.
 *
 * An empty list is a real answer, not a gap: for Meilisearch and Mailpit the
 * owner's decision is a per-workspace NAMESPACE — an index prefix, an inbox tag
 * — which is computed and injected as env rather than created by a command.
 * Those workspaces share the engine's master credential, and `catalog.ts` says
 * so where it says `provision: 'namespace'`.
 */
export function provisionSteps(
    engine: ServiceEngine,
    admin: EngineAdmin,
    slice: WorkspaceSlice,
    options: { dedicated?: boolean } = {},
): ProvisionStep[] {
    switch (engineSpecFor(engine).provision) {
        case 'sql-database-role':
            return engine === 'mysql' ? mysqlSteps(admin, slice) : postgresSteps(admin, slice);
        case 'redis-acl':
            return redisSteps(admin, slice, options);
        case 's3-scoped-user':
            return minioSteps(admin, slice);
        default:
            return [];
    }
}

// --- running them -----------------------------------------------------------

export interface ProvisionResult {
    ok: boolean;
    /** Set when `ok` is false: which step, and what the engine said. */
    error?: string;
}

/**
 * Run the steps inside the engine container.
 *
 * Never throws. A provisioning failure is a STATUS the caller reports — the
 * house rule of this whole module, and the one that matters most here, because
 * the caller is an MCP tool and an exception crossing that boundary becomes a
 * tool error with no state attached.
 */
export async function runProvisionSteps(
    runtime: ContainerRuntime,
    containerId: string,
    steps: ProvisionStep[],
): Promise<ProvisionResult> {
    for (const step of steps) {
        try {
            const result = await runtime.exec(containerId, step.argv);
            if (result.code === 0) continue;
            const detail = (result.stderr || result.stdout || '').trim();
            if (step.tolerate?.test(detail)) continue;
            return {
                ok: false,
                error: `provisioning the ${step.label} failed: ${detail || `exit ${result.code}`}`,
            };
        } catch (e) {
            return {
                ok: false,
                error: `provisioning the ${step.label} failed: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            };
        }
    }
    return { ok: true };
}
