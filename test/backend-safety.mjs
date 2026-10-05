import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, dirname, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
const require = createRequire(import.meta.url)
const host = require('../src/index.js')
const oldHome = process.env.DSH_HOME
const temp = await fs.mkdtemp(join(tmpdir(), 'skm-backend-safety-'))
const root = join(temp, 'skills')
let handler, groups = 0
const effects = []
host.apply({ connection: { requestRejection: () => undefined }, webServer: { register(config) { handler = config.handler; return () => {} } }, effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d) } })
const API = '/dsh-skill-manager/api'
async function call(method, path, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(req, { method, url: API + path, headers: {} })
  const res = { writeHead(status) { this.status = status }, end(text) { this.data = text ? JSON.parse(text) : {} } }
  await handler(req, res); return res
}
const fm = name => `---\nname: ${name}\ndescription: fixture\n---\nbody`
const file = (path, text) => ({ path, content: Buffer.from(text).toString('base64'), encoding: 'base64' })
async function importFiles(name, extra = []) {
  const p = await call('POST', '/import/preview', { files: [file('SKILL.md', fm(name)), ...extra] })
  assert.equal(p.status, 200, JSON.stringify(p.data))
  return () => call('POST', '/import/commit', { token: p.data.token, displayName: name })
}
async function test(name, action) { await action(); groups++; console.log('PASS ' + name) }
async function snapshot(base) {
  const out = new Map()
  async function walk(path) {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name), stat = await fs.lstat(child)
      assert.ok(!stat.isSymbolicLink())
      if (stat.isDirectory()) await walk(child)
      else { assert.ok(stat.isFile()); out.set(relative(base, child).replaceAll('\\', '/'), await fs.readFile(child)) }
    }
  }
  await walk(base); return out
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  process.env.DSH_HOME = temp
  await test('runtime handshake captured version/capabilities and real document identity', async () => {
    const list = await call('GET', '/library')
    assert.equal(list.data.runtime.apiVersion, 2); assert.equal(list.data.runtime.capabilities.sha256CAS, true)
    const commit = await importFiles('diagnostic'); const r = await commit(); assert.equal(r.status, 200)
    const get = await call('GET', '/library/skills/' + r.data.skills[0].id)
    assert.equal(get.data.document.path, join(root, 'diagnostic', 'SKILL.md')); assert.equal(get.data.document.sha256, get.data.revision)
    assert.ok(get.data.document.identity.ino)
  })
  await test('exclusive reserve collision preserves external target and never merges it', async () => {
    const commit = await importFiles('collision')
    const mkdir = fs.mkdir
    try {
      fs.mkdir = async (path, ...args) => { if (path === join(root, 'collision') && !args.length) { await mkdir(path); await fs.writeFile(join(path, 'foreign'), 'external'); } return mkdir(path, ...args) }
      const r = await commit(); assert.equal(r.status, 409); assert.equal(r.data.diagnostic.operation, 'reserve-new-directory')
    } finally { fs.mkdir = mkdir }
    assert.equal(await fs.readFile(join(root, 'collision', 'foreign'), 'utf8'), 'external')
    await assert.rejects(fs.stat(join(root, 'collision', 'SKILL.md')), { code: 'ENOENT' })
  })
  await test('pending crash directory hidden until committed metadata; no automatic stale lock deletion', async () => {
    await fs.mkdir(join(root, 'crashed'))
    await fs.writeFile(join(root, 'crashed', '.library-pending.json'), '{}')
    await fs.writeFile(join(root, 'crashed', 'SKILL.md'), fm('crashed'))
    assert.ok(!(await call('GET', '/library')).data.skills.some(s => s.name === 'crashed'))
    const lock = join(root, '.library-mutation.lock'); await fs.writeFile(lock, '{"pid":1}')
    const r = await call('GET', '/library'); assert.equal(r.status, 409); assert.equal(r.data.diagnostic.operation, 'acquire-library-lock')
    assert.equal(await fs.readFile(lock, 'utf8'), '{"pid":1}'); await fs.unlink(lock)
  })
  await test('all resources prepared before SKILL publication; metadata failure withdraws new invocation', async () => {
    const p = await call('POST', '/import/preview', { files: [file('a/SKILL.md', fm('publish-a')), file('a/bin', 'a'), file('b/SKILL.md', fm('publish-b')), file('b/bin', 'b')] })
    const write = fs.writeFile, rename = fs.rename
    let published = 0
    try {
      fs.writeFile = async (path, ...args) => { if (/publish-[ab][\\/]SKILL.md$/.test(path)) { published++; assert.equal(await fs.readFile(join(root, 'publish-a', 'bin'), 'utf8'), 'a'); assert.equal(await fs.readFile(join(root, 'publish-b', 'bin'), 'utf8'), 'b') }; return write(path, ...args) }
      fs.rename = async (a, b) => { if (b === join(root, '.skill-library.json')) throw Object.assign(new Error('metadata failure'), { code: 'EIO' }); return rename(a, b) }
      const r = await call('POST', '/import/commit', { token: p.data.token, displayName: 'batch' }); assert.equal(r.status, 503); assert.equal(published, 2)
    } finally { fs.writeFile = write; fs.rename = rename }
    for (const name of ['publish-a', 'publish-b']) await assert.rejects(fs.stat(join(root, name)), { code: 'ENOENT' })
  })
  await test('directory replacement detected; rollback never deletes foreign replacement', async () => {
    const commit = await importFiles('replaced', [file('asset', 'data')]), write = fs.writeFile
    const moved = join(temp, 'our-displaced-directory')
    try {
      fs.writeFile = async (path, ...args) => {
        const r = await write(path, ...args)
        if (path === join(root, 'replaced', '.library-pending.json')) { await fs.rename(join(root, 'replaced'), moved); await fs.mkdir(join(root, 'replaced')); await write(join(root, 'replaced', 'foreign'), 'keep') }
        return r
      }
      const r = await commit(); assert.equal(r.status, 503); assert.match(r.data.error, /身份已改变/)
    } finally { fs.writeFile = write }
    assert.equal(await fs.readFile(join(root, 'replaced', 'foreign'), 'utf8'), 'keep')
    await assert.rejects(fs.stat(join(root, 'replaced', 'asset')), { code: 'ENOENT' })
  })
  await test('concurrent same-name imports allocate independent IDs/names under root queue', async () => {
    const a = await importFiles('parallel'), b = await importFiles('parallel')
    const results = await Promise.all([a(), b()]); assert.deepEqual(results.map(r => r.status), [200, 200])
    assert.notEqual(results[0].data.skills[0].id, results[1].data.skills[0].id)
    assert.notEqual(results[0].data.skills[0].name, results[1].data.skills[0].name)
  })
  await test('committed pending marker cleanup failure keeps stable metadata and visibility', async () => {
    const commit = await importFiles('pending-cleanup'), unlink = fs.unlink
    let result
    try {
      fs.unlink = async (path, ...args) => { if (path === join(root, 'pending-cleanup', '.library-pending.json')) throw Object.assign(new Error('marker lock'), { code: 'EPERM' }); return unlink(path, ...args) }
      result = await commit(); assert.equal(result.status, 200); assert.equal(result.data.cleanupWarnings.length, 1)
    } finally { fs.unlink = unlink }
    const list = await call('GET', '/library'); assert.equal(list.data.skills.find(s => s.name === 'pending-cleanup').id, result.data.skills[0].id)
    await fs.unlink(join(root, 'pending-cleanup', '.library-pending.json'))
  })
  await test('junction resource destination is rejected without changing external resources', async () => {
    const commit = await importFiles('link-race', [file('dir/asset', 'new')]), mkdir = fs.mkdir
    const outside = join(temp, 'outside'); await mkdir(outside)
    await fs.writeFile(join(outside, 'asset'), 'keep')
    try {
      fs.mkdir = async (path, ...args) => { if (path === join(root, 'link-race', 'dir')) { await fs.symlink(outside, path, 'junction'); return }; return mkdir(path, ...args) }
      const r = await commit(); assert.equal(r.status, 400); assert.match(r.data.error, /junction/)
    } finally { fs.mkdir = mkdir }
    assert.equal(await fs.readFile(join(outside, 'asset'), 'utf8'), 'keep')
  })
  await test('legacy NEW import also avoids stage rename, overwrite still requires atomic replacement', async () => {
    const rename = fs.rename
    try {
      fs.rename = async (a, b) => { if (String(a).includes('.skm-stage-')) throw Object.assign(new Error('stage lock'), { code: 'EPERM' }); return rename(a, b) }
      const r = await call('POST', '/skills/create', { name: 'legacy-new', content: 'body' }); assert.equal(r.status, 200)
    } finally { fs.rename = rename }
  })
  await test('permanent atomic edit lock remains transparent and leaves exact prior bytes', async () => {
    const skill = (await call('GET', '/library')).data.skills.find(s => s.name === 'diagnostic')
    const detail = await call('GET', '/library/skills/' + skill.id), rename = fs.rename
    const before = await fs.readFile(detail.data.document.path)
    try {
      fs.rename = async (a, b) => { if (String(a).includes('.library-edit-')) throw Object.assign(new Error('persistent edit lock'), { code: 'EPERM' }); return rename(a, b) }
      const r = await call('PATCH', '/library/skills/' + skill.id, { content: 'new', expectedRevision: detail.data.revision })
      assert.equal(r.status, 503); assert.equal(r.data.diagnostic.code, 'EPERM'); assert.equal(r.data.diagnostic.operation, 'atomic-rename'); assert.equal(r.data.diagnostic.target, detail.data.document.path)
    } finally { fs.rename = rename }
    assert.deepEqual(await fs.readFile(detail.data.document.path), before)
  })
  if (process.env.SKM_REAL_SAMPLE) await test('real 13-skill copy imports full resources; duplicate import independent; real edit copy preserves identity/CAS', async () => {
    const source = resolve(process.env.SKM_REAL_SAMPLE), original = await snapshot(source), copied = join(temp, 'copied-input')
    // Byte copy only: source ACL/delete restrictions are intentionally not cloned.
    for (const [path, bytes] of original) { await fs.mkdir(dirname(join(copied, path)), { recursive: true }); await fs.writeFile(join(copied, path), bytes, { flag: 'wx' }) }
    const rename = fs.rename
    const beforeMetadata = (await call('GET', '/library')).data
    let r
    try {
      fs.rename = async (a, b) => { if (String(a).includes('.library-stage-')) throw Object.assign(new Error('persistent real-sample stage lock'), { code: 'EPERM' }); return rename(a, b) }
      const p = await call('POST', '/import/preview', { path: copied }); assert.equal(p.status, 200, JSON.stringify(p.data)); assert.equal(p.data.skills.length, 13)
      r = await call('POST', '/import/commit', { token: p.data.token, displayName: '真实集合' }); assert.equal(r.status, 200, JSON.stringify(r.data))
    } finally { fs.rename = rename }
    for (const [path, bytes] of original) assert.equal(digest(await fs.readFile(join(root, path))), digest(bytes), path)
    const list = (await call('GET', '/library')).data
    assert.equal(r.data.collection.skillIds.length, 13)
    for (const s of beforeMetadata.skills) assert.equal(list.skills.find(x => x.id === s.id).name, s.name)
    const p2 = await call('POST', '/import/preview', { path: copied })
    const second = await call('POST', '/import/commit', { token: p2.data.token, displayName: '独立副本' }); assert.equal(second.status, 200)
    for (const s of second.data.skills) { assert.ok(!r.data.skills.some(x => x.id === s.id || x.name === s.name)); assert.match(await fs.readFile(join(root, s.name, 'SKILL.md'), 'utf8'), new RegExp('name: ' + s.name)) }
    for (const [path, bytes] of original) assert.equal(digest(await fs.readFile(join(root, path))), digest(bytes), path)
    const realEdit = resolve(process.env.SKM_REAL_EDIT)
    const editBytes = await fs.readFile(realEdit), editName = 'real-edit-storage'
    await fs.mkdir(join(root, editName)); await fs.writeFile(join(root, editName, 'SKILL.md'), editBytes)
    const adopted = (await call('GET', '/library')).data.skills.find(s => s.name === 'test')
    const get = await call('GET', '/library/skills/' + adopted.id)
    assert.equal(get.data.skill.content, editBytes.toString('utf8'))
    const patch = await call('PATCH', '/library/skills/' + adopted.id, { content: get.data.skill.content + '\n临时回归正文\n', expectedRevision: get.data.revision })
    assert.equal(patch.status, 200); assert.equal(patch.data.skill.id, adopted.id); assert.equal(patch.data.skill.name, 'test')
    assert.equal((await call('PATCH', '/library/skills/' + adopted.id, { content: 'stale', expectedRevision: get.data.revision })).status, 409)
    assert.deepEqual(await fs.readFile(realEdit), editBytes)
    const after = await snapshot(source); assert.equal(after.size, original.size); for (const [path, bytes] of original) assert.deepEqual(after.get(path), bytes)
    console.log(`REAL SAMPLE: ${original.size} files, 13 skills, SHA-256 unchanged; real source/edit untouched`)
  })
  console.log(`BACKEND SAFETY OK: ${groups} groups, temp root only`)
} finally {
  for (const dispose of effects.reverse()) dispose()
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.match(temp, /skm-backend-safety-[^\\/]+$/)
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 4 })
}
