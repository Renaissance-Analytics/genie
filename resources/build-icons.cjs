/**
 * Build app + tray icons from resources/icon-source.png.
 *
 * Source image must be at least 1024×1024. Anything larger gets
 * downscaled; anything smaller fails.
 *
 * Emits:
 *   - resources/icon.png      — 1024×1024 (electron-builder derives
 *                                .icns + .ico from this for macOS +
 *                                Windows packaging).
 *   - resources/tray-icon.png — 32×32 (tray bar icon. Windows + Linux
 *                                use it as-is; macOS template-mode
 *                                works best with a separate alpha-only
 *                                version we don't generate here).
 *
 * Run:   `node resources/build-icons.cjs`  (or `npm run build:icons`)
 */
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');

const SOURCE_CANDIDATES = [
    path.join(__dirname, 'icon-source.png'),
    path.join(__dirname, 'icon-source.jpg'),
    path.join(__dirname, 'icon-source.jpeg'),
];
const SOURCE = SOURCE_CANDIDATES.find((p) => fs.existsSync(p));
const ICON_OUT = path.join(__dirname, 'icon.png');
const TRAY_OUT = path.join(__dirname, 'tray-icon.png');
const LOGO_OUT = path.join(__dirname, 'logo.png');
// Next.js serves files in renderer/public/ next to the HTML, which is
// where the master view's <img src="./logo.png" /> resolves. Copy a
// second copy there so the renderer doesn't have to reach into the
// main-process resources/ tree.
const PUBLIC_LOGO_OUT = path.join(__dirname, '..', 'renderer', 'public', 'logo.png');

if (!SOURCE) {
    console.error(
        `Missing source: tried\n  ${SOURCE_CANDIDATES.join('\n  ')}\n` +
        `Save your 1024×1024 master logo as one of those, then re-run.`,
    );
    process.exit(1);
}

async function build() {
    const meta = await sharp(SOURCE).metadata();
    if ((meta.width ?? 0) < 1024 || (meta.height ?? 0) < 1024) {
        throw new Error(
            `${path.basename(SOURCE)} is ${meta.width}×${meta.height}; needs to be at least 1024×1024.`,
        );
    }

    // Crop tight to the logo by trimming the near-black surround. The
    // source has substantial dead space around the icon's rounded
    // square; trimming gives every downstream size more of the logo
    // and less of the bezel.
    const trimmed = await sharp(SOURCE)
        .trim({ threshold: 25, lineArt: false })
        .png()
        .toBuffer();
    const trimmedMeta = await sharp(trimmed).metadata();
    const trimSize = Math.max(trimmedMeta.width ?? 1024, trimmedMeta.height ?? 1024);

    // App icon — paste the trimmed logo into a 1024×1024 transparent
    // square with a thin 6% margin. electron-builder derives .icns +
    // .ico from this.
    const margin = Math.round(trimSize * 0.06);
    await sharp({
        create: {
            width: trimSize + margin * 2,
            height: trimSize + margin * 2,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: trimmed, gravity: 'center' }])
        .resize(1024, 1024, { fit: 'cover' })
        .png({ compressionLevel: 9 })
        .toFile(ICON_OUT);
    console.log(`Wrote ${ICON_OUT}`);

    // Tray icon — 32×32, logo fills the canvas. No transparent margin
    // because tray bars supply their own breathing room.
    await sharp(trimmed)
        .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toFile(TRAY_OUT);
    console.log(`Wrote ${TRAY_OUT}`);

    // Header logo — 128×128 PNG with transparent background for use
    // in the app's UI (TheFloor top-left, About dialog, etc.).
    await sharp(trimmed)
        .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toFile(LOGO_OUT);
    console.log(`Wrote ${LOGO_OUT}`);

    fs.mkdirSync(path.dirname(PUBLIC_LOGO_OUT), { recursive: true });
    fs.copyFileSync(LOGO_OUT, PUBLIC_LOGO_OUT);
    console.log(`Wrote ${PUBLIC_LOGO_OUT}`);
}

build().catch((e) => {
    console.error(e);
    process.exit(1);
});
