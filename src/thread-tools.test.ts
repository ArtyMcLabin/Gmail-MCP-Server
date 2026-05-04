import { describe, it, expect } from 'vitest';
import {
    GetThreadSchema,
    ListInboxThreadsSchema,
    GetInboxWithThreadsSchema,
    ModifyThreadSchema,
    toolDefinitions,
    getToolByName,
} from './tools.js';

describe('GetThreadSchema', () => {
    it('parses with required threadId', () => {
        const result = GetThreadSchema.parse({ threadId: '18abc123' });
        expect(result.threadId).toBe('18abc123');
        expect(result.format).toBe('full'); // default
    });

    it('accepts optional format parameter', () => {
        const result = GetThreadSchema.parse({ threadId: '18abc123', format: 'metadata' });
        expect(result.format).toBe('metadata');
    });

    it('accepts minimal format', () => {
        const result = GetThreadSchema.parse({ threadId: '18abc123', format: 'minimal' });
        expect(result.format).toBe('minimal');
    });

    it('rejects invalid format', () => {
        expect(() => GetThreadSchema.parse({ threadId: '18abc123', format: 'invalid' })).toThrow();
    });

    it('rejects missing threadId', () => {
        expect(() => GetThreadSchema.parse({})).toThrow();
    });
});

describe('ListInboxThreadsSchema', () => {
    it('parses with defaults when no args provided', () => {
        const result = ListInboxThreadsSchema.parse({});
        expect(result.query).toBe('in:inbox');
        expect(result.maxResults).toBe(50);
    });

    it('accepts custom query', () => {
        const result = ListInboxThreadsSchema.parse({ query: 'from:user@example.com' });
        expect(result.query).toBe('from:user@example.com');
    });

    it('accepts custom maxResults', () => {
        const result = ListInboxThreadsSchema.parse({ maxResults: 10 });
        expect(result.maxResults).toBe(10);
    });

    it('accepts both custom query and maxResults', () => {
        const result = ListInboxThreadsSchema.parse({ query: 'is:unread', maxResults: 25 });
        expect(result.query).toBe('is:unread');
        expect(result.maxResults).toBe(25);
    });
});

describe('GetInboxWithThreadsSchema', () => {
    it('parses with defaults when no args provided', () => {
        const result = GetInboxWithThreadsSchema.parse({});
        expect(result.query).toBe('in:inbox');
        expect(result.maxResults).toBe(50);
        expect(result.expandThreads).toBe(true);
    });

    it('accepts expandThreads = false', () => {
        const result = GetInboxWithThreadsSchema.parse({ expandThreads: false });
        expect(result.expandThreads).toBe(false);
    });

    it('accepts all custom parameters', () => {
        const result = GetInboxWithThreadsSchema.parse({
            query: 'label:important',
            maxResults: 5,
            expandThreads: false,
        });
        expect(result.query).toBe('label:important');
        expect(result.maxResults).toBe(5);
        expect(result.expandThreads).toBe(false);
    });
});

describe('ModifyThreadSchema', () => {
    it('parses with required threadId only', () => {
        const result = ModifyThreadSchema.parse({ threadId: '18abc123' });
        expect(result.threadId).toBe('18abc123');
        expect(result.addLabelIds).toBeUndefined();
        expect(result.removeLabelIds).toBeUndefined();
    });

    it('accepts addLabelIds', () => {
        const result = ModifyThreadSchema.parse({
            threadId: '18abc123',
            addLabelIds: ['Label_1', 'Label_2'],
        });
        expect(result.addLabelIds).toEqual(['Label_1', 'Label_2']);
    });

    it('accepts removeLabelIds', () => {
        const result = ModifyThreadSchema.parse({
            threadId: '18abc123',
            removeLabelIds: ['INBOX', 'UNREAD'],
        });
        expect(result.removeLabelIds).toEqual(['INBOX', 'UNREAD']);
    });

    it('accepts both addLabelIds and removeLabelIds', () => {
        const result = ModifyThreadSchema.parse({
            threadId: '18abc123',
            addLabelIds: ['Label_1'],
            removeLabelIds: ['INBOX'],
        });
        expect(result.addLabelIds).toEqual(['Label_1']);
        expect(result.removeLabelIds).toEqual(['INBOX']);
    });

    it('rejects missing threadId', () => {
        expect(() => ModifyThreadSchema.parse({})).toThrow();
    });

    it('rejects non-string threadId', () => {
        expect(() => ModifyThreadSchema.parse({ threadId: 12345 })).toThrow();
    });

    it('rejects non-array addLabelIds', () => {
        expect(() => ModifyThreadSchema.parse({ threadId: '18abc123', addLabelIds: 'INBOX' })).toThrow();
    });

    it('rejects non-array removeLabelIds', () => {
        expect(() => ModifyThreadSchema.parse({ threadId: '18abc123', removeLabelIds: 'INBOX' })).toThrow();
    });
});

describe('Thread tool definitions', () => {
    it('registers get_thread in toolDefinitions', () => {
        const tool = getToolByName('get_thread');
        expect(tool).toBeDefined();
        expect(tool!.name).toBe('get_thread');
        expect(tool!.scopes).toContain('gmail.readonly');
        expect(tool!.scopes).toContain('gmail.modify');
    });

    it('registers list_inbox_threads in toolDefinitions', () => {
        const tool = getToolByName('list_inbox_threads');
        expect(tool).toBeDefined();
        expect(tool!.name).toBe('list_inbox_threads');
        expect(tool!.scopes).toContain('gmail.readonly');
        expect(tool!.scopes).toContain('gmail.modify');
    });

    it('registers get_inbox_with_threads in toolDefinitions', () => {
        const tool = getToolByName('get_inbox_with_threads');
        expect(tool).toBeDefined();
        expect(tool!.name).toBe('get_inbox_with_threads');
        expect(tool!.scopes).toContain('gmail.readonly');
        expect(tool!.scopes).toContain('gmail.modify');
    });

    it('registers modify_thread in toolDefinitions', () => {
        const tool = getToolByName('modify_thread');
        expect(tool).toBeDefined();
        expect(tool!.name).toBe('modify_thread');
        expect(tool!.scopes).toContain('gmail.modify');
        expect(tool!.annotations.destructiveHint).toBe(true);
        expect(tool!.annotations.idempotentHint).toBe(true);
    });

    it('modify_thread description mentions atomic thread-level operation', () => {
        const tool = getToolByName('modify_thread');
        expect(tool!.description).toContain('ALL messages');
        expect(tool!.description).toContain('atomically');
    });

    it('has descriptions for all thread tools', () => {
        const threadTools = ['get_thread', 'list_inbox_threads', 'get_inbox_with_threads', 'modify_thread'];
        for (const toolName of threadTools) {
            const tool = getToolByName(toolName);
            expect(tool!.description).toBeTruthy();
            expect(tool!.description.length).toBeGreaterThan(10);
        }
    });

    it('total tool count includes the 4 thread tools', () => {
        const threadToolNames = ['get_thread', 'list_inbox_threads', 'get_inbox_with_threads', 'modify_thread'];
        const threadTools = toolDefinitions.filter(t => threadToolNames.includes(t.name));
        expect(threadTools).toHaveLength(4);
    });
});
