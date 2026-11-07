// NSIS signs its temporary *__uninstaller.exe, embeds those bytes in setup.exe, then
// deletes the temporary file. Keep a copy immediately after signIf succeeds so the shared
// verification step can check the embedded uninstaller without installing/running Genie.
const { copyFileSync, mkdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

module.exports = function retainSignedUninstaller({ packager, outDir }) {
    const evidenceDir = join(outDir, 'signature-evidence');
    const evidenceFile = join(evidenceDir, 'nsis-uninstaller.exe');
    // A repeated build must produce fresh evidence, not reuse an earlier uninstaller.
    rmSync(evidenceFile, { force: true });
    const sign = packager.signIf.bind(packager);
    packager.signIf = async (file) => {
        const signed = await sign(file);
        if (/__uninstaller\.exe$/i.test(file)) {
            if (signed !== true) throw new Error('NSIS uninstaller was not signed');
            mkdirSync(evidenceDir, { recursive: true });
            copyFileSync(file, evidenceFile);
            console.log(`Retained signed NSIS uninstaller: ${evidenceFile}`);
        }
        return signed;
    };
};
