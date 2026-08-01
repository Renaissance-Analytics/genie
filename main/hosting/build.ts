import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * BUILD-ON-FIRST-USE for static sites (Tynn #232, P2).
 *
 * A hosted frontend serves what a BUILD produced — hashed, same-origin assets in
 * a `dist/` — never a dev server. That is the entire reason a hosted origin is
 * stable enough to carry over a tunnel: no second Vite port, no HMR socket, no
 * absolute asset URLs baked at request time.
 *
 * So the runtime has to be able to produce that `dist/` for a user who has never
 * run a build, and it has to fail LOUDLY and specifically when it cannot —
 * "your site is up" over an empty directory is exactly the class of quiet
 * brokenness this whole runtime exists to remove.
 *
 * Pure: {@link buildPlanFor} (what to run) and the executable helpers. Impure:
 * {@link ensureBuilt}, whose fs + spawn access is injected.
 */

// --- pure: what to run -----------------------------------------------------

export interface BuildPlan {
    command: string;
    args: string[];
}

/**
 * `npm` on Windows is a batch file; only `npm.cmd` is executable.
 *
 * And since the CVE-2024-27980 hardening, Node REFUSES to spawn a `.cmd` or
 * `.bat` at all without `shell: true` — `spawn('npm.cmd', …, { shell: false })`
 * fails outright with `EINVAL`. So on Windows the build necessarily runs
 * through the command interpreter; see {@link isShellSafe} for why that is
 * sound here and how it is kept that way.
 */
export function npmExecutable(platform: NodeJS.Platform | string): string {
    return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function npxExecutable(platform: NodeJS.Platform | string): string {
    return platform === 'win32' ? 'npx.cmd' : 'npx';
}

/** Characters a command interpreter would act on rather than pass through. */
const SHELL_METACHARACTERS = /[&|<>^"'`$();!%\r\n]/;

/**
 * Whether a plan is safe to hand to a shell.
 *
 * Windows leaves no choice about USING one (see {@link npmExecutable}), so the
 * property that has to hold instead is that nothing in the argv ever comes from
 * outside this file. {@link buildPlanFor} only ever emits fixed literals — the
 * repo's `package.json` decides WHAT the build does, but never what Genie types
 * on the command line. This is the assertion of that, checked at the moment of
 * spawning rather than trusted, so threading a project-supplied string into the
 * argv later fails loudly instead of quietly becoming a command-injection bug.
 *
 * The `cwd` is deliberately not part of this: it is passed as a spawn option,
 * not on the command line, so a workspace path with a `&` in it is inert.
 */
export function isShellSafe(plan: BuildPlan): boolean {
    return ![plan.command, ...plan.args].some((token) => SHELL_METACHARACTERS.test(token));
}

/**
 * PURE. How to build this project, or `null` when it has no build.
 *
 * The project's OWN `build` script wins over anything we could infer: it is the
 * contract its author wrote, and it may set env, chain a type-check, or emit
 * something other than a plain vite bundle. Guessing `vite build` instead would
 * produce a different artifact than the one the project's CI ships — the hosted
 * preview would then not be previewing the app.
 *
 * `npx --no-install` is deliberate: it runs the vite already in `node_modules`
 * and refuses to silently fetch one from the registry.
 */
export function buildPlanFor(
    pkg: unknown,
    platform: NodeJS.Platform | string = process.platform,
): BuildPlan | null {
    if (!pkg || typeof pkg !== 'object') return null;
    const manifest = pkg as {
        scripts?: Record<string, unknown>;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
    };
    if (typeof manifest.scripts?.build === 'string' && manifest.scripts.build.trim()) {
        return { command: npmExecutable(platform), args: ['run', 'build'] };
    }
    const hasVite = !!(manifest.devDependencies?.vite ?? manifest.dependencies?.vite);
    if (hasVite) {
        return { command: npxExecutable(platform), args: ['--no-install', 'vite', 'build'] };
    }
    return null;
}

// --- thin impure -----------------------------------------------------------

export interface BuildSeams {
    readPackageJson(repoDir: string): Promise<Record<string, unknown> | null>;
    fileExists(p: string): Promise<boolean>;
    run(
        command: string,
        args: string[],
        cwd: string,
        opts: { shell: boolean },
    ): Promise<{ code: number | null; output: string }>;
}

export interface EnsureBuiltOptions {
    /** The project root — where `package.json` and `node_modules` live. */
    repoDir: string;
    /** The directory that will be SERVED. Built when it holds no `index.html`. */
    docroot: string;
    platform?: NodeJS.Platform | string;
    seams?: BuildSeams;
    onOutput?: (chunk: string) => void;
}

/** Keep the reported output bounded — it exists to explain a failure. */
const OUTPUT_TAIL_LIMIT = 4_000;

/**
 * Ensure the docroot holds a built app, running the project's build if it does
 * not.
 *
 * "Is it built?" is answered by the presence of `index.html` in the docroot:
 * that is the file the static adapter serves for `/` and falls back to for every
 * client-side route, so its absence means the site cannot work regardless of
 * what else is there.
 */
export async function ensureBuilt(opts: EnsureBuiltOptions): Promise<{ built: boolean }> {
    const seams = opts.seams ?? defaultSeams;
    const platform = opts.platform ?? process.platform;
    const shell = path.join(opts.docroot, 'index.html');

    if (await seams.fileExists(shell)) return { built: false };

    const pkg = await seams.readPackageJson(opts.repoDir);
    const plan = buildPlanFor(pkg, platform);
    if (!plan) {
        throw new Error(
            `hosting: ${opts.repoDir} has no build script and no vite dependency — ` +
                'point the site at an already-built directory, or add a `build` script.',
        );
    }

    if (!(await seams.fileExists(path.join(opts.repoDir, 'node_modules')))) {
        // Running the build anyway fails several frames from the real cause,
        // with a message about a missing binary rather than missing deps.
        throw new Error(
            `hosting: ${opts.repoDir} has no node_modules — run \`npm install\` there first.`,
        );
    }

    // Windows cannot run npm without a shell (see `npmExecutable`); everywhere
    // else we do not use one. Either way the argv must be ours alone.
    const useShell = platform === 'win32';
    if (useShell && !isShellSafe(plan)) {
        throw new Error(
            `hosting: refusing to run \`${plan.command} ${plan.args.join(' ')}\` through a shell`,
        );
    }
    const { code, output } = await seams.run(plan.command, plan.args, opts.repoDir, {
        shell: useShell,
    });
    if (code !== 0) {
        throw new Error(
            `hosting: \`${plan.command} ${plan.args.join(' ')}\` failed (${code}) in ${opts.repoDir}\n` +
                output.slice(-OUTPUT_TAIL_LIMIT),
        );
    }
    if (!(await seams.fileExists(shell))) {
        // Exit 0 with an empty docroot means the project builds somewhere else.
        // Reporting success would hand the browser an origin that 404s on `/`.
        throw new Error(
            `hosting: the build succeeded but produced no index.html in ${opts.docroot} — ` +
                'check the site\'s docroot setting.',
        );
    }
    return { built: true };
}

// --- default seams ---------------------------------------------------------

const defaultSeams: BuildSeams = {
    async readPackageJson(repoDir) {
        try {
            const raw = await fsp.readFile(path.join(repoDir, 'package.json'), 'utf8');
            const parsed: unknown = JSON.parse(raw);
            return parsed && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : null;
        } catch {
            return null;
        }
    },

    async fileExists(p) {
        try {
            await fsp.access(p);
            return true;
        } catch {
            return false;
        }
    },

    run(command, args, cwd, opts) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                cwd,
                shell: opts.shell,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            const collect = (chunk: unknown) => {
                output = (output + String(chunk)).slice(-OUTPUT_TAIL_LIMIT);
            };
            child.stdout?.on('data', collect);
            child.stderr?.on('data', collect);
            child.on('error', reject);
            child.on('close', (code) => resolve({ code, output }));
        });
    },
};
