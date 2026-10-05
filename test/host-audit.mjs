import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, lstat } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

const require = createRequire(import.meta.url)
const host = require('../src/index.js')
const BASE = '/dsh-skill-manager/api/skills'
const oldHome = process.env.DSH_HOME
const tmp = await mkdtemp(join(tmpdir(), 'skm-host-test-'))
const root = join(tmp, 'skills')
let handler, gate = () => undefined
host.apply({ connection: { requestRejection: req => gate(req) }, webServer: { register: config => { handler = config.handler } }, effect: fn => fn() })
assert.equal(host.name, 'dsh-skill-manager')
assert.equal(typeof handler, 'function')
let passed = 0
async function test(name, action) { await action(); passed++; console.log('PASS ' + name) }
async function call(method, path = BASE, body, options = {}) {
  const req = Readable.from(options.chunks || (options.raw !== undefined ? [options.raw] : body === undefined ? [] : [JSON.stringify(body)]))
  Object.assign(req, { method, url: path, headers: options.headers || {} })
  const response = { status: 0, text: '', headers: null, writeHead(status, headers) { this.status = status; this.headers = headers }, end(text) { this.text = text || '' } }
  await handler(req, response)
  return { code: response.status, data: response.text ? JSON.parse(response.text) : {}, headers: response.headers }
}
const create = (name, extra = {}) => call('POST', BASE + '/create', { name, content: '# Instructions', description: 'test', ...extra })
const upload = (fileName, content, extra = {}) => call('POST', BASE + '/import', { fileName, content, ...extra })
const fm = (name, description = 'test') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions`
const file = (path, content) => ({ path, content: (Buffer.isBuffer(content) ? content : Buffer.from(content)).toString('base64'), encoding: 'base64' })
const importFiles = (files, extra = {}) => call('POST', BASE + '/import', { files, ...extra })
try {
  process.env.DSH_HOME = tmp
  await test('empty global scope list', async () => {
    const r = await call('GET'); assert.equal(r.code, 200); assert.deepEqual(r.data.skills, []); assert.equal(r.data.scope, 'user-dsh'); assert.equal(r.data.root, root)
  })
  await test('create trimmed name and YAML-safe description', async () => {
    const r = await create('  trimmed-name  ', { description: 'colon: apostrophe\' "quote"\nline' }); assert.equal(r.code, 200); assert.equal(r.data.skill.name, 'trimmed-name'); assert.equal(r.data.skill.description, 'colon: apostrophe\' "quote"\nline')
    assert.equal((await call('GET', BASE + '/trimmed-name')).data.skill.description, r.data.skill.description)
  })
  await test('duplicate create 409 / overwrite true succeeds', async () => {
    assert.equal((await create('trimmed-name')).code, 409)
    assert.equal((await create('trimmed-name', { overwrite: 'true' })).code, 400)
    assert.equal((await create('trimmed-name', { overwrite: true, content: 'replacement' })).code, 200)
    assert.match(await readFile(join(root, 'trimmed-name', 'SKILL.md'), 'utf8'), /replacement/)
  })
  await test('simultaneous writes serialize into success and 409', async () => {
    const results = await Promise.all([create('concurrent'), create('concurrent')]); assert.deepEqual(results.map(r => r.code).sort(), [200, 409])
  })
  await test('invalid name and frontmatter mismatch rejected', async () => {
    for (const name of ['../escape', 'Bad Name', '', 'a/b', 'a\\b']) assert.equal((await create(name)).code, 400)
    assert.equal((await create('matching', { content: fm('other') })).code, 400)
    assert.equal((await create('matching', { content: fm('matching', 'metadata description') })).data.skill.description, 'metadata description')
  })
  await test('plain .md upload fallback adds host-compatible frontmatter', async () => {
    const r = await upload('plain-upload.MD', '# No metadata'); assert.equal(r.code, 200); assert.equal(r.data.skill.name, 'plain-upload'); assert.match(r.data.skill.content, /name: plain-upload/); assert.ok(r.data.skill.description)
    assert.equal((await upload('../bad.md', 'x')).code, 400)
    assert.equal((await upload('markdown-upload.markdown', '# Markdown')).data.skill.name, 'markdown-upload')
    assert.equal((await importFiles([file('SKILL.md', '# Folder text')], { folderName: 'plain-folder' })).data.skill.name, 'plain-folder')
  })
  await test('single/double quoted apostrophes and comments preserve strings', async () => {
    const r = await upload('ignored.md', fm('quoted', `'It''s "fine": details # text'`)); assert.equal(r.code, 200); assert.equal(r.data.skill.description, 'It\'s "fine": details # text')
    const s = await upload('ignored.md', fm('double-quoted', '"escaped \\"quote\\" and apostrophe\'" # comment')); assert.equal(s.code, 200); assert.equal(s.data.skill.description, 'escaped "quote" and apostrophe\'')
  })
  await test('literal/folded multiline YAML and CRLF', async () => {
    let r = await upload('x.md', fm('literal', '|-\n  first\n  second')); assert.equal(r.code, 200); assert.equal(r.data.skill.description, 'first\nsecond')
    r = await upload('x.md', fm('folded', '>-\n  first\n  second').replaceAll('\n', '\r\n')); assert.equal(r.code, 200); assert.equal(r.data.skill.description, 'first second')
    r = await upload('x.md', fm('multiquote', '"first\n  second"')); assert.equal(r.code, 200); assert.equal(r.data.skill.description, 'first second')
  })
  await test('missing description completed; bad YAML/types/invocation rejected', async () => {
    assert.equal((await upload('x.md', '---\nname: missing-desc\n---\nbody')).code, 200)
    for (const content of [fm('bad', 'null'), fm('bad', 'true'), fm('bad', '"unterminated'), '---\nname: bad\nbody', fm('bad', 'test\nname: duplicate'), fm('bad', 'test\nuserInvocable: true'), fm('bad', 'test\nuser-invocable: wrong'), fm('"bad "', 'test')]) assert.equal((await upload('x.md', content)).code, 400, content)
    assert.equal((await upload('x.md', fm('policy', 'test\nuser-invocable: false\ndisable-model-invocation: yes'))).code, 200)
  })
  await test('local directory preserves nested text and binary assets', async () => {
    const source = join(tmp, 'external', 'local-bundle'); await mkdir(join(source, 'scripts'), { recursive: true }); await writeFile(join(source, 'SKILL.md'), fm('local-bundle')); await writeFile(join(source, 'scripts', 'run.js'), 'console.log(1)'); await writeFile(join(source, 'asset.bin'), Buffer.from([0, 255, 7]))
    assert.equal((await call('POST', BASE + '/import', { path: source })).code, 200)
    assert.equal(await readFile(join(root, 'local-bundle', 'scripts', 'run.js'), 'utf8'), 'console.log(1)'); assert.deepEqual(await readFile(join(root, 'local-bundle', 'asset.bin')), Buffer.from([0, 255, 7]))
    assert.equal((await call('POST', BASE + '/import', { path: source })).code, 409)
    assert.equal((await call('POST', BASE + '/import', { path: tmp })).code, 400)
    const md = join(tmp, 'single.md'); await writeFile(md, '# single'); assert.equal((await call('POST', BASE + '/import', { path: md })).code, 200)
  })
  await test('browser folder base64 resources and overwrite removes stale assets', async () => {
    const files = [file('SKILL.md', fm('browser-bundle')), file('resources/nested.bin', Buffer.from([0, 128, 255])), file('scripts/run.js', 'hello')]
    assert.equal((await importFiles(files)).code, 200); assert.deepEqual(await readFile(join(root, 'browser-bundle', 'resources', 'nested.bin')), Buffer.from([0, 128, 255]))
    assert.equal((await importFiles(files)).code, 409)
    assert.equal((await importFiles([file('SKILL.md', fm('browser-bundle'))], { overwrite: true })).code, 200)
    await assert.rejects(readFile(join(root, 'browser-bundle', 'scripts', 'run.js')), { code: 'ENOENT' })
  })
  await test('upload traversal, absolute, Windows ADS/reserved, duplicate and prefix collisions', async () => {
    for (const path of ['../escape', '/absolute', 'C:/absolute', 'a\\b', 'a/../b', './a', 'a//b', 'a:stream', 'CON.txt', 'a.', 'a ', 'a\u0000b']) assert.equal((await importFiles([file('SKILL.md', fm('attack')), file(path, 'x')])).code, 400, path)
    assert.equal((await importFiles([file('SKILL.md', fm('attack')), file('A', '1'), file('a', '2')])).code, 400)
    assert.equal((await importFiles([file('SKILL.md', fm('attack')), file('a', '1'), file('a/b', '2')])).code, 400)
    assert.equal((await importFiles([file('resource', 'x')])).code, 400)
    assert.equal((await importFiles([file('SKILL.md', fm('attack')), { path: 'binary', encoding: 'base64', content: '!!!' }])).code, 400)
    assert.equal((await importFiles([file('SKILL.md', fm('attack'))], { name: 'attack' })).code, 400)
  })
  await test('flat-name and renamed-storage conflicts, detail and deletion', async () => {
    await writeFile(join(root, 'odd-filename.md'), fm('flat-skill'))
    assert.equal((await call('GET', BASE + '/flat-skill')).code, 200)
    assert.equal((await create('flat-skill')).code, 409)
    assert.equal((await call('DELETE', BASE + '/flat-skill')).code, 200)
    await assert.rejects(lstat(join(root, 'odd-filename.md')), { code: 'ENOENT' })
    await mkdir(join(root, 'odd-directory')); await writeFile(join(root, 'odd-directory', 'SKILL.md'), fm('renamed-storage'))
    assert.equal((await create('renamed-storage')).code, 409)
    assert.equal((await create('renamed-storage', { overwrite: true })).code, 200)
    await assert.rejects(lstat(join(root, 'odd-directory')), { code: 'ENOENT' })
    await writeFile(join(root, 'renamed-storage.md'), fm('renamed-storage'))
    assert.equal((await call('DELETE', BASE + '/renamed-storage')).code, 200)
    await assert.rejects(lstat(join(root, 'renamed-storage.md')), { code: 'ENOENT' })
    assert.equal((await call('DELETE', BASE + '/renamed-storage')).code, 404)
  })
  await test('non-skill destination never overwritten; invalid existing entries ignored', async () => {
    await mkdir(join(root, 'unrelated')); await writeFile(join(root, 'unrelated', 'precious.txt'), 'keep')
    assert.equal((await create('unrelated', { overwrite: true })).code, 409)
    assert.equal(await readFile(join(root, 'unrelated', 'precious.txt'), 'utf8'), 'keep')
    await writeFile(join(root, 'invalid.md'), '# not a host skill')
    assert.ok(!(await call('GET')).data.skills.some(s => s.name === 'invalid'))
  })
  await test('symlink/junction input, resource and target rejected', async () => {
    const outside = join(tmp, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep')
    const source = join(tmp, 'linked-source'); await mkdir(source); await writeFile(join(source, 'SKILL.md'), fm('linked-source')); await symlink(outside, join(source, 'link'), 'junction')
    assert.equal((await call('POST', BASE + '/import', { path: source })).code, 400)
    await symlink(outside, join(tmp, 'source-junction'), 'junction'); assert.equal((await call('POST', BASE + '/import', { path: join(tmp, 'source-junction') })).code, 400)
    await symlink(outside, join(root, 'linked-target'), 'junction'); assert.equal((await create('linked-target', { overwrite: true })).code, 400)
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
    // Removing the junction itself is safe: its lstat and known target checked.
    assert.ok((await lstat(join(root, 'linked-target'))).isSymbolicLink()); await rm(join(root, 'linked-target'))
  })
  await test('invalid JSON, non-object bodies and file count remain rejected', async () => {
    for (const raw of ['{', 'null', '[]', '"x"']) assert.equal((await call('POST', BASE + '/create', undefined, { raw })).code, 400)
    assert.equal((await importFiles(Array.from({ length: 2049 }, (_, i) => file('x' + i, '')))).code, 400)
  })
  await test('large Content-Length is not a capacity gate', async () => {
    const raw = JSON.stringify({ name: 'large-header', content: '# header body' })
    assert.equal((await call('POST', BASE + '/create', undefined, { raw, headers: { 'content-length': String(25 * 1024 * 1024) } })).code, 200)
    assert.match(await readFile(join(root, 'large-header', 'SKILL.md'), 'utf8'), /# header body/)
  })
  await test('valid streamed JSON above 24 MiB imports resource above 16 MiB byte-for-byte', async () => {
    const bytes = Buffer.alloc(19 * 1024 * 1024, 0xa5)
    bytes[0] = 0; bytes[bytes.length - 1] = 0xff
    const raw = JSON.stringify({ files: [file('SKILL.md', fm('large-stream')), file('huge.bin', bytes)] })
    const length = Buffer.byteLength(raw)
    assert.ok(length > 24 * 1024 * 1024)
    // Several valid JSON chunks, rather than oversized invalid text, exercise the stream reader.
    const chunks = function* () { for (let i = 0; i < raw.length; i += 1024 * 1024) yield raw.slice(i, i + 1024 * 1024) }
    const r = await call('POST', BASE + '/import', undefined, { chunks: chunks(), headers: { 'content-length': String(length) } })
    assert.equal(r.code, 200, JSON.stringify(r))
    assert.deepEqual(await readFile(join(root, 'large-stream', 'huge.bin')), bytes)
    // Reuse the same bytes for the filesystem walker and legacy local import.
    const source = join(tmp, 'large-local-source')
    await mkdir(source); await writeFile(join(source, 'SKILL.md'), fm('large-local'))
    await writeFile(join(source, 'huge.bin'), bytes)
    const local = await call('POST', BASE + '/import', { path: source })
    assert.equal(local.code, 200, JSON.stringify(local))
    assert.deepEqual(await readFile(join(root, 'large-local', 'huge.bin')), bytes)
  })
  await test('exact routing and encoded traversal rejection', async () => {
    assert.equal((await call('GET', '/wrong' + BASE)).code, 404)
    assert.equal((await call('GET', BASE + '/%E0%A4%A')).code, 400)
    assert.equal((await call('DELETE', BASE + '/..%2Fescape')).code, 400)
    assert.equal((await call('GET', BASE + '/absent')).code, 404)
  })
  await test('host/origin/auth gate rejects before mutations; fail closed', async () => {
    gate = req => req.headers.host === 'evil.example' || req.headers.origin === 'https://evil.example' ? 403 : req.headers.authorization === 'bad' ? 401 : undefined
    assert.equal((await call('POST', BASE + '/create', { name: 'blocked', content: 'x' }, { headers: { host: 'evil.example' } })).code, 403)
    assert.equal((await call('POST', BASE + '/create', { name: 'blocked', content: 'x' }, { headers: { origin: 'https://evil.example' } })).code, 403)
    assert.equal((await call('DELETE', BASE + '/concurrent', undefined, { headers: { authorization: 'bad' } })).code, 401)
    assert.equal((await call('GET', BASE + '/blocked')).code, 404)
    assert.equal((await call('GET', BASE + '/concurrent')).code, 200)
    let missing
    host.apply({ connection: {}, webServer: { register: config => { missing = config.handler } }, effect: fn => fn() })
    const previous = handler; handler = missing; assert.equal((await call('GET')).code, 503); handler = previous; gate = () => undefined
  })
  await test('no staging/backup leftovers; library list reflects persisted metadata', async () => {
    assert.ok(!(await readdir(root)).some(name => name.startsWith('.skm-')))
    const response = await call('GET'); for (const skill of response.data.skills) { assert.ok(skill.name); assert.ok(skill.description); assert.equal((await call('GET', BASE + '/' + skill.name)).code, 200) }
  })
  console.log(`HOST AUDIT OK: ${passed} groups, isolated temporary library ${tmp}`)
} finally {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  // Before deletion prove the absolute target is our mkdtemp child, not real DSH_HOME.
  const absolute = resolve(tmp), parent = resolve(tmpdir())
  assert.equal(dirname(absolute), parent); assert.match(relative(parent, absolute), /^skm-host-test-[^\\/]+$/)
  assert.ok((await lstat(absolute)).isDirectory()); await rm(absolute, { recursive: true, force: true })
}
