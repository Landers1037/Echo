import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(root, '.echo-dev')
const isWindows = process.platform === 'win32'
const children = new Set()
const watchers = []
const binaries = new Set()
let stopping = false
let backend
let building = false
let rebuildPending = false
let sequence = 0
let rebuildTimer
let pollingTimer

function launch(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options })
  children.add(child)
  child.once('close', () => children.delete(child))
  child.once('error', error => console.error(`[echo] ${command}: ${error.message}`))
  return child
}

function completed(child) {
  return new Promise(resolveExit => {
    child.once('error', () => resolveExit(1))
    child.once('close', code => resolveExit(code ?? 1))
  })
}

async function terminate(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const closed = completed(child)
  if (isWindows) {
    await new Promise(resolveKill => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', resolveKill)
      killer.once('close', resolveKill)
    })
  } else {
    child.kill('SIGTERM')
  }
  const forceTimer = setTimeout(() => child.kill('SIGKILL'), 2500)
  forceTimer.unref()
  await closed
  clearTimeout(forceTimer)
}

async function rebuildBackend() {
  if (stopping) return
  if (building) {
    rebuildPending = true
    return
  }
  building = true
  do {
    rebuildPending = false
    const candidate = join(scratch, `echo-${process.pid}-${++sequence}${isWindows ? '.exe' : ''}`)
    binaries.add(candidate)
    console.log('[echo] Building Go backend…')
    const build = launch('go', ['build', '-o', candidate, './cmd/echo'])
    const result = await completed(build)
    if (stopping) break
    if (result === 0) {
      const previous = backend
      backend = undefined
      await terminate(previous)
      if (stopping) break
      const dataDir = process.env.ECHO_DATA_DIR || 'notes'
      backend = launch(candidate, ['--addr', '127.0.0.1:8080', '--data-dir', dataDir, '--dev'])
      const active = backend
      active.once('close', code => {
        if (!stopping && backend === active && code !== 0) {
          console.error(`[echo] Backend exited (${code}). Edit a Go file to rebuild, or restart npm run dev.`)
        }
      })
      console.log('[echo] Starting backend at http://127.0.0.1:8080')
      for (const file of [...binaries]) {
        if (file !== candidate) {
          await unlink(file).catch(() => {})
          binaries.delete(file)
        }
      }
    } else {
      await unlink(candidate).catch(() => {})
      binaries.delete(candidate)
      console.error('[echo] Go build failed. The previous backend stays available; edit source to retry.')
    }
  } while (rebuildPending && !stopping)
  building = false
}

function queueRebuild(filename) {
  if (!filename || !/\.(go|mod|sum)$/.test(String(filename))) return
  const normalized = String(filename).replaceAll('\\', '/')
  if (normalized.includes('web/dist/')) return
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => void rebuildBackend(), 300)
}

async function sourceSignature(directory) {
  const result = []
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(current, entry.name)
      const rel = relative(root, full).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        if (rel !== 'internal/web/dist') await visit(full)
      } else if (entry.isFile() && /\.(go|mod|sum)$/.test(entry.name)) {
        const info = await stat(full).catch(() => null)
        if (info) result.push(`${rel}:${info.mtimeMs}:${info.size}`)
      }
    }
  }
  if (directory === root) {
    await visit(join(root, 'cmd'))
    await visit(join(root, 'internal'))
    for (const file of ['go.mod', 'go.sum']) {
      const info = await stat(join(root, file)).catch(() => null)
      if (info) result.push(`${file}:${info.mtimeMs}:${info.size}`)
    }
  } else {
    await visit(directory)
  }
  return result.sort().join('|')
}

async function setupWatchers() {
  try {
    for (const directory of ['cmd', 'internal']) {
      watchers.push(watch(join(root, directory), { recursive: true }, (_, filename) => queueRebuild(filename)))
    }
    watchers.push(watch(root, (_, filename) => {
      if (filename === 'go.mod' || filename === 'go.sum') queueRebuild(filename)
    }))
  } catch {
    for (const watcher of watchers.splice(0)) watcher.close()
    let previous = await sourceSignature(root)
    let checking = false
    pollingTimer = setInterval(async () => {
      if (checking || stopping) return
      checking = true
      try {
        const next = await sourceSignature(root)
        if (next !== previous) {
          previous = next
          queueRebuild('source.go')
        }
      } finally {
        checking = false
      }
    }, 1000)
  }
}

async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  clearTimeout(rebuildTimer)
  clearInterval(pollingTimer)
  for (const watcher of watchers) watcher.close()
  await Promise.all([...children].map(terminate))
  await Promise.all([...binaries].map(file => unlink(file).catch(() => {})))
  process.exit(code)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('uncaughtException', error => {
  console.error(error)
  void shutdown(1)
})
process.on('unhandledRejection', error => {
  console.error(error)
  void shutdown(1)
})

await mkdir(scratch, { recursive: true })
await setupWatchers()
console.log('[echo] Checking Draw.io…')
if (await completed(launch(process.execPath, [join(root, 'scripts/fetch-drawio.mjs')])) !== 0) await shutdown(1)
const vite = launch(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'])
vite.once('close', code => {
  if (!stopping) void shutdown(code ?? 1)
})
console.log('[echo] Open http://127.0.0.1:5173 — Ctrl+C stops both servers.')
await rebuildBackend()
