// after-pack: make the packaged node-pty actually able to spawn a pty on EVERY OS.
// Same root failure everywhere — the Electron-ABI rebuild leaves node-pty's native
// runtime incomplete/unusable per platform — with a different missing piece each time:
//   • Windows: build/Release is missing conpty.dll + OpenConsole.exe (they live only
//     in prebuilds/third_party, not compiled by node-gyp) → ConPTY can't LoadLibrary
//     → "Cannot find conpty.dll" → no pty.
//   • macOS: node-pty's spawn-helper is UNSIGNED, so Apple Silicon SIGKILLs it on
//     exec (all arm64 code must be at least ad-hoc signed) → the shell child never
//     starts → cursor, no output. Ad-hoc signing (certless) fixes it; it needs NO
//     Developer-ID / notarization (that's the separate, deferred signing, #13).
//   • Linux: spawn-helper must remain executable.
// See genie #14 (Windows) + #13 (macOS).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
    const plat = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
    const np = path.join(
        context.appOutDir,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'node-pty',
    );
    const rel = path.join(np, 'build', 'Release');

    // ── Windows: copy the ConPTY runtime the rebuild dropped ────────────────────
    if (plat === 'win32' && fs.existsSync(rel)) {
        const arch = context.arch === 3 ? 'win32-arm64' : 'win32-x64';
        const sources = [
            path.join(np, 'prebuilds', arch, 'conpty'),
            path.join(np, 'prebuilds', 'win32-x64', 'conpty'),
        ];
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
        // node-pty's conpty.node LoadLibrary's conpty.dll from a `conpty/` SUBDIR next
        // to itself — build/Release/conpty/conpty.dll — mirroring the prebuilds layout
        // (prebuilds/<plat>/conpty.node + prebuilds/<plat>/conpty/conpty.dll). The
        // rebuild ships conpty.node but NOT that subdir, so recreate it. (Also drop a
        // top-level copy for any older resolution path.)
        const conptySub = path.join(rel, 'conpty');
        try {
            fs.mkdirSync(conptySub, { recursive: true });
        } catch {
            /* best-effort */
        }
        for (const f of ['conpty.dll', 'OpenConsole.exe']) {
            let src = null;
            for (const dir of sources) {
                const cand = path.join(dir, f);
                if (fs.existsSync(cand)) {
                    src = cand;
                    break;
                }
            }
            if (!src) {
                console.log(`[after-pack] node-pty: WARNING no source found for ${f}`);
                continue;
            }
            for (const dst of [path.join(conptySub, f), path.join(rel, f)]) {
                try {
                    fs.copyFileSync(src, dst);
                } catch (e) {
                    console.log(`[after-pack] node-pty: copy ${f} -> ${dst} failed: ${e && e.message}`);
                }
            }
            console.log(`[after-pack] node-pty: placed ${f} in build/Release/conpty/ (+ build/Release/)`);
        }
    }

    // ── Unix: keep spawn-helper executable ──────────────────────────────────────
    if (plat === 'darwin' || plat === 'linux') {
        const helper = path.join(rel, 'spawn-helper');
        if (fs.existsSync(helper)) {
            try {
                fs.chmodSync(helper, 0o755);
                console.log('[after-pack] node-pty: chmod +x spawn-helper');
            } catch (e) {
                console.log(`[after-pack] node-pty: chmod spawn-helper failed: ${e && e.message}`);
            }
        } else {
            console.log('[after-pack] node-pty: WARNING spawn-helper missing from build/Release');
        }
    }

    // ── macOS: ad-hoc code-sign so nested execs (spawn-helper) run on Apple Silicon.
    // Certless — no Developer-ID / notarization (that's the deferred #13 work).
    // electron-builder skips its OWN signing when no cert is configured, so this is
    // what actually signs the app. If a real cert IS present, skip and let
    // electron-builder's signing (which runs after this hook) take over.
    if (plat === 'darwin') {
        const hasCert = !!(process.env.CSC_LINK || process.env.MAC_CSC_LINK);
        if (!hasCert) {
            const appName = `${context.packager.appInfo.productFilename}.app`;
            const appPath = path.join(context.appOutDir, appName);
            if (fs.existsSync(appPath)) {
                try {
                    // Sign inside-out isn't needed for ad-hoc; --deep ad-hoc-signs the
                    // whole bundle incl. Electron helpers + node-pty's spawn-helper.
                    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
                        stdio: 'inherit',
                    });
                    console.log(`[after-pack] ad-hoc code-signed ${appName} (certless — lets spawn-helper run on arm64)`);
                } catch (e) {
                    console.log(`[after-pack] WARNING ad-hoc codesign failed: ${e && e.message}`);
                }
            }
        }
    }
};
