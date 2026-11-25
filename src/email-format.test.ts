import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolveDefaultEmailFormat, resolveEmailBody } from './email-format.js';
import { createEmailMessage, createEmailWithNodemailer } from './utl.js';
import { ReplyAllSchema, SendEmailSchema, UpdateDraftSchema } from './tools.js';

describe('email format resolution', () => {
    it('keeps plain text when unconfigured', () => {
        expect(resolveDefaultEmailFormat({})).toBe('text/plain');
        expect(resolveEmailBody({ body: 'hello' }, {})).toEqual({ mimeType: 'text/plain', text: 'hello' });
    });

    it.each(['text/plain', 'text/html', 'multipart/alternative'] as const)('accepts %s', mimeType => {
        expect(resolveDefaultEmailFormat({ GMAIL_DEFAULT_MIME_TYPE: mimeType })).toBe(mimeType);
    });

    it.each(['', 'html', 'application/pdf'])('rejects invalid configuration %j', value => {
        expect(() => resolveEmailBody({ body: 'hello' }, { GMAIL_DEFAULT_MIME_TYPE: value }))
            .toThrow('GMAIL_DEFAULT_MIME_TYPE must be one of:');
    });

    it('honors an explicit plain-text override', () => {
        expect(resolveEmailBody({ body: 'hello', htmlBody: '<b>hello</b>', mimeType: 'text/plain' }, {
            GMAIL_DEFAULT_MIME_TYPE: 'text/html',
        })).toEqual({ mimeType: 'text/plain', text: 'hello' });
    });

    it('escapes text and preserves Unicode and line breaks under an HTML default', () => {
        expect(resolveEmailBody({ body: '<team> & "friends"\r\nI’m here\n\nthanks' }, {
            GMAIL_DEFAULT_MIME_TYPE: 'text/html',
        })).toEqual({ mimeType: 'text/html', html: '<div>&lt;team&gt; &amp; &quot;friends&quot;<br>I’m here<br><br>thanks</div>' });
    });

    it('generates HTML and retains the exact text fallback for a multipart default', () => {
        expect(resolveEmailBody({ body: 'one\ntwo' }, { GMAIL_DEFAULT_MIME_TYPE: 'multipart/alternative' }))
            .toEqual({ mimeType: 'multipart/alternative', text: 'one\ntwo', html: '<div>one<br>two</div>' });
    });

    it('preserves explicit HTML in body', () => {
        expect(resolveEmailBody({ body: '<p>hello</p>', mimeType: 'text/html' }, {}))
            .toEqual({ mimeType: 'text/html', html: '<p>hello</p>' });
    });

    it('retains supplied HTML when mimeType is omitted', () => {
        expect(resolveEmailBody({ body: 'hello', htmlBody: '<b>hello</b>' }, {}))
            .toEqual({ mimeType: 'multipart/alternative', text: 'hello', html: '<b>hello</b>' });
    });

    it('uses htmlBody instead of converting body under an HTML default', () => {
        expect(resolveEmailBody({ body: 'hello', htmlBody: '<b>hello</b>' }, {
            GMAIL_DEFAULT_MIME_TYPE: 'text/html',
        })).toEqual({ mimeType: 'text/html', html: '<b>hello</b>' });
    });
});

describe('message builders use the configured format', () => {
    beforeEach(() => vi.stubEnv('GMAIL_DEFAULT_MIME_TYPE', undefined));
    afterEach(() => vi.unstubAllEnvs());

    // Decode MIME body parts without network access or extra dependencies.
    function bodyPart(raw: string, mimeType: string): string | undefined {
        const part = raw.split(new RegExp(`Content-Type: ${mimeType}[^\\r\\n]*\\r?\\n`, 'i'))[1];
        if (part == null) return undefined;
        const [headers, ...chunks] = part.split(/\r?\n\r?\n/);
        const encoded = chunks.join('\n\n').split(/\r?\n--/)[0].trimEnd();
        const decoded = /Content-Transfer-Encoding: base64/i.test(headers)
            ? Buffer.from(encoded, 'base64').toString('utf8')
            : /Content-Transfer-Encoding: quoted-printable/i.test(headers)
                ? encoded.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                : encoded;
        return decoded.replace(/\r\n/g, '\n');
    }

    for (const [name, build] of [
        ['simple', createEmailMessage],
        ['attachment', (args: any) => createEmailWithNodemailer({
            ...args, attachments: [fileURLToPath(import.meta.url)],
        })],
    ] as const) {
        const args = { to: ['test@example.com'], subject: 'Format test', body: 'one & two\nthree' };

        it(`${name}: leaves ordinary unconfigured mail as plain text`, async () => {
            const raw = await build(args);
            expect(bodyPart(raw, 'text/plain')).toBe(args.body);
            expect(bodyPart(raw, 'text/html')).toBeUndefined();
        });

        it.each(['text/html', 'multipart/alternative'] as const)(`${name}: applies %s without losing attachment data`, async mimeType => {
            vi.stubEnv('GMAIL_DEFAULT_MIME_TYPE', mimeType);
            const raw = await build(args);
            expect(bodyPart(raw, 'text/html')).toBe('<div>one &amp; two<br>three</div>');
            expect(bodyPart(raw, 'text/plain')).toBe(mimeType === 'text/html' ? undefined : args.body);
            if (name === 'attachment') expect(raw).toContain('filename=email-format.test.ts');
        });

        it(`${name}: explicit plain text overrides the configured default`, async () => {
            vi.stubEnv('GMAIL_DEFAULT_MIME_TYPE', 'multipart/alternative');
            const raw = await build({ ...args, mimeType: 'text/plain' });
            expect(bodyPart(raw, 'text/plain')).toBe(args.body);
            expect(bodyPart(raw, 'text/html')).toBeUndefined();
        });

        it(`${name}: keeps explicit HTML markup`, async () => {
            const raw = await build({ ...args, body: '<b>hello</b>', mimeType: 'text/html' });
            expect(bodyPart(raw, 'text/html')).toBe('<b>hello</b>');
        });

        it(`${name}: retains supplied HTML without mimeType`, async () => {
            const raw = await build({ ...args, htmlBody: '<p>hello</p>' });
            expect(bodyPart(raw, 'text/html')).toBe('<p>hello</p>');
            expect(bodyPart(raw, 'text/plain')).toBe(args.body);
        });
    }

    it('preserves omitted versus explicit MIME choices across the write schemas', () => {
        const args = { to: ['test@example.com'], subject: 'hello', body: 'hello' };
        const cases = [
            [SendEmailSchema, args],
            [UpdateDraftSchema, { ...args, draftId: 'draft' }],
            [ReplyAllSchema, { messageId: 'message', body: 'hello' }],
        ] as const;
        vi.stubEnv('GMAIL_DEFAULT_MIME_TYPE', 'text/html');
        for (const [schema, input] of cases) {
            const parsed = schema.parse(input);
            expect(parsed.mimeType).toBeUndefined();
            expect(resolveEmailBody(parsed).mimeType).toBe('text/html');
            expect(resolveEmailBody(schema.parse({ ...input, mimeType: 'text/plain' })).mimeType).toBe('text/plain');
        }
    });
});
