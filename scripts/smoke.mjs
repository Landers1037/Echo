import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { unzipSync, strFromU8 } from 'fflate'

const base = (process.env.ECHO_TEST_URL || 'http://127.0.0.1:8080').replace(/\/$/, '')
const prefix = `Echo-Smoke-${Date.now()}-${randomBytes(3).toString('hex')}`
const notePath = `${prefix}/中文测试.md`
const movedPath = `${prefix}/移动后.md`
const group = `${prefix}-分组`
const tag = `${prefix}-标签`
const secondTag = `${prefix}-第二标签`
const renamedTag = `${tag}-改名`
let createdFolder = false
let uploadedPath = ''
let checks = 0

async function call(method, path, body, expected = 200) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    ...(body === undefined ? {} : body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    signal: AbortSignal.timeout(15000),
  })
  if (response.status !== expected) throw new Error(`${method} ${path}: expected ${expected}, got ${response.status}: ${await response.text()}`)
  checks++
  return response
}
async function json(method, path, body, expected) { return (await call(method, path, body, expected)).json() }
const encoded = value => encodeURIComponent(value)

try {
  assert.equal((await json('GET', '/health')).ok, true)
  await json('POST', '/folders', { path: prefix }, 201)
  createdFolder = true
  let note = await json('POST', '/notes', {
    path: notePath,
    content: '---\ncustom:\n  preserve: yes\n---\n# 冒烟测试\n\n- [ ] 可排期任务\n\n```md\n- [ ] 代码示例不应成为任务\n```\n',
  }, 201)
  assert.equal(note.path, notePath)
  const batch = await json('POST', '/notes/batch', { paths: [notePath], tags: [tag, secondTag], group, revisions: { [notePath]: note.revision } })
  note = batch[0]
  assert.deepEqual(note.metadata.tags, [tag, secondTag])
  assert.equal(note.metadata.group, group)
  assert.match(note.content, /preserve: yes/)
  const filtered = await json('GET', `/notes?q=${encoded('可排期任务')}&group=${encoded(group)}&tags=${encoded(`${tag},${secondTag}`)}`)
  assert.deepEqual(filtered.map(item => item.path), [notePath])
  await json('PUT', '/tags', { name: tag, newName: renamedTag })
  note = await json('GET', `/notes?path=${encoded(notePath)}`)
  assert(note.metadata.tags.includes(renamedTag))

  const form = new FormData()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrL8AAAAASUVORK5CYII=', 'base64')
  form.append('file', new Blob([png], { type: 'image/png' }), 'smoke.png')
  const upload = await json('POST', `/assets?notePath=${encoded(notePath)}`, form, 201)
  uploadedPath = upload.path
  assert.match(upload.markdownPath, /^\.\.\//)
  const asset = await call('GET', `/assets?path=${encoded(upload.path)}`)
  assert.equal(Buffer.compare(Buffer.from(await asset.arrayBuffer()), png), 0)
  const staleRevision = note.revision
  note = await json('PUT', '/notes', { path: notePath, content: `${note.content}\n![测试图片](${upload.markdownPath})\n`, revision: note.revision })
  const conflict = await json('PUT', '/notes', { path: notePath, content: '# 不应覆盖', revision: staleRevision }, 409)
  assert.equal(conflict.current.revision, note.revision)
  const tasks = (await json('GET', '/tasks')).filter(task => task.notePath === notePath)
  assert.equal(tasks.length, 1)
  note = await json('PUT', '/tasks', { notePath, id: tasks[0].id, line: tasks[0].line, revision: note.revision, status: 'doing', due: '2020-01-01T09:00:00Z', remindAt: '2020-01-01T08:55:00Z', repeat: 'none', timezone: 'UTC' })
  assert.equal(note.path, notePath)
  assert.match(note.content, /"status":"doing"/)
  assert.match(note.content, /echo-task:/)
  const updatedTask = (await json('GET', '/tasks')).find(task => task.id === tasks[0].id)
  assert.equal(updatedTask.status, 'doing')
  const reminder = (await json('GET', '/reminders')).find(item => item.taskId === tasks[0].id)
  assert(reminder, 'due task has a persisted reminder')
  assert.equal((await json('POST', '/reminders/ack', { id: reminder.id })).claimed, true)
  assert.equal((await json('POST', '/reminders/ack', { id: reminder.id })).claimed, false)

  const snapshot = await json('POST', '/exports', { paths: [notePath], format: 'snapshot' })
  assert.equal(snapshot.notes.length, 1)
  assert.equal(snapshot.notes[0].content, note.content)
  assert.match(snapshot.notes[0].assets[upload.markdownPath], /^data:image\/png;base64,/)
  assert.deepEqual(snapshot.missing, [])
  assert.equal(await (await call('POST', '/exports', { paths: [notePath], format: 'md' })).text(), note.content)
  const bundleResponse = await call('POST', '/exports', { paths: [notePath], format: 'bundle' })
  const bundle = unzipSync(new Uint8Array(await bundleResponse.arrayBuffer()))
  assert(bundle[notePath])
  const bundledImage = Object.keys(bundle).find(name => name.startsWith('.assets/'))
  assert(bundledImage)
  assert(Buffer.from(bundle[bundledImage]).equals(png))
  assert(strFromU8(bundle[notePath]).includes(`../${bundledImage}`))

  note = await json('POST', '/notes/move', { path: notePath, target: movedPath, revision: note.revision })
  assert.equal(note.path, movedPath)
  await json('DELETE', `/notes?path=${encoded(movedPath)}`)
  const trashed = (await json('GET', '/trash')).find(item => item.path === movedPath)
  assert(trashed)
  await json('POST', '/trash/restore', { id: trashed.id })
  assert.equal((await json('GET', `/notes?path=${encoded(movedPath)}`)).content, note.content)
  console.log(`Echo API smoke passed: ${checks} requests; CRUD, metadata, image upload, task/reminder, exports, conflicts and trash restore.`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  // Only mutate the unique fixture names created by this run. Recycle the folder;
  // a disposable --data-dir can be removed by the calling test harness afterward.
  for (const [kind, name] of [['groups', group], ['tags', tag], ['tags', secondTag], ['tags', renamedTag]]) {
    await json('DELETE', `/${kind}?name=${encoded(name)}`).catch(error => console.warn(`Fixture cleanup: ${error.message}`))
  }
  if (createdFolder) await json('DELETE', `/folders?path=${encoded(prefix)}`).catch(error => console.warn(`Fixture cleanup: ${error.message}`))
  if (uploadedPath) console.log(`Fixture resources retained in the test library: ${uploadedPath}; fixture folder is in its recycle bin.`)
}
