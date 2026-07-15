import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    define: {
      'process.env.GH_UPDATE_TOKEN': JSON.stringify(process.env.GH_UPDATE_TOKEN ?? ''),
    },
    plugins: [
      {
        name: 'copy-shell-integration',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'shellIntegration.ps1',
            source: readFileSync(resolve('src/main/pty/shellIntegration.ps1'), 'utf8'),
          })
          this.emitFile({
            type: 'asset',
            fileName: 'shellIntegration.sh',
            source: readFileSync(resolve('src/main/pty/shellIntegration.sh'), 'utf8'),
          })
        },
      },
      {
        // spec 047 phase 3 / phase 4: the managed SessionStart hook scripts, emitted beside
        // out/main/index.js so ManagedHookController.resolveHookScriptPath finds them at
        // runtime (dev and packaged). The .ps1 is used on Windows, the .sh on Linux/macOS;
        // both are emitted on every build and the runtime picks the right one. Covered by
        // build.files `out/**/*`.
        name: 'copy-agent-state-hook',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'multiagent-agent-state.ps1',
            source: readFileSync(resolve('src/main/integration/assets/multiagent-agent-state.ps1'), 'utf8'),
          })
          this.emitFile({
            type: 'asset',
            fileName: 'multiagent-agent-state.sh',
            source: readFileSync(resolve('src/main/integration/assets/multiagent-agent-state.sh'), 'utf8'),
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
    build: {
      externalizeDeps: true
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      react({}),
      tailwindcss()
    ]
  }
})
