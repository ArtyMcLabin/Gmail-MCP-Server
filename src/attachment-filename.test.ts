import { describe, it, expect } from 'vitest';
import { resolveAttachmentFilename, AttachmentPartLike } from './attachment-filename.js';

const att = (filename: string, attachmentId: string, size: number): AttachmentPartLike => ({
    filename,
    body: { attachmentId, size },
});

const message = (...parts: AttachmentPartLike[]): AttachmentPartLike => ({
    filename: '',
    body: { size: 0 },
    parts: [{ filename: '', body: { size: 120 } }, ...parts],
});

describe('resolveAttachmentFilename', () => {
    it('returns the filename on an exact attachmentId match', () => {
        const payload = message(att('a.pdf', 'ID-A', 100), att('b.pdf', 'ID-B', 200));
        expect(resolveAttachmentFilename(payload, 'ID-B', 999)).toBe('b.pdf');
    });

    it('falls back to a unique size match when the id does not match', () => {
        const payload = message(att('a.pdf', 'NEW-A', 11290), att('b.pdf', 'NEW-B', 93241));
        expect(resolveAttachmentFilename(payload, 'OLD-B', 93241)).toBe('b.pdf');
    });

    it('does not guess when several attachments share the downloaded size', () => {
        const payload = message(att('a.pdf', 'NEW-A', 500), att('b.pdf', 'NEW-B', 500));
        expect(resolveAttachmentFilename(payload, 'OLD', 500)).toBeNull();
    });

    it('uses the only named attachment when nothing else matches', () => {
        const payload = message(att('only.xlsx', 'NEW', 10));
        expect(resolveAttachmentFilename(payload, 'OLD', 99)).toBe('only.xlsx');
    });

    it('finds attachments in nested multipart parts', () => {
        const payload: AttachmentPartLike = {
            parts: [{ parts: [{ parts: [att('deep.pdf', 'NEW', 42), att('other.png', 'NEW2', 7)] }] }],
        };
        expect(resolveAttachmentFilename(payload, 'OLD', 42)).toBe('deep.pdf');
    });

    it('never borrows another attachment\'s name for an unnamed exact match', () => {
        const payload = message({ filename: '', body: { attachmentId: 'X', size: 42 } }, att('real.pdf', 'Y', 9));
        expect(resolveAttachmentFilename(payload, 'X', 42)).toBeNull();
    });

    it('does not count unnamed attachments as the "only" attachment', () => {
        const payload = message({ filename: '', body: { attachmentId: 'U', size: 5 } }, att('real.pdf', 'Y', 9));
        expect(resolveAttachmentFilename(payload, 'OLD', 1)).toBeNull();
    });

    it('returns null for an empty or missing payload', () => {
        expect(resolveAttachmentFilename(undefined, 'X', 1)).toBeNull();
        expect(resolveAttachmentFilename({}, 'X', 1)).toBeNull();
    });
});
