/**
 * Recovers an attachment's original filename from a message payload.
 *
 * `download_attachment` receives an attachmentId from an earlier call, then
 * re-fetches the message to look the filename up. The attachmentId in the new
 * response does not always equal the one passed in, so an exact-id lookup can
 * miss and the download falls back to a meaningless `attachment-<id>` name.
 *
 * Resolution order:
 *   1. exact attachmentId match (with a filename)
 *   2. the only named attachment whose size equals the downloaded byte length
 *   3. the only named attachment in the message
 * Returns null when none of these is unambiguous; the caller then uses its
 * fallback name.
 *
 * Pure function: no Gmail calls, unit-testable with a plain payload object.
 */
export interface AttachmentPartLike {
    filename?: string | null;
    body?: { attachmentId?: string | null; size?: number | null } | null;
    parts?: AttachmentPartLike[] | null;
}

export function resolveAttachmentFilename(
    payload: AttachmentPartLike | null | undefined,
    attachmentId: string,
    byteLength: number,
): string | null {
    const all: { filename: string; attachmentId: string; size: number }[] = [];
    const collect = (part: AttachmentPartLike | null | undefined) => {
        if (!part) return;
        if (part.body?.attachmentId) {
            all.push({
                filename: part.filename || '',
                attachmentId: part.body.attachmentId,
                size: part.body.size ?? -1,
            });
        }
        for (const sub of part.parts ?? []) collect(sub);
    };
    collect(payload);

    // An exact match is authoritative, even when that part has no filename.
    const exact = all.find(p => p.attachmentId === attachmentId);
    if (exact) return exact.filename || null;

    const bySize = all.filter(p => p.size === byteLength);
    if (bySize.length === 1) return bySize[0].filename || null;

    if (all.length === 1) return all[0].filename || null;

    return null;
}
