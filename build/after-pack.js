// electron-builder afterPack: delegate to the OFFICIAL per-OS node-pty packaging
// fix shipped by fancy-term-host (v0.3.0 `/electron`). It makes a packaged node-pty
// actually spawn a terminal:
//   • Windows — copy conpty.dll + OpenConsole.exe into build/Release/conpty/
//   • macOS   — ad-hoc codesign spawn-helper (certless; no Developer-ID needed)
//   • Linux   — chmod +x spawn-helper
// Idempotent + unit-tested upstream. This replaces the hand-rolled copy that used
// to live here — see Particle-Academy/fancy-term-host#7 + genie #14.
const { fancyTermAfterPack } = require('@particle-academy/fancy-term-host/electron');

exports.default = async function afterPack(context) {
    const result = await fancyTermAfterPack(context);
    console.log(
        `[after-pack] fancy-term-host node-pty: ${result.platform} -> ${result.action}` +
            ` (ok=${result.ok})${result.detail ? ' - ' + result.detail : ''}`,
    );
    return result;
};
