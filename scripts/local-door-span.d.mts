export interface PageFrame { readonly seq: number; readonly handle: string; readonly n: number }
export function pageSpan(frames: readonly PageFrame[], handle: string, nativeFrom: number, nativeTo: number): { from: number; to: number } | null;
