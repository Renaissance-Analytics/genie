// RED STUB (Tynn #1022, client setting): the names exist so the tests compile; nothing is kept yet.
export const CLIENT_SOUND_KEY = 'genie.client.sound-volume';
export type ClientSoundKey = 'alert_volume' | 'alert_muted' | 'alert_levels';
export function clientSoundValues(): Readonly<Record<string, boolean | string>> { return {}; }
export function setClientSound(_key: ClientSoundKey, _value: boolean | string): void {}
export function subscribeClientSound(_listener: () => void): () => void { return () => {}; }
