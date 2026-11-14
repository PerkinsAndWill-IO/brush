import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

/**
 * Serves ./fixtures at /fixtures/* in `vite dev` and `vite preview` only.
 * Tests call `window.__brush.loadPdf('/fixtures/pdfs/office-1-sheet.pdf')`.
 * Fixtures are never copied into a production build.
 */
function serveFixtures(): Plugin {
  const handler = (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
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
    createReadStream(file).pipe(res)
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
  /** File name, e.g. `house.drawing`. */
  name: string
  /** Label for the picker, from the file name. */
  label: string
  /** Where the app fetches it. */
  url: string
  size: number
}

function listSamples(): SampleEntry[] {
  if (!existsSync(samplesDir)) return []
  return readdirSync(samplesDir)
    .filter((f) => /\.drawing$/i.test(f) && statSync(resolve(samplesDir, f)).isFile())
    .sort()
    .map((name) => {
      const stem = basename(name, extname(name)).replace(/[-_]+/g, ' ')
      return { name, label: stem.charAt(0).toUpperCase() + stem.slice(1), url: `/samples/${encodeURIComponent(name)}`, size: statSync(resolve(samplesDir, name)).size }
    })
}

/**
 * The sample `.drawing` files in `../schema/public/examples` (single source: not copied into editor/).
 * - `virtual:brush-samples` exports the list for the start page's sample picker.
 * - `vite dev` / `vite preview` serve them at /samples/*; `vite build` emits them into dist/samples/.
 * If the folder is missing (editor deployed on its own) the list is empty and the picker hides.
 */
function sampleDrawings(): Plugin {
  const VIRTUAL = 'virtual:brush-samples'
  const RESOLVED = '\0' + VIRTUAL
  const handler = (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0])
    if (!url.startsWith('/samples/')) return next()
    const sample = listSamples().find((s) => s.name === url.slice('/samples/'.length))
    if (!sample) return next()
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-store')
    createReadStream(resolve(samplesDir, sample.name)).pipe(res)
  }
  return {
    name: 'brush-sample-drawings',
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return
      return `export default ${JSON.stringify(listSamples())}`
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
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
    generateBundle() {
      for (const s of listSamples()) this.emitFile({ type: 'asset', fileName: `samples/${s.name}`, source: readFileSync(resolve(samplesDir, s.name)) })
    },
  }
}

// Tauri expects a fixed port; tests override with --port.
export default defineConfig(({ mode }) => {
  // The AI Gateway key stays on the dev server (no VITE_ prefix => never in the bundle).
  // The app's hosted second pass targets /api/ai-gateway; in dev this proxy adds the key,
  // in production the Vercel Function api/ai-gateway.ts does.
  const gatewayKey = loadEnv(mode, root, '').VERCEL_AI_GATEWAY_API_KEY
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
  plugins: [react(), serveFixtures(), sampleDrawings()],
  resolve: {
    alias: {
      '@core': resolve(root, 'src/core'),
      '@app': resolve(root, 'src/app'),
    },
  },
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
