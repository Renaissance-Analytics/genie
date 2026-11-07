#!/usr/bin/env node
/**
 * BUILD genie-launch.exe (native/win-launcher/genie-launch.c; #1628, #1639) with MSVC, on Windows. Nothing prebuilt is
 * checked in: CI and the release build it from source, and electron-builder packs it (resources/bin) with the app.
 *
 * Elsewhere it does nothing but leave the (empty) output folder electron-builder reads. On a Windows machine with no MSVC
 * it says so and exits 0 — Genie then starts its processes with Node's spawn, as before — EXCEPT on CI (CI=true), where
 * a missing compiler is a failure: a Windows build that ships without the launcher must never pass.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'build', 'win-launcher');
const out = join(outDir, 'genie-launch.exe');
const source = join(root, 'native', 'win-launcher', 'genie-launch.c');
mkdirSync(outDir, { recursive: true });

if (process.platform !== 'win32') {
    console.log('[win-launcher] not Windows: nothing to build');
    process.exit(0);
}
const ci = process.env.CI === 'true';
const fail = (why) => {
    if (ci) { console.error(`[win-launcher] FAILED on CI: ${why}`); process.exit(1); }
    console.warn(`[win-launcher] not built (${why}); Genie falls back to Node's spawn on this machine`);
    process.exit(0);
};

const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
if (!existsSync(vswhere)) fail('no vswhere.exe (Visual Studio Build Tools are not installed)');
let vs = '';
try {
    vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
} catch (error) { fail(`vswhere failed: ${error.message}`); }
const vcvars = join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
if (!vs || !existsSync(vcvars)) fail('no MSVC x64 tools');

// One cmd: the compiler's environment, then cl. Warnings are errors; no CRT DLL (static), so the exe stands alone.
const cmd = `call "${vcvars}" >nul && cl /nologo /O2 /W4 /WX /MT /DUNICODE /D_UNICODE "${source}" /Fo"${join(outDir, 'genie-launch.obj')}" /Fe"${out}" /link /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib`;
try {
    execFileSync('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { stdio: 'inherit', windowsVerbatimArguments: true });
} catch (error) { fail(`cl failed: ${error.message}`); }
if (!existsSync(out) || statSync(out).size === 0) fail('cl produced no genie-launch.exe');
console.log(`[win-launcher] built ${out} (${statSync(out).size} bytes)`);
