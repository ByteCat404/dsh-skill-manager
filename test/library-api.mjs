import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { join, resolve, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
const require = createRequire(import.meta.url)
const host = require('../src/index.js')
const API = '/dsh-skill-manager/api'
const oldHome = process.env.DSH_HOME
const tmp = await fs.mkdtemp(join(tmpdir(), 'skm-library-test-'))
const root = join(tmp, 'skills')
let handler, gate = () => undefined, passed = 0
host.apply({ connection: { requestRejection: req => gate(req) }, webServer: { register: config => { handler = config.handler } }, effect: fn => fn() })
const fm = (name, body = 'instructions') => `---\nname: ${name}\ndescription: test\n---\n${body}`
const file = (path, content) => ({ path, content: (Buffer.isBuffer(content) ? content : Buffer.from(content)).toString('base64'), encoding: 'base64' })
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})
function zip(files) {
  const locals = [], central = []; let offset = 0
  for (const [name, value] of files) {
    const path = Buffer.from(name), data = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let crc = 0xffffffff
    for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
    crc = (crc ^ 0xffffffff) >>> 0
    const local = Buffer.alloc(30), c = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26)
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(path.length, 28); c.writeUInt32LE(offset, 42)
    locals.push(local, path, data); central.push(c, path); offset += local.length + path.length + data.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end]).toString('base64')
}
async function call(method, path, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(req, { method, url: API + path, headers })
  const res = { status: 0, text: '', writeHead(code) { this.status = code }, end(text) { this.text = text || '' } }
  await handler(req, res)
  return { code: res.status, data: res.text ? JSON.parse(res.text) : {} }
}
async function test(name, action) { await action(); passed++; console.log('PASS ' + name) }
const preview = (body, headers) => call('POST', '/import/preview', body, headers)
const commit = (p, displayName, extra = {}, headers) => call('POST', '/import/commit', { token: p.data.token, displayName, ...extra }, headers)
const library = () => call('GET', '/library')
let skill, collection
try {
  process.env.DSH_HOME = tmp
  await test('create in completely absent skill root succeeds', async () => {
    const r = await call('POST', '/library/create', { displayName: '首个技能', description: 'test', content: '# body' })
    assert.equal(r.code, 200)
    assert.equal((await call('DELETE', '/library/skills/' + r.data.skill.id)).code, 200)
  })
  await test('adopt existing odd-storage/flat skills without changing any bytes; persist stable IDs', async () => {
    await fs.mkdir(join(root, 'odd-storage'), { recursive: true })
    await fs.writeFile(join(root, 'odd-storage', 'SKILL.md'), fm('existing'))
    await fs.writeFile(join(root, 'odd-storage', 'asset.bin'), Buffer.from([0, 255]))
    await fs.writeFile(join(root, 'flat.md'), fm('flat'))
    const a = await library(), b = await library()
    assert.equal(a.code, 200); assert.equal(a.data.skills.length, 2); assert.deepEqual(a.data, b.data)
    assert.deepEqual(await fs.readFile(join(root, 'odd-storage', 'asset.bin')), Buffer.from([0, 255]))
    assert.equal(await fs.readFile(join(root, 'flat.md'), 'utf8'), fm('flat'))
    assert.equal(JSON.parse(await fs.readFile(join(root, '.skill-library.json'), 'utf8')).version, 1)
  })
  await test('Chinese create and metadata-only rename keep stable host name/resource bytes', async () => {
    const r = await call('POST', '/library/create', { displayName: '中文技能', description: '中文说明', content: '# 正文' })
    assert.equal(r.code, 200); skill = r.data.skill
    assert.equal(skill.displayName, '中文技能'); assert.match(skill.name, /^skill-/)
    await fs.writeFile(join(root, skill.name, 'asset'), 'keep')
    const before = await fs.readFile(join(root, skill.name, 'SKILL.md'))
    const changed = await call('PATCH', '/library/skills/' + skill.id, { displayName: '重命名中文' })
    assert.equal(changed.code, 200); assert.equal(changed.data.skill.name, skill.name); assert.equal(changed.data.skill.id, skill.id)
    assert.deepEqual(await fs.readFile(join(root, skill.name, 'SKILL.md')), before)
    assert.equal(await fs.readFile(join(root, skill.name, 'asset'), 'utf8'), 'keep')
    assert.equal((await call('GET', '/skills/' + skill.name)).code, 200)
  })
  await test('multiple collections support shared membership and rename/remove collection leaves skill', async () => {
    const a = await call('POST', '/collections', { displayName: '集合一', skillIds: [skill.id, skill.id] })
    const b = await call('POST', '/collections', { displayName: '集合二', skillIds: [skill.id] })
    assert.equal(a.code, 200); assert.equal(b.code, 200); collection = a.data.collection
    assert.deepEqual(collection.skillIds, [skill.id])
    assert.equal((await call('PATCH', '/collections/' + collection.id, { displayName: '修改', skillIds: [] })).code, 200)
    assert.equal((await call('PATCH', '/collections/' + collection.id, { skillIds: ['absent'] })).code, 400)
    assert.equal((await call('DELETE', '/collections/' + collection.id)).code, 200)
    assert.ok((await library()).data.skills.some(s => s.id === skill.id))
  })
  await test('recursive uploaded multi-skill preview→names→commit copies binary resources independently', async () => {
    const p = await preview({ sourceName: '技能包', files: [file('pack/one/SKILL.md', fm('one')), file('pack/one/scripts/run.js', 'run'), file('pack/two/SKILL.md', fm('two')), file('pack/two/data.bin', Buffer.from([1, 0, 255]))] })
    assert.equal(p.code, 200); assert.equal(p.data.kind, 'collection'); assert.equal(p.data.skills.length, 2)
    assert.ok(!(await library()).data.skills.some(s => s.name === 'one'))
    const r = await commit(p, '导入集合', { names: { [p.data.skills[0].candidateId]: '第一个', [p.data.skills[1].candidateId]: '第二个' } })
    assert.equal(r.code, 200); assert.equal(r.data.skills[0].displayName, '第一个'); assert.equal(r.data.collection.displayName, '导入集合')
    assert.equal(await fs.readFile(join(root, 'one', 'scripts', 'run.js'), 'utf8'), 'run')
    assert.deepEqual(await fs.readFile(join(root, 'two', 'data.bin')), Buffer.from([1, 0, 255]))
    await assert.rejects(fs.stat(join(root, 'one', 'data.bin')), { code: 'ENOENT' })
    assert.equal((await commit(p, 'replay')).code, 403)
  })
  await test('same frontmatter names create independent copies without overwriting existing resources', async () => {
    const p = await preview({ files: [file('a/SKILL.md', fm('one')), file('b/SKILL.md', fm('one')), file('b/asset', 'b')] })
    const r = await commit(p, '重复包')
    assert.equal(r.code, 200); assert.notEqual(r.data.skills[0].name, r.data.skills[1].name)
    assert.notEqual(r.data.skills[0].name, 'one')
    assert.equal(await fs.readFile(join(root, 'one', 'scripts', 'run.js'), 'utf8'), 'run')
    for (const s of r.data.skills) assert.match(await fs.readFile(join(root, s.name, 'SKILL.md'), 'utf8'), new RegExp('name: ' + s.name))
  })
  await test('outside repository documentation is explicitly warned, never silently copied into a skill', async () => {
    const p = await preview({ files: [file('repo/README.md', 'docs'), file('repo/LICENSE', 'license'), file('repo/.gitignore', 'ignore'), file('repo/a/SKILL.md', fm('repo-a')), file('repo/b/SKILL.md', fm('repo-b'))] })
    assert.equal(p.code, 200); assert.equal(p.data.warnings.length, 3)
    assert.equal((await commit(p, '仓库')).code, 200)
    await assert.rejects(fs.stat(join(root, 'repo-a', 'README.md')), { code: 'ENOENT' })
    const single = await preview({ files: [file('README.md', 'docs'), file('wrapper/SKILL.md', fm('wrapper')), file('wrapper/README.md', 'skill docs')] })
    assert.equal(single.code, 200); assert.equal(single.data.warnings.length, 1)
    assert.equal((await commit(single, '独立')).code, 200)
    assert.equal(await fs.readFile(join(root, 'wrapper', 'README.md'), 'utf8'), 'skill docs')
  })
  await test('parent-child skills, unowned assets and unsafe uploaded paths rejected before commit', async () => {
    assert.equal((await preview({ files: [file('SKILL.md', fm('parent')), file('child/SKILL.md', fm('child'))] })).code, 400)
    assert.equal((await preview({ files: [file('a/SKILL.md', fm('a')), file('b/SKILL.md', fm('b')), file('shared', 'x')] })).code, 400)
    for (const path of ['../evil', 'x:ads', 'CON.txt', 'a\\b', '/absolute', 'a/../b', 'x.', 'a//b']) assert.equal((await preview({ files: [file('SKILL.md', fm('x')), file(path, 'x')] })).code, 400)
    assert.equal((await preview({ files: [file('SKILL.md', fm('x')), file('A', 'a'), file('a', 'b')] })).code, 400)
    assert.equal((await preview({ files: [file('SKILL.md', fm('x')), file('a', 'a'), file('a/b', 'b')] })).code, 400)
    assert.equal((await preview({ files: [file('SKILL.md', fm('x')), { path: 'bad', content: '!!!', encoding: 'base64' }] })).code, 400)
    assert.equal((await preview({ files: [file('skill.md', fm('x'))] })).code, 400)
    assert.equal((await preview({ files: [file('SKILL.md', fm('x'))], path: tmp })).code, 400)
  })
  await test('recursive path preview copies full skill bundle and rejects links/target ancestors', async () => {
    const source = join(tmp, 'external')
    await fs.mkdir(join(source, 'pack', 'scripts'), { recursive: true })
    await fs.writeFile(join(source, 'pack', 'SKILL.md'), fm('local'))
    await fs.writeFile(join(source, 'pack', 'scripts', 'run'), 'local-asset')
    const p = await preview({ path: source }); assert.equal(p.code, 200); assert.equal(p.data.kind, 'skill')
    assert.equal((await commit(p, '本地技能')).code, 200)
    assert.equal(await fs.readFile(join(root, 'local', 'scripts', 'run'), 'utf8'), 'local-asset')
    assert.equal((await preview({ path: tmp })).code, 400); assert.equal((await preview({ path: root })).code, 400)
    const outside = join(tmp, 'outside'); await fs.mkdir(outside)
    await fs.symlink(outside, join(source, 'link'), 'junction')
    assert.equal((await preview({ path: source })).code, 400)
  })
  await test('preview capabilities bind auth scope, single use, expiry and root epoch', async () => {
    const p = await preview({ fileName: 'simple.md', content: '# body' }, { authorization: 'identity-a' })
    assert.equal(p.code, 200)
    assert.equal((await commit(p, 'wrong', {}, { authorization: 'identity-b' })).code, 403)
    assert.equal((await commit(p, 'right', {}, { authorization: 'identity-a' })).code, 200)
    const expired = await preview({ fileName: 'expiry.md', content: 'body' })
    const original = Date.now
    try { Date.now = () => original() + 11 * 60 * 1000; assert.equal((await commit(expired, 'expired')).code, 403) } finally { Date.now = original }
    const changed = await preview({ fileName: 'epoch.md', content: 'body' })
    process.env.DSH_HOME = join(tmp, 'other-home'); assert.equal((await library()).code, 200)
    process.env.DSH_HOME = tmp; assert.equal((await commit(changed, 'changed')).code, 403)
    const single = await preview({ fileName: 'concurrent.md', content: 'body' })
    const r = await Promise.all([commit(single, 'one'), commit(single, 'two')]); assert.deepEqual(r.map(x => x.code).sort(), [200, 403])
  })
  await test('batch failure rolls back every installed bundle, preserves previous metadata and consumes token', async () => {
    const before = await fs.readFile(join(root, '.skill-library.json'))
    const p = await preview({ files: [file('a/SKILL.md', fm('rollback-one')), file('b/SKILL.md', fm('rollback-two'))] })
    const original = fs.rename
    try {
      fs.rename = async (a, b) => { if (b === join(root, '.skill-library.json')) throw Object.assign(new Error('injected atomic save failure'), { code: 'EIO' }); return original(a, b) }
      assert.equal((await commit(p, '回滚')).code, 503)
    } finally { fs.rename = original }
    for (const name of ['rollback-one', 'rollback-two']) await assert.rejects(fs.stat(join(root, name)), { code: 'ENOENT' })
    assert.deepEqual(await fs.readFile(join(root, '.skill-library.json')), before)
    assert.equal((await commit(p, 'retry')).code, 403)
    assert.ok(!(await fs.readdir(root)).some(p => p.startsWith('.library-stage-') || p.startsWith('.library-write-')))
  })
  await test('delete skill removes references from all collections; save failure restores resources', async () => {
    const r = await call('POST', '/collections', { displayName: '删除验证', skillIds: [skill.id] }); assert.equal(r.code, 200)
    const original = fs.rename
    try {
      fs.rename = async (a, b) => { if (b === join(root, '.skill-library.json')) throw new Error('injected delete failure'); return original(a, b) }
      assert.equal((await call('DELETE', '/library/skills/' + skill.id)).code, 400)
    } finally { fs.rename = original }
    assert.equal(await fs.readFile(join(root, skill.name, 'asset'), 'utf8'), 'keep')
    assert.equal((await call('DELETE', '/library/skills/' + skill.id)).code, 200)
    const state = (await library()).data
    assert.ok(state.collections.every(c => !c.skillIds.includes(skill.id)))
    assert.equal((await call('DELETE', '/library/skills/' + skill.id)).code, 404)
  })
  await test('GET/edit raw and body Markdown preserve odd/flat storage, resources, IDs and collection membership', async () => {
    for (const [name, path] of [['existing', join(root, 'odd-storage', 'SKILL.md')], ['flat', join(root, 'flat.md')]]) {
      const s = (await library()).data.skills.find(s => s.name === name)
      const c = await call('POST', '/collections', { displayName: '编辑归属', skillIds: [s.id] })
      const meta = await fs.readFile(join(root, '.skill-library.json'))
      const get = await call('GET', '/library/skills/' + s.id)
      assert.equal(get.code, 200); assert.equal(get.data.skill.content, await fs.readFile(path, 'utf8'))
      assert.equal(get.data.revision, createHash('sha256').update(await fs.readFile(path)).digest('hex'))
      assert.equal(get.data.skill.revision, get.data.revision)
      const edit = await call('PATCH', '/library/skills/' + s.id, { content: '# 新正文', expectedRevision: get.data.revision })
      assert.equal(edit.code, 200, JSON.stringify(edit)); assert.equal(edit.data.skill.name, name); assert.equal(edit.data.skill.id, s.id)
      assert.equal(edit.data.skill.content, fm(name, '# 新正文'))
      assert.equal(await fs.readFile(path, 'utf8'), edit.data.skill.content)
      assert.deepEqual(await fs.readFile(join(root, '.skill-library.json')), meta)
      assert.deepEqual((await library()).data.collections.find(x => x.id === c.data.collection.id).skillIds, [s.id])
      const raw = `---\nname: ${name}\ndescription: edited\nuser-invocable: false\n---\nraw body\n`
      assert.equal((await call('PATCH', '/library/skills/' + s.id, { content: raw, expectedRevision: edit.data.revision })).code, 200)
      assert.equal(await fs.readFile(path, 'utf8'), raw)
    }
    assert.deepEqual(await fs.readFile(join(root, 'odd-storage', 'asset.bin')), Buffer.from([0, 255]))
  })
  await test('strict edit validation, stale/concurrent CAS and unknown identities are fail closed', async () => {
    const s = (await library()).data.skills.find(s => s.name === 'flat'), url = '/library/skills/' + s.id
    const get = (await call('GET', url)).data
    const before = await fs.readFile(join(root, 'flat.md'))
    for (const body of [{ content: 'x' }, { content: 'x', expectedRevision: 'bad' }, { content: '', expectedRevision: get.revision }, { content: fm('renamed'), expectedRevision: get.revision }, { content: '---\nname: flat\ndescription: test\nuser-invocable: invalid\n---\nx', expectedRevision: get.revision }, { content: '---\nname: flat\n---\nx', expectedRevision: get.revision }, { displayName: 'x', name: 'renamed' }, { expectedRevision: get.revision }]) assert.equal((await call('PATCH', url, body)).code, 400)
    assert.equal((await call('PATCH', url, { content: 'x', expectedRevision: '0'.repeat(64) })).code, 409)
    assert.deepEqual(await fs.readFile(join(root, 'flat.md')), before)
    const results = await Promise.all(['first', 'second'].map(content => call('PATCH', url, { content, expectedRevision: get.revision })))
    assert.deepEqual(results.map(r => r.code).sort(), [200, 409])
    assert.equal((await call('GET', '/library/skills/unknown')).code, 404)
  })
  await test('transient edit rename retries; permanent rename and metadata save failure restore original bytes', async () => {
    const s = (await library()).data.skills.find(s => s.name === 'flat'), url = '/library/skills/' + s.id, path = join(root, 'flat.md')
    const original = fs.rename
    let detail = (await call('GET', url)).data, attempts = 0
    try {
      fs.rename = async (a, b) => { if (b === path && a.includes('.library-edit-') && ++attempts < 3) throw Object.assign(new Error('scanner lock'), { code: 'EPERM' }); return original(a, b) }
      assert.equal((await call('PATCH', url, { content: 'retry body', expectedRevision: detail.revision })).code, 200)
      assert.equal(attempts, 3)
    } finally { fs.rename = original }
    detail = (await call('GET', url)).data
    const bytes = await fs.readFile(path), metadata = await fs.readFile(join(root, '.skill-library.json'))
    for (const mode of ['target', 'metadata']) {
      attempts = 0
      try {
        fs.rename = async (a, b) => { if ((mode === 'target' && b === path && a.includes('.library-edit-')) || (mode === 'metadata' && b === join(root, '.skill-library.json'))) { attempts++; throw Object.assign(new Error('permanent lock'), { code: 'EBUSY' }) }; return original(a, b) }
        const r = await call('PATCH', url, { content: 'must rollback', expectedRevision: detail.revision, displayName: 'changed' })
        assert.equal(r.code, 503); assert.match(r.data.error, /关闭.*权限/); assert.equal(attempts, 5)
      } finally { fs.rename = original }
      assert.deepEqual(await fs.readFile(path), bytes); assert.deepEqual(await fs.readFile(join(root, '.skill-library.json')), metadata)
    }
    assert.ok(!(await fs.readdir(root)).some(p => /^\.library-(edit|backup)-/.test(p)))
  })
  await test('collection bypasses persistent stage rename locks; resource write failure rolls back installed resources and metadata', async () => {
    const original = fs.rename
    const files = prefix => [file('a/SKILL.md', fm(prefix + '-one')), file('a/bin', Buffer.from([0, 255])), file('b/SKILL.md', fm(prefix + '-two')), file('b/scripts/run', 'resource')]
    let p = await preview({ files: files('transient') }), attempts = 0
    try {
      fs.rename = async (a, b) => { if (a.includes('.library-stage-')) { attempts++; throw Object.assign(new Error('persistent indexer'), { code: 'EPERM' }) }; return original(a, b) }
      assert.equal((await commit(p, '恢复集合')).code, 200); assert.equal(attempts, 0)
    } finally { fs.rename = original }
    assert.deepEqual(await fs.readFile(join(root, 'transient-one', 'bin')), Buffer.from([0, 255]))
    await library() // Reconcile canonical scan ordering before the transaction snapshot.
    const before = await fs.readFile(join(root, '.skill-library.json'))
    p = await preview({ files: files('permanent') }); attempts = 0
    const write = fs.writeFile
    try {
      fs.writeFile = async (a, ...args) => { if (a === join(root, 'permanent-two', 'scripts', 'run')) { attempts++; throw Object.assign(new Error('permanent handle'), { code: 'EPERM' }) }; return write(a, ...args) }
      const r = await commit(p, '失败集合'); assert.equal(r.code, 503); assert.equal(attempts, 1); assert.equal(r.data.diagnostic.operation, 'write-new-resource')
    } finally { fs.writeFile = write }
    assert.deepEqual(await fs.readFile(join(root, '.skill-library.json')), before)
    for (const name of ['permanent-one', 'permanent-two']) await assert.rejects(fs.stat(join(root, name)), { code: 'ENOENT' })
    assert.deepEqual(await fs.readFile(join(root, 'transient-one', 'bin')), Buffer.from([0, 255]))
    assert.equal(await fs.readFile(join(root, 'transient-two', 'scripts', 'run'), 'utf8'), 'resource')
    assert.ok(!(await fs.readdir(root)).some(p => p.startsWith('.library-stage-')))
  })
  await test('legacy overwrite and delete reconcile IDs and collection members', async () => {
    const existing = (await library()).data.skills.find(s => s.name === 'existing')
    const c = await call('POST', '/collections', { displayName: '兼容', skillIds: [existing.id] })
    assert.equal((await call('POST', '/skills/create', { name: 'existing', content: 'new', overwrite: true })).code, 200)
    assert.equal((await library()).data.skills.find(s => s.name === 'existing').id, existing.id)
    assert.equal((await call('DELETE', '/skills/existing')).code, 200)
    assert.deepEqual((await library()).data.collections.find(x => x.id === c.data.collection.id).skillIds, [])
  })
  await test('real ZIP archive module preview and commit preserve independent binary resources', async () => {
    const p = await preview({ archive: { fileName: 'skills.zip', content: zip([['repo/README.md', 'repository docs'], ['repo/a/SKILL.md', fm('archive-a')], ['repo/a/bin', Buffer.from([0, 255, 9])], ['repo/b/SKILL.md', fm('archive-b')]]) } })
    assert.equal(p.code, 200, JSON.stringify(p)); assert.equal(p.data.kind, 'collection'); assert.equal(p.data.warnings.length, 1)
    const r = await commit(p, '压缩集合'); assert.equal(r.code, 200)
    assert.deepEqual(await fs.readFile(join(root, 'archive-a', 'bin')), Buffer.from([0, 255, 9]))
    assert.equal((await preview({ archive: { fileName: 'traversal.zip', content: zip([['../SKILL.md', fm('evil')]]) } })).code, 400)
  })
  await test('real store ZIP above 16 MiB previews and commits exact resource bytes', async () => {
    const bytes = Buffer.alloc(19 * 1024 * 1024, 0x9b)
    bytes[0] = 0; bytes[bytes.length - 1] = 0xff
    // ZIP method 0 stores bytes directly: packed/unpacked ratio is 1, not a bomb.
    const content = zip([['large-archive/SKILL.md', fm('large-archive')], ['large-archive/huge.bin', bytes]])
    assert.ok(Buffer.byteLength(content, 'base64') > 16 * 1024 * 1024)
    const p = await preview({ archive: { fileName: 'large.zip', content } })
    assert.equal(p.code, 200, JSON.stringify(p))
    const r = await commit(p, '大压缩包'); assert.equal(r.code, 200, JSON.stringify(r))
    assert.deepEqual(await fs.readFile(join(root, r.data.skills[0].name, 'huge.bin')), bytes)
  })
  await test('four pending 19 MiB previews exceed 64 MiB and each commits exact independent bytes', async () => {
    const original = Date.now
    try { Date.now = () => original() + 11 * 60 * 1000; await library() } finally { Date.now = original }
    const bytes = Buffer.alloc(19 * 1024 * 1024, 0xa5)
    bytes[0] = 0; bytes[bytes.length - 1] = 0xff
    const source = join(tmp, 'large-preview-source')
    await fs.mkdir(source); await fs.writeFile(join(source, 'SKILL.md'), fm('large-preview'))
    await fs.writeFile(join(source, 'huge.bin'), bytes)
    const pending = []
    // One upload also exercises >24 MiB JSON; subsequent local previews avoid
    // retaining four encoded request strings alongside the 76 MiB pending data.
    {
      const body = { files: [file('SKILL.md', fm('large-preview')), file('huge.bin', bytes)] }
      assert.ok(Buffer.byteLength(JSON.stringify(body)) > 24 * 1024 * 1024)
      pending.push(await preview(body))
    }
    for (let i = 1; i < 4; i++) pending.push(await preview({ path: source }))
    assert.ok(bytes.length * pending.length > 64 * 1024 * 1024)
    for (const p of pending) assert.equal(p.code, 200, JSON.stringify(p))
    assert.equal(new Set(pending.map(p => p.data.token)).size, 4)
    await assert.rejects(fs.stat(join(root, 'large-preview')), { code: 'ENOENT' })
    const names = new Set()
    for (const [i, p] of pending.entries()) {
      const r = await commit(p, '大资源 ' + i); assert.equal(r.code, 200, JSON.stringify(r))
      const name = r.data.skills[0].name; names.add(name)
      assert.deepEqual(await fs.readFile(join(root, name, 'huge.bin')), bytes)
      assert.equal((await commit(p, 'replay')).code, 403)
    }
    assert.equal(names.size, 4)
  })
  await test('local Markdown above 16 MiB previews, commits and remains visible to library scanning', async () => {
    const content = fm('large-markdown', '# Large Markdown\n' + 'x'.repeat(17 * 1024 * 1024))
    const source = join(tmp, 'large-markdown.md')
    await fs.writeFile(source, content)
    assert.ok(Buffer.byteLength(content) > 16 * 1024 * 1024)
    const p = await preview({ path: source }); assert.equal(p.code, 200)
    const r = await commit(p, '大 Markdown'); assert.equal(r.code, 200)
    assert.equal(r.data.skills[0].name, 'large-markdown')
    assert.equal(await fs.readFile(join(root, 'large-markdown', 'SKILL.md'), 'utf8'), content)
    {
      const scanned = (await library()).data.skills.find(s => s.id === r.data.skills[0].id)
      assert.ok(scanned, 'large Markdown must not be silently skipped during library scan')
      assert.equal(scanned.name, 'large-markdown'); assert.equal(scanned.content, content)
    }
    // Avoid carrying large Markdown response bodies through subsequent list tests.
    assert.equal((await call('DELETE', '/library/skills/' + r.data.skills[0].id)).code, 200)
  })
  await test('file count, pending preview count and expiry cleanup remain bounded', async () => {
    assert.equal((await preview({ files: Array.from({ length: 2049 }, (_, i) => file('f' + i, '')) })).code, 400)
    const original = Date.now
    try { Date.now = () => original() + 11 * 60 * 1000; await library() } finally { Date.now = original }
    for (let i = 0; i < 32; i++) assert.equal((await preview({ fileName: 'p' + i + '.md', content: 'body' })).code, 200)
    assert.equal((await preview({ fileName: 'full.md', content: 'body' })).code, 429)
    try { Date.now = () => original() + 11 * 60 * 1000; assert.equal((await preview({ fileName: 'cleaned.md', content: 'body' })).code, 200) } finally { Date.now = original }
  })
  await test('host gate applies to every new route and archive is dynamically optional', async () => {
    gate = () => 401
    assert.equal((await library()).code, 401)
    assert.equal((await preview({ fileName: 'a.md', content: 'x' })).code, 401)
    assert.equal((await call('POST', '/collections', { displayName: 'blocked' })).code, 401)
    gate = () => undefined
    // Another agent may have installed archive; either absence or an invalid archive must fail safely.
    const r = await preview({ archive: { fileName: 'bad.zip', content: 'YWJj' } })
    assert.ok([400, 413, 501].includes(r.code), JSON.stringify(r))
  })
  console.log(`LIBRARY API OK: ${passed} groups, isolated temporary DSH_HOME (not production validation)`)
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  const absolute = resolve(tmp), parent = resolve(tmpdir())
  assert.equal(dirname(absolute), parent); assert.match(relative(parent, absolute), /^skm-library-test-[^\\/]+$/)
  assert.ok((await fs.lstat(absolute)).isDirectory()); await fs.rm(absolute, { recursive: true, force: true })
}
