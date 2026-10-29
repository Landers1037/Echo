import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))
const excalidrawFonts = path.resolve(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')

const drawioRoot = path.resolve(root, 'third_party/drawio')

function drawioContentType(file: string) {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.xml': 'application/xml',
    '.txt': 'text/plain; charset=utf-8', '.properties': 'text/plain; charset=utf-8', '.map': 'application/json', '.wasm': 'application/wasm',
  }
  return types[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function drawioAssets(): Plugin {
  return {
    name: 'drawio-assets',
    configureServer(server) {
      server.middlewares.use('/drawio', (req, res, next) => {
        let requestPath = '/'
        try { requestPath = decodeURIComponent((req.url || '/').split('?')[0]) } catch { next(); return }
        const file = path.resolve(drawioRoot, `.${requestPath}`)
        const relative = path.relative(drawioRoot, file)
        if (relative.startsWith('..') || path.isAbsolute(relative)) { next(); return }
        fs.stat(file, (error, stat) => {
          if (error) { next(); return }
          const target = stat.isDirectory() ? path.join(file, 'index.html') : file
          fs.stat(target, (targetError, targetStat) => {
            if (targetError || !targetStat.isFile()) { next(); return }
            res.setHeader('Content-Type', drawioContentType(target))
            res.setHeader('Cache-Control', 'no-cache')
            fs.createReadStream(target).pipe(res)
          })
        })
      })
    },
    closeBundle() {
      if (!fs.existsSync(path.join(drawioRoot, 'index.html'))) throw new Error('Draw.io is missing. Run node scripts/fetch-drawio.mjs')
      fs.cpSync(drawioRoot, path.resolve(root, 'internal/web/dist/drawio'), { recursive: true })
    },
  }
}

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
  plugins: [react(), excalidrawAssets(), drawioAssets()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  build: { outDir: 'internal/web/dist', emptyOutDir: false, chunkSizeWarningLimit: 1200 },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], setupFiles: ['src/test-setup.ts'] },
})
