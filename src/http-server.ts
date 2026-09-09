/**
 * Stateless Streamable HTTP transport for the Gmail MCP server.
 *
 * Deliberately built on node:http - no express, no extra dependency. Every
 * request gets its own Server + StreamableHTTPServerTransport pair
 * (sessionIdGenerator: undefined), so nothing is remembered between calls and
 * concurrent clients cannot collide on JSON-RPC request ids.
 *
 * Security posture: binds loopback by default, and every /mcp request must
 * carry a bearer API key. The key comes from GMAIL_MCP_API_KEY or a 0600 file
 * in the config dir, generated on first start.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isHttpRequested } from './http-flag.js';

export const DEFAULT_HTTP_PORT = 9101;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const MCP_PATH = '/mcp';

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');

/** Read per call rather than at import time so the path stays overridable (and testable). */
function apiKeyPath(): string {
    return process.env.GMAIL_MCP_API_KEY_PATH || path.join(CONFIG_DIR, 'http-api-key');
}

/** Max accepted request body. Gmail attachments are sent as file paths, so bodies stay small. */
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpOptions {
    host: string;
    port: number;
    /** Explicit key; when omitted resolveApiKey() reads env/keyfile or generates one. */
    apiKey?: string;
    /** Skip bearer auth entirely. Only honoured on a loopback bind. */
    noAuth?: boolean;
    /** Respond with application/json instead of an SSE stream. */
    jsonResponse?: boolean;
    /** Browser Origin values to accept. Requests without an Origin header are always accepted. */
    allowedOrigins?: string[];
    maxBodyBytes?: number;
}

export interface StartedHttpServer {
    url: string;
    port: number;
    apiKey?: string;
    httpServer: http.Server;
    close: () => Promise<void>;
}

function envFlag(name: string): boolean {
    const value = process.env[name];
    return value === '1' || value === 'true' || value === 'yes';
}

export { isHttpRequested };

/** Returns the flag's value, treating an empty value as absent - an empty bind address means "all interfaces". */
function flagValue(argv: string[], flag: string): string | undefined {
    const inline = argv.find(arg => arg.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1) || undefined;

    const index = argv.indexOf(flag);
    if (index !== -1 && index + 1 < argv.length && !argv[index + 1].startsWith('-')) {
        return argv[index + 1] || undefined;
    }
    return undefined;
}

/**
 * Returns HTTP options when HTTP mode is requested (--http or GMAIL_MCP_HTTP),
 * otherwise null, meaning "run stdio".
 */
export function parseHttpOptions(argv: string[]): HttpOptions | null {
    if (!isHttpRequested(argv)) return null;

    const rawPort = flagValue(argv, '--port') ?? process.env.GMAIL_MCP_PORT;
    const port = rawPort === undefined ? DEFAULT_HTTP_PORT : Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port: ${rawPort}`);
    }

    const rawMaxBody = process.env.GMAIL_MCP_MAX_BODY_BYTES;
    const maxBodyBytes = rawMaxBody === undefined ? DEFAULT_MAX_BODY_BYTES : Number(rawMaxBody);
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
        throw new Error(`Invalid GMAIL_MCP_MAX_BODY_BYTES: ${rawMaxBody}`);
    }

    const allowedOrigins = (process.env.GMAIL_MCP_ALLOWED_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);

    return {
        host: flagValue(argv, '--host') ?? process.env.GMAIL_MCP_HOST ?? DEFAULT_HTTP_HOST,
        port,
        apiKey: process.env.GMAIL_MCP_API_KEY || undefined,
        noAuth: argv.includes('--no-auth') || envFlag('GMAIL_MCP_NO_AUTH'),
        jsonResponse: argv.includes('--json-response') || envFlag('GMAIL_MCP_JSON_RESPONSE'),
        allowedOrigins,
        maxBodyBytes,
    };
}

export function isLoopbackHost(host: string): boolean {
    const normalized = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/^::ffff:/, '');
    return normalized === 'localhost'
        || normalized === '::1'
        || normalized.startsWith('127.');
}

/** Length-independent constant-time comparison (digests first, so length never leaks). */
export function secureCompare(a: string, b: string): boolean {
    const digestA = crypto.createHash('sha256').update(a).digest();
    const digestB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Resolves the API key: explicit value, then GMAIL_MCP_API_KEY, then the key
 * file, generating and persisting a new one (0600) if none exists.
 */
export function resolveApiKey(explicit?: string): string {
    const fromEnv = explicit || process.env.GMAIL_MCP_API_KEY;
    if (fromEnv) return fromEnv;

    const keyPath = apiKeyPath();

    // Creation is exclusive ('wx'): if two instances start at once, the loser adopts the
    // winner's key instead of overwriting it and 401ing every client already holding it.
    for (let attempt = 0; attempt < 3; attempt++) {
        if (fs.existsSync(keyPath)) {
            const stored = fs.readFileSync(keyPath, 'utf8').trim();
            if (stored) return stored;
            fs.rmSync(keyPath, { force: true });
        }

        const generated = crypto.randomBytes(32).toString('base64url');
        fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });

        try {
            fs.writeFileSync(keyPath, `${generated}\n`, { mode: 0o600, flag: 'wx' });
        } catch (error: any) {
            if (error?.code === 'EEXIST') continue;
            throw error;
        }

        console.error(`Generated a new HTTP API key at ${keyPath}`);
        return generated;
    }

    throw new Error(`Could not establish an API key at ${keyPath}`);
}

/** Extracts a presented key from Authorization: Bearer or X-API-Key. */
export function extractPresentedKey(headers: http.IncomingHttpHeaders): string | undefined {
    const authorization = headers.authorization;
    if (typeof authorization === 'string') {
        const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
        if (match) return match[1].trim();
    }

    const apiKeyHeader = headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) return apiKeyHeader.trim();

    return undefined;
}

export function isAuthorized(headers: http.IncomingHttpHeaders, apiKey?: string): boolean {
    if (!apiKey) return true;
    const presented = extractPresentedKey(headers);
    return presented !== undefined && secureCompare(presented, apiKey);
}

/** Rejects cross-origin browser traffic (DNS rebinding); non-browser clients send no Origin. */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
    if (!origin) return true;
    return allowedOrigins.includes(origin);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
    });
    res.end(payload);
}

function jsonRpcError(code: number, message: string) {
    return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * Routes on the request target alone. The Host header is attacker-controlled and need
 * not be a valid URL authority, so it must never be fed to the URL parser.
 */
export function requestPath(target: string | undefined): string {
    const withoutQuery = (target || '/').split(/[?#]/, 1)[0];

    // Absolute-form targets ("GET http://host/mcp") are legal; fall back to the raw value.
    if (/^https?:\/\//i.test(withoutQuery)) {
        try {
            return new URL(withoutQuery).pathname;
        } catch {
            return withoutQuery;
        }
    }

    return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
                // Stop buffering but leave the socket alive so the 413 can actually be written.
                req.pause();
                reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * Starts the HTTP listener. `createServer` is called once per request so the
 * server stays stateless; pass port 0 to bind an ephemeral port (tests).
 */
export async function startHttpServer(
    options: HttpOptions & { createServer: () => Server },
): Promise<StartedHttpServer> {
    const {
        host,
        port,
        noAuth = false,
        jsonResponse = false,
        allowedOrigins = [],
        maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
        createServer,
    } = options;

    if (noAuth && !isLoopbackHost(host)) {
        throw new Error(
            `Refusing to start unauthenticated on non-loopback host "${host}". Drop --no-auth or bind 127.0.0.1.`,
        );
    }

    const apiKey = noAuth ? undefined : resolveApiKey(options.apiKey);

    const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
        const pathname = requestPath(req.url);

        if (pathname === '/health') {
            sendJson(res, 200, { status: 'ok', transport: 'streamable-http', stateless: true });
            return;
        }

        if (pathname !== MCP_PATH) {
            sendJson(res, 404, jsonRpcError(-32601, `Not found: ${pathname}`));
            return;
        }

        if (!isOriginAllowed(req.headers.origin, allowedOrigins)) {
            sendJson(res, 403, jsonRpcError(-32600, 'Origin not allowed'));
            return;
        }

        if (!isAuthorized(req.headers, apiKey)) {
            sendJson(res, 401, jsonRpcError(-32001, 'Unauthorized'), {
                'WWW-Authenticate': 'Bearer realm="gmail-mcp"',
            });
            return;
        }

        // Stateless mode has no session to stream into or delete.
        if (req.method === 'GET' || req.method === 'DELETE') {
            sendJson(res, 405, jsonRpcError(-32000, 'Method not allowed: server runs in stateless mode'), {
                Allow: 'POST',
            });
            return;
        }

        if (req.method !== 'POST') {
            sendJson(res, 405, jsonRpcError(-32000, `Method not allowed: ${req.method}`), { Allow: 'POST' });
            return;
        }

        let parsedBody: unknown;
        try {
            const raw = await readBody(req, maxBodyBytes);
            parsedBody = raw ? JSON.parse(raw) : undefined;
        } catch (error: any) {
            if (res.headersSent) return;

            if (error?.statusCode === 413) {
                // The rest of the body is still in flight; answer, then drop the connection.
                res.on('finish', () => req.destroy());
                sendJson(res, 413, jsonRpcError(-32700, 'Request body too large'), { Connection: 'close' });
                return;
            }

            sendJson(res, 400, jsonRpcError(-32700, 'Parse error'));
            return;
        }

        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: jsonResponse,
        });

        res.on('close', () => {
            void transport.close();
            void server.close();
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
    };

    const httpServer = http.createServer((req, res) => {
        // Nothing in here may reject: an unhandled rejection in a request listener
        // takes the whole process down, and the earliest code runs before any auth.
        handleRequest(req, res).catch((error: unknown) => {
            console.error('Error handling MCP request:', error);
            if (!res.headersSent) {
                sendJson(res, 500, jsonRpcError(-32603, 'Internal server error'));
            } else if (!res.writableEnded) {
                res.end();
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
            httpServer.removeListener('error', reject);
            resolve();
        });
    });

    const boundPort = (httpServer.address() as AddressInfo).port;
    const displayHost = host.includes(':') ? `[${host}]` : host;
    const url = `http://${displayHost}:${boundPort}${MCP_PATH}`;

    console.error(`Gmail MCP server listening on ${url} (stateless streamable HTTP)`);
    if (!apiKey) {
        console.error('WARNING: authentication disabled (--no-auth), loopback only.');
    } else if (!isLoopbackHost(host)) {
        console.error(`Bound to non-loopback host ${host} - traffic is unencrypted, put it behind TLS.`);
    }

    return {
        url,
        port: boundPort,
        apiKey,
        httpServer,
        close: () => new Promise<void>((resolve, reject) => {
            httpServer.close(error => (error ? reject(error) : resolve()));
            httpServer.closeAllConnections?.();
        }),
    };
}
