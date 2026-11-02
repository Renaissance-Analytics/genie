/** RED STUB (the proxy's first commit). */
export async function reportProxyAnswers(_options: { hosts: readonly string[]; resolve(url: string): Promise<string>; send(answers: Record<string, string>): Promise<void>; log?: (line: string) => void }): Promise<void> {}
