import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
const require = createRequire(import.meta.url)
const libraryModule = require('../src/library.js')
let library
require.cache[require.resolve('../src/library.js')].exports = helpers => (library = libraryModule(helpers))
const host = require('../src/index.js')
const oldHome = process.env.DSH_HOME
const tmp = await fs.mkdtemp(join(tmpdir(), 'skm-edit-retry-'))
const root = join(tmp, 'skills')
const effects = []
let handler, listener, count = 0, registrySkill
const agent = { id: 'session', session: { id: 'session', header: { cwd: tmp, origin: 'user' } } }
const services = {
  agents: { get: id => id === agent.id ? agent : undefined },
  sessionQuery: { observeSession: async () => ({ [Symbol.dispose]() {} }) },
  skills: { get: async () => registrySkill },
}
host.apply({
  connection: { requestRejection: () => undefined },
  webServer: { register(config) { handler = config.handler; return () => {} } },
  get: name => services[name],
  on(name, fn) { assert.equal(name, 'agent/pre-step'); listener = fn; return () => {} },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
})
require.cache[require.resolve('../src/library.js')].exports = libraryModule
const API = '/dsh-skill-manager/api'
async function call(method, path, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(req, { method, url: API + path, headers: {} })
  const res = { writeHead(status) { this.status = status }, end(text) { this.data = text ? JSON.parse(text) : {} } }
  await handler(req, res)
  return res
}
async function test(label, action) { await action(); count++; console.log('PASS ' + label) }
const fm = (name, body) => `---\nname: ${name}\ndescription: fixture\nuser-invocable: true\n---\n${body}`
const registry = row => ({ name: row.name, path: row.path, resourceBase: { kind: 'directory', path: row.resourceBase }, content: row.content.replace(/^---\r?\n[\s\S]*?^---\r?$(?:\n|$)/m, '').trim(), invocation: { userInvocable: true } })
try {
  process.env.DSH_HOME = tmp
  await fs.mkdir(join(root, 'odd-storage'), { recursive: true })
  await fs.writeFile(join(root, 'odd-storage', 'SKILL.md'), fm('odd', 'old body'))
  await fs.writeFile(join(root, 'odd-storage', 'asset'), Buffer.from([0, 255, 3]))
  await fs.writeFile(join(root, 'flat.md'), fm('flat', 'old flat'))
  await test('edit feeds fresh loadLibrary identity and next-turn activation; stale registry fails closed', async () => {
    const rows = (await library.loadLibrary(root)).skills
    const odd = rows.find(s => s.name === 'odd')
    registrySkill = registry(odd)
    const active = await call('POST', '/activation', { sessionId: 'session', skillIds: [odd.id], expectedRevision: 0 })
    assert.equal(active.status, 200, JSON.stringify(active.data))
    const get = await call('GET', '/library/skills/' + odd.id)
    assert.equal((await call('PATCH', '/library/skills/' + odd.id, { content: 'fresh {{literal}} body', expectedRevision: get.data.revision })).status, 200)
    const updated = (await library.loadLibrary(root)).skills.find(s => s.id === odd.id)
    assert.equal(updated.path, odd.path); assert.equal(updated.resourceBase, odd.resourceBase)
    assert.match(updated.content, /fresh \{\{literal\}\} body/)
    assert.deepEqual(await fs.readFile(join(root, 'odd-storage', 'asset')), Buffer.from([0, 255, 3]))
    const stale = await call('GET', '/activation?sessionId=session')
    assert.equal(stale.status, 200); assert.equal(stale.data.available, false); assert.match(stale.data.reason, /正文已变化/)
    registrySkill = registry(updated)
    const messages = [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] }]
    const decision = await listener({ agent, turn: 1, step: 1, messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    const injected = decision.messages.find(m => m.source.form === 'instructions')
    assert.ok(injected); assert.match(injected.content[0].text, /fresh \{\{literal\}\} body/); assert.ok(injected.content[0].text.includes(updated.resourceBase))
    const flat = rows.find(s => s.name === 'flat')
    const detail = await call('GET', '/library/skills/' + flat.id)
    assert.equal((await call('PATCH', '/library/skills/' + flat.id, { content: 'new flat', expectedRevision: detail.data.revision })).status, 200)
    const fresh = (await library.loadLibrary(root)).skills.find(s => s.id === flat.id)
    assert.equal(fresh.path, join(root, 'flat.md')); assert.equal(fresh.resourceBase, root); assert.match(fresh.content, /new flat/)
  })
  await test('external modification after staging is detected without clobbering it', async () => {
    const flat = (await library.loadLibrary(root)).skills.find(s => s.name === 'flat')
    const get = await call('GET', '/library/skills/' + flat.id)
    const original = fs.writeFile
    try {
      fs.writeFile = async (path, ...args) => {
        const result = await original(path, ...args)
        if (String(path).includes('.library-edit-')) await original(join(root, 'flat.md'), fm('flat', 'external writer'))
        return result
      }
      assert.equal((await call('PATCH', '/library/skills/' + flat.id, { content: 'do not clobber', expectedRevision: get.data.revision })).status, 409)
    } finally { fs.writeFile = original }
    assert.equal(await fs.readFile(join(root, 'flat.md'), 'utf8'), fm('flat', 'external writer'))
    assert.ok(!(await fs.readdir(root)).some(name => /^\.library-(edit|backup)-/.test(name)))
  })
  await test('hardlinked editable targets rejected and link resource bytes untouched', async () => {
    const flat = (await library.loadLibrary(root)).skills.find(s => s.name === 'flat')
    const before = await fs.readFile(join(root, 'flat.md'))
    const link = join(tmp, 'hardlink')
    await fs.link(join(root, 'flat.md'), link)
    const response = await call('GET', '/library/skills/' + flat.id)
    assert.equal(response.status, 400); assert.match(response.data.error, /链接/)
    assert.deepEqual(await fs.readFile(link), before)
    await fs.unlink(link)
  })
  await test('post-commit cleanup failure reports success with precise recoverable warnings', async () => {
    const flat = (await library.loadLibrary(root)).skills.find(s => s.name === 'flat')
    const detail = await call('GET', '/library/skills/' + flat.id)
    const original = fs.rm
    let leftover
    try {
      fs.rm = async (path, ...args) => { if (String(path).includes('.library-backup-')) { leftover = path; throw Object.assign(new Error('cleanup lock'), { code: 'EPERM' }) }; return original(path, ...args) }
      const response = await call('PATCH', '/library/skills/' + flat.id, { content: 'saved despite cleanup', expectedRevision: detail.data.revision })
      assert.equal(response.status, 200); assert.equal(response.data.cleanupWarnings.length, 1)
      assert.ok(response.data.cleanupWarnings[0].includes(leftover))
      assert.match(await fs.readFile(join(root, 'flat.md'), 'utf8'), /saved despite cleanup/)
      assert.ok(await fs.lstat(leftover))
    } finally { fs.rm = original }
    await fs.unlink(leftover)
  })
  await test('failed edit and failed cleanup preserve primary error and report precise leftovers', async () => {
    const flat = (await library.loadLibrary(root)).skills.find(s => s.name === 'flat')
    const detail = await call('GET', '/library/skills/' + flat.id), before = await fs.readFile(join(root, 'flat.md'))
    const rename = fs.rename, remove = fs.rm
    try {
      fs.rename = async (a, b) => { if (String(a).includes('.library-edit-')) throw Object.assign(new Error('primary rename lock'), { code: 'EPERM' }); return rename(a, b) }
      fs.rm = async (path, ...args) => { if (/\.library-(edit|backup)-/.test(String(path))) throw Object.assign(new Error('secondary cleanup lock'), { code: 'EPERM' }); return remove(path, ...args) }
      const response = await call('PATCH', '/library/skills/' + flat.id, { content: 'failed update', expectedRevision: detail.data.revision })
      assert.equal(response.status, 503); assert.match(response.data.error, /primary rename lock/); assert.match(response.data.error, /secondary cleanup lock/)
      assert.deepEqual(await fs.readFile(join(root, 'flat.md')), before)
    } finally { fs.rename = rename; fs.rm = remove }
    for (const name of await fs.readdir(root)) if (/^\.library-(edit|backup)-/.test(name)) await fs.unlink(join(root, name))
  })
  await test('legacy overwrite permanent install and rollback locks retain all original resource backups', async () => {
    const original = fs.rename
    const bytes = await fs.readFile(join(root, 'odd-storage', 'SKILL.md'))
    try {
      fs.rename = async (a, b) => {
        if (String(a).includes('.skm-stage-') || String(a).includes('.skm-backup-')) throw Object.assign(new Error('locked install/restore'), { code: 'EPERM' })
        return original(a, b)
      }
      const response = await call('POST', '/skills/create', { name: 'odd', content: 'replacement', overwrite: true })
      assert.equal(response.status, 503); assert.match(response.data.error, /勿删除备份/); assert.match(response.data.error, /locked install\/restore/)
    } finally { fs.rename = original }
    const backups = (await fs.readdir(root)).filter(name => name.startsWith('.skm-backup-'))
    assert.equal(backups.length, 1)
    const saved = join(root, backups[0], '0')
    assert.deepEqual(await fs.readFile(join(saved, 'SKILL.md')), bytes)
    assert.deepEqual(await fs.readFile(join(saved, 'asset')), Buffer.from([0, 255, 3]))
    await fs.rename(saved, join(root, 'odd-storage'))
    await fs.rmdir(join(root, backups[0]))
  })
  console.log(`EDIT RETRY OK: ${count} groups, isolated temporary DSH_HOME`)
} finally {
  for (const dispose of effects.reverse()) dispose()
  library.dispose()
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  assert.equal(dirname(resolve(tmp)), resolve(tmpdir())); assert.match(tmp, /skm-edit-retry-[^\\/]+$/)
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 4 })
}
