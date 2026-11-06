import { NOT_SAFE, type SafeModeItem, type SafeModeView } from '../core/safe-mode.js';

/** SAFE MODE, GENIE-HOST'S (Tynn #386). Red first: the shape only. */
export class SafeMode {
    static open(_runtimeDir: string, _options: { readonly now?: () => number; readonly pid?: number; readonly log?: (line: string) => void } = {}): SafeMode {
        return new SafeMode();
    }

    active(): boolean { return false; }
    view(): SafeModeView { return NOT_SAFE; }
    leave(): SafeModeView { return NOT_SAFE; }
    onChange(_listener: (view: SafeModeView) => void): () => void { return () => {}; }
    hold(_kind: 'process' | 'site', _item: SafeModeItem): void {}
    wasRunning(_agents: readonly string[]): void {}
    beat(_agents: readonly string[]): void {}
    writeCleanExit(_reason: string): void {}
}
