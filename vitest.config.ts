import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * Vitest config for the two execution contexts in this app.
 *
 * Uses Vitest 4 `projects` (the replacement for the deprecated `workspace` API)
 * so the renderer (DOM env) and main process (node env) get separate setups while
 * a single `vitest run` emits aggregated coverage.
 *
 * Projects do NOT inherit root plugins/resolve by default (vitest#7225). We
 * re-declare `plugins` and `resolve.alias` inside each project that needs them so
 * TSX transform (@vitejs/plugin-react) and the @renderer/@shared aliases resolve
 * reliably — do not rely on `extends` for this.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/**/*.{test,spec}.{ts,tsx}',
      ],
      // Keep the global floor at zero for legacy integration-only surfaces,
      // with measured nonzero ratchets on pure and directly tested seams.
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
        'src/renderer/src/utils/**': {
          lines: 77,
          functions: 78,
          branches: 72,
          statements: 73,
        },
        'src/shared/**': {
          lines: 97,
          functions: 100,
          branches: 84,
          statements: 93,
        },
        'src/main/{pty/buildEnv.ts,pty/shellIntegration.ts,sessions/{claudePaths,codexDetection,deepSearch,transcriptParse}.ts}': {
          lines: 90,
          functions: 100,
          branches: 75,
          statements: 90,
        },
      },
    },
    projects: [
      {
        // Renderer: React components + stores + utils — DOM environment.
        plugins: [react()],
        resolve: {
          alias: { '@renderer': resolve('src/renderer/src'), '@shared': resolve('src/shared') },
        },
        test: {
          name: 'renderer',
          environment: 'happy-dom',
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}'],
          setupFiles: ['./tests/setup.renderer.ts'],
        },
      },
      {
        // Main process + shared: Node-only logic — node environment, no DOM globals.
        resolve: {
          alias: { '@shared': resolve('src/shared') },
        },
        test: {
          name: 'main',
          environment: 'node',
          include: [
            'src/main/**/*.{test,spec}.{ts,tsx}',
            'src/shared/**/*.{test,spec}.{ts,tsx}',
          ],
        },
      },
    ],
  },
})
