// after-pack: ensure node-pty's ConPTY runtime files land in build/Release on Windows.
//
// The Electron-ABI rebuild (`electron-builder install-app-deps`) compiles node-pty's
// .node addons into node_modules/node-pty/build/Release, but does NOT copy the
// ConPTY runtime pieces (conpty.dll / OpenConsole.exe) there — they only exist under
// node-pty/prebuilds/<plat>/conpty and node-pty/third_party/conpty/*. At runtime the
// ConPTY backend does `LoadLibrary(build/Release/conpty.dll)` and fails with
// "Cannot find conpty.dll ... error code: 3", so NO pty spawns and the in-process
// terminal backend is dead. This copies the missing files into build/Release so a
// packaged Windows build can actually spawn terminals. (genie #14)
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;
    // Arch enum (builder-util): ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
    const arch = context.arch === 3 ? 'win32-arm64' : 'win32-x64';
    const np = path.join(
        context.appOutDir,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
    );
    const rel = path.join(np, 'build', 'Release');
    // No rebuilt build dir → node-pty resolves from prebuilds (which already has the
    // DLLs), so there's nothing to fix.
    if (!fs.existsSync(rel)) return;

    const wanted = ['conpty.dll', 'OpenConsole.exe'];
    const sources = [
        path.join(np, 'prebuilds', arch, 'conpty'),
        path.join(np, 'prebuilds', 'win32-x64', 'conpty'),
    ];
    // Also scan third_party/conpty/<version>/<win10-*>/ as a fallback.
    try {
        const tp = path.join(np, 'third_party', 'conpty');
        for (const v of fs.existsSync(tp) ? fs.readdirSync(tp) : []) {
            const vd = path.join(tp, v);
            for (const w of fs.existsSync(vd) ? fs.readdirSync(vd) : []) {
                sources.push(path.join(vd, w));
            }
        }
    } catch {
        /* best-effort */
    }

    for (const f of wanted) {
        const dst = path.join(rel, f);
        if (fs.existsSync(dst)) continue;
        for (const dir of sources) {
            const src = path.join(dir, f);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dst);
                console.log(`[after-pack] node-pty: copied ${f} -> build/Release (from ${dir})`);
                break;
            }
        }
        if (!fs.existsSync(dst)) {
            console.log(`[after-pack] node-pty: WARNING could not find a source for ${f}`);
        }
    }
};
