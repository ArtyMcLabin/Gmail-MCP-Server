import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
    parseHttpOptions,
    startHttpServer,
    secureCompare,
    extractPresentedKey,
    isAuthorized,
    isOriginAllowed,
    isLoopbackHost,
    DEFAULT_HTTP_PORT,
    DEFAULT_HTTP_HOST,
    type StartedHttpServer,
} from './http-server.js';

const API_KEY = 'test-key-abcdef0123456789';

/** Minimal stand-in for the real Gmail server - same shape, no Google calls. */
function createStubServer(): Server {
    const server = new Server({ name: 'gmail-test', version: '0.0.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }],
    }));

    server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: 'text', text: 'pong' }],
    }));

    return server;
}

describe('parseHttpOptions', () => {
    const savedEnv = { ...process.env };

    beforeEach(() => {
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('GMAIL_MCP_')) delete process.env[key];
        }
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('returns null when HTTP mode is not requested', () => {
        expect(parseHttpOptions([])).toBeNull();
        expect(parseHttpOptions(['auth', '--scopes=gmail.readonly'])).toBeNull();
    });

    it('defaults to loopback and the registered port', () => {
        const options = parseHttpOptions(['--http']);
        expect(options).toMatchObject({ host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT, noAuth: false });
    });

    it('reads --port and --host in both = and space forms', () => {
        expect(parseHttpOptions(['--http', '--port=9999'])?.port).toBe(9999);
        expect(parseHttpOptions(['--http', '--port', '9998'])?.port).toBe(9998);
        expect(parseHttpOptions(['--http', '--host=0.0.0.0'])?.host).toBe('0.0.0.0');
    });

    it('honours GMAIL_MCP_HTTP and friends', () => {
        process.env.GMAIL_MCP_HTTP = '1';
        process.env.GMAIL_MCP_PORT = '9123';
        process.env.GMAIL_MCP_HOST = '0.0.0.0';
        process.env.GMAIL_MCP_ALLOWED_ORIGINS = 'http://a.test, http://b.test';

        expect(parseHttpOptions([])).toMatchObject({
            host: '0.0.0.0',
            port: 9123,
            allowedOrigins: ['http://a.test', 'http://b.test'],
        });
    });

    it('rejects a nonsense port', () => {
        expect(() => parseHttpOptions(['--http', '--port=notaport'])).toThrow(/Invalid port/);
        expect(() => parseHttpOptions(['--http', '--port=99999'])).toThrow(/Invalid port/);
    });
});

describe('auth helpers', () => {
    it('compares keys of differing length without throwing', () => {
        expect(secureCompare('abc', 'abc')).toBe(true);
        expect(secureCompare('abc', 'abcd')).toBe(false);
        expect(secureCompare('', 'x')).toBe(false);
    });

    it('extracts bearer and x-api-key credentials', () => {
        expect(extractPresentedKey({ authorization: `Bearer ${API_KEY}` })).toBe(API_KEY);
        expect(extractPresentedKey({ authorization: `bearer  ${API_KEY} ` })).toBe(API_KEY);
        expect(extractPresentedKey({ 'x-api-key': API_KEY })).toBe(API_KEY);
        expect(extractPresentedKey({ authorization: API_KEY })).toBeUndefined();
        expect(extractPresentedKey({})).toBeUndefined();
    });

    it('authorizes only on an exact key match', () => {
        expect(isAuthorized({ authorization: `Bearer ${API_KEY}` }, API_KEY)).toBe(true);
        expect(isAuthorized({ authorization: 'Bearer wrong' }, API_KEY)).toBe(false);
        expect(isAuthorized({}, API_KEY)).toBe(false);
        expect(isAuthorized({}, undefined)).toBe(true);
    });

    it('allows requests without an Origin, blocks unlisted browser origins', () => {
        expect(isOriginAllowed(undefined, [])).toBe(true);
        expect(isOriginAllowed('http://evil.test', [])).toBe(false);
        expect(isOriginAllowed('http://ok.test', ['http://ok.test'])).toBe(true);
    });

    it('recognises loopback hosts', () => {
        expect(isLoopbackHost('127.0.0.1')).toBe(true);
        expect(isLoopbackHost('localhost')).toBe(true);
        expect(isLoopbackHost('::1')).toBe(true);
        expect(isLoopbackHost('0.0.0.0')).toBe(false);
        expect(isLoopbackHost('192.168.1.10')).toBe(false);
    });
});

describe('startHttpServer', () => {
    let started: StartedHttpServer | undefined;

    afterEach(async () => {
        await started?.close();
        started = undefined;
    });

    it('refuses to run unauthenticated on a non-loopback host', async () => {
        await expect(
            startHttpServer({ host: '0.0.0.0', port: 0, noAuth: true, createServer: createStubServer }),
        ).rejects.toThrow(/Refusing to start unauthenticated/);
    });

    it('rejects missing and wrong credentials with 401', async () => {
        started = await startHttpServer({ host: '127.0.0.1', port: 0, apiKey: API_KEY, createServer: createStubServer });

        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

        const noKey = await fetch(started.url, { method: 'POST', headers, body });
        expect(noKey.status).toBe(401);
        expect(noKey.headers.get('www-authenticate')).toMatch(/Bearer/);

        const wrongKey = await fetch(started.url, {
            method: 'POST',
            headers: { ...headers, Authorization: 'Bearer nope' },
            body,
        });
        expect(wrongKey.status).toBe(401);
    });

    it('blocks a cross-origin browser request before touching auth', async () => {
        started = await startHttpServer({
            host: '127.0.0.1',
            port: 0,
            apiKey: API_KEY,
            allowedOrigins: ['http://allowed.test'],
            createServer: createStubServer,
        });

        const response = await fetch(started.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${API_KEY}`,
                Origin: 'http://evil.test',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });

        expect(response.status).toBe(403);
    });

    it('serves /health without credentials and 404s unknown paths', async () => {
        started = await startHttpServer({ host: '127.0.0.1', port: 0, apiKey: API_KEY, createServer: createStubServer });
        const base = started.url.replace('/mcp', '');

        const health = await fetch(`${base}/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toMatchObject({ status: 'ok', stateless: true });

        const missing = await fetch(`${base}/nope`, { headers: { Authorization: `Bearer ${API_KEY}` } });
        expect(missing.status).toBe(404);
    });

    it('returns 405 for GET and DELETE (no sessions to resume)', async () => {
        started = await startHttpServer({ host: '127.0.0.1', port: 0, apiKey: API_KEY, createServer: createStubServer });
        const auth = { Authorization: `Bearer ${API_KEY}`, Accept: 'text/event-stream' };

        expect((await fetch(started.url, { method: 'GET', headers: auth })).status).toBe(405);
        expect((await fetch(started.url, { method: 'DELETE', headers: auth })).status).toBe(405);
    });

    it('completes an MCP handshake and tool call over HTTP with a valid key', async () => {
        started = await startHttpServer({ host: '127.0.0.1', port: 0, apiKey: API_KEY, createServer: createStubServer });

        const client = new Client({ name: 'test-client', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(started.url), {
            requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
        });

        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toContain('ping');

        const result = await client.callTool({ name: 'ping', arguments: {} });
        expect(JSON.stringify(result.content)).toContain('pong');

        await client.close();
    });

    it('issues no session id - every request stands alone', async () => {
        started = await startHttpServer({
            host: '127.0.0.1',
            port: 0,
            apiKey: API_KEY,
            jsonResponse: true,
            createServer: createStubServer,
        });

        const response = await fetch(started.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                Authorization: `Bearer ${API_KEY}`,
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-06-18',
                    capabilities: {},
                    clientInfo: { name: 'raw', version: '0.0.0' },
                },
            }),
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('mcp-session-id')).toBeNull();
        expect(response.headers.get('content-type')).toMatch(/application\/json/);
        expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } });
    });

    it('rejects an oversized body', async () => {
        started = await startHttpServer({
            host: '127.0.0.1',
            port: 0,
            apiKey: API_KEY,
            maxBodyBytes: 128,
            createServer: createStubServer,
        });

        const response = await fetch(started.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(500) } }),
        }).catch(error => error as Error);

        // Node may surface the mid-stream abort as a fetch failure; either way the request must not succeed.
        if (response instanceof Error) {
            expect(response.message).toBeTruthy();
        } else {
            expect(response.status).toBe(413);
        }
    });
});
