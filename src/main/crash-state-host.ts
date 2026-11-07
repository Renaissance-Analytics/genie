import type { CrashRecord, CrashStateView, HangNotice } from '../core/crash-record.js';

/**
 * GENIE-HOST'S CRASH STATE (#1623 review; Tynn story #386): what a LOCAL window is told about the last crash.
 *
 *  - `record`: the latest CrashRecord — at boot the previous run's newest (crash-records.ts `previousRunRecord`), then
 *    each one this host's watchdog writes. The safe-mode banner and the reopened-window notice hand it to "Send a crash
 *    report". Already bounded (core/crash-record.ts) and content-free.
 *  - `notice`: set when the watchdog ended a hung window (and started a new one): the new window says so, NOT safe mode —
 *    this host never stopped. Kept until the person dismisses it, so a window opened later still says what happened.
 */
export class CrashStateHost {
    #view: CrashStateView;
    readonly #listeners = new Set<(view: CrashStateView) => void>();

    constructor(latest: CrashRecord | null) {
        this.#view = { record: latest, notice: null };
    }

    view(): CrashStateView {
        return this.#view;
    }

    recorded(record: CrashRecord): void {
        this.#set({ ...this.#view, record });
    }

    hung(notice: HangNotice): void {
        this.#set({ ...this.#view, notice });
    }

    /** The person dismissed the notice: forgotten, for every window. The record stays for a later report. */
    dismiss(): CrashStateView {
        if (this.#view.notice !== null) this.#set({ ...this.#view, notice: null });
        return this.#view;
    }

    onChange(listener: (view: CrashStateView) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #set(view: CrashStateView): void {
        this.#view = view;
        for (const listener of [...this.#listeners]) {
            try { listener(view); } catch { /* a listener's fault is its own */ }
        }
    }
}
