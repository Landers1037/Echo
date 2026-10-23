import { spawn } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontend = join(root, 'internal', 'web', 'dist')

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with code ${code}`)))
  })
}

try {
  console.log('[echo] Checking TypeScript…')
  await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'])
  await mkdir(frontend, { recursive: true })
  // Keep the tracked embed placeholder; remove stale generated chunks only inside dist.
  for (const entry of await readdir(frontend)) {
    if (entry === '.placeholder') continue
    const target = resolve(frontend, entry)
    if (dirname(target) !== frontend) throw new Error('Unexpected build output path')
    await rm(target, { force: true, recursive: true })
  }
  console.log('[echo] Building frontend…')
  await run(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'])
  await mkdir(join(root, 'dist'), { recursive: true })
  const executable = join(root, 'dist', process.platform === 'win32' ? 'echo.exe' : 'echo')
  console.log('[echo] Embedding frontend and building executable…')
  await run('go', ['build', '-trimpath', '-o', executable, './cmd/echo'])
  console.log(`[echo] Built ${executable}`)
} catch (error) {
  console.error(`[echo] ${error.message}`)
  process.exitCode = 1
}
