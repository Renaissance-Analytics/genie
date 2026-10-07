import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAIN_BUILD_ENTRIES, mainBuildExternals, mainBuildConfig } from '../build-main.mjs';

/**
 * The main-process build, after nextron (Tynn #449).
 *
 * This REPLACES `nextron-main-entry.test.ts`, which asserted the same invariants against
 * `nextron.config.js`. That file is gone, and the old test is the reason this one is
 * written the way it is: it kept passing after `next`/`nextron` were removed from
 * `package.json`, because it read a config file that was still sitting in the tree. A
 * green assertion about a dead file is worse than no assertion — it reported the main
 * build as guarded while the real build emitted nothing loadable.
 *
 * What nextron actually did, measured from `node_modules/nextron/bin/webpack.config.cjs`
 * before it was removed:
 *
 *   - bundled ONLY `main/**` source, with `externals` = every key of
 *     `package.json#dependencies` — so the output `require()`s its deps at runtime
 *   - emitted flat `app/[name].js`, one file per entry, `splitChunks: false`
 *   - `node: { __dirname: false }` — `__dirname` stays the real runtime directory
 *   - appended `.mjs` to `resolve.extensions` (our override), which is the only reason
 *     `import … from './signing-core'` resolves to `signing-core.mjs`
 *
 * Each of those is load-bearing, and each is asserted below.
 */

const REPO = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    main: string;
    dependencies?: Record<string, string>;
};

describe('the main-process entry map', () => {
    it('builds the four bundles nextron built, and no others', () => {
        // Four, not one: three of these must be SEPARATE FILES rather than modules inside
        // `background.js`, and each for its own reason — see the per-entry tests below.
        expect(Object.keys(MAIN_BUILD_ENTRIES).sort()).toEqual([
            'app-preload',
            'background',
            'mcp-shuttle',
            'preload',
        ]);
    });

    it('points every entry at a file that exists', () => {
        for (const [name, rel] of Object.entries(MAIN_BUILD_ENTRIES)) {
            expect(fs.existsSync(path.join(REPO, rel)), `${name} -> ${rel}`).toBe(true);
        }
    });

    it('names the bundle package.json tells Electron to load', () => {
        // `app/background.js`. The nextron default was `app/main.js` from `main/main.ts`,
        // a file Genie does not have; under Vite the risk is the inverse — an entry key
        // renamed here silently emits a file nothing loads.
        expect(pkg.main).toBe('app/background.js');
        const emitted = `app/${path.basename(pkg.main, '.js')}.js`;
        expect(emitted).toBe(pkg.main);
        expect(MAIN_BUILD_ENTRIES).toHaveProperty(path.basename(pkg.main, '.js'));
    });

    it('builds background.ts as `background`', () => {
        expect(MAIN_BUILD_ENTRIES.background).toBe('main/background.ts');
    });

    it('keeps the GApp preload its own bundle (Tynn #250)', () => {
        // It is loaded into a THIRD-PARTY app's sandboxed window. The whole point is that
        // the file landing there contains only the two-call bridge surface — not Genie's
        // own preload, and not the main process it would otherwise be bundled with.
        expect(MAIN_BUILD_ENTRIES['app-preload']).toBe('main/apps/app-preload.ts');
        expect(MAIN_BUILD_ENTRIES['app-preload']).not.toBe(MAIN_BUILD_ENTRIES.preload);
    });

    it('keeps the MCP shuttle its own bundle (genie#346)', () => {
        // It runs as its own process on the shipped standalone Node and OUTLIVES the
        // Electron process `background.js` is. A file it can be started from is the point.
        expect(MAIN_BUILD_ENTRIES['mcp-shuttle']).toBe('main/mcp-shuttle/main.ts');
    });
});

describe('what the main bundle resolves at runtime vs inlines', () => {
    it('externalises every production dependency that CAN be required', () => {
        // nextron externalised all of them unconditionally. That was right until an ESM-only
        // dependency arrived: `@particle-academy/prism-acp` has no `require` condition at
        // all, so externalising it emitted a `require` that killed the main process at boot.
        // The rule is now "external unless it cannot be required", and the exception is
        // named in `ESM_ONLY_DEPENDENCIES` rather than being a silent hole here.
        const external = mainBuildExternals();
        const esmOnly = ['@particle-academy/prism-acp'];
        for (const dep of Object.keys(pkg.dependencies ?? {})) {
            if (esmOnly.includes(dep)) {
                expect(external, `${dep} is ESM-only and must be INLINED`).not.toContain(dep);
                continue;
            }
            expect(external, `${dep} must stay external`).toContain(dep);
        }
    });

    it('externalises `electron`, which only exists inside the runtime', () => {
        // Bundling it produces a file that throws at boot with a module-not-found for a
        // module the runtime was always going to provide.
        expect(mainBuildExternals()).toContain('electron');
    });

    it('does NOT externalise Genie’s own main sources', () => {
        // The inverse failure: externalising `main/**` emits a `require('./terminal/ipc')`
        // against a path that does not exist beside the flat bundle.
        const external = mainBuildExternals();
        expect(external).not.toContain('./terminal/ipc');
        expect(external.some((e) => typeof e === 'string' && e.startsWith('.'))).toBe(false);
    });
});

describe('module resolution the main bundle depends on', () => {
    const config = mainBuildConfig();

    it('resolves `.mjs`, or the dep-free plugin cores do not resolve at all', () => {
        // `main/plugins/signing.ts` imports `./signing-core` with NO extension, and the
        // file on disk is `signing-core.mjs`. Those cores are shared VERBATIM with the
        // plain-Node CI signer and vitest, so they must stay native ESM. Drop `.mjs` here
        // and the build fails to resolve them — or worse, resolves the `.d.ts` beside them.
        expect(config.resolve?.extensions).toContain('.mjs');
    });

    it('emits CommonJS, which is what Electron’s main process loads', () => {
        // An ESM `background.js` under a `package.json` with no `"type": "module"` is
        // parsed as CJS and throws on the first `import`.
        expect(config.build?.rollupOptions?.output).toMatchObject({ format: 'cjs' });
    });

    it('emits one flat file per entry, never a shared chunk', () => {
        // nextron set `splitChunks: false` deliberately: hashed vendor chunks were emitted
        // and then not copied into `app/`, so Electron booted into
        // "Cannot find module './vendors-…'" with no IPC handlers ever registered.
        const output = config.build?.rollupOptions?.output as Record<string, unknown>;
        expect(output.entryFileNames).toBe('[name].js');
        // rolldown's name for what webpack called `splitChunks: false`.
        expect(output.codeSplitting).toBe(false);
    });

    it('honours the `@main/*` path alias the main tree imports through', () => {
        expect(Object.keys(config.resolve?.alias ?? {})).toContain('@main');
    });
});

/**
 * `NODE_ENV` is baked for a BUILD and left alone for a WATCH, and the difference decides
 * where every window loads from.
 *
 * `main/background.ts:429` is `const isProd = process.env.NODE_ENV === 'production'`, and
 * nothing sets `NODE_ENV` in a packaged app — so a production build has to carry the
 * answer with it, exactly as nextron's `EnvironmentPlugin({NODE_ENV:'production'})` did.
 *
 * The inverse is the trap, and it is the one this nearly shipped: bake `production` into
 * the DEV watch build and `isProd` is true there too, so `npm run dev` loads
 * `file://.../app/master.html` instead of `http://localhost:8888/master`. Vite's dev
 * server then runs for nobody, there is no HMR, and every window shows whatever was last
 * built — a dev loop that looks like it works and silently never picks up an edit.
 * `main/docs/docs.ts` and `main/testing-browser/index.ts` branch on it too.
 */
describe('NODE_ENV', () => {
    const nodeEnvOf = (cfg: ReturnType<typeof mainBuildConfig>) =>
        (cfg.define ?? {})['process.env.NODE_ENV'];

    it('is baked as production for a build, because a packaged app has none set', () => {
        expect(nodeEnvOf(mainBuildConfig('background'))).toBe(JSON.stringify('production'));
    });

    it('is NOT baked for the dev watch build, so dev loads the Vite dev server', () => {
        expect(nodeEnvOf(mainBuildConfig('background', { dev: true }))).toBeUndefined();
    });

    it('bakes production for the E2E build too, which loads app/*.html over file://', () => {
        // `build:e2e` is a normal (non-watch) build. The harness launches Electron on
        // `app/background.js` and expects the built pages, not a dev server.
        expect(nodeEnvOf(mainBuildConfig('background', { dev: false }))).toBe(
            JSON.stringify('production'),
        );
    });
});

/**
 * `__GENIE_E2E_BUILD__` decides whether the E2E rig is in the artifact at all.
 *
 * `main/e2e/flags.ts` reads it as a compile-time literal, so every `isE2E()` predicate
 * folds with the BUILD rather than with the environment. A production build therefore
 * cannot be talked into E2E mode by `GENIE_E2E=1`, and the rig the dead branches reached —
 * GitHub IPC mocks, a fake hosting layer, 18 seed modules, ~93 KB — is dropped.
 *
 * Both directions matter and neither is safe to assume:
 *
 *  - define it `true` by accident in production and the installer ships the mocks again;
 *  - define it `false` in the E2E build and the entire suite goes inert, passing because
 *    nothing it asserts against ever starts.
 *
 * Whether rolldown really removes the dead `await import()` is a claim about the bundler,
 * not about the config, so `scripts/assert-no-e2e-in-bundle.mjs` checks the real artifact.
 */
describe('the E2E-rig build flag', () => {
    const flagOf = (cfg: ReturnType<typeof mainBuildConfig>) =>
        (cfg.define ?? {})['__GENIE_E2E_BUILD__'];

    it('is the literal false for a production build', () => {
        // A literal, not a boolean: `define` substitutes source text, and only a literal
        // folds. `false` as a JS value would stringify to the same thing here, but asserting
        // the string is what pins the substitution being textual.
        expect(flagOf(mainBuildConfig('background'))).toBe('false');
    });

    it('is the literal true for an e2e build', () => {
        expect(flagOf(mainBuildConfig('background', { e2e: true }))).toBe('true');
    });

    it('is false for the dev watch build, which is not the E2E suite', () => {
        // `npm run dev` is a person at a keyboard. Shipping them mocked GitHub would make
        // the app lie to them about their own repositories.
        expect(flagOf(mainBuildConfig('background', { dev: true }))).toBe('false');
    });

    it('can be an e2e DEV build, which the harness uses against the dev server', () => {
        // `showE2EWindow` loads `http://localhost:8888/<page>` when dev, so the two options
        // are independent rather than a single mode.
        const cfg = mainBuildConfig('background', { dev: true, e2e: true });
        expect(flagOf(cfg)).toBe('true');
        expect((cfg.define ?? {})['process.env.NODE_ENV']).toBeUndefined();
    });
});

/**
 * AN ESM-ONLY DEPENDENCY MUST BE BUNDLED, NOT REQUIRED.
 *
 * `@particle-academy/prism-acp` is `"type": "module"` with an `exports` map that offers only
 * an `"import"` condition — there is no `require` path into it at all. The main bundle is
 * CommonJS and externalises every production dependency, so importing it emitted
 * `require("@particle-academy/prism-acp")` into `background.js` and the main process **died
 * at boot**: no window, and all 173 E2E specs failed at 0ms on all three platforms with
 * nothing in the log but `firstWindow: Timeout`.
 *
 * It was survivable before only because the package was used exclusively by
 * `main/acp/prism-host.mjs`, which runs as real ESM in its own process. Reading
 * `META_CLI_SESSION_ID` and `readRateLimit` from the mapper pulled it into the CJS bundle.
 *
 * Inlining is safe and is the right answer rather than a workaround: the package has ZERO
 * dependencies, so bundling it pulls in nothing else, and the alternative — a dynamic import
 * — is inlined anyway by `codeSplitting: false` while making the mapper async for no gain.
 *
 * This guard exists because the failure mode is maximally unhelpful: a unit suite of 11,730
 * tests passes, the renderer builds, `test` goes green on CI, and the only symptom is a
 * window that never opens.
 */
describe('ESM-only dependencies', () => {
    it('does NOT externalise prism-acp, which cannot be required', () => {
        expect(mainBuildExternals()).not.toContain('@particle-academy/prism-acp');
    });

    it('positive control: a CJS dependency IS still externalised', () => {
        // Without this, "nothing is external" would pass — and bundling `better-sqlite3`
        // would try to inline a native `.node` binding.
        expect(mainBuildExternals()).toContain('better-sqlite3');
    });

    it('names every ESM-only dependency it inlines, so the list cannot rot silently', () => {
        // A second ESM-only package added later must be added here too, and the way to find
        // out must not be a boot failure. The reason lives beside the list.
        const config = mainBuildConfig();
        expect(config.ssr?.noExternal).toContain('@particle-academy/prism-acp');
    });
});
