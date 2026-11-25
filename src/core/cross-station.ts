import type { AgentRecord } from './identity.js';

/** RED STUB (P9 x-station mail): the shapes the tests name; nothing is built yet. */
export interface StationRow { readonly id: string; readonly name: string }
export interface RosterEntry { readonly name: string; readonly workspace: string; readonly opensFrom: 'all' | readonly string[] }
export type CrossStationMode = 'queue' | 'connected';
const notBuilt = (): never => { throw new Error('cross-station mail is not built'); };
export const parseStationAddress = (_text: string): { name: string; workspace: string; station: string } | null => notBuilt();
export const stationWord = (_id: string, _stations: readonly StationRow[]): string => notBuilt();
export const findStation = (_word: string, _stations: readonly StationRow[]): StationRow | null => notBuilt();
export const peerParticipant = (_station: string, _name: string, _workspace: string): `peer:${string}` => notBuilt();
export const readPeer = (_p: string): { station: string; name: string; workspace: string } | null => notBuilt();
export const peerLabel = (_p: string, _stations: readonly StationRow[]): string | null => notBuilt();
export const rosterOf = (_r: readonly AgentRecord[], _s: ReadonlyMap<string, string>, _a: ReadonlySet<string>): RosterEntry[] => notBuilt();
export const opensFrom = (_e: RosterEntry, _w: string): boolean => notBuilt();
export const deliveryAdmission = (_c: { isOwner: boolean; readonly: boolean; station: string | null }): string | null => notBuilt();
export const sendPlan = (_m: CrossStationMode, _s: { personConnected: boolean }): 'try-then-queue' | 'try-once' | 'refuse' => notBuilt();
