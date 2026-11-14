import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const fixturesDir = resolve(root, 'fixtures')

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

// Tauri expects a fixed port; tests override with --port.
export default defineConfig(({ mode }) => {
  // The AI Gateway key stays on the dev server (no VITE_ prefix => never in the bundle).
  // The app's hosted second pass targets /ai-gateway in dev; the proxy adds the key.
  const gatewayKey = loadEnv(mode, root, '').VERCEL_AI_GATEWAY_API_KEY
  const proxy = gatewayKey
    ? {
        '/ai-gateway': {
          target: 'https://ai-gateway.vercel.sh',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/ai-gateway/, ''),
          headers: { 'x-api-key': gatewayKey },
        },
      }
    : undefined
  return {
  plugins: [react(), serveFixtures()],
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
