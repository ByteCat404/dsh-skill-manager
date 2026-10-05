import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
const require = createRequire(import.meta.url)
const host = require('../src/index.js')
const archivePath = require.resolve('../src/activation.js')
const previousModule = require.cache[archivePath], oldHome = process.env.DSH_HOME
const tmp = await fs.mkdtemp(join(tmpdir(), 'skm-library-integration-'))
const root = join(tmp, 'skills')
let helpers, handler, gate = () => undefined, handled = 0
const effects = []
try {
  process.env.DSH_HOME = tmp
  await fs.mkdir(join(root, 'odd.md'), { recursive: true })
  const content = '---\nname: physical-name\ndescription: test\nuser-invocable: false\n---\n# body'
  await fs.writeFile(join(root, 'odd.md', 'SKILL.md'), content)
  await fs.writeFile(join(root, 'flat.md'), '---\nname: flat\ndescription: test\n---\n# body')
  require.cache[archivePath] = { exports: { mountActivation(ctx, supplied) { helpers = supplied; return { async handle(req, res, pathname) { if (pathname !== '/dsh-skill-manager/api/activation') return false; handled++; res.writeHead(200); res.end('{}'); return true } } } } }
  host.apply({ on() {}, connection: { requestRejection: req => gate(req) }, webServer: { register: config => { handler = config.handler; return () => {} } }, effect: fn => effects.push(fn()) })
  const loaded = await helpers.loadLibrary(root)
  const physical = loaded.skills.find(s => s.name === 'physical-name')
  assert.equal(physical.path, join(root, 'odd.md', 'SKILL.md'))
  assert.equal(physical.resourceBase, join(root, 'odd.md'))
  assert.equal(physical.storagePath, join(root, 'odd.md'))
  assert.equal(physical.content, content)
  assert.equal(physical.invocation['user-invocable'], false)
  assert.match(physical.yaml, /user-invocable/)
  const flat = loaded.skills.find(s => s.name === 'flat')
  assert.equal(flat.path, join(root, 'flat.md')); assert.equal(flat.resourceBase, root)
  assert.equal((await helpers.loadLibrary(root)).skills.find(s => s.name === 'flat').id, flat.id)
  async function request() {
    const req = Readable.from([]); Object.assign(req, { method: 'GET', url: '/dsh-skill-manager/api/activation', headers: {} })
    const res = { code: 0, writeHead(code) { this.code = code }, end() {} }
    await handler(req, res); return res.code
  }
  assert.equal(await request(), 200); assert.equal(handled, 1)
  gate = () => 401; assert.equal(await request(), 401); assert.equal(handled, 1)
  for (const dispose of effects) if (typeof dispose === 'function') dispose()
  console.log('LIBRARY INTEGRATION OK: activation receives stable identity, exact raw YAML and real resource paths; host gate first; disposal supported (isolated temp DSH_HOME)')
} finally {
  if (previousModule) require.cache[archivePath] = previousModule; else delete require.cache[archivePath]
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  const absolute = resolve(tmp), parent = resolve(tmpdir())
  assert.equal(dirname(absolute), parent); assert.match(relative(parent, absolute), /^skm-library-integration-[^\\/]+$/)
  assert.ok((await fs.lstat(absolute)).isDirectory()); await fs.rm(absolute, { recursive: true, force: true })
}
