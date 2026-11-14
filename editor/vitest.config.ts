import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

// Unit tests: core only, node environment, no DOM.
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(root, 'src/core'),
      '@app': resolve(root, 'src/app'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
})
