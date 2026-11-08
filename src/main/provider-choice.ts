import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * THE PROGRAM THE PERSON CHOSE FOR A PROVIDER (Tynn #577), one small file both of Genie's processes read when a provider
 * starts: the window writes it, genie-host starts the agents. Only an .exe or .com: a batch file needs a shell.
 */
type Choices = Record<string, string>;

let choiceFile: string | null = null;

/** Where this process keeps the choices. Set once at boot; until then nothing is chosen. */
export function setProviderChoiceFile(file: string | null): void { choiceFile = file; }
export function providerChoiceFile(): string | null { return choiceFile; }

function read(file: string): Choices {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Choices : {};
    } catch { return {}; }
}

export function readProviderChoice(file: string | null, provider: string): string | null {
    if (file === null) return null;
    const value = read(file)[provider];
    return typeof value === 'string' && value !== '' ? value : null;
}

export function writeProviderChoice(file: string, provider: string, path: string): { ok: true } | { ok: false; reason: string } {
    if (!/\.(exe|com)$/i.test(path)) return { ok: false, reason: 'Choose an .exe: a batch file cannot be run without a shell.' };
    try {
        mkdirSync(dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify({ ...read(file), [provider]: path }), 'utf8');
        renameSync(temp, file);
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
