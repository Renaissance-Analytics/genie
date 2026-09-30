import { describe, expect, it } from 'vitest';
import { DEFAULT_VERSIONS, SERVICE_ENGINES, engineSpecFor, workspaceDnsName } from '../catalog';
import { provisionSteps } from '../provision';
import { serviceEnv, serviceOfEnvKey } from '../env-wiring';
import type { EngineAdmin, WorkspaceSlice } from '../provision';

/**
 * SEAWEEDFS — the S3 engine, replacing MinIO (genie#758).
 *
 * MinIO withdrew its images from BOTH registries. Measured 2026-09-30 with
 * anonymous manifest GETs: `quay.io/minio/minio:latest` 401,
 * `docker.io/minio/minio:latest` 401, Hub's tag list `object not found`, while
 * `library/redis:7-alpine` returned 200 from the same probe. So the S3 engine was
 * broken for every user, not merely in CI.
 *
 * Everything asserted here was read out of SeaweedFS's own source at tag 4.48,
 * not from a blog post — the flag names, the config shape, and the provisioning
 * command all have a specific file behind them, cited at the assertion.
 */
const ADMIN: EngineAdmin = { user: 'genie', password: 'admin_pw_0123456789' };

const slice = (name: string): WorkspaceSlice => ({
    identifier: name.replace(/-/g, '_'),
    dnsName: workspaceDnsName(name),
    password: `${name}_pw_0123456789`,
});

describe('the engine is in the catalog', () => {
    it('is offered as a service engine', () => {
        expect(SERVICE_ENGINES).toContain('seaweedfs');
    });

    it('pins a REAL VERSION, which is the whole reason it replaces MinIO', () => {
        // `catalog.ts` used to explain MinIO's `latest` like this: "MinIO tags are
        // release TIMESTAMPS, not majors, so there is no stable major to pin".
        // `latest` was therefore the honest default — and when `latest` stopped
        // being served, the engine went with it.
        //
        // SeaweedFS publishes dotted semver, so there is something to pin, and an
        // engine whose ref cannot move under a user on restart is the point.
        const spec = engineSpecFor('seaweedfs');

        expect(spec.image(DEFAULT_VERSIONS.seaweedfs)).toBe('chrislusf/seaweedfs:4.48');
        expect(spec.versions).not.toContain('latest');
        for (const v of spec.versions) {
            expect(v).toMatch(/^\d+\.\d+$/);
        }
    });

    it('serves S3 on 8333, the port weed actually listens on', () => {
        // weed/command/server.go:167 — `s3.port` defaults to 8333. MinIO's was
        // 9000, so carrying that over would publish a port nothing serves.
        const spec = engineSpecFor('seaweedfs');
        const s3 = spec.ports.find((p) => p.name === 's3');

        expect(s3).toBeDefined();
        expect(s3?.container).toBe(8333);
        expect(s3?.primary).toBe(true);
    });

    it('carves a workspace out as an S3-scoped user, exactly as MinIO did', () => {
        // The slice strategy is what `provision.ts` dispatches on and what
        // `env-wiring.ts` hands an app. Changing engines must not change the
        // shape of a workspace's access.
        expect(engineSpecFor('seaweedfs').provision).toBe('s3-scoped-user');
    });

    it('persists its data, and NOT in /tmp', () => {
        // `weed/command/server.go:67` — `-dir` defaults to `os.TempDir()`, so an
        // engine started without it writes every workspace's objects somewhere
        // that survives neither a restart nor a tmp sweep.
        //
        // The image entrypoint's `server` case supplies `-dir=/data` itself, so
        // the property to assert is that we ROUTE THROUGH it and do not pass a
        // `-dir` of our own — a second `-dir` would override the right one, and
        // bypassing the entrypoint would drop it entirely.
        const spec = engineSpecFor('seaweedfs');
        const volume = spec.volumes.find((v) => v.suffix === 'data');

        expect(volume).toBeDefined();
        expect(volume?.target).toBe('/data');

        const argv = (spec.entrypoint?.(ADMIN.password) ?? []).join(' ');
        expect(argv).toContain('/entrypoint.sh server');
        expect(argv).not.toMatch(/-dir=/);
    });
});

describe('the S3 gateway comes up AUTHENTICATED', () => {
    // THE SECURITY PROPERTY, and the one real difference from MinIO.
    //
    // weed/s3api/auth_credentials.go:414 —
    //     iam.isAuthEnabled = identityCount > 0 || startConfigFile != ""
    // and the comment two lines below: "No config file and no identities - this
    // is the normal allow-all case".
    //
    // MinIO took root credentials from env, so auth was on from its first second.
    // SeaweedFS started the same naive way is ALLOW-ALL: every workspace's bucket
    // on that host anonymously readable AND writable, permanently so if
    // provisioning ever failed. Passing a config file is what makes it
    // fail-CLOSED — line 422 warns that a file loading zero identities denies
    // every request, which is the safe direction to be wrong in.
    const argv = () => engineSpecFor('seaweedfs').entrypoint?.(ADMIN.password) ?? [];

    it('starts weed with an -s3.config, so auth is enabled before the port is served', () => {
        expect(argv().join(' ')).toMatch(/-s3\.config=\S+/);
    });

    it('writes that config in the same command that starts the server', () => {
        // Not a later provisioning step. Anything that configures the identity
        // AFTER boot leaves a window in which the gateway is open, and the whole
        // point is that there is no such window.
        const joined = argv().join(' ');
        const configPath = /-s3\.config=(\S+)/.exec(joined)?.[1];

        expect(configPath).toBeDefined();
        // The file is created, and the server is exec'd after it.
        expect(joined).toContain(configPath as string);
        expect(joined).toMatch(/exec\s+\/entrypoint\.sh\s+server/);
        expect(joined.indexOf(configPath as string)).toBeLessThan(joined.indexOf('exec /entrypoint.sh'));
    });

    it('seeds the admin identity with the password it was given', () => {
        expect(argv().join(' ')).toContain(ADMIN.password);
    });

    it('uses the PLURAL `identities` key — the singular silently denies everything', () => {
        // auth_credentials.go:669 documents exactly this trap: 'A singular
        // "identity" otherwise loads as an empty config, which denies every
        // request with nothing pointing at the mistake.' SeaweedFS logs a warning
        // and carries on, so the symptom is a working engine that refuses
        // everyone — which reads as a credential bug, not a typo.
        const joined = argv().join(' ');

        expect(joined).toContain('"identities"');
        expect(joined).not.toMatch(/"identity"\s*:/);
    });

    it('embeds JSON that actually parses, with the credential fields weed reads', () => {
        // weed/pb/iam.proto:198 — Credential is access_key / secret_key, parsed
        // by the protobuf JSON parser, which accepts either spelling. A config
        // that does not parse is a config that loads zero identities.
        const joined = argv().join(' ');
        const json = /(\{"identities".*?\}\]\})/.exec(joined)?.[1];

        expect(json, `no identities JSON found in: ${joined}`).toBeDefined();

        const parsed = JSON.parse(json as string) as {
            identities: Array<{
                name: string;
                credentials: Array<{ accessKey?: string; secretKey?: string }>;
                actions: string[];
            }>;
        };

        expect(parsed.identities).toHaveLength(1);
        expect(parsed.identities[0].credentials[0].accessKey).toBe(ADMIN.user);
        expect(parsed.identities[0].credentials[0].secretKey).toBe(ADMIN.password);
        // Admin, because this identity is what `s3.configure` runs as when it
        // creates every workspace's scoped user.
        expect(parsed.identities[0].actions).toContain('Admin');
    });
});

describe('provisioning one workspace', () => {
    const steps = () => provisionSteps('seaweedfs', ADMIN, slice('acme-app'));

    it('creates the bucket and a user scoped to it', () => {
        const argv = steps().map((s) => s.argv.join(' '));

        expect(argv.some((a) => a.includes('s3.bucket.create') && a.includes('acme-app'))).toBe(true);
        expect(argv.some((a) => a.includes('s3.configure'))).toBe(true);
    });

    it('SUPPLIES the workspace credential rather than letting the engine mint one', () => {
        // The decisive reason `s3.configure` is used and `s3.user.provision` is
        // not. `provision.ts` cannot capture step output — its own comments say
        // so — and command_s3_user_provision.go:158 GENERATES the access key. An
        // engine that invents the secret cannot be provisioned by Genie at all,
        // because nothing could tell the workspace what its password is.
        const s = slice('acme-app');
        const joined = provisionSteps('seaweedfs', ADMIN, s)
            .map((step) => step.argv.join(' '))
            .join(' | ');

        expect(joined).toContain(`-access_key ${s.dnsName}`);
        expect(joined).toContain(`-secret_key ${s.password}`);
    });

    it('scopes the user to its OWN bucket and no other', () => {
        const s = slice('acme-app');
        const configure = provisionSteps('seaweedfs', ADMIN, s)
            .map((step) => step.argv.join(' '))
            .find((a) => a.includes('s3.configure')) as string;

        expect(configure).toContain(`-buckets ${s.dnsName}`);
        // One bucket. A comma-separated list here would hand a workspace another
        // workspace's storage, which is the boundary this whole strategy exists
        // to draw.
        expect(/-buckets\s+([^\s]+)/.exec(configure)?.[1]).toBe(s.dnsName);
    });

    it('never grants Admin to a workspace', () => {
        // An Admin identity can read, write and delete every bucket on the
        // engine, and `-s3.autoCreateBucket` (server.go:185) lets admins create
        // buckets implicitly on upload. Granting it here would make the bucket
        // scope decorative.
        const configure = steps()
            .map((step) => step.argv.join(' '))
            .find((a) => a.includes('s3.configure')) as string;

        const actions = /-actions\s+([^\s]+)/.exec(configure)?.[1] ?? '';
        expect(actions.split(',')).not.toContain('Admin');
        expect(actions).toContain('Read');
        expect(actions).toContain('Write');
    });

    it('applies the change — without -apply it is a simulation', () => {
        // command_s3_configure.go:57 — `-apply` is a flag, and the code prints
        // the would-be identity and RETURNS when it is absent. Omitting it makes
        // provisioning report success having changed nothing at all.
        const configure = steps()
            .map((step) => step.argv.join(' '))
            .find((a) => a.includes('s3.configure')) as string;

        expect(configure).toContain('-apply');
    });

    it('points weed shell at the master and filer, which have no defaults', () => {
        // weed/command/shell.go:23-25 — `-master` and `-filer` are both empty
        // strings by default, so a bare `weed shell` connects to nothing. The
        // ports are `weed server`'s own: master 9333, filer 8888.
        const joined = steps()
            .map((step) => step.argv.join(' '))
            .join(' | ');

        expect(joined).toContain('-master=localhost:9333');
        expect(joined).toContain('-filer=localhost:8888');
    });

    it('tolerates an EXISTING bucket, and nothing else', () => {
        // `s3.bucket.create` has no `-ignoreExisting` and returns `bucket %s
        // already exists` — a non-zero exit. Provisioning runs on every acquire,
        // so without this the SECOND run fails and every restart breaks.
        //
        // Caught by the real-container test after this file had already claimed
        // convergence: the claim was reasoned from `s3.configure` being
        // convergent rather than read off `s3.bucket.create`.
        const bucketStep = steps()
            .map((step) => step.argv.join(' '))
            .find((a) => a.includes('s3.bucket.create')) as string;

        expect(bucketStep).toContain("already exists");
        expect(bucketStep).toContain('exit 0');

        // NOT a blanket tolerance. `|| true` would swallow a real failure — no
        // filer, no permission, a malformed name — behind a step that reported
        // success having made no bucket.
        expect(bucketStep).not.toMatch(/\|\|\s*true/);
        expect(bucketStep).toContain('exit 1');
    });

    it('is CONVERGENT, so re-provisioning an existing workspace is safe', () => {
        // command_s3_configure.go GetUser -> CreateUser on NotFound -> UpdateUser
        // otherwise, and `s3.bucket.create` on an existing bucket is a no-op.
        // Genie re-runs provisioning, so a step that failed the second time would
        // break every restart. Same argv twice is the shape that relies on it.
        const first = provisionSteps('seaweedfs', ADMIN, slice('acme-app')).map((s) => s.argv);
        const second = provisionSteps('seaweedfs', ADMIN, slice('acme-app')).map((s) => s.argv);

        expect(second).toEqual(first);
    });

    it('gives two workspaces different buckets and different credentials', () => {
        const a = slice('acme-app');
        const b = slice('beta-app');
        const flat = (s: WorkspaceSlice) =>
            provisionSteps('seaweedfs', ADMIN, s).map((step) => step.argv.join(' ')).join(' | ');

        expect(flat(a)).not.toBe(flat(b));
        expect(flat(a)).not.toContain(b.dnsName);
        expect(flat(a)).not.toContain(b.password);
    });

    it('never puts the ADMIN password into a workspace step', () => {
        // Except where it must: authenticating the shell. The workspace's own
        // `-secret_key` must never be the engine's root secret — that was the
        // pre-#250 MinIO defect, where every workspace got the root credential.
        const s = slice('acme-app');
        const configure = provisionSteps('seaweedfs', ADMIN, s)
            .map((step) => step.argv.join(' '))
            .find((a) => a.includes('s3.configure')) as string;

        expect(/-secret_key\s+([^\s]+)/.exec(configure)?.[1]).toBe(s.password);
        expect(/-secret_key\s+([^\s]+)/.exec(configure)?.[1]).not.toBe(ADMIN.password);
    });
});

describe('what an app is handed', () => {
    const provisioned = (engine: 'seaweedfs' | 'minio') => ({
        engine,
        host: `genie-svc-${engine}`,
        port: engine === 'seaweedfs' ? 8333 : 9000,
        slice: slice('acme-app'),
    });

    it('emits the SAME AWS_* contract MinIO did', () => {
        // The point of choosing an S3-compatible engine: an app's configuration
        // does not change. Laravel's s3 driver, the AWS SDKs and anything reading
        // AWS_* keep working, so swapping the engine is not a migration for the
        // application — only for the storage behind it.
        const env = serviceEnv([provisioned('seaweedfs')]);

        expect(env.AWS_ENDPOINT).toBe('http://genie-svc-seaweedfs:8333');
        expect(env.AWS_ACCESS_KEY_ID).toBe(slice('acme-app').dnsName);
        expect(env.AWS_SECRET_ACCESS_KEY).toBe(slice('acme-app').password);
        expect(env.AWS_BUCKET).toBe(slice('acme-app').dnsName);
        expect(env.AWS_DEFAULT_REGION).toBe('us-east-1');
        // SeaweedFS serves buckets as a path, like MinIO — a virtual-host style
        // client would look for `bucket.host`, which resolves to nothing here.
        expect(env.AWS_USE_PATH_STYLE_ENDPOINT).toBe('true');
    });

    it('hands the WORKSPACE credential, never the engine admin', () => {
        // The pre-#250 defect, and the reason `s3-scoped-user` exists: every
        // workspace used to receive the engine's root credential, so "workspace A
        // deletes workspace B's bucket" was documented behaviour rather than a
        // boundary failure.
        const env = serviceEnv([{ ...provisioned('seaweedfs'), adminPassword: ADMIN.password }]);

        // Asserted present FIRST. "is not the admin password" is trivially true
        // of a key that was never emitted, so without this the test passes for a
        // workspace that got no S3 credential at all.
        expect(env.AWS_SECRET_ACCESS_KEY).toBe(slice('acme-app').password);
        expect(env.AWS_SECRET_ACCESS_KEY).not.toBe(ADMIN.password);
        expect(Object.values(env)).not.toContain(ADMIN.password);
    });

    it('produces byte-identical AWS_* keys for either S3 engine', () => {
        // Which is exactly why `serviceOfEnvKey` cannot tell them apart from a
        // key alone — see the comment on ENGINE_OF_KEY.
        const seaweed = Object.keys(serviceEnv([provisioned('seaweedfs')])).sort();
        const minio = Object.keys(serviceEnv([provisioned('minio')])).sort();

        expect(seaweed).toEqual(minio);
    });

    it('attributes an AWS_ key to a service rather than to nothing', () => {
        // `serviceOfEnvKey` turns a list of missing keys into a sentence a person
        // can act on. A key it cannot attribute degrades that message silently.
        expect(serviceOfEnvKey('AWS_BUCKET', {})).not.toBeNull();
        expect(serviceOfEnvKey('GENIE_AWS_BUCKET', {})).not.toBeNull();
    });
});

describe('MinIO is RETIRED, not silently still on offer', () => {
    it('is marked retired, with a reason and a replacement', () => {
        // Leaving `minio` addable would promise an engine that cannot start: both
        // registries refuse its images, so `add` would succeed and the container
        // would fail to pull with `unauthorized` — the exact "whitelisted,
        // advertised, and not deliverable" shape the Postgres image header
        // complains about.
        //
        // It stays IN the catalog on purpose. Workspaces provisioned before the
        // withdrawal have `minio` service rows, and removing the engine would make
        // them unresolvable rather than merely unstartable.
        const minio = engineSpecFor('minio');

        expect(minio.retired).toBeDefined();
        expect(minio.retired?.replacement).toBe('seaweedfs');
        expect(minio.retired?.reason).toMatch(/image/i);
    });

    it('leaves the SHIPPING engine addable', () => {
        // The positive control: a guard that retired everything would satisfy the
        // assertion above and break every engine.
        expect(engineSpecFor('seaweedfs').retired).toBeUndefined();
        expect(engineSpecFor('postgres').retired).toBeUndefined();
    });

    it('keeps minio resolvable, so existing service rows still have a spec', () => {
        expect(SERVICE_ENGINES).toContain('minio');
        expect(engineSpecFor('minio').provision).toBe('s3-scoped-user');
    });
});
