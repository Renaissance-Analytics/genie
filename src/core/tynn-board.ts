/** STUB (red step, genie#1295): the types the tests name; the behaviour lands in the next commit. */
export type BoardLevel = 'versions' | 'stories' | 'tasks';
export type BoardKind = 'version' | 'story' | 'task';
export interface BoardScope { readonly version?: string; readonly story?: string }
export interface BoardIds { readonly versionId?: string; readonly storyId?: string; readonly taskId?: string }
export interface BoardStep { readonly verb: string; readonly actionId: string; readonly disabled: boolean; readonly icon: string; readonly label: string }
export interface BoardCard { readonly id: string; readonly kind: BoardKind; readonly number: string | null; readonly title: string; readonly status: string; readonly order: number; readonly claimedBy: string | null; readonly quick: BoardStep | null; readonly drill: BoardScope | null }
export interface BoardColumnView { readonly status: string; readonly label: string; readonly cards: readonly BoardCard[] }
export interface BoardView { readonly level: BoardLevel; readonly versionId: string | null; readonly storyId: string | null; readonly up: BoardScope | null; readonly crumbs: ReadonlyArray<{ label: string; scope: BoardScope }>; readonly columns: readonly BoardColumnView[]; readonly draggable: boolean }
export type TynnBoardState =
    | { readonly state: 'loading' }
    | { readonly state: 'not-linked' }
    | { readonly state: 'signed-out'; readonly reason: string }
    | { readonly state: 'error'; readonly reason: string }
    | { readonly state: 'ready'; readonly view: BoardView; readonly refused?: string | null };
export const BOARD_DATA_API = { method: 'GET', path: '' } as const;
export const BOARD_API: Readonly<Record<string, { method: 'POST' | 'DELETE'; path: string }>> = {};
export const BOARD_GAPS: Readonly<Record<string, string>> = {};
export const BOARD_LEVELS = {};
export const BOARD_FIELDS = {};
export const BOARD_DRAG = {};
export const BOARD_TRANSITIONS = {};
export const BOARD_QUICK_ACTIONS: Readonly<Record<string, Readonly<Record<string, { verb: string; guard?: string }>>>> = {};
export const BOARD_STATES: readonly string[] = [];
export function parseBoard(_json: unknown): BoardView | null { return null; }
export function canDrop(_level: BoardLevel, _from: string, _to: string, _override: boolean): boolean { return false; }
export function boardQueryPath(_projectId: string, _scope: BoardScope): string { return ''; }
export function boardActionRequest(_projectId: string, _action: string, _ids: BoardIds): { method: 'POST' | 'DELETE'; path: string } | null { return null; }
