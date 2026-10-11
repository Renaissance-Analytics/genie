// Run with: npx tsx scripts/fetch-caddy.ts
// Fetch the PINNED Caddy release for this platform into build/runtime/ before packaging.
//
// Pinned by version and the sha512 Caddy publishes (src/main/caddy-runtime.ts). A mismatch aborts the
// build — a binary that does not match its published sum is not the binary we meant to ship. Zero
// dependencies: node's fetch, crypto, and the platform's tar / PowerShell Expand-Archive.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { retry } from '../src/core/retry.js';
import { CADDY_VERSION, caddyDownload } from '../src/main/caddy-runtime.js';

const platform = process.platform as 'win32' | 'darwin' | 'linux';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const d = caddyDownload(platform, arch);
const outDir = join(process.cwd(), 'build', 'runtime');
const outBin = join(outDir, d.binaryInArchive);
mkdirSync(outDir, { recursive: true });

if (existsSync(outBin)) {
    const v = execFileSync(outBin, ['version'], { encoding: 'utf8' });
    if (v.includes(`v${CADDY_VERSION}`)) { console.log(`caddy ${CADDY_VERSION} already in build/runtime`); process.exit(0); }
}

console.log(`fetching ${d.url}`);
// A network reset in CI failed a packaging job once (PR #52: `fetch failed … read ECONNRESET`).
// Four attempts, 2s/4s/8s apart, each retry said in the log; the last error surfaces unchanged.
const bytes = await retry(
    async () => {
        const res = await fetch(d.url);
        if (!res.ok) throw new Error(`GET ${d.url} → HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    },
    { attempts: 4, delayMs: 2000, onRetry: (error, attempt) => console.warn(`fetch attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); retrying`) },
);
const sum = createHash('sha512').update(bytes).digest('hex');
if (sum !== d.sha512) {
    console.error(`sha512 mismatch for ${d.url}\n  expected ${d.sha512}\n  got      ${sum}`);
    process.exit(1);
}
const archive = join(outDir, `caddy.${d.archive}`);
writeFileSync(archive, bytes);
if (d.archive === 'zip') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${outDir}'`]);
} else {
    execFileSync('tar', ['-xzf', archive, '-C', outDir, d.binaryInArchive]);
    chmodSync(outBin, 0o755);
}
rmSync(archive);
for (const extra of ['LICENSE', 'README.md']) { const p = join(outDir, extra); if (existsSync(p)) rmSync(p); }
const v = execFileSync(outBin, ['version'], { encoding: 'utf8' });
if (!v.includes(`v${CADDY_VERSION}`)) { console.error(`extracted caddy reports ${v.trim()}, not v${CADDY_VERSION}`); process.exit(1); }
console.log(`caddy ${v.trim()} → ${outBin} (${bytes.length} bytes, sha512 verified)`);
