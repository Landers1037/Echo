import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))
const excalidrawFonts = path.resolve(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')

function excalidrawAssets(): Plugin {
  const contentType = (file: string) => file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.woff') ? 'font/woff' : 'application/octet-stream'
  return {
    name: 'excalidraw-assets',
    configureServer(server) {
      server.middlewares.use('/excalidraw-assets/fonts', (req, res, next) => {
        let requestPath = '/'
        try { requestPath = decodeURIComponent((req.url || '/').split('?')[0]) } catch { next(); return }
        const file = path.resolve(excalidrawFonts, `.${requestPath}`)
        const relative = path.relative(excalidrawFonts, file)
        if (relative.startsWith('..') || path.isAbsolute(relative)) { next(); return }
        fs.stat(file, (error, stat) => {
          if (error || !stat.isFile()) { next(); return }
          res.setHeader('Content-Type', contentType(file))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          fs.createReadStream(file).pipe(res)
        })
      })
    },
    closeBundle() {
      fs.cpSync(excalidrawFonts, path.resolve(root, 'internal/web/dist/excalidraw-assets/fonts'), { recursive: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), excalidrawAssets()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: { outDir: 'internal/web/dist', emptyOutDir: false, chunkSizeWarningLimit: 1200 },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['src/test-setup.ts'] },
})
