/**
 * The main-process build — what nextron's webpack did, as code we own (Tynn #449).
 *
 * Vite, not a new bundler: it is already this project's renderer bundler and a direct
 * devDependency, so the project has ONE bundler rather than two opaque ones.
 *
 * ## What this has to reproduce, and why each part is load-bearing
 *
 * Measured from `node_modules/nextron/bin/webpack.config.cjs` plus the repo's own
 * `nextron.config.js` override, both read before removal:
 *
 * - **Four flat files in `app/`**, one per entry, `splitChunks: false`. Not an
 *   optimisation choice. webpack 5 started extracting hashed vendor chunks once the main
 *   import graph grew, `require()`d them from `background.js`, and nextron had no step
 *   that copied them into `app/` — so Electron booted into "Cannot find module
 *   './vendors-…'", no IPC handler ever registered, and the renderer reported every
 *   terminal call as "No handler registered for 'terminal:resize'".
 * - **Only `main/**` is bundled; every production dependency stays external.** nextron's
 *   `externals` was literally `Object.keys(pkg.dependencies)`. Inlining them instead
 *   would bundle `better-sqlite3` and `node-pty`, whose `.node` bindings cannot be
 *   bundled at all, and would double-load packages that electron-builder unpacks out of
 *   the asar on purpose.
 * - **CommonJS.** `package.json` has no `"type": "module"`, so Electron parses
 *   `app/background.js` as CJS; an ESM output throws on its first `import`.
 * - **`.mjs` in `resolve.extensions`.** `main/plugins/signing.ts` imports
 *   `./signing-core` with no extension and the file is `signing-core.mjs`. Those cores
 *   are shared VERBATIM with the plain-Node CI signer and vitest, so they must stay
 *   native ESM. Without this the build cannot resolve them.
 * - **No typecheck.** nextron ran ts-loader with `transpileOnly: true`; typechecking is
 *   `npm run typecheck:main`, which CI runs as its own step. Keeping those separate is
 *   why a type error fails with a type error instead of a bundling error.
 *
 * Asserted by `scripts/__tests__/main-build-entries.test.ts`, which replaced a test that
 * had been passing against `nextron.config.js` for as long as that dead file sat in the
 * tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The four main-process bundles, entry name → source path relative to the repo root.
 *
 * The entry NAME is the emitted filename (`background` → `app/background.js`), so these
 * keys are a contract with `package.json#main`, `electron-builder.yml`, the E2E harness
 * and every `webPreferences.preload` path in the main tree.
 */
export const MAIN_BUILD_ENTRIES = {
    background: 'main/background.ts',
    preload: 'main/preload.ts',
    // A SECOND preload bundle (Tynn #250), loaded into a third-party app's sandboxed
    // window. Its own entry so the file landing there holds only the two-call bridge.
    'app-preload': 'main/apps/app-preload.ts',
    // Runs as its own process on the shipped standalone Node and outlives the Electron
    // process (genie#346). Its import graph is held to Node built-ins by
    // main/mcp-shuttle/__tests__/entry.test.ts.
    'mcp-shuttle': 'main/mcp-shuttle/main.ts',
};

/**
 * Dependencies that CANNOT be required, so they must be inlined.
 *
 * `@particle-academy/prism-acp` is `"type": "module"` with an `exports` map offering only an
 * `"import"` condition — there is no `require` path into it. Externalising it emitted
 * `require("@particle-academy/prism-acp")` into a CommonJS `background.js` and the main
 * process died at boot: no window, all 173 E2E specs failing at 0ms on three platforms, and
 * nothing in the log but `firstWindow: Timeout`. The unit suite and the renderer build were
 * both green throughout, which is what makes this worth naming rather than remembering.
 *
 * Safe to inline, and not a workaround: the package has zero dependencies, so bundling it
 * pulls in nothing else. A dynamic import would be inlined anyway under
 * `codeSplitting: false`, while making a synchronous mapper async for no benefit.
 *
 * Anything added here needs the same two properties — ESM-only, and cheap enough to inline.
 * `scripts/__tests__/main-build-entries.test.ts` holds the list to this file.
 */
const ESM_ONLY_DEPENDENCIES = ['@particle-academy/prism-acp'];

/**
 * Everything the bundle `require()`s at runtime instead of inlining.
 *
 * `electron` and the Node built-ins are provided by the runtime. The production
 * dependencies are resolved from the packaged `node_modules`, which is what
 * electron-builder ships and what `asarUnpack` deliberately leaves on disk.
 */
export function mainBuildExternals() {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    return [
        'electron',
        // Minus the ones that cannot be required — see ESM_ONLY_DEPENDENCIES.
        ...Object.keys(pkg.dependencies ?? {}).filter((d) => !ESM_ONLY_DEPENDENCIES.includes(d)),
        ...module.builtinModules,
        ...module.builtinModules.map((m) => `node:${m}`),
    ];
}

/**
 * The Vite config for one main-process entry.
 *
 * One Vite build PER ENTRY, not one build with four inputs. `inlineDynamicImports` is
 * what guarantees a single flat file with no shared chunk, and rolldown only permits it
 * when the build has exactly one input — which is the same constraint, reached from the
 * other side, that `splitChunks: false` was solving for webpack.
 */
export function mainBuildConfig(entry = 'background', { dev = false, e2e = false } = {}) {
    const input = MAIN_BUILD_ENTRIES[entry];
    if (!input) throw new Error(`build-main: unknown entry '${entry}'`);
    return {
        root: REPO,
        // No `.env` loading and no renderer plugins: this is a Node/Electron target.
        configFile: false,
        envDir: false,
        logLevel: 'warn',
        resolve: {
            // `.mjs` LAST, a pure fallback that only fires when no .ts/.js match exists —
            // the same ordering the webpack override used.
            extensions: ['.ts', '.tsx', '.js', '.json', '.mjs'],
            // The `paths` from main/tsconfig.json that main sources actually import
            // through. nextron got these from tsconfig-paths-webpack-plugin.
            alias: {
                '@main': path.join(REPO, 'main'),
                '@renderer': path.join(REPO, 'renderer'),
            },
        },
        // Explicit as well as effective: the externals list already omits these, and saying
        // it here too is what a reader checks first.
        ssr: { noExternal: ESM_ONLY_DEPENDENCIES },
        build: {
            outDir: path.join(REPO, 'app'),
            // The renderer writes its assets into the same `app/`, and `build:main` runs
            // first. Emptying here would delete whichever half built last.
            emptyOutDir: false,
            // Electron 44's Chromium/Node pair. Transpiling further is pointless work and
            // loses the stack frames that make a boot crash legible.
            target: 'node22',
            sourcemap: true,
            // The main process loads from disk once at boot and never streams it, so the
            // readable stack is worth more than the bytes.
            minify: false,
            ssr: true,
            rollupOptions: {
                // A NAMED input, `{ background: '…/background.ts' }`, not a bare path.
                // rolldown derives a chunk's name from the input FILE otherwise, so
                // `mcp-shuttle/main.ts` emits `main.js` — and the shuttle has to be
                // `mcp-shuttle.js` beside `background.js` for `resolveShuttleScript()` to
                // find it. The key makes the entry name the filename by contract instead
                // of by basename coincidence.
                input: { [entry]: path.join(REPO, input) },
                external: mainBuildExternals(),
                output: {
                    format: 'cjs',
                    entryFileNames: '[name].js',
                    // One file. See the splitChunks note in the header. rolldown's name for
                    // what webpack called `splitChunks: false`.
                    codeSplitting: false,
                },
            },
        },
        /**
         * Baked for a build, left alone for a watch.
         *
         * A packaged app has no `NODE_ENV` set, and `main/background.ts` reads
         * `process.env.NODE_ENV === 'production'` to decide whether a window loads
         * `app/*.html` over `file://` or `http://localhost:8888`. So a build must carry
         * the answer — nextron's `EnvironmentPlugin({NODE_ENV:'production'})` did exactly
         * this.
         *
         * Baking it into the DEV build inverts the one thing dev needs: every window would
         * load the last BUILT html instead of the dev server, so Vite would serve nobody,
         * there would be no HMR, and no edit would ever appear. Asserted both ways in
         * scripts/__tests__/main-build-entries.test.ts.
         */
        define: {
            ...(dev ? {} : { 'process.env.NODE_ENV': JSON.stringify('production') }),
            /**
             * Whether the E2E rig is in this artifact AT ALL.
             *
             * A literal, because only a literal folds: `main/e2e/flags.ts` reads it so every
             * `isE2E()` predicate resolves at BUILD time, each `if (isE2E())` becomes dead
             * code, and rolldown drops the rig behind it — GitHub IPC mocks, a fake hosting
             * layer, 18 seed modules. A shipped Genie cannot be talked into E2E mode by
             * setting `GENIE_E2E=1`, because there is nothing left to enter.
             *
             * `scripts/assert-no-e2e-in-bundle.mjs` holds this to the real artifact. Whether
             * a dead `await import()` is removed is a fact about the bundler, and this build
             * sets `codeSplitting: false`, which otherwise INLINES dynamic imports.
             */
            __GENIE_E2E_BUILD__: e2e ? 'true' : 'false',
        },
    };
}

/**
 * Build all four bundles. With `--watch`, rebuild each on change and never resolve —
 * which is what `scripts/dev.mjs` runs in place of nextron's dev main compiler.
 */
async function main({ watch = false, e2e = false } = {}) {
    const { build } = await import('vite');
    for (const entry of Object.keys(MAIN_BUILD_ENTRIES)) {
        const config = mainBuildConfig(entry, { dev: watch, e2e });
        if (watch) config.build.watch = {};
        await build(config);
        // Checked rather than assumed. The emitted filename comes from the input KEY, and
        // if that ever stops being true the failure is `package.json#main` pointing at a
        // file that is not there — which surfaces as Electron's bare "Cannot find module",
        // the exact error this build already produced once by emitting `app/main/*`
        // instead of `app/*`.
        const want = path.join(REPO, 'app', `${entry}.js`);
        if (!fs.existsSync(want)) {
            throw new Error(
                `build-main: expected ${path.relative(REPO, want).replace(/\\/g, '/')} and it is ` +
                    `not there — the entry name and the emitted filename have diverged`,
            );
        }
        console.log(`[build:main] app/${entry}.js${watch ? ' (watching)' : ''}`);
    }
}

// Only build when run as a script; importing this for its config must not build.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main({
        watch: process.argv.includes('--watch'),
        e2e: process.argv.includes('--e2e'),
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
