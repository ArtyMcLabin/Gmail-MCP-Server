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

describe('Body transfer encoding', () => {
    // Extract the body of the last MIME part (headers end at the first blank line)
    function getPartBody(raw: string): string {
        const idx = raw.indexOf('\r\n\r\n');
        return raw.slice(idx + 4);
    }

    it('keeps 7bit for ASCII-only plain bodies', () => {
        const raw = createEmailMessage({
            to: ['test@example.com'],
            subject: 'ASCII',
            body: 'Plain ASCII body',
        });

        expect(raw).toContain('Content-Transfer-Encoding: 7bit');
        expect(getPartBody(raw)).toBe('Plain ASCII body');
    });

    it('uses base64 for non-ASCII plain bodies and round-trips the text', () => {
        const body = 'こんにちは、これはテスト本文です。';
        const raw = createEmailMessage({
            to: ['test@example.com'],
            subject: '日本語件名',
            body,
        });

        expect(raw).toContain('Content-Transfer-Encoding: base64');
        expect(raw).not.toContain('Content-Transfer-Encoding: 7bit');
        const decoded = Buffer.from(getPartBody(raw).replace(/\r\n/g, ''), 'base64').toString('utf8');
        expect(decoded).toBe(body);
    });

    it('uses base64 for non-ASCII HTML-only bodies', () => {
        // Supplying htmlBody promotes the message to multipart/alternative, so the
        // HTML-only branch is exercised with body alone.
        const htmlBody = '<p>日本語の HTML 本文</p>';
        const raw = createEmailMessage({
            to: ['test@example.com'],
            subject: 'HTML',
            mimeType: 'text/html',
            body: htmlBody,
        });

        expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
        expect(raw).toContain('Content-Transfer-Encoding: base64');
        const decoded = Buffer.from(getPartBody(raw).replace(/\r\n/g, ''), 'base64').toString('utf8');
        expect(decoded).toBe(htmlBody);
    });

    it('encodes each part independently in multipart/alternative', () => {
        const body = '日本語テキスト';
        const htmlBody = '<p>ASCII html</p>';
        const raw = createEmailMessage({
            to: ['test@example.com'],
            subject: 'mixed',
            mimeType: 'text/html',
            body,
            htmlBody,
        });

        expect(raw).toContain('Content-Transfer-Encoding: base64');
        expect(raw).toContain('Content-Transfer-Encoding: 7bit');
        expect(raw).toContain(Buffer.from(body, 'utf8').toString('base64'));
        expect(raw).toContain(htmlBody);
    });

    it('wraps long base64 payloads at 76 characters', () => {
        const raw = createEmailMessage({
            to: ['test@example.com'],
            subject: 'long',
            body: 'あ'.repeat(500),
        });

        const lines = getPartBody(raw).split('\r\n').filter(Boolean);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) {
            expect(line.length).toBeLessThanOrEqual(76);
        }
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
