/**
 * P1-11 in local development: the photo relay's storage as a folder on this computer, so sending a photo from a
 * phone works with `pnpm dev:phone` and no Vercel Blob store. vite.config.ts uses it when .env.local has no
 * BLOB_READ_WRITE_TOKEN. Dev server only: never part of a build or a deployment.
 *
 * Each photo is one file named by its slot. Its type is read back from its first bytes (the relay accepted it by
 * them), and its age from the file's modification time.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PhotoStore } from '../api/photo-relay'
import { imageType } from '../api/photo-relay'

/** Store paths are `photo-relay/<slot>`; the slot alone names the file (the relay has already checked it). */
const SAFE = /^[A-Za-z0-9_-]+$/

export function localPhotoStore(dir: string): PhotoStore {
  const split = (path: string) => {
    const at = path.lastIndexOf('/')
    const prefix = path.slice(0, at + 1)
    const name = path.slice(at + 1)
    if (!SAFE.test(name)) throw new Error('invalid photo path')
    return { prefix, file: join(dir, name) }
  }
  return {
    configured: () => true,
    async put(path, bytes) {
      await mkdir(dir, { recursive: true })
      await writeFile(split(path).file, bytes)
    },
    async read(path) {
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await readFile(split(path).file))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
      return { bytes, contentType: imageType(bytes) ?? 'application/octet-stream' }
    },
    async del(paths) {
      await Promise.all(paths.map((p) => rm(split(p).file, { force: true })))
    },
    async list(prefix) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const files = names.filter((n) => SAFE.test(n))
      return Promise.all(files.map(async (n) => ({ pathname: prefix + n, uploadedAt: (await stat(join(dir, n))).mtime })))
    },
  }
}
