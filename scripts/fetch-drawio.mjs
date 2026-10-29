import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const VERSION = '32.6.1'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dest = join(root, 'third_party', 'drawio')
const marker = join(root, 'third_party', 'drawio.version')
const archive = join(root, 'third_party', `drawio-${VERSION}.tar.gz`)
const source = `https://codeload.github.com/jgraph/drawio/tar.gz/refs/tags/v${VERSION}`

async function alreadyFetched() {
  try {
    const current = (await readFile(marker, 'utf8')).trim()
    await access(join(dest, 'index.html'))
    await access(join(dest, 'js', 'viewer-static.min.js'))
    await access(join(dest, 'js', 'app.min.js'))
    await access(join(dest, 'js', 'PreConfig.js'))
    return current === VERSION
  } catch {
    return false
  }
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk })
    child.stderr?.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(output.trim() || `${command} exited with code ${code}`)))
  })
}

async function download(url, file) {
  let existing = 0
  try { existing = (await stat(file)).size } catch { existing = 0 }
  const headers = { 'User-Agent': 'echo-notes' }
  if (existing > 0) headers.Range = `bytes=${existing}-`
  const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20 * 60 * 1000) })
  const append = response.status === 206 && existing > 0
  if (!append && !response.ok) throw new Error(`Draw.io 下载失败（${response.status}）`)
  if (!response.body) throw new Error('Draw.io 下载没有响应内容')
  if (!append) existing = 0
  const totalHeader = Number(response.headers.get('content-length') || 0)
  const total = append ? existing + totalHeader : totalHeader
  const stream = createWriteStream(file, { flags: append ? 'a' : 'w' })
  const reader = response.body.getReader()
  let received = existing
  let reported = existing
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (!stream.write(value)) await new Promise(resolveDrain => stream.once('drain', resolveDrain))
    if (received - reported >= 8 * 1024 * 1024) {
      reported = received
      const doneText = total ? `${Math.floor(received / 1024 / 1024)}/${Math.floor(total / 1024 / 1024)}` : String(Math.floor(received / 1024 / 1024))
      console.log(`[echo] Downloading Draw.io… ${doneText} MB`)
    }
  }
  await new Promise((resolveEnd, reject) => {
    stream.on('error', reject)
    stream.end(resolveEnd)
  })
}

async function patch(file, addition) {
  const text = await readFile(file, 'utf8')
  if (text.includes('echo-drawio-host')) return
  await writeFile(file, `${text.trimEnd()}\n\n${addition}`)
}

try {
  if (await alreadyFetched()) {
    console.log(`[echo] Draw.io ${VERSION} already present`)
  } else {
    await run('tar', ['--version'])
    console.log(`[echo] Fetching Draw.io ${VERSION}…`)
    await mkdir(join(root, 'third_party'), { recursive: true })
    await download(source, archive)
    const listing = (await run('tar', ['-tzf', archive])).split(/\r?\n/).filter(Boolean)
    const index = listing.find(name => name.replaceAll('\\', '/').endsWith('src/main/webapp/index.html'))
    if (!index) throw new Error('压缩包里没有 src/main/webapp/index.html')
    const webapp = index.replaceAll('\\', '/').slice(0, -'index.html'.length)
    const strip = webapp.split('/').filter(Boolean).length
    await rm(dest, { recursive: true, force: true })
    await mkdir(dest, { recursive: true })
    console.log('[echo] Extracting Draw.io…')
    await run('tar', ['-xzf', archive, '-C', dest, `--strip-components=${strip}`, webapp.replace(/\/$/, '')])
    await rm(join(dest, 'WEB-INF'), { recursive: true, force: true })
    await rm(join(dest, 'META-INF'), { recursive: true, force: true })
    await patch(join(dest, 'js', 'PreConfig.js'), `/* echo-drawio-host */
window.DRAWIO_BASE_URL = window.location.origin + '/drawio';
window.DRAWIO_LIGHTBOX_URL = window.DRAWIO_BASE_URL;
window.DRAWIO_VIEWER_URL = window.DRAWIO_BASE_URL + '/js/viewer-static.min.js';
window.EXPORT_URL = null;
`)
    await patch(join(dest, 'js', 'PostConfig.js'), `/* echo-drawio-host */
window.VSS_CONVERT_URL = null;
`)
    await access(join(dest, 'js', 'viewer-static.min.js'))
    await access(join(dest, 'js', 'app.min.js'))
    await writeFile(marker, `${VERSION}\n`)
    await rm(archive, { force: true })
    console.log(`[echo] Draw.io ${VERSION} ready`)
  }
} catch (error) {
  console.error(`[echo] ${error.message}`)
  process.exitCode = 1
}
