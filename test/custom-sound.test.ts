import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SOUND_BYTES, soundFileMime } from '../src/core/custom-sound.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { customSoundData, handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * YOUR OWN SOUND FILE FOR AN ALERT (Tynn #766 row B2; Genie 1's "Custom file…" — genie main/notify-sound.ts and ipc.ts
 * `settings:choose-file` / `settings:sound-data-url` at v0.7.0-beta.342). The owner, 2026-10-17: "did you include the
 * custom sounds we had for genie 1?"
 *
 * The file is picked IN THE WINDOW over the HOST's disk (Tynn #835: FileBrowser, not a native dialog — so a remote
 * window picks on the host it drives) and its path handed to `settings.setSoundFile`, which keeps only a sound file
 * Genie can play. Playing reads it by SETTING KEY, never by path — so this is not a way to read an arbitrary file —
 * within a size cap. A file that is gone plays the alert's own sound (the caller's fallback), never nothing.
 */
const pty: PtyPort = { open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
const state = (): FeatureState => ({ toolStatuses: null, knowledgeQuery: '' });
/** A minimal RIFF/WAVE header: enough bytes to be a file the picker would hand over. */
const WAV = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1');

describe('which files are sounds', () => {
    it('the formats Chromium plays, by extension, any case; anything else is not a sound', () => {
        expect(soundFileMime('/x/ding.wav')).toBe('audio/wav');
        expect(soundFileMime('C:\\x\\Ding.MP3')).toBe('audio/mpeg');
        expect(soundFileMime('/x/a.ogg')).toBe('audio/ogg');
        expect(soundFileMime('/x/a.m4a')).toBe('audio/mp4');
        expect(soundFileMime('/x/a.flac')).toBe('audio/flac');
        expect(soundFileMime('/x/a.txt')).toBeNull();
        expect(soundFileMime('/x/wav')).toBeNull();
        expect(MAX_SOUND_BYTES).toBe(10 * 1024 * 1024);
    });
});

describe('choosing and playing your own file', () => {
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-custom-sound-'));
        services = await composeServices({ userData: join(dir, 'data'), pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => [] });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
    });

    it('picked: the alert is set to Custom file and the path is kept; the others are untouched', async () => {
        const file = join(dir, 'ding.wav');
        await writeFile(file, WAV);
        await handleFeatureAction(services, { kind: 'settings.set', key: 'sound_finished', value: 'sparkle' }, state());
        await handleFeatureAction(services, { kind: 'settings.setSoundFile', key: 'sound_question', path: file }, state());
        expect(services.settings.get('sound_question')).toBe('custom');
        expect(services.settings.get('sound_question_custom')).toBe(file);
        // CONTROL: another alert's choice stays as it was.
        expect(services.settings.get('sound_finished')).toBe('sparkle');
        expect(services.settings.get('sound_finished_custom')).toBe('');
    });

    it('refused, with the reason: a file that is not a sound, and a key that is not an alert sound', async () => {
        const text = join(dir, 'notes.txt');
        await writeFile(text, 'hello');
        await expect(handleFeatureAction(services, { kind: 'settings.setSoundFile', key: 'sound_question', path: text }, state())).rejects.toThrow(/not a sound file/);
        await expect(handleFeatureAction(services, { kind: 'settings.setSoundFile', key: 'theme', path: text }, state())).rejects.toThrow(/not an alert sound/);
        expect(services.settings.get('sound_question')).not.toBe('custom');
    });

    it('read by KEY into a data URL; null — so the alert plays its own sound — for no file, a gone file, a non-sound, a key that is not an alert sound, or one too big', async () => {
        const file = join(dir, 'ding.wav');
        await writeFile(file, WAV);
        await services.settings.set('sound_question_custom', file);
        expect(await customSoundData(services.settings, 'sound_question')).toBe(`data:audio/wav;base64,${WAV.toString('base64')}`);
        expect(await customSoundData(services.settings, 'sound_finished')).toBeNull();
        await services.settings.set('sound_finished_custom', join(dir, 'gone.wav'));
        expect(await customSoundData(services.settings, 'sound_finished')).toBeNull();
        await writeFile(join(dir, 'notes.txt'), 'x');
        await services.settings.set('sound_broken_custom', join(dir, 'notes.txt'));
        expect(await customSoundData(services.settings, 'sound_broken')).toBeNull();
        expect(await customSoundData(services.settings, 'theme')).toBeNull();
        const big = join(dir, 'big.wav');
        await writeFile(big, Buffer.alloc(MAX_SOUND_BYTES + 1));
        await services.settings.set('sound_mail_custom', big);
        expect(await customSoundData(services.settings, 'sound_mail')).toBeNull();
    });
});
