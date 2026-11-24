/**
 * Tests for inline images in HTML emails (multipart/related + Content-ID).
 *
 * Verifies:
 *  - createEmailWithNodemailer emits multipart/related with Content-ID + inline disposition
 *  - path-based and base64 content-based image sources both work
 *  - a regular attachment coexists with an inline image (multipart/mixed wrapper)
 *  - cid values are sanitized against CRLF header injection
 *  - inlineImages without htmlBody is rejected
 *  - a missing inline image file is rejected
 *  - needsRawBuilder routes attachment / inline-image mail to the raw builder
 *  - InlineImageSchema refinements (exactly-one source, contentType-with-content, cid shape)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmailWithNodemailer, needsRawBuilder, MAX_INLINE_IMAGE_CONTENT_BYTES } from './utl.js';
import { InlineImageSchema, ReplyAllSchema } from './tools.js';

// Minimal 1x1 transparent PNG used as the test image.
const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
let imgPath: string;

beforeAll(() => {
    imgPath = path.join(os.tmpdir(), `inline-img-test-${Date.now()}.png`);
    fs.writeFileSync(imgPath, Buffer.from(PNG_B64, 'base64'));
});

afterAll(() => {
    if (imgPath && fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
});

const baseArgs = {
    to: ['recipient@example.com'],
    subject: 'Inline image test',
    body: 'Plain-text fallback',
    htmlBody: '<p>Look:</p><img src="cid:logo1">',
};

describe('createEmailWithNodemailer — inline images', () => {
    it('emits multipart/related with Content-ID and inline disposition (path source)', async () => {
        const raw = await createEmailWithNodemailer({
            ...baseArgs,
            inlineImages: [{ cid: 'logo1', path: imgPath }],
        });
        expect(raw).toMatch(/Content-Type: multipart\/related/i);
        expect(raw).toMatch(/Content-ID: <logo1>/i);
        expect(raw).toMatch(/Content-Disposition: inline/i);
    });

    it('supports a base64 content source', async () => {
        const raw = await createEmailWithNodemailer({
            ...baseArgs,
            inlineImages: [{ cid: 'logo1', content: PNG_B64, contentType: 'image/png' }],
        });
        expect(raw).toMatch(/multipart\/related/i);
        expect(raw).toMatch(/Content-ID: <logo1>/i);
        expect(raw).toMatch(/Content-Disposition: inline/i);
    });

    it('keeps the plain-text + HTML alternative present', async () => {
        const raw = await createEmailWithNodemailer({
            ...baseArgs,
            inlineImages: [{ cid: 'logo1', path: imgPath }],
        });
        expect(raw).toMatch(/multipart\/alternative/i);
        expect(raw).toMatch(/text\/html/i);
        expect(raw).toMatch(/text\/plain/i);
    });

    it('keeps CRLF structural line endings (headers, boundaries, base64 parts), as with nodemailer 7.x', async () => {
        const raw = await createEmailWithNodemailer({
            ...baseArgs,
            inlineImages: [{ cid: 'logo1', path: imgPath }],
        });
        expect(raw).toContain('\r\n');
        expect(raw).not.toMatch(/[^\r]\n/);
    });

    it('embeds a regular attachment alongside an inline image (multipart/mixed)', async () => {
        const raw = await createEmailWithNodemailer({
            ...baseArgs,
            attachments: [imgPath],
            inlineImages: [{ cid: 'logo1', path: imgPath }],
        });
        expect(raw).toMatch(/multipart\/mixed/i);
        expect(raw).toMatch(/multipart\/related/i);
        expect(raw).toMatch(/Content-ID: <logo1>/i);
    });

    it('handles multiple inline images', async () => {
        const raw = await createEmailWithNodemailer({
            ...baseArgs,
            htmlBody: '<img src="cid:a"><img src="cid:b">',
            inlineImages: [
                { cid: 'a', path: imgPath },
                { cid: 'b', content: PNG_B64, contentType: 'image/png' },
            ],
        });
        expect(raw).toMatch(/Content-ID: <a>/i);
        expect(raw).toMatch(/Content-ID: <b>/i);
    });

    it('sanitizes CRLF injection attempts in cid (no injected header line)', async () => {
        const raw = await createEmailWithNodemailer({
            ...baseArgs,
            inlineImages: [{ cid: 'logo1\r\nX-Injected: evil', path: imgPath }],
        });
        // The CRLF is stripped, so "X-Injected:" can never begin its own header line.
        expect(raw).not.toMatch(/\nX-Injected:/i);
        expect(raw).toMatch(/Content-ID:/i);
    });

    it('rejects inlineImages without htmlBody', async () => {
        await expect(
            createEmailWithNodemailer({
                to: ['recipient@example.com'],
                subject: 'No html',
                body: 'plain only',
                inlineImages: [{ cid: 'logo1', path: imgPath }],
            }),
        ).rejects.toThrow(/htmlBody/);
    });

    it('rejects a missing inline image file', async () => {
        await expect(
            createEmailWithNodemailer({
                ...baseArgs,
                inlineImages: [{ cid: 'logo1', path: '/nonexistent/path/nope.png' }],
            }),
        ).rejects.toThrow(/does not exist/);
    });

    it('rejects a base64 content image over the size limit', async () => {
        const tooBig = 'A'.repeat(Math.ceil((MAX_INLINE_IMAGE_CONTENT_BYTES * 4) / 3) + 1000);
        await expect(
            createEmailWithNodemailer({
                ...baseArgs,
                inlineImages: [{ cid: 'big', content: tooBig, contentType: 'image/png' }],
            }),
        ).rejects.toThrow(/size limit/);
    });

    it('works with an HTML body and no plain-text body', async () => {
        const raw = await createEmailWithNodemailer({
            to: ['recipient@example.com'],
            subject: 'HTML only',
            htmlBody: '<p>No plain text here</p><img src="cid:logo1">',
            inlineImages: [{ cid: 'logo1', path: imgPath }],
        });
        expect(raw).toMatch(/multipart\/related/i);
        expect(raw).toMatch(/Content-ID: <logo1>/i);
    });
});

describe('needsRawBuilder', () => {
    it('is false for plain mail', () => {
        expect(needsRawBuilder({ to: ['a@b.com'], body: 'x' })).toBe(false);
    });

    it('is true with attachments', () => {
        expect(needsRawBuilder({ attachments: ['/a.pdf'] })).toBe(true);
    });

    it('is true with inline images', () => {
        expect(needsRawBuilder({ inlineImages: [{ cid: 'x', path: '/a.png' }] })).toBe(true);
    });

    it('is false for empty arrays', () => {
        expect(needsRawBuilder({ attachments: [], inlineImages: [] })).toBe(false);
    });

    it('is false for undefined args', () => {
        expect(needsRawBuilder(undefined)).toBe(false);
    });
});

describe('ReplyAllSchema — inline images', () => {
    it('accepts an inlineImages array', () => {
        expect(() =>
            ReplyAllSchema.parse({
                messageId: 'abc123',
                body: 'reply text',
                htmlBody: '<img src="cid:sig">',
                inlineImages: [{ cid: 'sig', path: '/abs/sig.png' }],
            }),
        ).not.toThrow();
    });
});

describe('InlineImageSchema', () => {
    it('accepts a valid path-based image', () => {
        expect(() => InlineImageSchema.parse({ cid: 'logo', path: '/abs/logo.png' })).not.toThrow();
    });

    it('accepts a valid content-based image', () => {
        expect(() =>
            InlineImageSchema.parse({ cid: 'logo', content: 'AAAA', contentType: 'image/png' }),
        ).not.toThrow();
    });

    it('rejects when both path and content are set', () => {
        expect(() =>
            InlineImageSchema.parse({
                cid: 'logo',
                path: '/a.png',
                content: 'AAAA',
                contentType: 'image/png',
            }),
        ).toThrow();
    });

    it('rejects when neither path nor content is set', () => {
        expect(() => InlineImageSchema.parse({ cid: 'logo' })).toThrow();
    });

    it('rejects content without contentType', () => {
        expect(() => InlineImageSchema.parse({ cid: 'logo', content: 'AAAA' })).toThrow();
    });

    it('rejects a cid with whitespace or angle brackets', () => {
        expect(() => InlineImageSchema.parse({ cid: 'bad cid', path: '/a.png' })).toThrow();
        expect(() => InlineImageSchema.parse({ cid: '<bad>', path: '/a.png' })).toThrow();
    });

    it('rejects image/svg+xml contentType', () => {
        expect(() =>
            InlineImageSchema.parse({ cid: 'logo', content: 'AAAA', contentType: 'image/svg+xml' }),
        ).toThrow();
    });
});
