import { writeProviderChoice } from './provider-choice.js';

/**
 * THE PROGRAM THE PERSON CHOSE FOR A PROVIDER, kept by genie-host (Tynn #577; #897 2c-3). The window picked it on this
 * host's disk (its host-disk picker); genie-host writes it to its own choice file, the one its agents start from, and reads
 * that provider's health again so the settings show the program it now finds. Only an .exe or .com (writeProviderChoice).
 */
export interface HostProviderProgramPorts {
    /** genie-host's choice file (provider-choice.ts); null until it is set. */
    file(): string | null;
    /** Read the provider's health again (ProviderHealthBook.refresh). */
    refresh(provider: string): void;
}

export interface HostProviderPrograms {
    choose(provider: string, path: string): { ok: true } | { ok: false; reason: string };
}

export function hostProviderPrograms(ports: HostProviderProgramPorts): HostProviderPrograms {
    return {
        choose: (provider, path) => {
            const file = ports.file();
            if (file === null) return { ok: false, reason: 'Genie has nowhere to keep the choice yet.' };
            const written = writeProviderChoice(file, provider, path);
            if (written.ok) ports.refresh(provider);
            return written;
        },
    };
}
