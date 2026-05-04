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
        expect(source).toContain('validatedArgs.inReplyTo = lastMessageId');
        expect(source).toContain("validatedArgs.references = allMessageIds.join(' ')");
    });

    it('read_email returns Message-ID', () => {
        const source = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');
        expect(source).toContain('message-id');
        expect(source).toContain('rfcMessageId');
        expect(source).toContain('Message-ID: ${rfcMessageId}');
    });
});
