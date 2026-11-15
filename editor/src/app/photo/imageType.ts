/** The image type of a file by its first bytes (not its name or declared type), or null: JPEG, PNG, HEIC/HEIF. PURE. */
export function imageType(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/heic' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' && /^(hei[cxms]|hev[cxms]|mif1|msf1)$/.test(String.fromCharCode(...b.subarray(8, 12)))) return 'image/heic'
  return null
}
