// RED-PHASE STUB (genie#1204): the shape the tests call, with no behaviour yet. Replaced by the implementation.
import type { FlowGraph } from '@particle-academy/fancy-flow/engine';
import { FLOW_SCHEMA_URL, type FlowDocument } from './flow-form.js';

export const SUPPORTED_KINDS: readonly string[] = [];
export function canonicalKind(kind: string): string { return kind; }
export function isSupportedKind(_kind: string): boolean { return false; }
export function paletteKindFilter(_: { kind: { name: string } }): boolean { return true; }
export function isTriggerKind(_kind: string): boolean { return false; }
export interface FlowProblem { readonly nodeId?: string; readonly message: string }
export function structuralProblems(_document: unknown): FlowProblem[] { return []; }
export function findCycle(_nodes: readonly unknown[], _edges: readonly unknown[]): string[] { return []; }
export interface SaveContext { readonly workspaces: readonly string[]; readonly agentProblem: (address: string) => string | null }
export function saveProblems(_document: unknown, _ctx: SaveContext): FlowProblem[] { return []; }
export function waitMs(_text: unknown): number | null { return null; }
export function documentToGraph(_document: unknown): FlowGraph { return { nodes: [], edges: [] } as unknown as FlowGraph; }
export function graphToDocument(_graph: FlowGraph): FlowDocument { return { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [], edges: [] } } as unknown as FlowDocument; }
export function withProblems(graph: FlowGraph, _problems: readonly FlowProblem[]): FlowGraph { return graph; }
export type NodeOutcome = 'ran' | 'failed' | 'held' | 'skipped' | 'not reached' | 'stopped' | 'running';
export function viewerStatuses(_nodes: Readonly<Record<string, NodeOutcome>>): Record<string, string> { return {}; }
