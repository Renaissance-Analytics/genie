import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSdkDocs } from '../src/core/sdk-docs.js';
import { renderAppSdkTypes } from '../src/core/sdk-types.js';
import { genieCatalog } from '../src/main/genie-catalog.js';

/**
 * `npm run docs:sdk` (ADF B7, Tynn #457): write docs/sdk/ from the catalog's schemas. Pages the generator no longer
 * writes are removed, so the folder is exactly what it says (test/adf-b7-sdk-docs.test.ts checks that in CI). It also writes
 * the app-sdk's types from the same catalog (GApps v2 V6; test/app-sdk.test.ts checks those).
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(repo, 'docs', 'sdk');
writeFileSync(join(repo, 'packages', 'app-sdk', 'src', 'generated.ts'), renderAppSdkTypes(genieCatalog().list()), 'utf8');
const pages = renderSdkDocs();

const existing: string[] = [];
const walk = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else existing.push(relative(root, path).split(sep).join('/'));
    }
};
walk(root);
for (const path of existing) if (!pages.has(path)) rmSync(join(root, path));

for (const [path, text] of pages) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
}
console.log(`docs/sdk: ${pages.size} pages written${existing.filter((p) => !pages.has(p)).length > 0 ? `, ${existing.filter((p) => !pages.has(p)).length} stale removed` : ''}`);
