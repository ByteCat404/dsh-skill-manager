import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { mountActivation, renderSkill, createProtocolUserMessage } = require('../src/activation.js')
const root = await mkdtemp(join(tmpdir(), 'skm-activation-'))
const path = join(root, 'skills')
await mkdir(path)
let count = 0
async function test(label, fn) { await fn(); count++; console.log('PASS ' + label) }
const agents = new Map()
for (const id of ['a', 'b']) agents.set(id, { id, session: { id, header: { cwd: root, origin: 'user' } } })
const rows = ['alpha', 'beta'].map(name => ({ id: 'id-' + name, name, path: join(path, name, 'SKILL.md'), content: '---\nname: ' + name + '\ndescription: fixture\n---\n\nInstructions {{literal}} ' + name }))
for (const row of rows) { await mkdir(dirname(row.path), { recursive: true }); await writeFile(row.path, row.content) }
const skills = new Map(rows.map(row => [row.name, { name: row.name, path: row.path, resourceBase: { kind: 'directory', path: dirname(row.path) }, content: 'Instructions {{literal}} ' + row.name, invocation: { userInvocable: true, modelInvocable: false } }]))
let listener, rejection, observations = 0, releases = 0
const services = {
  agents: { get: id => agents.get(id) },
  sessionQuery: { async observeSession(id) { observations++; if (!agents.has(id)) throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); return { [Symbol.dispose]() { releases++ } } } },
  skills: { async get(name, options) { assert.equal(options.scope, agents.get(options.scope.id)); assert.equal(options.cwd, root); return skills.get(name) } },
}
const ctx = {
  connection: { requestRejection: () => rejection },
  get: name => services[name],
  on(name, fn) { assert.equal(name, 'agent/pre-step'); listener = fn; return () => { listener = undefined } },
  effect() {},
}
let sequence = 0
const helpers = {
  skillsRoot: () => path,
  loadLibrary: async () => ({ skills: rows }),
  sendJson(res, status, data) { res.status = status; res.data = data },
  readJsonBody: async req => req.body,
  createUserMessage: input => ({ id: 'message-' + ++sequence, ...input }),
  loadManagedSkill: async (target, options) => { assert.equal(options.scope, agents.get(options.scope.id)); return [...skills.values()].find(skill => resolve(skill.path) === resolve(target)) }, 
}
let plugin = mountActivation(ctx, helpers)
await plugin.ready
async function call(method, id = 'a', body) {
  const response = { writeHead(status) { this.status = status }, end() {} }
  assert.equal(await plugin.handle({ method, url: '/dsh-skill-manager/api/activation?sessionId=' + id, body }, response, '/dsh-skill-manager/api/activation'), true)
  return response
}
const set = (id, skillIds, expectedRevision) => call('POST', id, { sessionId: id, skillIds, expectedRevision })
const user = () => ({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Task' }] })
async function step(id, turn, messages = [user()], nextDecision) {
  const decision = nextDecision || { kind: 'enter', messages }
  return listener({ agent: agents.get(id), turn, step: 1, messages, signal: new AbortController().signal }, async () => decision)
}
try {
  await test('empty selection and explicit availability contract', async () => {
    const r = await call('GET'); assert.equal(r.status, 200); assert.deepEqual(r.data.skillIds, []); assert.equal(r.data.revision, 0); assert.equal(r.data.available, true); assert.equal(r.data.effective, 'next-turn')
  })
  await test('authorization precedes state access', async () => { const before = observations; rejection = 403; assert.equal((await set('a', ['id-alpha'], 0)).status, 403); assert.equal(observations, before); rejection = undefined })
  await test('unknown sessions and subagents rejected', async () => {
    assert.equal((await call('GET', 'absent')).status, 404)
    agents.get('b').session.header.origin = 'subagent'; assert.equal((await call('GET', 'b')).status, 403); agents.get('b').session.header.origin = 'user'
  })
  await test('unmanaged sessions untouched even without host dependencies', async () => {
    const original = [user()]
    const saved = services.sessionQuery; delete services.sessionQuery
    assert.equal((await step('b', 1, original)).messages, original)
    services.sessionQuery = saved
  })
  await test('local factory exactly follows host detached immutable role and identity protocol', async () => {
    const input = { source: { kind: 'dsh-skill-manager' }, content: [{ type: 'text', text: '{{raw}}' }] }
    const value = createProtocolUserMessage(input)
    assert.equal(value.role, 'user'); assert.equal(value.source.kind, 'dsh-skill-manager')
    assert.match(value.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.deepEqual(Object.keys(value).sort(), ['content', 'id', 'role', 'source'])
    assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.content[0]), true)
    input.content[0].text = 'changed'; assert.equal(value.content[0].text, '{{raw}}')
  })
  await test('multi-selection persisted and session isolated', async () => {
    const r = await set('a', ['id-alpha', 'id-beta'], 0); assert.equal(r.status, 200); assert.equal(r.data.revision, 1)
    assert.deepEqual((await call('GET', 'b')).data.skillIds, [])
    const saved = JSON.parse(await readFile(join(path, '.activation.json'), 'utf8')); assert.deepEqual(saved.sessions.a.skillIds, ['id-alpha', 'id-beta'])
  })
  await test('CAS concurrent update has one winner', async () => {
    const results = await Promise.all([set('a', ['id-alpha', 'id-beta'], 1), set('a', ['id-alpha'], 1)])
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  })
  await test('invalid ids and revision are rejected', async () => {
    for (const body of [{ sessionId: 'a', skillIds: ['x', 'x'], expectedRevision: 2 }, { sessionId: 'a', skillIds: [], expectedRevision: -1 }, { sessionId: '__proto__', skillIds: [], expectedRevision: 0 }]) assert.equal((await call('POST', 'a', body)).status, 400)
    assert.equal((await set('a', ['missing'], 2)).status, 409)
  })
  await test('source user produces true instructions with literal templates and bases', async () => {
    const d = await step('a', 1); assert.equal(d.messages.length, 4); assert.equal(d.messages[0].source.kind, 'user')
    assert.deepEqual(d.messages.filter(m => m.source.form === 'instructions').map(m => m.source.name), ['alpha', 'beta'])
    const body = d.messages[2].content[0].text; assert.match(body, /Instructions \{\{literal\}\} alpha/); assert.ok(body.includes(dirname(rows[0].path))); assert.ok(!body.includes('raw frontmatter'))
  })
  await test('empty steps and non-user sources do not restart a turn', async () => {
    for (const messages of [[], [{ source: { kind: 'runtime-context' }, content: [] }], [{ source: { kind: 'dsh-skill-manager' }, content: [] }]]) assert.deepEqual((await step('a', 1, messages)).messages, messages)
    const rejected = { kind: 'reject' }; assert.equal(await step('a', 1, [user()], rejected), rejected)
  })
  await test('running turn selection frozen; next turn gets allOff declaration', async () => {
    assert.equal((await set('a', [], 2)).status, 200)
    assert.equal((await step('a', 1)).messages.filter(m => m.source.form === 'instructions').length, 2)
    const next = await step('a', 2); assert.equal(next.messages.length, 2); assert.match(next.messages[1].content[0].text, /allOff/); assert.match(next.messages[1].content[0].text, /historical instructions are retained/)
  })
  await test('same-turn explicit slash invocation not duplicated', async () => {
    assert.equal((await set('a', ['id-alpha'], 3)).status, 200)
    const original = [user(), { source: { kind: 'skill-invocation', name: 'alpha', path: rows[0].path }, content: [] }]
    const result = await step('a', 3, [original[0]], { kind: 'enter', messages: original }); assert.equal(result.messages.length, 3)
  })
  await test('project shadow path and user invocation policy fail closed', async () => {
    const original = skills.get('alpha')
    skills.set('alpha', { ...original, path: join(root, '.agents', 'alpha', 'SKILL.md') }); assert.equal((await set('b', ['id-alpha'], 0)).status, 409)
    const get = await call('GET', 'a'); assert.equal(get.status, 200); assert.equal(get.data.available, false); assert.equal(get.data.canDisable, true); assert.equal(get.data.reasonCode, 'ACTIVATION_SKILL_UNAVAILABLE')
    const d = await step('a', 4); assert.equal(d.messages.length, 2); assert.match(d.messages[1].content[0].text, /unavailable or conflict/)
    skills.set('alpha', { ...original, invocation: { userInvocable: false } }); assert.equal((await set('b', ['id-alpha'], 0)).status, 409); skills.set('alpha', original)
  })
  await test('reload persists state; missing services and missing auth return 503', async () => {
    plugin.dispose(); plugin = mountActivation(ctx, helpers); await plugin.ready; assert.deepEqual((await call('GET', 'a')).data.skillIds, ['id-alpha'])
    const saved = services.sessionQuery; delete services.sessionQuery; assert.equal((await call('GET')).status, 503); services.sessionQuery = saved
    const savedAuth = ctx.connection; ctx.connection = {}; assert.equal((await call('GET')).status, 503); ctx.connection = savedAuth
  })
  await test('unavailable skill can be cleared and ordinary sends survive broken state', async () => {
    const original = skills.get('alpha'); skills.delete('alpha')
    assert.equal((await call('GET', 'a')).data.canDisable, true)
    assert.equal((await set('a', [], 4)).status, 200)
    skills.set('alpha', original)
    const saved = services.sessionQuery; delete services.sessionQuery
    const messages = [user()]; assert.equal((await step('a', 8, messages)).messages, messages)
    services.sessionQuery = saved
  })
  await test('preset name winner never overrides explicit managed global path', async () => {
    let used = false
    assert.equal((await step('b', 1)).messages.length, 1)
    services.agentPresets = { serviceFor(agent, name) { assert.equal(name, 'skills'); return { async get(name) { used = true; return skills.get(name) } } } }
    assert.equal((await set('b', ['id-beta'], 0)).status, 200); assert.equal(used, false)
    assert.equal((await step('b', 1)).messages.length, 1) // previously unmanaged running turn remains untouched
    assert.equal((await step('b', 2)).messages.length, 3)
    delete services.agentPresets
  })
  await test('explicit managed load survives different project winner; name-only manual invocation is not deduplicated', async () => {
    const get = services.skills.get
    services.skills.get = async () => ({ ...skills.get('beta'), path: join(root, '.dsh', 'skills', 'beta', 'SKILL.md'), content: 'PROJECT WRONG BODY', resourceBase: { kind: 'directory', path: join(root, '.dsh', 'skills', 'beta') } })
    const r = await set('b', ['id-beta'], 1); assert.equal(r.status, 200)
    const manual = { source: { kind: 'skill-invocation', name: 'beta' }, content: [] }
    const d = await step('b', 3, [user()], { kind: 'enter', messages: [user(), manual] })
    assert.equal(d.messages.length, 4)
    const text = d.messages.at(-1).content[0].text
    assert.ok(text.includes(dirname(rows[1].path))); assert.match(text, /Instructions/); assert.ok(!text.includes('PROJECT WRONG BODY'))
    services.skills.get = get
  })
  await test('typed revision, content, source and missing-skill errors are distinct without writes', async () => {
    const rev = (await call('GET', 'b')).data.revision
    assert.equal((await set('b', ['id-beta'], rev - 1)).data.code, 'ACTIVATION_REVISION_CONFLICT')
    assert.equal((await set('b', ['missing'], rev)).data.code, 'ACTIVATION_SKILL_UNAVAILABLE')
    const old = skills.get('beta')
    skills.set('beta', { ...old, content: 'STALE BODY' })
    assert.equal((await set('b', ['id-beta'], rev)).data.code, 'ACTIVATION_CONTENT_CONFLICT')
    assert.equal((await call('GET', 'b')).data.reasonCode, 'ACTIVATION_CONTENT_CONFLICT')
    skills.set('beta', old)
    const load = helpers.loadManagedSkill
    plugin.dispose(); plugin = mountActivation(ctx, { ...helpers, loadManagedSkill: async () => ({ ...old, resourceBase: { kind: 'directory', path: root } }) }); await plugin.ready
    assert.equal((await set('b', ['id-beta'], rev)).data.code, 'ACTIVATION_SOURCE_CONFLICT')
    plugin.dispose(); plugin = mountActivation(ctx, { ...helpers, loadManagedSkill: load }); await plugin.ready
    assert.equal((await call('GET', 'b')).data.revision, rev)
  })
  await test('canonical renderer escapes name and resource but not body', async () => {
    const value = renderSkill({ name: 'a"b', content: '{{example}} <literal>', resourceBase: { kind: 'directory', path: 'C:\\a&<b>' } })
    assert.match(value, /name="a&quot;b"/); assert.match(value, /a&amp;&lt;b&gt;/); assert.match(value, /\{\{example\}\} <literal>/)
    assert.throws(() => renderSkill({ name: 'a', content: 'b' }), /真实资源/)
  })
  assert.equal(observations - releases, 1) // one missing-session attempt never returned a lease
  console.log(`ACTIVATION OK: ${count} isolated mock contract groups; live Host not tested`)
} finally {
  plugin.dispose()
  const absolute = resolve(root)
  assert.equal(dirname(absolute), resolve(tmpdir())); assert.match(absolute.split(/[\\/]/).at(-1), /^skm-activation-/); assert.equal((await lstat(absolute)).isDirectory(), true)
  await rm(absolute, { recursive: true, force: true })
}
