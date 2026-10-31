import { spawn } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontend = join(root, 'internal', 'web', 'dist')

const windowsGui = process.argv.includes('--windows-gui')

function run(command, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited with code ${code}`)))
  })
}

try {
  console.log('[echo] Checking Draw.io…')
  await run(process.execPath, [join(root, 'scripts/fetch-drawio.mjs')])
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
  if (windowsGui) {
    console.log('[echo] Embedding Windows common-controls manifest…')
    await run('go', [
      'run', 'github.com/tc-hib/go-winres@v0.3.3',
      'make',
      '--in', join(root, 'cmd/echo/winres.json'),
      '--out', join(root, 'cmd/echo/rsrc'),
      '--arch', 'amd64,arm64',
    ])
    const executable = join(root, 'dist', 'echo-gui.exe')
    console.log('[echo] Embedding frontend and building Windows GUI…')
    await run('go', ['build', '-trimpath', '-tags', 'gui', '-ldflags', '-w -s -H windowsgui', '-o', executable, './cmd/echo'], { GOOS: 'windows' })
    console.log(`[echo] Built ${executable}`)
  } else {
    const executable = join(root, 'dist', process.platform === 'win32' ? 'echo.exe' : 'echo')
    console.log('[echo] Embedding frontend and building executable…')
    await run('go', ['build', '-trimpath', '-ldflags', '-w -s', '-o', executable, './cmd/echo'])
    console.log(`[echo] Built ${executable}`)
  }
} catch (error) {
  console.error(`[echo] ${error.message}`)
  process.exitCode = 1
}
