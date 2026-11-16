import type { IssueWatchSetting } from './issue-watch.js';
import type { ServiceInstance } from './services.js';
import type { LiveModel } from './workspace-save.js';

/** Inert stubs (RED): services, workspace settings and issueWatch as repo declarations (Tynn #756 PR3). The implementation lands after the tests are seen failing. */

export interface ServiceDeclaration {
    readonly engine: string;
    readonly variant?: string;
    readonly version?: string;
    readonly scope?: 'shared' | 'dedicated';
    readonly active?: boolean;
    readonly detached?: boolean;
    readonly name?: string;
    readonly image?: string;
    readonly internalPort?: number;
    readonly kind?: string;
    readonly envKeys?: readonly string[];
}

export interface Exclusion {
    readonly field: string;
    readonly reason: string;
}

export function servicesDeclaration(_instances: readonly ServiceInstance[], _workspaceId: string): { value: ServiceDeclaration[]; excluded: Exclusion[] } {
    return { value: [], excluded: [] };
}

export interface ServiceRestoreAction {
    readonly declaration: ServiceDeclaration;
    readonly action: 'present' | 'attach' | 'create';
    readonly scope: 'shared' | 'dedicated';
    readonly instanceId?: string;
}

export function servicesRestorePlan(_declared: unknown, _instances: readonly ServiceInstance[], _workspaceId: string): { actions: ServiceRestoreAction[]; refused: { index: number; reason: string }[] } {
    return { actions: [], refused: [] };
}

export interface WorkspaceSettingsInput {
    readonly overrides: Readonly<Record<string, boolean | string>>;
    readonly defaultAgent: string | null;
    readonly envFile: string | null;
    readonly mcpOff: readonly string[];
}

export function workspaceSettingsDeclaration(_input: WorkspaceSettingsInput): { value: Record<string, unknown> | null; excluded: Exclusion[] } {
    return { value: null, excluded: [] };
}

export function workspaceSettingsRestore(_declared: unknown): { settings: Record<string, string>; defaultAgent: string | null; envFile: string | null; mcpOff: string[] | null; ignored: string[] } {
    return { settings: {}, defaultAgent: null, envFile: null, mcpOff: null, ignored: [] };
}

export interface ElementSources {
    readonly services: readonly ServiceInstance[];
    readonly workspace: WorkspaceSettingsInput;
    readonly agents: readonly { readonly name: string; readonly issueWatch: IssueWatchSetting | null }[];
}

export function withElements(model: LiveModel, _sources: ElementSources, _workspaceId: string): { model: LiveModel; excluded: Exclusion[] } {
    return { model, excluded: [] };
}
