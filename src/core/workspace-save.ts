import type { GuardViolation } from './workspace-save-guard.js';

/** Inert stubs (RED): the save planner, diff and upstream merge (Tynn #756). The implementation lands after the tests are seen failing. */

export interface SaveFile {
    readonly path: string;
    readonly text: string;
}

export interface LiveModel {
    readonly manifest: Record<string, unknown>;
    readonly manifestText: string;
    readonly files: readonly { readonly path: string; readonly value: unknown }[];
}

export type SavePlan =
    | { ok: true; files: SaveFile[]; backups: SaveFile[]; stampedTo: string | null }
    | { ok: false; reason: string; violations: GuardViolation[] };

export function requiredRevision(_manifest: Record<string, unknown>): string {
    return '0.4.0';
}

export function planSave(_model: LiveModel, _options: { revision?: string } = {}): SavePlan {
    return { ok: true, files: [], backups: [], stampedTo: null };
}

export type FileStatus = 'added' | 'changed' | 'unchanged';

export function diffFiles(_files: readonly SaveFile[], _onDisk: ReadonlyMap<string, string | null>): { path: string; status: FileStatus }[] {
    return [];
}

export function elementsOf(_path: string, _text: string | null): Map<string, unknown> {
    return new Map();
}

export type MergeKind = 'same' | 'local' | 'incoming' | 'conflict';

export interface MergeDecision {
    readonly id: string;
    readonly kind: MergeKind;
    readonly base: unknown;
    readonly local: unknown;
    readonly incoming: unknown;
}

export function mergeElements(_input: { base: ReadonlyMap<string, string | null>; local: ReadonlyMap<string, string | null>; incoming: ReadonlyMap<string, string | null> }): MergeDecision[] {
    return [];
}

export function applyMerge(_path: string, localText: string, _decisions: readonly MergeDecision[], _choices: Readonly<Record<string, 'local' | 'incoming'>>): { ok: true; text: string } | { ok: false; unresolved: string[] } {
    return { ok: true, text: localText };
}
