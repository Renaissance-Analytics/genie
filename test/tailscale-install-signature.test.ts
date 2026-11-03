import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTailscale, readAuthenticode, refusalOf, trustWords, type InstallPorts } from '../src/main/tailscale-cli.js';

/**
 * WHAT WINDOWS IS ASKED TO RUN (genie#1497). The installer came over the network and was started with nothing checked. Now Windows' own Authenticode verdict comes first: valid, and signed by Tailscale Inc.
 * (read from the real installer's certificate table on 2026-11-03: CN=Tailscale Inc., O=Tailscale Inc., under DigiCert's code-signing CA). Anything else is refused, in words, and the file does not stay.
 * On other platforms nothing is downloaded: the person is sent to Tailscale's page.
 */
const GOOD = 'CN=Tailscale Inc., O=Tailscale Inc., L=Toronto, S=Ontario, C=CA';

describe('the verdict', () => {
    it('valid, and Tailscale: no refusal', () => {
        expect(refusalOf({ status: 'Valid', subject: GOOD })).toBeNull();
        expect(refusalOf({ status: 'Valid', subject: 'CN="Tailscale Inc.", O="Tailscale Inc.", C=CA' })).toBeNull();
    });

    it.each([['NotSigned'], ['HashMismatch'], ['NotTrusted'], ['UnknownError'], ['']])('%s: refused, saying so', (status) => {
        expect(refusalOf({ status, subject: GOOD })).toMatch(status === '' ? /signature/ : new RegExp(status));
    });

    it.each([
        ['another publisher', 'CN=Evil Ltd., O=Evil Ltd., C=CA'],
        ['the name further along', 'CN=Evil Ltd., O=CN=Tailscale Inc., C=CA'],
        ['a longer name', 'CN=Tailscale Inc. Partners, O=Tailscale Inc., C=CA'],
        ['the right common name and another organisation', 'CN=Tailscale Inc., O=Evil Ltd., C=CA'],
    ])('valid, but %s: refused, naming who signed it', (_, subject) => {
        expect(refusalOf({ status: 'Valid', subject })).toMatch(/signed by/);
    });

    it('valid with no signer read: refused', () => {
        expect(refusalOf({ status: 'Valid', subject: null })).toMatch(/signed by/);
    });
});

describe("WinVerifyTrust's answers", () => {
    it.each([[0, 'Valid'], [-2146762496, 'NotSigned'], [-2146869232, 'HashMismatch'], [-2146762487, 'NotTrusted'], [-2146762495, 'Expired']])('%i is %s', (code, words) => {
        expect(trustWords(code)).toBe(words);
    });

    it('one it does not know is unknown, by number, and that is a refusal', () => {
        expect(trustWords(-2146762749)).toBe('UnknownError 0x800b0003');
        expect(refusalOf({ status: trustWords(-2146762749), subject: GOOD })).toContain('0x800b0003');
    });
});

describe('the install', () => {
    let launched: string[];
    let seen: string[];
    const bytes = () => new Response('the-installer');
    const ports = (over: Partial<InstallPorts>): Partial<InstallPorts> => ({
        platform: 'win32',
        installed: () => null,
        download: async () => bytes(),
        launch: (file) => { launched.push(file); },
        ...over,
    });
    beforeEach(() => { launched = []; seen = []; });

    it('a good signature runs what was checked', async () => {
        const result = await installTailscale(ports({ verify: async (file) => { seen.push(file); expect(readFileSync(file, 'utf8')).toBe('the-installer'); return { status: 'Valid', subject: GOOD }; } }));
        expect(result).toEqual({ started: true });
        expect(launched).toEqual(seen);
    });

    it('a bad one does not run, the file does not stay, and the person is sent to the page with the reason', async () => {
        const result = await installTailscale(ports({ verify: async (file) => { seen.push(file); return { status: 'HashMismatch', subject: GOOD }; } }));
        expect(launched).toEqual([]);
        expect(existsSync(seen[0]!)).toBe(false);
        expect(result.started).toBe(false);
        expect(result.url).toBe('https://tailscale.com/download');
        expect(result.message).toMatch(/HashMismatch/);
    });

    it('a check that cannot run at all is a refusal, never a pass', async () => {
        const result = await installTailscale(ports({ verify: async (file) => { seen.push(file); throw new Error('powershell is not there'); } }));
        expect(launched).toEqual([]);
        expect(existsSync(seen[0]!)).toBe(false);
        expect(result.started).toBe(false);
        expect(result.message).toMatch(/could not be checked/);
    });

    it('each download has a folder of its own', async () => {
        const verify = async (file: string) => { seen.push(file); return { status: 'Valid', subject: GOOD }; };
        await installTailscale(ports({ verify }));
        await installTailscale(ports({ verify }));
        expect(seen[0]!.replace(/[\\/][^\\/]*$/, '')).not.toBe(seen[1]!.replace(/[\\/][^\\/]*$/, ''));
    });

    it('on Linux nothing is downloaded, so there is nothing to check: the page', async () => {
        const result = await installTailscale(ports({ platform: 'linux', download: async () => { throw new Error('asked to download'); } }));
        expect(result).toEqual({ started: false, url: 'https://tailscale.com/download' });
    });
});

/** Windows' own answer, on files whose answer is known. CI's unit (windows) runs these. */
describe.skipIf(process.platform !== 'win32')('Windows itself', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'authenticode-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('an unsigned file: refused', async () => {
        const file = join(dir, 'unsigned.exe');
        writeFileSync(file, 'not a program');
        const answer = await readAuthenticode(file);
        // An answer that is really Windows': an empty one was refused too, for the wrong reason, on CI's first run.
        expect(answer.status).toMatch(/NotSigned|UnknownError/);
        expect(refusalOf(answer)).toContain(answer.status);
    });

    // node.exe carries its signature in the file, as Tailscale's installer does. Windows' own programs mostly use a catalogue, which this does not ask about.
    it('CONTROL: node.exe reads as validly signed, by someone who is not Tailscale', async () => {
        const answer = await readAuthenticode(process.execPath);
        expect(answer.status).toBe('Valid');
        expect(answer.subject).toMatch(/OpenJS|Node/);
        expect(refusalOf(answer)).toMatch(/signed by/);
    });

    it('the same file with one byte changed: refused for that', async () => {
        const changed = readFileSync(process.execPath);
        changed[Math.floor(changed.length / 3)]! ^= 0xff;
        const file = join(dir, 'changed.exe');
        writeFileSync(file, changed);
        const answer = await readAuthenticode(file);
        expect(answer.status).toBe('HashMismatch');
        expect(refusalOf(answer)).toContain('HashMismatch');
    });

    it('a name with a space and a quote in it reaches the check whole', async () => {
        const file = join(dir, "un signed's.exe");
        writeFileSync(file, 'not a program');
        expect((await readAuthenticode(file)).status).toMatch(/NotSigned|UnknownError/);
    });
});
