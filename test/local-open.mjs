import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'

const require = createRequire(import.meta.url)
const { createLocalOpener } = require('../src/local-open.js')
const moduleEntry = require.cache[require.resolve('../src/local-open.js')]
const originalExports = moduleEntry.exports
const opened = []
let openerError
moduleEntry.exports = { createLocalOpener: () => async path => { if (openerError) throw openerError; opened.push(path) } }
const plugin = require('../src/index.js')
const tmp = await fs.mkdtemp(join(tmpdir(), 'skm-local-open-'))
const oldHome = process.env.DSH_HOME
const root = join(tmp, "skills 空格 & ' , = % $(not-code)")
// Put the metacharacters in DSH_HOME, keeping the real skills root convention.
const home = root
const skills = join(home, 'skills')
const API = '/dsh-skill-manager/api'
const disposers = []
let handler, gate = () => undefined, count = 0
plugin.apply({
  connection: { requestRejection: req => gate(req) },
  webServer: { register(config) { handler = config.handler; return () => {} } },
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
})
moduleEntry.exports = originalExports
async function call(method, path, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  Object.assign(req, { method, url: API + path, headers })
  const res = { writeHead(status) { this.status = status }, end(text) { this.data = text ? JSON.parse(text) : {} } }
  await handler(req, res)
  return res
}
async function test(label, fn) { await fn(); count++; console.log('PASS ' + label) }
const fm = name => `---\nname: ${name}\ndescription: fixture\n---\nuntouched ${name}\n`
let id, flatId
const endpoint = () => '/library/skills/' + id + '/open'
try {
  process.env.DSH_HOME = home
  await fs.mkdir(join(skills, 'odd-storage'), { recursive: true })
  await fs.writeFile(join(skills, 'odd-storage', 'SKILL.md'), fm('bundle'))
  await fs.writeFile(join(skills, 'flat name.md'), fm('flat'))
  await test('capability and actual managed bundle/legacy flat path, without changing file bytes', async () => {
    const list = await call('GET', '/library')
    assert.equal(list.data.runtime.capabilities.localFileOpen, true)
    id = list.data.skills.find(s => s.name === 'bundle').id
    flatId = list.data.skills.find(s => s.name === 'flat').id
    assert.equal((await call('POST', endpoint())).status, 200)
    assert.deepEqual((await call('POST', '/library/skills/' + flatId + '/open', {})).data, { opened: true })
    assert.deepEqual(opened, [join(skills, 'odd-storage', 'SKILL.md'), join(skills, 'flat name.md')])
    assert.equal(await fs.readFile(opened[0], 'utf8'), fm('bundle'))
    assert.equal(await fs.readFile(opened[1], 'utf8'), fm('flat'))
    await assert.rejects(fs.stat(join(skills, '.activation.json')), { code: 'ENOENT' })
  })
  await test('host origin/auth rejection and missing gate happen before opening', async () => {
    const before = opened.length
    gate = req => req.headers.origin === 'https://evil.example' ? 403 : req.headers.authorization === 'bad' ? 401 : undefined
    assert.equal((await call('POST', endpoint(), undefined, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await call('POST', endpoint(), undefined, { authorization: 'bad' })).status, 401)
    gate = () => undefined
    const saved = handler
    plugin.apply({ connection: {}, webServer: { register(c) { handler = c.handler } }, effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) } })
    try { assert.equal((await call('POST', endpoint())).status, 503) } finally { handler = saved }
    assert.equal(opened.length, before)
  })
  await test('ID-only API rejects arbitrary body/query paths, traversal, unknown IDs and wrong methods', async () => {
    const before = opened.length
    for (const body of [{ path: tmp }, { id }, { content: 'no' }, { command: 'no' }, null, []]) assert.equal((await call('POST', endpoint(), body)).status, 400)
    assert.equal((await call('POST', endpoint() + '?path=' + encodeURIComponent(tmp))).status, 400)
    for (const invalid of ['..%2Foutside', 'C%3A%5Coutside', '%00', '%E0%A4%A']) assert.equal((await call('POST', '/library/skills/' + invalid + '/open')).status, 400)
    assert.equal((await call('POST', '/library/skills/missing/open')).status, 404)
    assert.equal((await call('GET', endpoint())).status, 404)
    assert.equal((await call('PATCH', endpoint())).status, 404)
    assert.equal(opened.length, before)
  })
  await test('hardlinked target never reaches opener', async () => {
    const target = join(skills, 'odd-storage', 'SKILL.md'), alias = join(tmp, 'hardlink.md'), before = opened.length
    await fs.link(target, alias)
    try { assert.equal((await call('POST', endpoint())).status, 400); assert.equal(opened.length, before) } finally { await fs.unlink(alias) }
  })
  await test('linked root and linked managed bundle are rejected', async () => {
    const before = opened.length
    const linkedHome = join(tmp, 'linked-home')
    await fs.symlink(home, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')
    process.env.DSH_HOME = linkedHome
    try { assert.equal((await call('POST', endpoint())).status, 400) } finally { process.env.DSH_HOME = home }
    const original = join(skills, 'odd-storage'), saved = join(tmp, 'saved-bundle')
    assert.ok(resolve(original).startsWith(resolve(tmp)))
    await fs.rename(original, saved)
    await fs.symlink(saved, original, process.platform === 'win32' ? 'junction' : 'dir')
    try { assert.notEqual((await call('POST', endpoint())).status, 200); assert.equal(opened.length, before) } finally {
      assert.ok((await fs.lstat(original)).isSymbolicLink()); await fs.unlink(original); await fs.rename(saved, original)
    }
    // Reconciliation can remove an invalid entry: use the freshly issued ID.
    id = (await call('GET', '/library')).data.skills.find(s => s.name === 'bundle').id
  })
  await test('file identity changed at handle open is rejected', async () => {
    const open = fs.open, before = opened.length
    fs.open = async (path, ...args) => {
      const handle = await open(path, ...args)
      if (path === join(skills, 'odd-storage', 'SKILL.md') && args[0] === 'r') {
        const stat = handle.stat.bind(handle)
        // NTFS inode Numbers may exceed MAX_SAFE_INTEGER: +1 can round back
        // to the same value. Choose a guaranteed-distinct small fixture ID.
        handle.stat = async () => { const value = await stat(); value.ino = value.ino === 0 ? 1 : 0; return value }
      }
      return handle
    }
    try { assert.equal((await call('POST', endpoint())).status, 409); assert.equal(opened.length, before) } finally { fs.open = open }
  })
  await test('malicious metadata root escape rejected and no launch on failure', async () => {
    const path = join(skills, '.skill-library.json'), bytes = await fs.readFile(path), before = opened.length
    const data = JSON.parse(bytes); data.skills.find(s => s.id === id).storagePath = '../outside.md'
    await fs.writeFile(path, JSON.stringify(data))
    try { assert.equal((await call('POST', endpoint())).status, 400); assert.equal(opened.length, before) } finally { await fs.writeFile(path, bytes) }
  })
  await test('launcher error truthfully propagates and vanished target does not launch', async () => {
    openerError = Object.assign(new Error('fixture default-app failure'), { status: 503, code: 'LOCAL_OPEN_FAILED' })
    const before = opened.length
    try {
      const response = await call('POST', endpoint())
      assert.equal(response.status, 503); assert.equal(response.data.diagnostic.code, 'LOCAL_OPEN_FAILED'); assert.equal(response.data.opened, undefined)
    } finally { openerError = undefined }
    const flat = join(skills, 'flat name.md'); await fs.unlink(flat)
    assert.equal((await call('POST', '/library/skills/' + flatId + '/open')).status, 404)
    assert.equal(opened.length, before)
  })
  await test('prefer native associated-path host capability and never fallback on its errors', async () => {
    let nativeCalls = 0
    const target = join(skills, 'odd-storage', 'SKILL.md')
    const open = createLocalOpener({ loadNative: async () => ({ canOpenNativePath: () => true, openNativeAssociatedPath: async (path, signal) => { assert.equal(path, target); assert.ok(signal instanceof AbortSignal); nativeCalls++ } }), run: () => assert.fail('fallback called') })
    await open(target); assert.equal(nativeCalls, 1)
    for (const native of [{ canOpenNativePath: () => false, openNativeAssociatedPath() {} }, {}, { canOpenNativePath: () => true, openNativeAssociatedPath: async () => { throw new Error('association missing') } }]) {
      await assert.rejects(createLocalOpener({ loadNative: async () => native, run: () => assert.fail('fallback called') })(target), error => error.status === 503)
    }
  })
  await test('Windows fallback uses fixed encoded script, no shell interpolation, and preserves punctuation', async () => {
    const target = "C:\\中文 & ' , = % $(no-code)\\skills\\demo\\SKILL.md"
    let calls = 0
    await createLocalOpener({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, loadNative: async () => undefined, run: async (cmd, args, opts) => {
      calls++; assert.equal(cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      assert.equal(args.at(-2), '-EncodedCommand')
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
      assert.ok(!script.includes(target)); assert.ok(script.includes('$env:DSH_SKM_OPEN_PATH')); assert.ok(script.includes('UseShellExecute=$true'))
      assert.equal(opts.env.DSH_SKM_OPEN_PATH, target); assert.equal(opts.shell, undefined)
    } })(target)
    assert.equal(calls, 1)
  })
  await test('macOS/Linux fallback argv and unsupported/headless/WSL/error reporting', async () => {
    const target = '/tmp/中文 & $(no-code)/SKILL.md'
    for (const [platform, command] of [['darwin', '/usr/bin/open'], ['linux', 'xdg-open']]) {
      await createLocalOpener({ platform, env: { DISPLAY: ':1' }, osRelease: 'fixture-linux', loadNative: async () => undefined, run: async (cmd, args) => { assert.equal(cmd, command); assert.deepEqual(args, [target]) } })(target)
    }
    for (const config of [{ platform: 'linux', env: {} }, { platform: 'linux', env: { WSL_INTEROP: 'yes' } }, { platform: 'freebsd', env: {} }]) {
      await assert.rejects(createLocalOpener({ ...config, osRelease: 'fixture-linux', loadNative: async () => undefined, run: () => assert.fail('must not run') })(target), { code: 'LOCAL_OPEN_UNAVAILABLE' })
    }
    await assert.rejects(createLocalOpener({ platform: 'darwin', loadNative: async () => undefined, run: async () => { throw Object.assign(new Error('missing opener'), { code: 'ENOENT' }) } })(target), { code: 'LOCAL_OPEN_FAILED', status: 503 })
    await assert.rejects(createLocalOpener({ platform: 'darwin', loadNative: async () => undefined, run: async () => { throw Object.assign(new Error('deadline'), { name: 'AbortError' }) } })(target), { code: 'LOCAL_OPEN_TIMEOUT', status: 503 })
    await assert.rejects(createLocalOpener({ platform: 'darwin', loadNative: async () => undefined })('relative.md'), { code: 'LOCAL_OPEN_INVALID_PATH' })
  })
  console.log(`LOCAL OPEN OK: ${count} groups; all launchers injected, only disposable fixtures touched`)
} finally {
  moduleEntry.exports = originalExports
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  disposers.reverse().forEach(fn => fn())
  assert.ok(resolve(tmp).startsWith(resolve(tmpdir())) && tmp.includes('skm-local-open-'))
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 })
}
