/**
 * Host-side "put a pasted image where the CLI will read it" — shared by the local
 * IPC clipboard handler (`clipboard:write-image`) and the remote-bridge route
 * (`/api/clipboard/image` → `MobileDataDeps.writeClipboardImage`) so BOTH paths
 * behave identically on every OS.
 *
 * WHY a platform split (the beta.104 Linux fix):
 *   - **Windows / macOS** put a real image on the OS clipboard and Claude Code
 *     reads it natively on Ctrl+V — the native, no-temp-file experience. Keep it.
 *   - **Linux** does NOT reliably hand Claude Code a clipboard image: a headless
 *     host (Genie Cloud / the Aionima Virtual Workstation) has no display and no
 *     clipboard at all, and even a HEADED X11/Wayland desktop needs `xclip` /
 *     `wl-paste` and the right `image/png` target for the CLI to see it — which it
 *     frequently can't. `clipboard.writeImage` still returns without throwing, so
 *     the old code reported `ok:true` while NOTHING landed → Claude Code's
 *     "no image content available … use Ctrl+V to paste it."
 *
 * The durable, display-independent Linux delivery is a temp FILE: write the PNG to
 * a file the CLI can read and return its PATH. The caller (Terminal.tsx) pastes the
 * quoted path into the pty and Claude Code attaches the image from the path, exactly
 * like a drag-drop / file-path reference — no OS image clipboard needed.
 */
import { clipboard, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WriteClipboardImageResult {
    /** The image was placed where the CLI can read it (clipboard OR temp file). */
    ok: boolean;
    /** The host can accept a pasted image at all. Only ever false on a legacy
     *  caller that leaves the whole writer unwired; this helper always supports
     *  it (Linux via temp file, Windows/macOS via clipboard). */
    supported: boolean;
    /**
     * Absolute HOST path to a temp PNG the caller must hand the CLI (a bracketed
     * paste of the quoted path) instead of a clipboard trigger. Set ONLY on Linux,
     * where the OS image clipboard is unreliable for Claude Code. Absent on
     * Windows/macOS, where the image is on the OS clipboard and Ctrl+V reads it.
     */
    path?: string;
}

/** Temp dir for pasted-image files, e.g. `/tmp/genie-clipboard`. */
function clipboardTmpDir(): string {
    return path.join(os.tmpdir(), 'genie-clipboard');
}

/** Best-effort GC: drop pasted-image temp files older than the window so the dir
 *  can't grow without bound. Never throws — cleanup must not break a paste. */
function pruneOldPastes(dir: string, maxAgeMs = 6 * 60 * 60 * 1000): void {
    try {
        const now = Date.now();
        for (const name of fs.readdirSync(dir)) {
            if (!name.startsWith('paste-')) continue;
            const full = path.join(dir, name);
            try {
                if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.unlinkSync(full);
            } catch {
                /* file vanished / racing prune — ignore */
            }
        }
    } catch {
        /* dir missing or unreadable — nothing to prune */
    }
}

/** Write the PNG to a fresh temp file and return its absolute path. */
function writePngTempFile(png: Buffer): string {
    const dir = clipboardTmpDir();
    fs.mkdirSync(dir, { recursive: true });
    pruneOldPastes(dir);
    const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, png);
    return file;
}

/**
 * Place a pasted PNG where the local CLI will read it. See the module header for
 * the platform split. `png` is a decoded PNG buffer (the client always ships a
 * `nativeImage.toDataURL()` PNG); this validates it decodes before acting.
 */
export function writeClipboardImagePng(png: Buffer): WriteClipboardImageResult {
    // Validate the payload decodes to a real image on every OS — a garbage buffer
    // must never become a temp file whose path we hand the CLI, nor a broken
    // clipboard write. `nativeImage` is pure image decoding (no display needed),
    // so this is safe on a headless Linux host too.
    let img: Electron.NativeImage;
    try {
        img = nativeImage.createFromBuffer(png);
    } catch {
        return { ok: false, supported: true };
    }
    if (img.isEmpty()) return { ok: false, supported: true };

    if (process.platform === 'linux') {
        // Linux: hand the CLI a temp FILE + path — the OS image clipboard is
        // unreliable here (headless has none; headed needs xclip/wl-paste +
        // image/png target). Write the ORIGINAL png bytes (a valid PNG from the
        // client's toDataURL) so the file is a clean, CLI-readable image.
        try {
            const file = writePngTempFile(png);
            return { ok: true, supported: true, path: file };
        } catch {
            return { ok: false, supported: true };
        }
    }

    // Windows / macOS: the OS image clipboard is reliable and the CLI reads it
    // natively on Ctrl+V — keep the native clipboard paste (no temp file).
    try {
        clipboard.writeImage(img);
        return { ok: true, supported: true };
    } catch {
        return { ok: false, supported: true };
    }
}
