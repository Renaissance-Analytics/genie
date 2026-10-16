import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * NAMED IMPORTS FROM A COMMONJS PACKAGE — the defect the window smoke found on 2026-10-10.
 *
 * `dist/main/main.js` is ESM and the main-process bundle leaves packages external, so Node
 * loads them with its own rules. For a CommonJS package Node can only offer the named exports
 * its lexer can SEE; `electron-updater` defines `autoUpdater` through a getter, so
 * `import { autoUpdater } from 'electron-updater'` threw `Named export 'autoUpdater' not
 * found` the moment the built app loaded — after typecheck and 615 unit tests had passed,
 * because none of them load the real module under Node's ESM loader. The default import
 * (`import pkg from 'electron-updater'`) is `module.exports` and always works.
 *
 * This guard reads the SOURCE, because the only runtime that reproduces the failure is the
 * built app. It counts named value-imports from packages whose `package.json` declares no ESM
 * surface, and the only acceptable count is zero.
 */

const ROOT = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
}

/** The bare package name of a specifier: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
export function packageOf(specifier: string): string {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** Does this installed package offer an ESM surface, as far as Node's loader is concerned? */
export function isCommonJsPackage(pkg: string): boolean | null {
    const manifest = join(ROOT, 'node_modules', pkg, 'package.json');
    if (!existsSync(manifest)) return null;
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as { type?: string; module?: string; exports?: unknown };
    if (json.type === 'module' || typeof json.module === 'string') return false;
    const exportsText = JSON.stringify(json.exports ?? null);
    if (exportsText.includes('"import"')) return false;
    return true;
}

/** Every `import { … } from '<bare>'` (value imports only) in one file's text. */
export function namedBareImports(text: string): { names: string; from: string }[] {
    const found: { names: string; from: string }[] = [];
    const re = /^\s*import\s+(?!type\s)(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'".][^'"]*)['"]/gm;
    for (const m of text.matchAll(re)) found.push({ names: m[1]!.trim(), from: m[2]! });
    return found;
}

describe('named imports from CommonJS packages in the main process', () => {
    const files = sourceFiles(join(ROOT, 'src', 'main'));

    it('finds the main-process sources at all — the positive control for the scan', () => {
        expect(files.length).toBeGreaterThan(5);
    });

    it('classifies electron-updater as CommonJS and the Fancy/Prism packages as ESM — the positive control for the classifier', () => {
        expect(isCommonJsPackage('electron-updater')).toBe(true);
        expect(isCommonJsPackage('@particle-academy/prism-acp')).toBe(false);
        expect(isCommonJsPackage('@particle-academy/fancy-term-host')).toBe(false);
    });

    it('sees a named import and ignores a default or type-only one — the positive control for the parser', () => {
        const text = [
            "import { autoUpdater } from 'electron-updater';",
            "import pkg from 'electron-updater';",
            "import type { UpdaterPort } from './updater.js';",
            "import type { Thing } from 'electron-updater';",
            "import {\n    a,\n    b,\n} from 'some-cjs';",
        ].join('\n');
        expect(namedBareImports(text)).toEqual([
            { names: 'autoUpdater', from: 'electron-updater' },
            { names: 'a,\n    b,', from: 'some-cjs' },
        ]);
    });

    it('is ZERO across src/main — COUNTED, with every offender named', () => {
        const offenders: string[] = [];
        for (const file of files) {
            for (const imp of namedBareImports(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))) {
                if (imp.from.startsWith('node:')) continue;
                // Electron's own module is CommonJS too, but Electron's loader special-cases it
                // and every named import from it works — measured by every window smoke to date.
                if (imp.from === 'electron') continue;
                if (isCommonJsPackage(packageOf(imp.from)) === true) {
                    offenders.push(`${file.slice(ROOT.length + 1)}: import { ${imp.names} } from '${imp.from}'`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
