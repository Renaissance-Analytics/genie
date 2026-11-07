import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THAT THE PERSON LEFT THE HOST RUNNING (P6): on at "Just close the UI", off when Genie is opened again or everything is
 * shut down. A file in the runtime folder, so it outlives a reboot, which is what it is for. The OS ending the session
 * does not touch it.
 */
export class LeftRunningMark {
    readonly #file: string;
    readonly #listeners = new Set<(value: boolean) => void>();
    #value: boolean;

    constructor(runtime: string) {
        this.#file = join(runtime, 'left-running');
        this.#value = existsSync(this.#file);
    }

    now(): boolean { return this.#value; }

    set(value: boolean): void {
        if (value === this.#value) return;
        this.#value = value;
        if (value) {
            mkdirSync(join(this.#file, '..'), { recursive: true });
            writeFileSync(this.#file, '');
        } else {
            rmSync(this.#file, { force: true });
        }
        for (const listener of [...this.#listeners]) listener(value);
    }

    onChange(listener: (value: boolean) => void): void { this.#listeners.add(listener); }
}
