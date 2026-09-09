import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { toMcpTools, toolDefinitions, type ToolDefinition } from './tools.js';

describe('toMcpTools', () => {
    it('converts a definition to the MCP tool shape', () => {
        const [tool] = toMcpTools([toolDefinitions[0]]);

        expect(tool.name).toBe(toolDefinitions[0].name);
        expect(tool.description).toBe(toolDefinitions[0].description);
        expect(tool.annotations).toBe(toolDefinitions[0].annotations);
        expect(tool.inputSchema).toEqual(zodToJsonSchema(toolDefinitions[0].schema));
    });

    it('converts every registered tool', () => {
        const tools = toMcpTools(toolDefinitions);

        expect(tools).toHaveLength(toolDefinitions.length);
        for (const tool of tools) {
            expect(tool.inputSchema).toBeTypeOf('object');
        }
    });

    describe('schema conversion is memoised', () => {
        // Guards the hot path: stateless HTTP builds a fresh Server per request,
        // so an unmemoised tools/list re-converts every schema on every call.
        it('returns the identical inputSchema object across calls', () => {
            const first = toMcpTools(toolDefinitions);
            const second = toMcpTools(toolDefinitions);

            for (let i = 0; i < first.length; i++) {
                expect(second[i].inputSchema).toBe(first[i].inputSchema);
            }
        });

        it('hits the same entries when called with a filtered subset', () => {
            // The ListTools handler passes a scope-filtered subset, so the cache
            // must key on the schema itself, not on the array it arrived in.
            const all = toMcpTools(toolDefinitions);
            const subset = toMcpTools(toolDefinitions.filter(t => t.scopes.includes('gmail.readonly')));

            expect(subset.length).toBeGreaterThan(0);
            for (const tool of subset) {
                const fromAll = all.find(t => t.name === tool.name);
                expect(tool.inputSchema).toBe(fromAll!.inputSchema);
            }
        });

        it('does not conflate two tools that share a name but not a schema', () => {
            const alpha: ToolDefinition = {
                name: 'probe',
                description: 'first',
                schema: z.object({ a: z.string() }),
                scopes: ['gmail.readonly'],
                annotations: { title: 'Probe' },
            };
            const beta: ToolDefinition = { ...alpha, schema: z.object({ b: z.number() }) };

            const [convertedAlpha] = toMcpTools([alpha]);
            const [convertedBeta] = toMcpTools([beta]);

            expect(convertedAlpha.inputSchema).not.toBe(convertedBeta.inputSchema);
            expect(convertedAlpha.inputSchema).toEqual(zodToJsonSchema(alpha.schema));
            expect(convertedBeta.inputSchema).toEqual(zodToJsonSchema(beta.schema));
        });
    });
});
