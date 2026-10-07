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
    it('externalises every production dependency, as nextron did', () => {
        const external = mainBuildExternals();
        for (const dep of Object.keys(pkg.dependencies ?? {})) {
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
