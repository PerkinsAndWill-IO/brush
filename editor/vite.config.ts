import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const fixturesDir = resolve(root, 'fixtures')
/** Sample `.drawing` files shipped with the format spec (`schema/` in this repo). Offered on the start page. */
const samplesDir = resolve(root, '..', 'schema', 'public', 'examples')

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

/** Send a file, honouring a single `Range: bytes=a-b` (206) like a static host does, so range loading can be tested. */
function sendFile(req: { headers?: Record<string, string | string[] | undefined> }, res: import('node:http').ServerResponse, file: string) {
  const size = statSync(file).size
  res.setHeader('Accept-Ranges', 'bytes')
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers?.range ?? ''))
  if (!m || (!m[1] && !m[2])) {
    res.setHeader('Content-Length', size)
    createReadStream(file).pipe(res)
    return
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start > end) {
    res.statusCode = 416
    res.setHeader('Content-Range', `bytes */${size}`)
    res.end()
    return
  }
  res.statusCode = 206
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  res.setHeader('Content-Length', end - start + 1)
  createReadStream(file, { start, end }).pipe(res)
}

/**
 * Serves ./fixtures at /fixtures/* in `vite dev` and `vite preview` only.
 * Tests call `window.__brush.loadPdf('/fixtures/pdfs/office-1-sheet.pdf')`.
 * Fixtures are never copied into a production build.
 */
function serveFixtures(): Plugin {
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (!url.startsWith('/fixtures/')) return next()
    const file = resolve(fixturesDir, '.' + url.slice('/fixtures'.length))
    if (!file.startsWith(fixturesDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404
      res.end('fixture not found')
      return
    }
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    sendFile(req, res, file)
  }
  return {
    name: 'brush-serve-fixtures',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

export interface SampleEntry {
  /** Path relative to the samples folder, e.g. `house.drawing` or `kro/kro-sample.drawing`. */
  name: string
  /** Label for the picker, from the file name. */
  label: string
  /** Where the app fetches it. */
  url: string
  size: number
}

/** A Git LFS pointer (the clone ran without `git lfs pull`): ~130 bytes of text, not a drawing. */
function isLfsPointer(file: string): boolean {
  if (statSync(file).size > 1024) return false
  return readFileSync(file, 'utf8').startsWith('version https://git-lfs.github.com/spec/')
}

/** `.drawing` files in the samples folder and its subfolders (e.g. `kro/`), as `/`-separated paths relative to it. */
function findSampleFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name
    if (e.isDirectory()) return findSampleFiles(resolve(dir, e.name), rel + '/')
    if (!e.isFile() || !/\.drawing$/i.test(e.name) || isLfsPointer(resolve(dir, e.name))) return []
    return [rel]
  })
}

function listSamples(): SampleEntry[] {
  if (!existsSync(samplesDir)) return []
  return findSampleFiles(samplesDir)
    .sort()
    .map((name) => {
      const stem = basename(name, extname(name)).replace(/[-_]+/g, ' ')
      const url = `/samples/${name.split('/').map(encodeURIComponent).join('/')}`
      return { name, label: stem.charAt(0).toUpperCase() + stem.slice(1), url, size: statSync(resolve(samplesDir, name)).size }
    })
}

/** Samples too big for git, hosted elsewhere (Vercel Blob): `remote-samples.json` in the samples folder, a list of `SampleEntry` with absolute URLs. */
function listRemoteSamples(): SampleEntry[] {
  const file = resolve(samplesDir, 'remote-samples.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SampleEntry[]) : []
}

/**
 * The sample `.drawing` files in `../schema/public/examples` (single source: not copied into editor/).
 * - `virtual:brush-samples` exports the list for the start page's sample picker, plus the remote ones.
 * - `vite dev` / `vite preview` serve them at /samples/*; `vite build` emits them into dist/samples/.
 * If the folder is missing (editor deployed on its own) the list is empty and the picker hides.
 */
function sampleDrawings(): Plugin {
  const VIRTUAL = 'virtual:brush-samples'
  const RESOLVED = '\0' + VIRTUAL
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (!url.startsWith('/samples/')) return next()
    const sample = listSamples().find((s) => s.name === url.slice('/samples/'.length))
    if (!sample) return next()
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    sendFile(req, res, resolve(samplesDir, sample.name))
  }
  return {
    name: 'brush-sample-drawings',
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return
      return `export default ${JSON.stringify([...listSamples(), ...listRemoteSamples()])}`
    },
    configureServer(server) {
      server.middlewares.use(handler)
      // a sample added or removed refreshes the list
      if (existsSync(samplesDir)) server.watcher.add(samplesDir)
      const refresh = (file: string) => {
        if (!file.startsWith(samplesDir + sep)) return
        const mod = server.moduleGraph.getModuleById(RESOLVED)
        if (mod) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', refresh)
      server.watcher.on('unlink', refresh)
      server.watcher.on('change', refresh) // e.g. `git lfs pull` replacing a pointer with the drawing
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
    generateBundle() {
      for (const s of listSamples()) this.emitFile({ type: 'asset', fileName: `samples/${s.name}`, source: readFileSync(resolve(samplesDir, s.name)) })
    },
  }
}

/**
 * P1-11 in dev: answer /api/photo-relay with the real function (api/photo-relay.ts), so sending a photo from a phone
 * can be tried locally. With BLOB_READ_WRITE_TOKEN in editor/.env.local it uses that Vercel Blob store (a private
 * one; the token stays on the dev server). Without it, photos wait in a folder on this computer
 * (scripts/photo-relay-local-store.ts, in the system temp folder). A phone cannot open `localhost`: start with
 * `pnpm dev:phone` and open the app at the computer's network address (see AGENTS.md).
 */
function photoRelayDev(token: string | undefined): Plugin {
  return {
    name: 'brush-photo-relay-dev',
    configureServer(server) {
      if (token) process.env.BLOB_READ_WRITE_TOKEN = token
      const localDir = resolve(tmpdir(), 'brush-photo-relay')
      server.config.logger.info(token ? '  photo relay: Vercel Blob (BLOB_READ_WRITE_TOKEN)' : `  photo relay: local folder ${localDir}`)
      server.middlewares.use('/api/photo-relay', (req, res, next) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('error', next)
        req.on('end', async () => {
          try {
            type Handler = (r: Request) => Promise<Response>
            type Relay = Record<string, Handler | undefined>
            const fn = (await server.ssrLoadModule('/api/photo-relay.ts')) as Relay & { relayWith: (store: unknown) => Relay }
            let relay: Relay = fn
            if (!token) {
              const { localPhotoStore } = (await server.ssrLoadModule('/scripts/photo-relay-local-store.ts')) as { localPhotoStore: (dir: string) => unknown }
              relay = fn.relayWith(localPhotoStore(localDir))
            }
            const handler = relay[req.method ?? 'GET']
            if (!handler) {
              res.statusCode = 405
              res.end()
              return
            }
            const headers = new Headers()
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
            const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined
            // mounted at /api/photo-relay, so req.url is only the rest ("?id=...")
            const r = await handler(new Request(`http://${req.headers.host}/api/photo-relay${req.url === '/' ? '' : req.url}`, { method: req.method, headers, body }))
            res.statusCode = r.status
            r.headers.forEach((v, k) => res.setHeader(k, v))
            res.end(Buffer.from(await r.arrayBuffer()))
          } catch (e) {
            next(e)
          }
        })
      })
    },
  }
}

// Tauri expects a fixed port; tests override with --port.
export default defineConfig(({ mode }) => {
  // The AI Gateway key stays on the dev server (no VITE_ prefix => never in the bundle).
  // The app's hosted second pass targets /api/ai-gateway; in dev this proxy adds the key,
  // in production the Vercel Function api/ai-gateway.ts does.
  const env = loadEnv(mode, root, '')
  const gatewayKey = env.VERCEL_AI_GATEWAY_API_KEY
  const proxy = gatewayKey
    ? {
        '/api/ai-gateway': {
          target: 'https://ai-gateway.vercel.sh',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api\/ai-gateway/, ''),
          headers: { 'x-api-key': gatewayKey },
        },
      }
    : undefined
  return {
  plugins: [react(), serveFixtures(), sampleDrawings(), photoRelayDev(env.BLOB_READ_WRITE_TOKEN)],
  resolve: {
    alias: {
      '@core': resolve(root, 'src/core'),
      '@app': resolve(root, 'src/app'),
    },
  },
  // the photo worker's OpenCV build (11 MB, CommonJS): pre-bundle it up front so its first use does not reload the page
  // both are loaded only by the photo worker, on first use: prebundled at start-up, so the dev server does not stop
  // to optimise them in the middle of an import (and reload the page)
  optimizeDeps: { include: ['@techstark/opencv-js', 'libheif-js/libheif-wasm/libheif-bundle.mjs'] },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/reports/**', '**/test-results/**'] },
    proxy,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  }
})
