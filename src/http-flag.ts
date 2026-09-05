/**
 * The single "is HTTP mode wanted?" predicate.
 *
 * It lives alone, with no imports, so `index.ts` can ask the question without
 * pulling in the HTTP transport (and through it the SDK's Streamable HTTP stack)
 * on every stdio start, which costs ~50ms for nothing.
 */
export function isHttpRequested(argv: string[], env: NodeJS.ProcessEnv = process.env): boolean {
    if (argv.includes('--http')) return true;

    const flag = env.GMAIL_MCP_HTTP;
    return flag === '1' || flag === 'true' || flag === 'yes';
}
