import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, SOUND_CHOICES, alertSound, previewSound, soundFile, soundPickerList } from '../src/core/alerts.js';
import { missingSoundAssets } from '../scripts/sound-assets-check.mjs';

/**
 * THE SOUND LIBRARY (Tynn #441): the 47 Kenney CC0 sounds the owner picked on 2026-11-08, beside Genie's own five.
 * Each is EXACTLY the file he picked (by the sha256 of the source file), renamed so the set reads as words and never
 * as a pack with gaps: a family, and a name from one theme per family; no numbers, no pack names. Which source file
 * each name came from is kept only in the sounds' CREDITS.md. Every choice resolves to a file that ships, and every
 * sound file that ships is a choice.
 */

/** [value, label, the source file under the envelope's .ai/design/cc0-candidates/, its sha256]: the owner's picks. */
const LIBRARY: ReadonlyArray<readonly [string, string, string, string]> = [
    ['chime-amber', 'Chimes · Amber', 'kenney_interface-sounds/Audio/confirmation_001.ogg', '063564703b6094d70718a3e787a55cc9141611e4ecd6b6637f8828f79b4a8c3a'],
    ['chime-beryl', 'Chimes · Beryl', 'kenney_interface-sounds/Audio/confirmation_002.ogg', '33b17a9a9a2397c62b285c52c33a907fdffb476909c99e42dde603f6a7a8b12c'],
    ['chime-coral', 'Chimes · Coral', 'kenney_interface-sounds/Audio/confirmation_003.ogg', '3091bf0be0497f825769ee0733ca7bdc3bcd59bd6c6e8f2ba8f93d580ff38022'],
    ['chime-garnet', 'Chimes · Garnet', 'kenney_interface-sounds/Audio/question_001.ogg', 'abb8f9e4eb2071491b0b15f84ee302386b1847609310c1b000ae174639a6cc5a'],
    ['chime-jade', 'Chimes · Jade', 'kenney_interface-sounds/Audio/question_003.ogg', '00bafc564e29c12e99da584864a750260e7110378251d63d3aa5b3d727836efe'],
    ['chime-opal', 'Chimes · Opal', 'kenney_interface-sounds/Audio/question_004.ogg', '585ecb58b529dc49b5c5ce5ba93427bf73b7052bae55e49c43ba8f169c93ac99'],
    ['chime-pearl', 'Chimes · Pearl', 'kenney_interface-sounds/Audio/maximize_005.ogg', '0ee06fc3ee494723fc95b2224f9dc0af857f2903e7f94d5d33d8e67f454b3cf7'],
    ['chime-topaz', 'Chimes · Topaz', 'kenney_interface-sounds/Audio/maximize_006.ogg', 'f050b3bb77cb0b901bc8df43d2cc1872c353aebae10b4030cf8ae681726ad343'],
    ['alert-altair', 'Alerts · Altair', 'kenney_interface-sounds/Audio/error_002.ogg', '76810ec365f41078fd0507101da5bb7b8730fe011dde43908329fdabd8575e79'],
    ['alert-deneb', 'Alerts · Deneb', 'kenney_interface-sounds/Audio/error_006.ogg', 'a97513d7fd2b12b1210c423be943b4c1ab0e899b11db95855e9b74836e646ae0'],
    ['alert-rigel', 'Alerts · Rigel', 'kenney_interface-sounds/Audio/error_007.ogg', 'f1ee4c1ac8bfe1a82eacb54b26f49e8974bab93bcf10c01800bc10dbf730f559'],
    ['alert-vega', 'Alerts · Vega', 'kenney_interface-sounds/Audio/error_008.ogg', 'eba17ecb2a426bfd4a8a6acff5f8a86202b6424a77af0fd842e37809a1ab6d81'],
    ['click-alder', 'Clicks · Alder', 'kenney_interface-sounds/Audio/back_001.ogg', '07db973f79f6ae0f2edc34561e7592e24d0577455919fb602cb8ecc0da991dcf'],
    ['click-birch', 'Clicks · Birch', 'kenney_interface-sounds/Audio/back_004.ogg', 'c22e3c49f42c2a5ba6748e91283efe124f32822469c1258c3e5d7b3d7ab9361c'],
    ['click-cedar', 'Clicks · Cedar', 'kenney_interface-sounds/Audio/click_003.ogg', '2fa929138bc3a0f432696588f66eac94b8f6d463905ec8808c6461ce4b054292'],
    ['click-elm', 'Clicks · Elm', 'kenney_interface-sounds/Audio/close_002.ogg', 'bc4279d2bb2bf86592473eab6a8eab55e51b54a8619315000dbd780a83b102d8'],
    ['click-hazel', 'Clicks · Hazel', 'kenney_interface-sounds/Audio/drop_001.ogg', '692ee3a6f1821402ca649ff735bee9591dc4846c8098fc7d6a90fd15fa57c1af'],
    ['click-larch', 'Clicks · Larch', 'kenney_interface-sounds/Audio/drop_002.ogg', '4ac4d1cef7e936965cbf795852ca2020300b9e2ba7daa59f2bf4f1f7bf416218'],
    ['click-maple', 'Clicks · Maple', 'kenney_interface-sounds/Audio/drop_004.ogg', '10738707f9300f9b963ceba46d5da2ed4a221faf7d39484a643c2d3bc151c5f2'],
    ['click-oak', 'Clicks · Oak', 'kenney_interface-sounds/Audio/minimize_001.ogg', '8481912bc7fa5828924a00ef15b6cd613b994956e0817bd3122065c9b2896d2d'],
    ['click-pine', 'Clicks · Pine', 'kenney_interface-sounds/Audio/minimize_005.ogg', '4e6792a98c75d3ff187c0c55561c38c569e02c64757ebebb98831cfe84e3e172'],
    ['click-rowan', 'Clicks · Rowan', 'kenney_interface-sounds/Audio/minimize_006.ogg', '39d7c47855b9642f43548b7b132c20e20a1490c7eb13d10008c32fcb24da19f8'],
    ['digital-ariel', 'Digital · Ariel', 'kenney_digital-audio/Audio/laser2.ogg', '50470d64f9397855e5d9a334484da9c5232b3e0524c52f088b8a73822bd89f45'],
    ['digital-callisto', 'Digital · Callisto', 'kenney_digital-audio/Audio/laser9.ogg', 'ae77fe3e3f3488e64b83f0526640af512e5ef452d88e79b4b97404803a047e9f'],
    ['digital-deimos', 'Digital · Deimos', 'kenney_digital-audio/Audio/lowDown.ogg', 'e0215fcfd8b9d7877f74d5c46b239a13d7db0d25998da97b80404931ef9eef5d'],
    ['digital-europa', 'Digital · Europa', 'kenney_digital-audio/Audio/pepSound1.ogg', 'f2f44effce087e47683f0fea05a71002bd8dca78fb10bf93d9f0b38d49f9590e'],
    ['digital-ganymede', 'Digital · Ganymede', 'kenney_digital-audio/Audio/pepSound2.ogg', '5a33494e622c15c4587e0a19447cf55c86283faac0e6c1238b550f43a30f16a3'],
    ['digital-io', 'Digital · Io', 'kenney_digital-audio/Audio/phaseJump2.ogg', '5d85717cfca231f7da7887cef5f44b2131bbe3308eb0c1fee0b4f9e61d59b571'],
    ['digital-miranda', 'Digital · Miranda', 'kenney_digital-audio/Audio/phaserDown3.ogg', '19fd2f5bb8448e022381f1a72c36117d4adcb521ebeb697e888bfaf7945cfa56'],
    ['digital-oberon', 'Digital · Oberon', 'kenney_digital-audio/Audio/phaserUp1.ogg', '4423d459fc15fdd8593a4584d71e272ec2e5f8bdc11b759db623fc613ffd957c'],
    ['digital-phobos', 'Digital · Phobos', 'kenney_digital-audio/Audio/powerUp2.ogg', '83786b43d828a399e14ac20604b63a60ca05385977f5477d00304c2adc696204'],
    ['digital-rhea', 'Digital · Rhea', 'kenney_digital-audio/Audio/powerUp4.ogg', 'df6992456056af760815460b66d2ca1c3a07c200cca26325db5820b90104d177'],
    ['digital-titan', 'Digital · Titan', 'kenney_digital-audio/Audio/spaceTrash5.ogg', '7b74e7c5c9df8023bd6bdc595045ef96bd3e606da5457cfbbb6ff9d4dd32a005'],
    ['digital-triton', 'Digital · Triton', 'kenney_digital-audio/Audio/tone1.ogg', '12c6a1955aad54cb04206b5e9985df4379ebc598a01b65070609e0b0a3b9b026'],
    ['jingle-finch', 'Jingles · Finch', 'kenney_music-jingles/Audio/8-Bit jingles/jingles_NES00.ogg', '1010c9b566d6c090ff03a4aaaf7439e26eb4cc4f20373800d0b7e6a9057b795d'],
    ['jingle-heron', 'Jingles · Heron', 'kenney_music-jingles/Audio/8-Bit jingles/jingles_NES11.ogg', 'ee06814cd4e703bdd501b8035d143061b7fa21cf3b5ab2d0cb4e014dabf1054a'],
    ['jingle-kestrel', 'Jingles · Kestrel', 'kenney_music-jingles/Audio/8-Bit jingles/jingles_NES12.ogg', 'ac678f8435036f800f4b2244e6d6b929bfdd012640698ab9815b35b86bfbcd29'],
    ['jingle-lark', 'Jingles · Lark', 'kenney_music-jingles/Audio/Hit jingles/jingles_HIT01.ogg', 'ddca9df332d7cdab525bbbe62ca26e9d61aa64bfa626d9516d5c53eb91c45322'],
    ['jingle-magpie', 'Jingles · Magpie', 'kenney_music-jingles/Audio/Hit jingles/jingles_HIT02.ogg', '1ebd52ba108c0e749d2814c54e44bba6c39d111fa30d025fddfac70538e0e241'],
    ['jingle-nightingale', 'Jingles · Nightingale', 'kenney_music-jingles/Audio/Hit jingles/jingles_HIT11.ogg', '40d6f3fb92225d039a9196c5cda98c9366efdc837c10b9b6d01d94dfafae8ec9'],
    ['jingle-oriole', 'Jingles · Oriole', 'kenney_music-jingles/Audio/Pizzicato jingles/jingles_PIZZI00.ogg', 'b442ade3308a2bbda4b8c572c86f9f1071c7bdbcfb1e6f915d35c605b61bd475'],
    ['jingle-plover', 'Jingles · Plover', 'kenney_music-jingles/Audio/Pizzicato jingles/jingles_PIZZI01.ogg', '3f8f2534a297d19386c233a7ee4fa8737cc40870dd206010263760e1983dde46'],
    ['jingle-robin', 'Jingles · Robin', 'kenney_music-jingles/Audio/Pizzicato jingles/jingles_PIZZI02.ogg', '4967dc3cd31257716f455ef50f8980378726ce086954c7a5563c0c57ee129e3e'],
    ['jingle-sparrow', 'Jingles · Sparrow', 'kenney_music-jingles/Audio/Pizzicato jingles/jingles_PIZZI03.ogg', '88da900ec74a79fb845f2dcf2068383998833a9ee1b87a23f074924781af5700'],
    ['jingle-swift', 'Jingles · Swift', 'kenney_music-jingles/Audio/Pizzicato jingles/jingles_PIZZI12.ogg', 'f5fc4c01b106e6317acaee1bffb51704e41c85b0fa7529dff86b447bdabf150c'],
    ['jingle-thrush', 'Jingles · Thrush', 'kenney_music-jingles/Audio/Pizzicato jingles/jingles_PIZZI13.ogg', '44f5b9d0d3ed9835a015e72199b4b82acc2e7f322c342c4f8f8bf1abd3537214'],
    ['jingle-wren', 'Jingles · Wren', 'kenney_music-jingles/Audio/Pizzicato jingles/jingles_PIZZI14.ogg', 'b6c0e64f9e69883e411e1b7595db5b516019a6e5b720c360bec8f75977549b28'],
];

const SOUNDS = new URL('../src/renderer/sounds/', import.meta.url);
const SPECIAL = new Set(['synth', 'custom', 'off']);
const GENIE_FIVE = ['3tootpipe', 'dingdongdoink', 'sparkle', 'triumphant', 'winddown'];

describe('the library: exactly the owner’s 47 picks', () => {
    it('every pick ships, byte for byte, under its new name', () => {
        expect(LIBRARY).toHaveLength(47);
        for (const [value, , source, sha] of LIBRARY) {
            const file = new URL(`${value}.ogg`, SOUNDS);
            expect(existsSync(file), `${value} (${source})`).toBe(true);
            const bytes = readFileSync(file);
            expect(bytes.subarray(0, 4).toString('latin1'), value).toBe('OggS');
            expect(createHash('sha256').update(bytes).digest('hex'), `${value} is ${source}`).toBe(sha);
        }
    });

    it('is a choice each, labelled with its family and its name, after Genie’s own and before Custom file and None', () => {
        expect(SOUND_CHOICES.map((c) => c.value as string)).toEqual(['synth', ...GENIE_FIVE, ...LIBRARY.map(([v]) => v), 'custom', 'off']);
        const labels: Record<string, string> = Object.fromEntries(SOUND_CHOICES.map((c) => [c.value, c.label]));
        for (const [value, label] of LIBRARY) expect(labels[value], value).toBe(label);
    });

    it('reads as words: no numbers, no pack or source names, every name unique', () => {
        for (const [value, label] of LIBRARY) {
            expect(value).toMatch(/^(chime|alert|click|digital|jingle)-[a-z]+$/);
            expect(label).toMatch(/^(Chimes|Alerts|Clicks|Digital|Jingles) · [A-Z][a-z]+$/);
            expect(`${value} ${label}`.toLowerCase(), value).not.toMatch(/kenney|nes\b|pizzi|laser|pepsound|powerup|spacetrash|phase|tone|confirmation|question|maximize|minimize|error|drop|back|close/);
        }
        const names = LIBRARY.map(([, label]) => label.split(' · ')[1]);
        expect(new Set(names).size).toBe(names.length);
    });

    it('the picker groups them by family: Genie’s own first, then the five families, then Custom file and None', () => {
        const groups = soundPickerList();
        expect(groups.map((g) => g.label)).toEqual(['Genie', 'Chimes and confirmations', 'Alerts and errors', 'Clicks and moves', 'Digital', 'Jingles', 'Other']);
        const prefix: Record<string, string> = { 'Chimes and confirmations': 'chime-', 'Alerts and errors': 'alert-', 'Clicks and moves': 'click-', Digital: 'digital-', Jingles: 'jingle-' };
        for (const g of groups.slice(1, 6)) {
            expect(g.options.length, g.label).toBeGreaterThan(0);
            for (const o of g.options) expect(o.value.startsWith(prefix[g.label]!), o.value).toBe(true);
        }
        expect(groups[0]!.options.map((o) => o.value)).toEqual(['synth', ...GENIE_FIVE]);
        expect(groups[6]!.options.map((o) => o.value)).toEqual(['custom', 'off']);
        // Every choice is in the picker once, in order, under its own label.
        const all = groups.flatMap((g) => g.options);
        expect(all.map((o) => o.value)).toEqual(SOUND_CHOICES.map((c) => c.value));
        expect(all.map((o) => o.label)).toEqual(SOUND_CHOICES.map((c) => c.label));
    });

    it('CREDITS.md names Kenney and CC0 and maps every new name to its source; Kenney’s CC0 licence text ships beside it', () => {
        const credits = readFileSync(new URL('CREDITS.md', SOUNDS), 'utf8');
        expect(credits).toMatch(/Kenney/);
        expect(credits).toMatch(/CC0/);
        const rows = [...credits.matchAll(/^\| `([a-z-]+\.ogg)` \| `([^`]+)` \|\r?$/gm)].map((m) => [m[1], m[2]]);
        expect(rows).toEqual(LIBRARY.map(([value, , source]) => [`${value}.ogg`, source]));
        const licence = readFileSync(new URL('LICENSE-kenney-cc0.txt', SOUNDS), 'utf8');
        expect(licence).toMatch(/Creative Commons Zero, CC0/);
        expect(licence).toMatch(/creativecommons\.org\/publicdomain\/zero\/1\.0/);
    });
});

describe('every choice resolves to a packaged file', () => {
    it('each sound choice names a file in src/renderer/sounds/, and every sound file there is a choice: none missing, no extras', () => {
        const named = SOUND_CHOICES.filter((c) => !SPECIAL.has(c.value)).map((c) => soundFile(c.value));
        for (const f of named) expect(f).not.toBeNull();
        for (const f of named) expect(existsSync(new URL(f!, SOUNDS)), String(f)).toBe(true);
        const shipped = readdirSync(SOUNDS).filter((f) => /\.(wav|ogg|mp3|flac|m4a|aac|opus)$/i.test(f)).sort();
        expect(shipped).toEqual(named.map(String).sort());
        expect(shipped).toHaveLength(52);
        for (const v of SPECIAL) expect(soundFile(v)).toBeNull();
    });

    it('an alert set to a library sound plays its ogg, and Preview plays the same; Genie’s own five are still wavs', () => {
        expect(alertSound('question', { notification_sounds: true, sound_question: 'jingle-robin' })).toEqual({ kind: 'wav', file: 'jingle-robin.ogg' });
        expect(previewSound('finished', 'chime-amber')).toEqual({ kind: 'wav', file: 'chime-amber.ogg' });
        expect(previewSound('finished', 'sparkle')).toEqual({ kind: 'wav', file: 'sparkle.wav' });
    });

    it('today’s defaults are kept: no alert starts playing a new sound', () => {
        expect(Object.fromEntries(ALERT_KINDS.filter((k) => k.sound !== 'off').map((k) => [k.kind, k.sound]))).toEqual({
            question: 'dingdongdoink', approval: '3tootpipe', broken: 'dingdongdoink', finished: 'triumphant', mail: 'dingdongdoink',
        });
    });

    it('the built-renderer check names each sound file the build did not emit, and passes when every one is there', () => {
        const sources = ['jingle-robin.ogg', 'sparkle.wav'];
        expect(missingSoundAssets(sources, ['assets/index-abc.js', 'assets/sparkle-Ab12_x9Z.wav'])).toEqual(['jingle-robin.ogg']);
        expect(missingSoundAssets(sources, ['assets/jingle-robin-Zz9-aB3c.ogg', 'assets/sparkle-Ab12_x9Z.wav'])).toEqual([]);
        // A longer name is not the file: chime-amber-extra-….ogg is not chime-amber.ogg.
        expect(missingSoundAssets(['chime-amber.ogg'], ['assets/chime-amber-extra-Q1w2E3r4.ogg'])).toEqual(['chime-amber.ogg']);
    });
});
