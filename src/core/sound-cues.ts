import { ALERT_KINDS, type AlertKind } from './alerts.js';

/**
 * EVERY SOUND HAS A SIGHT (Tynn #1057). RED SKELETON: the shape the guard test reads; nothing is drawn yet.
 */
export type CueKind = AlertKind | 'ratelimit';
export type CueTone = 'needs' | 'bad' | 'ok' | 'info' | 'muted';
export interface CueLook { readonly icon: string; readonly tone: CueTone }

export const CUE_KINDS: readonly CueKind[] = [...ALERT_KINDS.map((k) => k.kind), 'ratelimit'];

export const CUE_LOOK: Readonly<Partial<Record<CueKind, CueLook>>> = {};

export interface SoundCue {
    readonly id: string;
    readonly kind: CueKind;
    readonly workspaceId: string | null;
    readonly agentId: string | null;
    readonly who: string | null;
    readonly detail: string;
    readonly at: number;
    readonly seen: boolean;
}
export type SoundCues = readonly SoundCue[];
export const NO_CUES: SoundCues = Object.freeze([]);
export const CUE_LOG = 60;
export type CueWhere = { readonly workspaceId: string } | { readonly agentId: string } | 'machine';
export type NewCue = Omit<SoundCue, 'seen'>;

export function addCue(cues: SoundCues, _cue: NewCue): SoundCues { return cues; }
export function seeRoute(cues: SoundCues, _route: string): SoundCues { return cues; }
export function seeAgent(cues: SoundCues, _agentId: string): SoundCues { return cues; }
export function seeCue(cues: SoundCues, _id: string): SoundCues { return cues; }
export function seeAll(cues: SoundCues): SoundCues { return cues; }
export function unseenCues(_cues: SoundCues, _where?: CueWhere): SoundCue[] { return []; }
export function latestUnseen(_cues: SoundCues, _where: CueWhere): SoundCue | null { return null; }
export function workspaceLog(_cues: SoundCues, _workspaceId: string, _n?: number): SoundCue[] { return []; }
export function cueWanted(_kind: AlertKind, _settings: Readonly<Record<string, boolean | string | undefined>>): boolean { return false; }
export interface CueAction { readonly agentId: string | null; readonly kind: string; readonly workspaceId?: string | undefined; readonly title?: string | undefined; readonly body?: string | undefined; readonly reason?: string | undefined; readonly tool?: string | undefined }
export interface CueAgent { readonly id: string; readonly name: string; readonly workspaceId: string }
export function cueOfAction(_action: CueAction, _agents: readonly CueAgent[], _at: number, _id: string): NewCue | null { return null; }
export function cueOfAlert(_alert: { kind: AlertKind; workspace: string; agent: string; detail: string; agentId?: string | null | undefined }, _at: number, _id: string): NewCue | null { return null; }
