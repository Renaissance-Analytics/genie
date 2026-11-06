import type { CrashRecord, CrashStateView, HangNotice } from '../core/crash-record.js';

/** GENIE-HOST'S CRASH STATE (#1623 review; Tynn #386). Not built yet: this is its shape. */
export class CrashStateHost {
    constructor(_latest: CrashRecord | null) {}

    view(): CrashStateView {
        return { record: null, notice: null };
    }

    recorded(_record: CrashRecord): void {}

    hung(_notice: HangNotice): void {}

    dismiss(): CrashStateView {
        return this.view();
    }

    onChange(_listener: (view: CrashStateView) => void): () => void {
        return () => {};
    }
}
