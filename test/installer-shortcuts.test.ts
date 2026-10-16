import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entryFor } from '../src/core/entry-mode.js';

/**
 * TWO START-MENU SHORTCUTS: GENIE, AND GENIE IN DOCTOR MODE (the owner, 2026-10-13: "can the installer also add a
 * shortcut for genie with the doctor flag so it can be opened from the app/start menus? (so two shortcuts, normal and
 * doctor)"). electron-builder's NSIS installer makes the normal one (`$SMPROGRAMS\${SHORTCUT_NAME}.lnk`); its documented
 * custom-script hooks (`build/installer.nsh`, `customInstall` / `customUnInstall`) add the doctor one beside it — the same
 * executable with `--doctor` — and remove it on uninstall. The packaged app's argv (`Genie.exe --doctor`) is what the
 * entry reads. (Linux ships an AppImage: no installer, no menu to add to.)
 */
const nsh = () => readFileSync('build/installer.nsh', 'utf8');
const DOCTOR_LINK = '"$SMPROGRAMS\\${SHORTCUT_NAME} (doctor mode).lnk"';

describe('the installer script', () => {
    it('customInstall creates the doctor shortcut: the app executable, with --doctor', () => {
        const install = nsh().match(/!macro customInstall\b([\s\S]*?)!macroend/)![1]!;
        expect(install).toContain(`CreateShortCut ${DOCTOR_LINK} "$appExe" "--doctor"`);
    });

    it('customUnInstall removes exactly that shortcut', () => {
        const uninstall = nsh().match(/!macro customUnInstall\b([\s\S]*?)!macroend/)![1]!;
        expect(uninstall).toContain(`Delete ${DOCTOR_LINK}`);
    });

    it('electron-builder uses this script, and still makes the normal shortcut itself (positive control: it is not switched off)', () => {
        const yml = readFileSync('electron-builder.yml', 'utf8');
        expect(yml).toMatch(/nsis:[\s\S]*?\n\s+include: build\/installer\.nsh/);
        expect(yml).not.toMatch(/createStartMenuShortcut:\s*false/);
    });
});

describe('the shortcut opens doctor mode', () => {
    it('the packaged app\u2019s argv with --doctor is doctor mode; without it, Genie', () => {
        expect(entryFor(['C:\\Users\\u\\AppData\\Local\\Programs\\genie\\Genie.exe', '--doctor'])).toBe('doctor');
        expect(entryFor(['C:\\Users\\u\\AppData\\Local\\Programs\\genie\\Genie.exe'])).toBe('main');
    });
});
