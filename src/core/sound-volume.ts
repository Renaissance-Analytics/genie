import type { AlertKind } from './alerts.js';

// RED STUB (Tynn #1022): the names exist so the tests compile; nothing is read yet.
export const SOUND_VOLUME_SETTING = 'sound_volume';
export const SOUND_MUTED_SETTING = 'sound_muted';
export const SOUND_LEVELS_SETTING = 'sound_levels';
type Values = Readonly<Record<string, boolean | string | undefined>>;
export function masterLevel(_settings: Values): number { return 100; }
export function eventLevel(_kind: AlertKind, _settings: Values): number { return 100; }
export function withEventLevel(raw: boolean | string | undefined, _kind: AlertKind, _pct: number): string { return typeof raw === 'string' ? raw : '{}'; }
export function alertVolume(_kind: AlertKind | null, _settings: Values): number { return 1; }
export function previewVolume(_kind: AlertKind | null, _settings: Values): number { return 1; }
