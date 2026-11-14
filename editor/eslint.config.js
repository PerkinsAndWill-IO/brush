// ESLint flat config. The important part is the `src/core/**` purity block
// (AGENTS.md rule 4): core may not import UI/browser libraries or the app,
// and may not touch DOM / network globals.
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const CORE_FORBIDDEN_MODULES = [
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  'tldraw',
  'tldraw/*',
  '@tldraw/*',
  'pdfjs-dist',
  'pdfjs-dist/*',
  '@tauri-apps/*',
  '@app',
  '@app/*',
]

const CORE_FORBIDDEN_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'location',
].map((name) => ({ name, message: `core must stay pure: no DOM/network globals (${name}). Move this to src/app.` }))

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'reports/**',
      'test-results/**',
      'playwright-report/**',
      'src-tauri/**',
      'fixtures/**',
      '**/*.min.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
    },
  },
  {
    files: ['src/app/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['scripts/**', 'tests/**', '*.config.{ts,js}', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/core/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: CORE_FORBIDDEN_MODULES.filter((m) => !m.includes('*')).map((name) => ({
            name,
            message: 'core must not depend on UI, PDF, shell or app code (AGENTS.md rule 4).',
          })),
          patterns: [
            {
              group: CORE_FORBIDDEN_MODULES.filter((m) => m.includes('*')),
              message: 'core must not depend on UI, PDF, shell or app code (AGENTS.md rule 4).',
            },
            {
              // relative imports reaching into src/app, e.g. '../../app/x'
              regex: '^(\\.\\.?/)+(.*/)?app(/|$)',
              message: 'core must not import from src/app (AGENTS.md rule 4).',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', ...CORE_FORBIDDEN_GLOBALS],
    },
  },
)
