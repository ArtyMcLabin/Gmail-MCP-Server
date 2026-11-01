/**
 * Tests for email threading header fixes (issue #66)
 *
 * Verifies:
 * 1. createEmailMessage uses separate `references` field when provided
 * 2. createEmailMessage falls back to `inReplyTo` for References when no `references` field
 * 3. No References/In-Reply-To headers on new emails
 * 4. Source verification: createEmailWithNodemailer uses references field
 * 5. Source verification: handleEmailAction auto-resolves threading headers
 * 6. Source verification: read_email returns Message-ID
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmailMessage } from './utl.js';

// Resolve src directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = __dirname;

// Helper: extract a header value from a raw MIME message string
function getHeader(raw: string, headerName: string): string | null {
    const regex = new RegExp(`^${headerName}:\\s*(.+)$`, 'mi');
    const match = raw.match(regex);
    return match ? match[1].trim() : null;
}

describe('Email threading headers', () => {
    it('uses separate references field when provided', () => {
        const args = {
            to: ['test@example.com'],
            subject: 'Re: Thread test',
            body: 'Reply body',
            inReplyTo: '<msg3@example.com>',
            references: '<msg1@example.com> <msg2@example.com> <msg3@example.com>',
        };
        const raw = createEmailMessage(args);

        expect(getHeader(raw, 'References')).toBe(
            '<msg1@example.com> <msg2@example.com> <msg3@example.com>'
        );
        expect(getHeader(raw, 'In-Reply-To')).toBe('<msg3@example.com>');
    });

    it('falls back to inReplyTo when references is absent', () => {
        const args = {
            to: ['test@example.com'],
            subject: 'Re: Fallback test',
            body: 'Reply body',
            inReplyTo: '<single@example.com>',
        };
        const raw = createEmailMessage(args);

        expect(getHeader(raw, 'References')).toBe('<single@example.com>');
    });

    it('has no threading headers on new emails', () => {
        const args = {
            to: ['test@example.com'],
            subject: 'New email',
            body: 'Fresh email body',
        };
        const raw = createEmailMessage(args);

        expect(getHeader(raw, 'References')).toBeNull();
        expect(getHeader(raw, 'In-Reply-To')).toBeNull();
    });
});

describe('Source verification', () => {
    it('createEmailWithNodemailer uses references field with inReplyTo fallback', () => {
        const source = fs.readFileSync(path.join(srcDir, 'utl.ts'), 'utf-8');
        expect(source).toContain('references: validatedArgs.references || validatedArgs.inReplyTo');
    });

    it('handleEmailAction auto-resolves threading headers', () => {
        const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');
        expect(source).toContain('validatedArgs.threadId && !validatedArgs.inReplyTo');
        expect(source).toContain('gmail.users.threads.get');
        expect(source).toContain('validatedArgs.inReplyTo = newestMessageId');
        expect(source).toContain("validatedArgs.references = allMessageIds.join(' ')");
    });

    it('auto-resolve picks the reply parent by internalDate, not by array position', () => {
        // Regression guard for ArtyMcLabin/PersonalAssistant-ClaudeCode#208: the
        // reply parent used to be threadMessages[length - 1]. Gmail does not
        // guarantee that array is chronological, and anchoring a draft to a
        // non-newest parent makes it list in Drafts without ever rendering
        // inside the conversation.
        const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');
        expect(source).toContain('internalDate');
        expect(source).not.toContain('threadMessages[threadMessages.length - 1]');
    });
});

describe('Thread parent selection (#208)', () => {
    // Mirrors the ordering logic in handleEmailAction's auto-resolve block.
    const pickParentAndChain = (messages: any[]) => {
        const ordered = messages
            .map((msg, idx) => ({ msg, idx }))
            .sort((a, b) => {
                const da = Number(a.msg.internalDate ?? NaN);
                const db = Number(b.msg.internalDate ?? NaN);
                if (Number.isFinite(da) && Number.isFinite(db) && da !== db) {
                    return da - db;
                }
                return a.idx - b.idx;
            })
            .map((entry) => entry.msg);
        const idOf = (m: any) =>
            (m?.payload?.headers || []).find(
                (h: any) => h.name?.toLowerCase() === 'message-id'
            )?.value;
        return {
            inReplyTo: idOf(ordered[ordered.length - 1]),
            references: ordered.map(idOf).filter(Boolean).join(' '),
        };
    };

    const msg = (id: string, internalDate?: string) => ({
        internalDate,
        payload: { headers: [{ name: 'Message-ID', value: id }] },
    });

    it('picks the NEWEST message when the array is out of order', () => {
        const out = pickParentAndChain([
            msg('<a@x>', '1000'),
            msg('<c@x>', '3000'),
            msg('<b@x>', '2000'),
        ]);
        expect(out.inReplyTo).toBe('<c@x>');
        expect(out.references).toBe('<a@x> <b@x> <c@x>');
    });

    it('still picks the newest when the array is already chronological', () => {
        const out = pickParentAndChain([
            msg('<a@x>', '1000'),
            msg('<b@x>', '2000'),
        ]);
        expect(out.inReplyTo).toBe('<b@x>');
    });

    it('falls back to array order when internalDate is missing', () => {
        const out = pickParentAndChain([msg('<a@x>'), msg('<b@x>')]);
        expect(out.inReplyTo).toBe('<b@x>');
        expect(out.references).toBe('<a@x> <b@x>');
    });

    it('handles a single-message thread', () => {
        const out = pickParentAndChain([msg('<only@x>', '500')]);
        expect(out.inReplyTo).toBe('<only@x>');
        expect(out.references).toBe('<only@x>');
    });

    it('read_email returns Message-ID', () => {
        const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');
        expect(source).toContain('message-id');
        expect(source).toContain('rfcMessageId');
        expect(source).toContain('Message-ID: ${rfcMessageId}');
    });
});
