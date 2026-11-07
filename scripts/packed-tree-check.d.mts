export function leftovers(files: readonly string[], target?: { platform?: string; arch?: string }): { file: string; why: string }[];
export function required(target?: { platform?: string; arch?: string }): string[];
