import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'copy-shell-integration',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'shellIntegration.ps1',
            source: readFileSync(resolve('src/main/pty/shellIntegration.ps1'), 'utf8'),
          })
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          ptyWorker: resolve('src/main/pty/ptyWorker.ts'),
        },
        output: {
          entryFileNames: '[name].js',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      react(),
      tailwindcss()
    ]
  }
})
