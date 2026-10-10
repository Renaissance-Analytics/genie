// electron-builder `afterPack` hook — the node-pty packaging fix, from fancy-term-host.
//
// `fancy-term-host/docs/packaging.md`: a standard packaged Electron build spawns NO terminal at
// all until three per-OS breakages are patched — Windows is missing the `conpty/` subdir with
// `conpty.dll` + `OpenConsole.exe` that node-pty `LoadLibrary`s; macOS arm64 kills the unsigned
// `spawn-helper`; Linux loses the helper's executable bit. The package ships the fix as a hook,
// so Genie does not reimplement it and inherits every correction Fancy makes to it.
//
// CommonJS because electron-builder loads hooks with `require`.
//
// It never throws on its own; it returns a result. A `skipped` result means node-pty was not
// found under the packed app — almost always a wrong `asarUnpack` glob — and that is turned
// into a hard failure here, because an installer that silently cannot open a terminal is the
// exact kind of green build this project exists to stop.

const { fancyTermAfterPack } = require('@particle-academy/fancy-term-host/electron');

module.exports = async function afterPack(context) {
    const result = await fancyTermAfterPack(context);
    console.log(`[fancy-term-host] ${result.platform}: ${result.action}${result.detail ? ` — ${result.detail}` : ''}`);
    if (!result.ok) {
        throw new Error(`node-pty packaging fix failed (${result.action}): ${result.detail ?? 'no detail'}`);
    }
};
