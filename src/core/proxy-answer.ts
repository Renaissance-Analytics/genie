export type ProxyRoute =
    | { readonly kind: 'direct' }
    | { readonly kind: 'proxy'; readonly scheme: 'http' | 'https'; readonly host: string; readonly port: number }
    | { readonly kind: 'unsupported'; readonly scheme: string; readonly host: string; readonly port: number };
/** RED STUB (the proxy's first commit). */
export function parseProxyAnswer(_answer: string): ProxyRoute[] { return [{ kind: 'direct' }]; }
export function routeLabel(_route: ProxyRoute): string { return ''; }
