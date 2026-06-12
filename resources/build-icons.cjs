/**
 * Build app + tray icons from resources/icon-source.png.
 *
 * Source image must be at least 1024×1024. Anything larger gets
 * downscaled; anything smaller fails.
 *
 * Emits:
 *   - resources/icon.png             — 1024×1024 (electron-builder derives
 *                                       .icns from this for macOS).
 *   - resources/icon.ico             — multi-size Windows icon
 *                                       (16/24/32/48/64/128/256), each size
 *                                       resampled individually so the taskbar
 *                                       never renders a shrunken 256px
 *                                       layer. PNG-compressed ICO (Vista+).
 *   - resources/tray-icon.png        — 32×32 (tray bar icon. Windows + Linux
 *                                       use it as-is; macOS template-mode
 *                                       works best with a separate alpha-only
 *                                       version we don't generate here).
 *   - resources/tray-icon-update.png — same, with an amber badge dot in the
 *                                       bottom-right corner; shown while an
 *                                       update is available.
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
const ICO_OUT = path.join(__dirname, 'icon.ico');
const TRAY_OUT = path.join(__dirname, 'tray-icon.png');
const TRAY_UPDATE_OUT = path.join(__dirname, 'tray-icon-update.png');
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

    // Update-available tray variant — same icon with an amber badge dot
    // bottom-right. The dot gets a dark outline so it reads on both light
    // and dark tray bars.
    const badge = Buffer.from(
        `<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg">
            <circle cx="25" cy="25" r="6.5" fill="#09090b"/>
            <circle cx="25" cy="25" r="5" fill="#f59e0b"/>
        </svg>`,
    );
    await sharp(trimmed)
        .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .composite([{ input: badge, top: 0, left: 0 }])
        .png({ compressionLevel: 9 })
        .toFile(TRAY_UPDATE_OUT);
    console.log(`Wrote ${TRAY_UPDATE_OUT}`);

    // Windows .ico — each layer resampled from the trimmed master
    // individually (sharp's Lanczos at 16px beats Windows shrinking a
    // 256px layer). Written as a PNG-compressed ICO container, valid
    // since Vista. electron-builder picks this up via win.icon and
    // embeds it in the exe — this is what the taskbar + alt-tab show.
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const icoPngs = await Promise.all(
        icoSizes.map((size) =>
            sharp(trimmed)
                .resize(size, size, {
                    fit: 'contain',
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .png({ compressionLevel: 9 })
                .toBuffer(),
        ),
    );
    fs.writeFileSync(ICO_OUT, buildIco(icoSizes, icoPngs));
    console.log(`Wrote ${ICO_OUT}`);

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

/**
 * Assemble a PNG-compressed ICO container: ICONDIR header, one
 * ICONDIRENTRY per image, then the raw PNG blobs. Windows accepts
 * PNG-in-ICO for all layers since Vista.
 */
function buildIco(sizes, pngs) {
    const count = sizes.length;
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(count, 4);

    const entries = Buffer.alloc(16 * count);
    let offset = 6 + 16 * count;
    for (let i = 0; i < count; i++) {
        const size = sizes[i];
        const png = pngs[i];
        const o = i * 16;
        entries.writeUInt8(size >= 256 ? 0 : size, o); // width (0 = 256)
        entries.writeUInt8(size >= 256 ? 0 : size, o + 1); // height
        entries.writeUInt8(0, o + 2); // palette
        entries.writeUInt8(0, o + 3); // reserved
        entries.writeUInt16LE(1, o + 4); // color planes
        entries.writeUInt16LE(32, o + 6); // bits per pixel
        entries.writeUInt32LE(png.length, o + 8);
        entries.writeUInt32LE(offset, o + 12);
        offset += png.length;
    }
    return Buffer.concat([header, entries, ...pngs]);
}

build().catch((e) => {
    console.error(e);
    process.exit(1);
});
