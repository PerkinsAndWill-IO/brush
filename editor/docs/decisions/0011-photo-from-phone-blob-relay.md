# 0011 A photo from the phone goes through a private Vercel Blob store

Date: 2026-11-14

## Context

The markup is photographed with a phone, and the editor runs on a computer. Getting the photo across (AirDrop,
messaging it to yourself, a cable) is the slowest part of an import. P1-11 asks for a QR code in the import dialog:
scan it, take or pick the photo, and it lands in the dialog.

A phone cannot reach the computer's browser directly, so the photo needs a relay that both can reach: the editor's
own deployment (decision 0007). Vercel Functions keep no state between requests, so the photo has to wait in a store.

## Decision

1. **A Vercel Function `api/photo-relay.ts`** with one slot per QR code. The dialog makes a random slot id (128 bits)
   and shows the link `/?phone=<id>`; that page posts the photo to the slot; the dialog polls the slot every 2 s and
   receives the photo, which is deleted as it is handed over. A slot is given up when the dialog closes, and codes
   expire after 15 minutes. Photos left behind are deleted by the next upload after an hour.
2. **New dependency `@vercel/blob` 2.8.2** (pinned exactly; server side only, in the function), with blobs written as
   **private**: there is no public link to a photo. It is read only through the function, by whoever holds the
   slot id.
3. **New dependency `uqr` 0.1.3** (MIT, no dependencies) to encode the QR code; the dialog draws it as SVG.
4. **The phone sends the photo through the function**, not straight to Blob: one request, no upload tokens or
   webhooks. A Function request is limited to 4.5 MB, so a larger photo is scaled down to a JPEG on the phone before
   it is sent (most iPhone photos are 2 to 4 MB and go as they are; iOS hands Safari a JPEG). The relay takes JPEG,
   PNG and HEIC only, checked by their first bytes, up to 4 MB.

## Alternatives considered

- **Blob client uploads** (the phone uploads straight to Blob with a token from the function): no size limit, but a
  token handshake and an upload-completed webhook for a case the size cap already covers.
- **WebRTC between phone and computer**: no stored photo, but it still needs a signalling server and fails on many
  office networks.
- **Upstash Redis / KV**: a key-value store is not meant for 4 MB images.

## Consequences

- **Setup:** a Blob store must be connected to the `brush-editor` Vercel project (Storage, then Blob, then Connect;
  that sets `BLOB_READ_WRITE_TOKEN`). Until then the dialog says that sending from a phone is not set up.
- **Access:** production is public, so anyone who sees a QR code can send a photo to that slot for 15 minutes.
  Previews are behind Vercel Deployment Protection, so a phone has to sign in to Vercel there.
- **Local development:** `pnpm dev` runs no functions, and a phone cannot open the computer's `localhost`; the dialog
  explains this instead of showing a code.
- The photo passes through Vercel's storage for the seconds between upload and pickup.
