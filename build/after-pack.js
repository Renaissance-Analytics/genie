// electron-builder afterPack: delegate to the OFFICIAL per-OS node-pty packaging
// fix shipped by fancy-term-host (v0.3.0 `/electron`). It makes a packaged node-pty
// actually spawn a terminal:
//   • Windows — copy conpty.dll + OpenConsole.exe into build/Release/conpty/
//   • macOS   — ad-hoc codesign spawn-helper (certless; no Developer-ID needed)
//   • Linux   — chmod +x spawn-helper
// Idempotent + unit-tested upstream. This replaces the hand-rolled copy that used
// to live here — see Particle-Academy/fancy-term-host#7 + genie #14.
const fs = require('fs');
const path = require('path');
const {
    fancyTermAfterPack,
    resolveNodePtyDir,
    nodeAfterPackIo,
} = require('@particle-academy/fancy-term-host/electron');

// electron-builder Arch enum (electron-builder/out/core) → node-pty win prebuild suffix.
const WIN_ARCH = { 0: 'ia32', 1: 'x64', 3: 'arm64' };

// WORKAROUND — Particle-Academy/fancy-term-host#9 (arch-blind conpty source).
// The upstream helper's findConptySource() returns the FIRST `prebuilds/*/conpty`
// it sees via readdir(), ignoring the target arch. node-pty ships BOTH
// `win32-arm64` and `win32-x64` prebuilds and `win32-arm64` sorts first, so an
// x64 build gets the ARM64 conpty.dll (the two dlls differ by arch) → x64
// conpty.node can't LoadLibrary it and NO terminal spawns. Until upstream matches
// the arch, prune the non-target win32 prebuild in the packaged tree so the
// helper's first match IS the correct arch. Remove once fancy-term-host ships the
// arch-aware fix. Windows-only: macOS/Linux sign/chmod the rebuilt (arch-correct)
// spawn-helper in build/Release, so they have no arch-selection bug.
function pruneWrongArchWinPrebuilds(context) {
    if (context.electronPlatformName !== 'win32') return;
    const io = nodeAfterPackIo();
    const nodePty = resolveNodePtyDir(context.appOutDir, 'win32', io);
    if (!nodePty) return;
    // Our win target is x64-only (electron-builder.yml); fall back to x64 if the
    // context ever omits arch so we never keep the wrong-arch dll.
    const want = WIN_ARCH[context.arch] ?? 'x64';
    const prebuilds = path.join(nodePty, 'prebuilds');
    for (const name of io.readdir(prebuilds)) {
        if (name.startsWith('win32-') && name !== `win32-${want}`) {
            fs.rmSync(path.join(prebuilds, name), { recursive: true, force: true });
            console.log(
                `[after-pack] pruned non-target prebuild ${name} (target win32-${want}) ` +
                    `— fancy-term-host#9 arch workaround`,
            );
        }
    }
}

exports.default = async function afterPack(context) {
    pruneWrongArchWinPrebuilds(context);
    const result = await fancyTermAfterPack(context);
    console.log(
        `[after-pack] fancy-term-host node-pty: ${result.platform} -> ${result.action}` +
            ` (ok=${result.ok})${result.detail ? ' - ' + result.detail : ''}`,
    );
    return result;
};
