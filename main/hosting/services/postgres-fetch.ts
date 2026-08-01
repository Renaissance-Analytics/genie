import path from 'node:path';
import {
    assertDigest,
    defaultFetchSeams,
    engineInstallDir,
    ensureStagedInstall,
    type EnsureInstallOptions,
    type FetchSeams,
} from './fetch-seams';

/**
 * FETCH-ON-FIRST-USE for PostgreSQL (Tynn #232, P3).
 *
 * Same bargain as FrankenPHP: Genie's installer stays small, and a workspace
 * that never asks for a database never pays for one. The first time a workspace
 * enables the `postgres` service we download the official binary distribution,
 * verify it, and keep it under userData keyed by version.
 *
 * ## Where the bytes come from, and why that is the official source
 *
 * PostgreSQL upstream ships SOURCE. The binary distributions for Windows and
 * macOS are built and published by EDB, and postgresql.org's own download pages
 * are what send users there ("Binaries without installer"). So `get.enterprisedb.com`
 * is not a mirror we picked — it is the distribution channel the project points
 * at, and it is pinned here by exact version and file name.
 *
 * ## Why the digest is PINNED IN THIS FILE, unlike FrankenPHP's
 *
 * `frankenphp-fetch.ts` reads GitHub's published `digest` over a second TLS
 * connection and compares. EDB publishes no machine-readable digest at all — so
 * fetching "the expected hash" from the same host that serves the bytes would
 * verify nothing.
 *
 * The alternative is what this file does: the sha256 of each artifact is a
 * CONSTANT, measured once from a real download and reviewed into the source, the
 * way a lockfile or a Homebrew formula pins one. That is strictly stronger than
 * a same-origin digest — changing it requires changing reviewed, committed code,
 * not compromising a JSON endpoint. The cost is that bumping the version is a
 * deliberate two-line change with a hash that has to be re-measured, which is
 * exactly the friction a runtime this privileged should have.
 *
 * Measured 2026-08-01 by downloading each artifact and hashing it.
 *
 * ## Platform coverage
 *
 * Windows x64 and macOS are fetchable; the macOS artifact is a UNIVERSAL Mach-O
 * (verified: fat header, x86_64 + arm64), so one file covers Intel and Apple
 * Silicon. EDB publishes NO Linux build — on Linux the distro is the supported
 * channel, so {@link assetFor} returns null there and the runtime falls back to
 * a PostgreSQL already on the machine (see `postgres.ts#discoverSystemPostgres`),
 * which is what Genie Cloud's Linux image provides.
 *
 * Everything above `--- thin impure ---` is pure and unit-tested; the I/O is the
 * shared {@link FetchSeams}, so no test here downloads 330 MB.
 */

// --- the pinned release ----------------------------------------------------

/**
 * The PostgreSQL release Genie installs.
 *
 * Pinned, never "latest": a user's cluster is initialised by a specific
 * `initdb`, and a data directory written by one major version cannot be read by
 * another. Moving this without a migration path would strand every existing
 * workspace database, so it is a deliberate change, not a floating dependency.
 */
export const POSTGRES_VERSION = '17.6';

/** EDB's build number for {@link POSTGRES_VERSION}. Part of the file name. */
const POSTGRES_BUILD = '1';

const EDB_BASE = 'https://get.enterprisedb.com/postgresql';

export interface PostgresAsset {
    name: string;
    url: string;
    /** The pinned sha256 — see the file header on why it is a constant. */
    sha256: string;
    /** Archive members worth unpacking (see {@link FetchSeams.extract}). */
    members: readonly string[];
}

/**
 * What the archive actually contains that we need.
 *
 * `bin/` is the servers and tools, `lib/` the loadable modules, `share/` the
 * bootstrap catalogue `initdb` reads — without `share` a cluster cannot be
 * created at all. Everything else in the zip is pgAdmin (a 30 MB desktop GUI),
 * StackBuilder and 20 MB of HTML documentation, none of which a managed
 * background cluster has any use for.
 */
const WANTED_MEMBERS = ['pgsql/bin', 'pgsql/lib', 'pgsql/share'] as const;

/**
 * PURE. The artifact for a platform/arch, or `null` when upstream publishes
 * none.
 *
 * Returning `null` rather than guessing is the same call `assetNameFor` makes in
 * `frankenphp-fetch.ts`: handing a machine an executable it cannot run turns
 * into a service that mysteriously refuses to start, far from the code that
 * chose the file.
 */
export function assetFor(platform: NodeJS.Platform | string, arch: string): PostgresAsset | null {
    const v = `${POSTGRES_VERSION}-${POSTGRES_BUILD}`;
    if (platform === 'win32') {
        if (arch !== 'x64') return null;
        const name = `postgresql-${v}-windows-x64-binaries.zip`;
        return {
            name,
            url: `${EDB_BASE}/${name}`,
            sha256: 'd378882abd001a186735acd6f6ba716bca6ccd192e800412d4fd15ed25376b3e',
            members: WANTED_MEMBERS,
        };
    }
    if (platform === 'darwin') {
        // One artifact for both Macs — the binaries are a universal Mach-O.
        if (arch !== 'x64' && arch !== 'arm64') return null;
        const name = `postgresql-${v}-osx-binaries.zip`;
        return {
            name,
            url: `${EDB_BASE}/${name}`,
            sha256: '5afb85f5d764176bb00a527cfc5dd9127b9f8efaa33f5a9afbedbf6ceb985fcc',
            members: WANTED_MEMBERS,
        };
    }
    // Linux: no EDB binary distribution exists. See the file header.
    return null;
}

// --- pure: where it lands --------------------------------------------------

export interface PostgresLayout {
    /** Directory holding `initdb`, `postgres`, `psql`, … */
    binDir: string;
    /** ABSOLUTE path to the server executable. */
    serverPath: string;
    initdbPath: string;
    psqlPath: string;
    createdbPath: string;
    /** `pg_ctl` — how a cluster is shut down CLEANLY; see `postgres.ts#stop`. */
    pgCtlPath: string;
}

const exe = (platform: NodeJS.Platform | string, name: string): string =>
    platform === 'win32' ? `${name}.exe` : name;

/** PURE. Where the tools sit inside an installed (or system) PostgreSQL. */
export function layoutForBinDir(
    binDir: string,
    platform: NodeJS.Platform | string,
): PostgresLayout {
    return {
        binDir,
        serverPath: path.join(binDir, exe(platform, 'postgres')),
        initdbPath: path.join(binDir, exe(platform, 'initdb')),
        psqlPath: path.join(binDir, exe(platform, 'psql')),
        createdbPath: path.join(binDir, exe(platform, 'createdb')),
        pgCtlPath: path.join(binDir, exe(platform, 'pg_ctl')),
    };
}

/** PURE. The bin directory inside an install created by this module. The archive
 *  nests everything under `pgsql/`. */
export function installedBinDir(installDir: string): string {
    return path.join(installDir, 'pgsql', 'bin');
}

export function postgresInstallDir(baseDir: string, version = POSTGRES_VERSION): string {
    return engineInstallDir(baseDir, 'postgres', version);
}

// --- thin impure -----------------------------------------------------------

export interface PostgresInstall extends PostgresLayout {
    version: string;
    installDir: string;
    /** True when THIS call performed the download (i.e. first use). */
    downloaded: boolean;
    /** True when these binaries were found on the machine rather than fetched. */
    system: boolean;
}

/**
 * Ensure PostgreSQL is installed, downloading it once.
 *
 * Safe to call on every service start: an installed runtime short-circuits
 * before any network request.
 */
export async function ensurePostgres(opts: EnsureInstallOptions): Promise<PostgresInstall> {
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    const seams: FetchSeams = opts.seams ?? defaultFetchSeams;

    const asset = assetFor(platform, arch);
    if (!asset) {
        throw new Error(
            `postgres: no official binary distribution for ${platform}/${arch} — ` +
                'install PostgreSQL through the system package manager and Genie will use it',
        );
    }

    const installDir = postgresInstallDir(opts.baseDir);
    const layout = layoutForBinDir(installedBinDir(installDir), platform);

    const downloaded = await ensureStagedInstall(
        {
            installDir,
            sentinel: layout.serverPath,
            resolve: () => ({
                url: asset.url,
                assetName: asset.name,
                members: asset.members,
                verify: (d) => assertDigest(asset.name, 'sha256', asset.sha256, d.sha256),
            }),
        },
        opts.baseDir,
        seams,
        opts.onPhase,
    );

    return { ...layout, version: POSTGRES_VERSION, installDir, downloaded, system: false };
}
