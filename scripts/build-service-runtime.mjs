// @ts-check
/**
 * build-service-runtime.mjs — produce `resources/runtime/` for the per-user
 * OS-service pty-host (fancy-term-host@0.2.0 `/service`).
 *
 * WHAT IT SHIPS (consumed by main/terminal/host-service.ts resolveShippedRuntime):
 *
 *   resources/runtime/
 *     node[.exe]        a PINNED standalone Node (the service's own runtime —
 *                       NOT Genie's Electron binary, so it never pins the app
 *                       across an auto-update)
 *     node-pty/         the node-pty package (lib/ + prebuilds/ + package.json …)
 *                       whose native binding loads under that standalone Node's
 *                       ABI. resolveShippedRuntime() points the service at
 *                       runtime.nodePath = <runtime>/node[.exe] and
 *                       runtime.nodePtyDir = <runtime>  (the service sets
 *                       NODE_PATH=<runtime>, so the host's `require('node-pty')`
 *                       resolves to <runtime>/node-pty).
 *
 * WHY NODE 20 (and why no ABI rebuild is required):
 *   node-pty@1.1.0 is an N-API addon (node-addon-api ^7 → Node-API). Its
 *   shipped `prebuilds/<plat>-<arch>/*.node` are N-API binaries, which are
 *   ABI-STABLE across Node major versions AND across Electron. So a single
 *   prebuild loads on Node 20, Node 22, and Genie's Electron alike — there is
 *   no per-Node-ABI recompile to do. We still PIN Node 20.20.2 (Iron LTS): it
 *   is the exact line the release/CI workflows already use (setup-node 20) and
 *   the line node-pty publishes/validates its prebuilds against, so the runtime
 *   we ship matches what the rest of the pipeline is built and tested on.
 *
 *   The script nonetheless VERIFIES the binding actually loads under the
 *   downloaded standalone Node (`<runtime>/node -e require('node-pty')`), so a
 *   green run is real proof the shipped node-pty works on the shipped node —
 *   not an assumption.
 *
 * Cross-platform: win/mac/linux × x64/arm64. Idempotent: wipes and recreates
 * resources/runtime/ each run. `resources/runtime/` is a build artifact and is
 * gitignored.
 *
 * Usage:
 *   node scripts/build-service-runtime.mjs                  # current OS/arch
 *   node scripts/build-service-runtime.mjs --platform win32 --arch x64
 *   NODE_RUNTIME_VERSION=20.20.2 node scripts/build-service-runtime.mjs
 */

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import https from 'node:https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Pinned standalone Node — Iron LTS, the line CI/release setup-node 20 uses. */
const NODE_VERSION = process.env.NODE_RUNTIME_VERSION || '20.20.2';

/** Parse `--platform x --arch y` overrides; default to the current process. */
function parseArgs(argv) {
    const out = { platform: process.platform, arch: process.arch };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--platform') out.platform = argv[++i];
        else if (argv[i] === '--arch') out.arch = argv[++i];
    }
    return out;
}

const { platform, arch } = parseArgs(process.argv.slice(2));

// Map Node's process.platform/arch → the nodejs.org dist naming.
const DIST_OS = { win32: 'win', darwin: 'darwin', linux: 'linux' };
const DIST_ARCH = { x64: 'x64', arm64: 'arm64' };

function die(msg) {
    console.error(`\x1b[31m[build-service-runtime] ${msg}\x1b[0m`);
    process.exit(1);
}
function log(msg) {
    console.log(`\x1b[36m[build-service-runtime]\x1b[0m ${msg}`);
}

const distOs = DIST_OS[platform];
const distArch = DIST_ARCH[arch];
if (!distOs) die(`unsupported platform: ${platform}`);
if (!distArch) die(`unsupported arch: ${arch}`);

const RUNTIME_DIR = path.join(REPO_ROOT, 'resources', 'runtime');
const NODE_BIN_NAME = platform === 'win32' ? 'node.exe' : 'node';

/** GET a URL to a Buffer, following redirects. */
function fetchBuffer(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(url, (res) => {
                if (
                    res.statusCode &&
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location
                ) {
                    if (redirects <= 0) return reject(new Error('too many redirects'));
                    res.resume();
                    return resolve(fetchBuffer(res.headers.location, redirects - 1));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`GET ${url} → ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            })
            .on('error', reject);
    });
}

/** Stream a URL to a file, following redirects. */
function downloadToFile(url, dest, redirects = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(url, (res) => {
                if (
                    res.statusCode &&
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location
                ) {
                    if (redirects <= 0) return reject(new Error('too many redirects'));
                    res.resume();
                    return resolve(downloadToFile(res.headers.location, dest, redirects - 1));
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`GET ${url} → ${res.statusCode}`));
                }
                pipeline(res, createWriteStream(dest)).then(resolve, reject);
            })
            .on('error', reject);
    });
}

/**
 * Download the pinned standalone Node and place its `node`/`node.exe` at
 * resources/runtime/node[.exe]. Windows ships a bare node.exe; mac/linux ship a
 * .tar.gz whose `bin/node` we extract.
 */
async function fetchStandaloneNode(tmpDir) {
    const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
    if (platform === 'win32') {
        const url = `${base}/win-${distArch}/node.exe`;
        const dest = path.join(RUNTIME_DIR, 'node.exe');
        log(`downloading standalone Node ${NODE_VERSION} (win-${distArch})…`);
        await downloadToFile(url, dest);
        return dest;
    }

    // mac/linux: pull the tarball, extract only bin/node.
    const tarName = `node-v${NODE_VERSION}-${distOs}-${distArch}.tar.gz`;
    const url = `${base}/${tarName}`;
    log(`downloading standalone Node ${NODE_VERSION} (${distOs}-${distArch})…`);
    const tarPath = path.join(tmpDir, tarName);
    await downloadToFile(url, tarPath);

    // Extract bin/node from the tarball. `tar` is present on macOS & Linux runners.
    const innerDir = `node-v${NODE_VERSION}-${distOs}-${distArch}`;
    execFileSync('tar', ['-xzf', tarPath, '-C', tmpDir, `${innerDir}/bin/node`], {
        stdio: 'inherit',
    });
    const extracted = path.join(tmpDir, innerDir, 'bin', 'node');
    const dest = path.join(RUNTIME_DIR, 'node');
    await fs.copyFile(extracted, dest);
    await fs.chmod(dest, 0o755);
    return dest;
}

/**
 * Produce an ABI-matched node-pty package at resources/runtime/node-pty/.
 *
 * node-pty@1.1.0 ships N-API prebuilds (ABI-stable), so we install a clean copy
 * (which brings down `prebuilds/<plat>-<arch>/`) and copy the package. When the
 * target platform/arch differs from the host (cross-build), npm still fetches
 * the package incl. its cross-platform prebuilds, so the right `.node` is present.
 *
 * We install with --ignore-scripts (skip node-pty's gyp `install` hook — we want
 * the published prebuilds, not a host-ABI source build) into a scratch dir, then
 * copy node_modules/node-pty (+ its node-addon-api dep) into runtime/node-pty.
 */
async function buildNodePty(tmpDir) {
    const scratch = path.join(tmpDir, 'np');
    await fs.mkdir(scratch, { recursive: true });
    await fs.writeFile(
        path.join(scratch, 'package.json'),
        JSON.stringify({ name: 'np-scratch', private: true, version: '0.0.0' }) + '\n',
    );

    // Match the version Genie depends on. Reading it from genie's package.json
    // keeps the runtime in lockstep with the app's node-pty.
    const geniePkg = JSON.parse(
        await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const nodePtySpec = geniePkg.dependencies?.['node-pty'] || '^1.1.0';
    log(`installing node-pty@${nodePtySpec} (prebuilds) into scratch dir…`);

    // On Windows, npm is npm.cmd; Node's execFileSync can't spawn a .cmd
    // directly (EINVAL since the CVE-2024-27980 fix) — go through the shell.
    const isWin = process.platform === 'win32';
    const npm = isWin ? 'npm.cmd' : 'npm';
    execFileSync(
        npm,
        ['install', `node-pty@${nodePtySpec}`, '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: scratch, stdio: 'inherit', shell: isWin },
    );

    const src = path.join(scratch, 'node_modules', 'node-pty');
    if (!existsSync(src)) die('node-pty was not installed into the scratch dir');

    // Confirm the prebuild for the TARGET platform/arch is present.
    const prebuildDir = path.join(src, 'prebuilds', `${platform}-${arch}`);
    if (!existsSync(prebuildDir)) {
        die(
            `node-pty has no prebuild for ${platform}-${arch} at ${prebuildDir} — ` +
                `cannot ship an ABI-matched binding`,
        );
    }

    const dest = path.join(RUNTIME_DIR, 'node-pty');
    await copyDir(src, dest);

    // node-pty depends on node-addon-api at runtime only for its headers during a
    // source build; the prebuilt path doesn't require it at runtime. But copy the
    // package's own nested node_modules if present so nothing dangles.
    const nestedNm = path.join(src, 'node_modules');
    if (existsSync(nestedNm)) {
        await copyDir(nestedNm, path.join(dest, 'node_modules'));
    }

    return dest;
}

/** Recursive copy (dirs + files + exec bits), no symlink following surprises. */
async function copyDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const e of entries) {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) {
            await copyDir(s, d);
        } else if (e.isSymbolicLink()) {
            const link = await fs.readlink(s);
            await fs.symlink(link, d).catch(() => {});
        } else {
            await fs.copyFile(s, d);
            // Preserve exec bit (spawn-helper on mac, node.exe etc.)
            const st = await fs.stat(s);
            await fs.chmod(d, st.mode).catch(() => {});
        }
    }
}

/**
 * Verify the shipped node-pty actually loads under the shipped standalone Node,
 * exactly the way the service runs it: NODE_PATH=<runtime>, require('node-pty').
 * Skipped on a cross-build (can't exec a foreign-platform node binary here).
 */
function verifyLoads(nodePath) {
    const crossBuild = platform !== process.platform || arch !== process.arch;
    if (crossBuild) {
        log(
            `skipping load-verify (cross-build ${process.platform}-${process.arch} → ${platform}-${arch}; ` +
                `the foreign node binary can't run on this host)`,
        );
        return;
    }
    log('verifying node-pty loads under the standalone Node (NODE_PATH=<runtime>)…');
    const script =
        "const pty = require('node-pty');" +
        "if (typeof pty.spawn !== 'function') { throw new Error('node-pty.spawn missing'); }" +
        "console.log('node-pty loaded OK on standalone Node ' + process.version);";
    execFileSync(nodePath, ['-e', script], {
        cwd: RUNTIME_DIR,
        env: { ...process.env, NODE_PATH: RUNTIME_DIR },
        stdio: 'inherit',
    });
}

async function main() {
    log(`target ${platform}-${arch}, Node ${NODE_VERSION}`);

    // Idempotent: wipe + recreate.
    await fs.rm(RUNTIME_DIR, { recursive: true, force: true });
    await fs.mkdir(RUNTIME_DIR, { recursive: true });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'genie-runtime-'));
    try {
        const nodePath = await fetchStandaloneNode(tmpDir);
        if (platform !== 'win32') await fs.chmod(nodePath, 0o755);
        log(`standalone Node → ${path.relative(REPO_ROOT, nodePath)}`);

        const nodePtyDir = await buildNodePty(tmpDir);
        log(`node-pty → ${path.relative(REPO_ROOT, nodePtyDir)}`);

        verifyLoads(nodePath);

        log('\x1b[32mresources/runtime/ built successfully.\x1b[0m');
        log(`layout:`);
        log(`  resources/runtime/${NODE_BIN_NAME}`);
        log(`  resources/runtime/node-pty/  (incl. prebuilds/${platform}-${arch})`);
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

main().catch((e) => die(e?.stack || String(e)));
