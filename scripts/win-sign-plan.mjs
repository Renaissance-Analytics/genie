#!/usr/bin/env node
/**
 * WHAT A SIGNED WINDOWS BUILD WOULD SIGN, AND WHO SIGNED EACH FILE ALREADY.
 *
 *   node scripts/win-sign-plan.mjs <win-unpacked dir> [electron-builder.yml] [--json <out.json>] [--check]
 *
 * Windows only (Get-AuthenticodeSignature), on an UNSIGNED package (`--config.win.signExecutable=false`, as CI's
 * "it packages" builds), so each file still carries only the signature it was shipped with. Never run on the owner's
 * desktop.
 *
 * Which files electron-builder signs is ITS rule, for the version pinned below (app-builder-lib/out/winPackager.js,
 * signApp, createTransformerForExtraFiles and shouldSignFile). It is copied here, not reimplemented by guess, and
 * test/win-sign-plan.test.ts fails when the installed electron-builder is not that version, so the copy is re-read on
 * every upgrade:
 *   - the app root: <productName>.exe (signed and resource-edited), and every other file shouldSignFile accepts;
 *   - extra resources outside the root (resources/**, not app.asar.unpacked): every file shouldSignFile accepts;
 *   - resources/app.asar.unpacked/**: every file shouldSignFile accepts;
 *   - shouldSignFile(file): with no signExts, `.exe` only; else a positive entry it ends with signs it, then a `!entry`
 *     it ends with does not, else `.exe`. Matching is `endsWith`, so an entry may be a whole file name.
 * Each file is reported with its signature as shipped: `ours` (our publisher), `third-party` (valid, someone else's),
 * `unsigned`, or `invalid`. --check exits 1 if any file the build would sign is `third-party`: signtool would replace
 * that publisher's signature with ours.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

export const ELECTRON_BUILDER_VERSION = '26.15.3';
/** Our publisher, as the Azure Trusted Signing certificate names it (electron-builder.yml azureSignOptions.publisherName). */
export const OUR_PUBLISHER = 'Renaissance Analytics';

/** electron-builder 26.15.3's WinPackager.shouldSignFile, verbatim in behaviour. */
export function shouldSignFile(file, signExts, fallbackValue = false) {
    const isExe = file.endsWith('.exe');
    if (!signExts?.length) return isExe || fallbackValue;
    if (signExts.some((ext) => file.endsWith(ext))) return true;
    if (signExts.some((ext) => ext.startsWith('!') && file.endsWith(ext.substring(1)))) return false;
    return isExe || fallbackValue;
}

function walk(dir) {
    let out = [];
    let names = [];
    try { names = readdirSync(dir); } catch { return out; }
    for (const n of names) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) out = out.concat(walk(p));
        else out.push(p);
    }
    return out;
}

/** The files electron-builder would sign in this package, by its rule (see the header), as paths relative to `root`. */
export function signPlan(root, { productFilename, signExts }) {
    const exe = `${productFilename}.exe`;
    const plan = [];
    for (const name of readdirSync(root)) {
        const p = join(root, name);
        if (statSync(p).isDirectory()) continue;
        if (name === exe || shouldSignFile(name, signExts)) plan.push(name);
    }
    const resources = join(root, 'resources');
    const unpacked = join(resources, 'app.asar.unpacked');
    for (const p of walk(resources)) {
        const rel = relative(root, p);
        if (p.startsWith(unpacked)) { if (shouldSignFile(p, signExts)) plan.push(rel); continue; }
        // An extra resource: signed by the copy transformer when shouldSignFile accepts it and it is not at the root.
        if (dirname(p) !== root && shouldSignFile(p, signExts)) plan.push(rel);
    }
    return plan.map((r) => r.replace(/\\/g, '/'));
}

/** What a signature says, as `ours`, `third-party`, `unsigned` or `invalid`, with the signer's subject. */
export function classify(status, subject) {
    if (status === 'NotSigned') return { kind: 'unsigned', signer: null };
    if (status !== 'Valid') return { kind: 'invalid', signer: subject || null, status };
    const cn = /CN=("[^"]+"|[^,]+)/.exec(subject || '')?.[1]?.replace(/^"|"$/g, '') ?? subject;
    const org = /O=("[^"]+"|[^,]+)/.exec(subject || '')?.[1]?.replace(/^"|"$/g, '') ?? '';
    return { kind: cn === OUR_PUBLISHER || org === OUR_PUBLISHER ? 'ours' : 'third-party', signer: cn };
}

function signatures(root, files) {
    // One PowerShell for all of them: a path per line in, a JSON array out.
    const list = join(root, '..', 'win-sign-plan.files.txt');
    writeFileSync(list, files.map((f) => join(root, f)).join('\n'));
    const script = `$ErrorActionPreference = 'Stop'; Get-Content -LiteralPath '${list.replace(/'/g, "''")}' | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{ path = [string]$_; status = [string]$s.Status; subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' } } } | ConvertTo-Json -Compress`;
    // Without the caller's PSModulePath: started from pwsh 7, Windows PowerShell 5.1 inherits pwsh's module path and
    // cannot load Microsoft.PowerShell.Security, where Get-AuthenticodeSignature lives (measure run 42376824533).
    const env = { ...process.env };
    delete env.PSModulePath;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
    const rows = JSON.parse(out || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ file: relative(root, r.path).replace(/\\/g, '/'), ...classify(r.status, r.subject) }));
}

function readConfig(path) {
    const text = readFileSync(path, 'utf8');
    const product = /^productName:\s*["']?([^"'\n]+)["']?\s*$/m.exec(text)?.[1]?.trim() ?? 'Genie';
    const win = text.split(/\r?\n/);
    const start = win.findIndex((l) => /^win:\s*$/.test(l));
    let signExts = null;
    for (let i = start + 1; start >= 0 && i < win.length && /^(\s|$)/.test(win[i]); i += 1) {
        const m = /^\s+signExts:\s*\[(.*)\]\s*$/.exec(win[i]);
        if (m) signExts = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    return { productFilename: product, signExts };
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
    const args = process.argv.slice(2);
    const root = args[0];
    const configFile = args[1] && !args[1].startsWith('--') ? args[1] : 'electron-builder.yml';
    const jsonAt = args.indexOf('--json');
    const config = readConfig(configFile);
    const plan = new Set(signPlan(root, config));
    // Every .exe/.dll/.node in the package, signed by the plan or not, so the report is the whole picture.
    const all = walk(root).map((p) => relative(root, p).replace(/\\/g, '/')).filter((f) => /\.(exe|dll|node)$/i.test(f));
    const rows = signatures(root, all).map((r) => ({ ...r, wouldSign: plan.has(r.file) }));
    rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file));
    console.log(`### win-sign-plan: signExts=${JSON.stringify(config.signExts)}; ${rows.length} .exe/.dll/.node files; the build would sign ${rows.filter((r) => r.wouldSign).length}`);
    for (const r of rows) console.log(`### ${r.wouldSign ? 'SIGN' : '    '} ${r.kind.padEnd(11)} ${r.file}${r.signer ? `  [${r.signer}]` : ''}${r.status ? ` (${r.status})` : ''}`);
    const resigned = rows.filter((r) => r.wouldSign && r.kind === 'third-party');
    console.log(`### would replace another publisher's signature on ${resigned.length} file(s)${resigned.length ? `: ${resigned.map((r) => r.file).join(', ')}` : ''}`);
    // The other half: an .exe, .dll or .node (a DLL by another name) that ships unsigned and that the build would NOT sign
    // would ship unsigned (one added to the package and not to signExts). On a signed tree there is none of these, so
    // --check is for an unsigned one.
    const leftUnsigned = rows.filter((r) => !r.wouldSign && r.kind === 'unsigned' && /\.(exe|dll|node)$/i.test(r.file));
    console.log(`### would leave ${leftUnsigned.length} unsigned .exe/.dll/.node unsigned${leftUnsigned.length ? `: ${leftUnsigned.map((r) => r.file).join(', ')} (add it to win.signExts)` : ''}`);
    if (jsonAt >= 0) writeFileSync(args[jsonAt + 1], JSON.stringify({ signExts: config.signExts, rows }, null, 2));
    if (args.includes('--check') && (resigned.length > 0 || leftUnsigned.length > 0)) process.exit(1);
}
