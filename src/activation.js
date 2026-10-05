'use strict'

// Host evidence: dsh-tool-skill/lib/index.js:168-202 (pre-step waterfall),
// dsh-agent-loop/lib/index.js:902-924,962-965,1061 (admission/termination/commit).
// Never inject into an empty step: that would prevent normal turn termination.
const fs = require('node:fs/promises')
const { join, resolve, dirname, relative, isAbsolute } = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_ACTIVE = 64
const FILE = '.activation.json'
const error = (message, status = 400, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) })

async function managedLoader(ctx) {
  let module
  try { module = await import('@deepseek-ai/dsh-skill-filesystem') }
  catch (e) {
    if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(e.code)) throw e
    // Anchor to the already running host executable module, never to cwd, a
    // user supplied path, or a scanned plugin directory. Electron resolves ASAR.
    if (!process.versions.electron || !process.argv[1] || !isAbsolute(process.argv[1])) throw e
    const path = createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-skill-filesystem')
    module = await import(pathToFileURL(path).href)
  }
  if (typeof module.FileSystemSkillProvider !== 'function') throw new Error('FileSystemSkillProvider unavailable')
  const control = new AbortController()
  const provider = new module.FileSystemSkillProvider(ctx, { signal: control.signal, invalidate() {} }, { includeDefaultRoots: false, watch: false })
  return {
    get: (path, options) => provider.get({ source: 'user', locator: { path, directory: dirname(path) } }, options),
    async dispose() { control.abort(); await provider.dispose() },
  }
}
const normalized = path => {
  if (typeof path !== 'string') return undefined
  const value = resolve(path).replace(/\\/g, '/')
  return process.platform === 'win32' ? value.toLowerCase() : value
}
const escapeAttr = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const escapeText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// Canonical host wrapper, copied in shape from dsh-skill/lib/index.js:57-79.
// Only admitted directory resources are rendered here; no synthetic cwd base.
function renderSkill(skill) {
  if (skill.resourceBase?.kind !== 'directory' || typeof skill.resourceBase.path !== 'string') throw error('技能缺少真实资源基础目录', 503)
  return `<skill_content name="${escapeAttr(skill.name)}">\n<skill_resources>\nBase directory for this skill: ${escapeText(skill.resourceBase.path)}\nResolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.\n</skill_resources>\n\n<skill_instructions>\n${skill.content}\n</skill_instructions>\n</skill_content>`
}

// Protocol adapter for external CJS plugins whose bare ESM dependency is not
// resolvable. Exactly dsh-llm/lib/index.js:37-41,59-63: detach, role, UUID,
// deep freeze. brandString is runtime identity; there is no timestamp field.
// This creates a plugin-source message, never impersonates direct user input.
function createProtocolUserMessage(input) {
  const message = structuredClone({ ...input, role: 'user', id: randomUUID() })
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child)
      Object.freeze(value)
    }
    return value
  }
  return freeze(message)
}

function mountActivation(ctx, helpers) {
  const { skillsRoot, loadLibrary, sendJson, readJsonBody } = helpers
  if (![skillsRoot, loadLibrary, sendJson, readJsonBody].every(fn => typeof fn === 'function')) throw new TypeError('activation requires skillsRoot, loadLibrary, sendJson and readJsonBody helpers')
  let stopped = false
  let factory
  let factoryError
  let loader, loaderError
  const loaderReady = Promise.resolve().then(async () => {
    if (typeof helpers.loadManagedSkill === 'function') loader = { get: helpers.loadManagedSkill }
    else loader = await managedLoader(ctx)
  }).catch(e => { loaderError = e })
  const ready = Promise.resolve().then(async () => {
    if (helpers.createUserMessage) factory = helpers.createUserMessage
    else {
      try { factory = (await import('@deepseek-ai/dsh-llm')).createUserMessage }
      catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND' && e.code !== 'MODULE_NOT_FOUND') throw e; factory = createProtocolUserMessage }
    }
    if (typeof factory !== 'function') throw new Error('createUserMessage unavailable')
  }).catch(e => { factoryError = e })
  let queue = Promise.resolve()
  const turns = new WeakMap()
  function service(name) { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name] }
  function registry(agent) { return service('agentPresets')?.serviceFor(agent, 'skills') || service('skills') }
  async function available() {
    await ready
    if (stopped || factoryError || !factory || typeof ctx.on !== 'function' || !service('agents') || !service('sessionQuery')) throw error('宿主会话或技能集成不可用', 503)
  }
  async function safeRoot() {
    let current = resolve(skillsRoot())
    while (true) {
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw error('activation 状态目录不得为链接', 503) } catch (e) { if (e.code !== 'ENOENT') throw e }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  async function state() {
    await safeRoot()
    const path = join(skillsRoot(), FILE)
    try {
      const stat = await fs.lstat(path)
      if (stat.isSymbolicLink()) throw error('activation 状态不得为链接', 503)
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw error('activation 状态超过限制或不是文件', 503)
      const data = JSON.parse(await fs.readFile(path, 'utf8'))
      if (data.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) throw error('activation 状态损坏', 503)
      return data
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, sessions: {} }; throw e }
  }
  function entry(data, id) {
    const value = Object.hasOwn(data.sessions, id) ? data.sessions[id] : { skillIds: [], revision: 0 }
    if (!Array.isArray(value.skillIds) || !value.skillIds.every(x => typeof x === 'string') || !Number.isSafeInteger(value.revision) || value.revision < 0) throw error('activation 会话状态损坏', 503)
    return value
  }
  async function inspect(id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\x00-\x1f]/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw error('非法 sessionId')
    const query = service('sessionQuery')
    let observation
    try { observation = await query.observeSession(id) } catch (e) {
      if (e.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || /not found/i.test(e.message)) throw error('会话不存在', 404)
      throw error('无法验证会话', 503)
    }
    try {
      const agent = service('agents').get(id)
      if (!agent || agent.session.id !== id) throw error('会话尚未就绪，请打开会话后重试', 503)
      if (agent.session.header.origin === 'subagent') throw error('子会话不支持当前技能开关', 403)
      if (!registry(agent) || typeof registry(agent).get !== 'function') throw error('会话技能服务不可用', 503)
      return agent
    } finally {
      const dispose = observation?.[Symbol.dispose]
      if (typeof dispose === 'function') dispose.call(observation)
      else if (typeof observation?.dispose === 'function') observation.dispose()
    }
  }
  async function library() {
    const result = await loadLibrary(skillsRoot())
    const rows = Array.isArray(result) ? result : result?.skills
    if (!Array.isArray(rows)) throw error('技能库服务不可用', 503)
    return rows
  }
  async function resolveSelected(agent, ids, signal) {
    const rows = await library()
    const loaded = []
    for (const id of ids) {
      signal?.throwIfAborted()
      const row = rows.find(s => (s.id ?? s.name) === id)
      if (!row || !NAME.test(row.name)) throw error('所选技能已不可用: ' + id, 409, 'ACTIVATION_SKILL_UNAVAILABLE')
      const expectedPath = row.path || row.skillPath || row.storagePath && (row.storagePath.endsWith('.md') ? row.storagePath : join(row.storagePath, 'SKILL.md'))
      if (!expectedPath) throw error('技能库缺少可信资源身份', 503)
      await safeRoot()
      const root = resolve(skillsRoot()), target = resolve(expectedPath), child = relative(root, target)
      if (!child || isAbsolute(child) || child === '..' || child.startsWith('..' + require('node:path').sep)) throw error('所选技能路径不在受管用户库内: ' + target, 409, 'ACTIVATION_SOURCE_CONFLICT')
      for (let current = target; ; current = dirname(current)) {
        let stat
        try { stat = await fs.lstat(current) } catch (e) { if (e.code === 'ENOENT') throw error('所选技能文件已不存在: ' + current, 409, 'ACTIVATION_SKILL_UNAVAILABLE'); throw e }
        if (stat.isSymbolicLink() || (current === target && (!stat.isFile() || stat.nlink !== 1))) throw error('所选技能资源身份不可信: ' + current, 409, 'ACTIVATION_SOURCE_CONFLICT')
        if (current === root) break
      }
      await loaderReady
      const options = { cwd: agent.session.header.cwd, scope: agent, signal }
      // The managed ID chooses its own global path. A winning project catalog
      // name is not the identity selected by the human in this library.
      const skill = loader ? await loader.get(target, options) : await registry(agent).get(row.name, options)
      if (!skill || skill.invocation?.userInvocable !== true) throw error('技能不允许用户调用或已不可用: ' + row.name, 409, 'ACTIVATION_SKILL_UNAVAILABLE')
      if (skill.name !== row.name || normalized(skill.path) !== normalized(target) || skill.resourceBase?.kind !== 'directory' || normalized(skill.resourceBase.path) !== normalized(dirname(target))) {
        if (!loader && loaderError) throw error('显式用户库加载器不可用，按名称解析得到不同来源；未启用: ' + target, 503, 'ACTIVATION_LOADER_UNAVAILABLE')
        throw error('所选技能来源不匹配: ' + row.name + '；期望 ' + target + '，实际 ' + (skill.path || '无路径'), 409, 'ACTIVATION_SOURCE_CONFLICT')
      }
      if (typeof row.content !== 'string') throw error('技能库缺少可信正文', 503)
      const expectedContent = row.content.replace(/^---\r?\n[\s\S]*?^---\r?$(?:\n|$)/m, '').trim()
      if (skill.content !== expectedContent) throw error('技能正文已变化，请刷新技能库后重试: ' + row.name, 409, 'ACTIVATION_CONTENT_CONFLICT')
      // The native provider (or exact-identity registry adapter) owns
      // frontmatter stripping, resource base and invocation policy.
      // Path + body identity bind the selected global-library subject, not a shadow.
      loaded.push({ id, name: skill.name, path: target, resourcePath: dirname(target), text: renderSkill(skill) })
    }
    return loaded
  }
  async function save(data) {
    const root = skillsRoot()
    await safeRoot()
    await fs.mkdir(root, { recursive: true })
    const path = join(root, FILE)
    const temporary = join(root, '.activation-' + randomUUID() + '.tmp')
    await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 })
    try { await fs.rename(temporary, path) } catch (e) { await fs.unlink(temporary).catch(() => {}); throw e }
  }
  const serialize = fn => { const next = queue.catch(() => {}).then(fn); queue = next; return next }
  function response(value, extra = {}) { return { skillIds: [...value.skillIds], revision: value.revision, available: true, canDisable: true, effective: 'next-turn', historyRetained: true, ...extra } }
  async function handle(req, res, pathname) {
    if (pathname !== '/dsh-skill-manager/api/activation') return false
    try {
      if (typeof ctx.connection?.requestRejection !== 'function') throw error('宿主认证不可用', 503)
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return true }
      await available()
      if (req.method === 'GET') {
        const id = new URL(req.url, 'http://dsh.local').searchParams.get('sessionId')
        const agent = await inspect(id)
        const value = entry(await state(), id)
        try { await resolveSelected(agent, value.skillIds); sendJson(res, 200, response(value)) }
        catch (e) { sendJson(res, 200, response(value, { available: false, reason: e.message, reasonCode: e.code, code: e.code })) }
      } else if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const agent = await inspect(body.sessionId)
        if (!Array.isArray(body.skillIds) || body.skillIds.length > MAX_ACTIVE || !body.skillIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256) || new Set(body.skillIds).size !== body.skillIds.length) throw error('skillIds 必须为不重复的技能身份列表（最多64项）')
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw error('expectedRevision 必须为非负整数')
        const result = await serialize(async () => {
          const data = await state()
          const before = entry(data, body.sessionId)
          if (before.revision !== body.expectedRevision) throw error('技能开关已在其他窗口更改，请刷新重试', 409, 'ACTIVATION_REVISION_CONFLICT')
          await resolveSelected(agent, body.skillIds)
          if (before.revision === Number.MAX_SAFE_INTEGER) throw error('activation revision 已耗尽', 503)
          const value = { skillIds: [...body.skillIds], revision: before.revision + 1 }
          data.sessions[body.sessionId] = value
          await save(data)
          return value
        })
        sendJson(res, 200, response(result))
      } else sendJson(res, 405, { error: 'method not allowed', available: false })
    } catch (e) { sendJson(res, e.status || 503, { error: e.message, code: e.code, available: false, reason: e.message, reasonCode: e.code }) }
    return true
  }
  const off = ctx.on('agent/pre-step', async ({ agent, messages, signal, turn }, next) => {
    const decision = await next()
    if (stopped || decision.kind === 'reject' || !messages.some(m => m.source?.kind === 'user') || agent.session.header.origin === 'subagent') return decision
    let snapshot = turns.get(agent)
    if (!snapshot || snapshot.turn !== turn) {
      let data
      try { data = await state() } catch (e) {
        ctx.logger?.warn?.('skill activation state unavailable; automatic skills skipped')
        return decision
      }
      // Ordinary sessions are untouched; even allOff declarations require prior
      // explicit management of this Session. Never break an unrelated prompt.
      if (!Object.hasOwn(data.sessions, agent.session.id)) {
        turns.set(agent, { turn, unmanaged: true })
        return decision
      }
      let value
      try { value = entry(data, agent.session.id); await available() } catch (e) {
        ctx.logger?.warn?.('skill activation integration unavailable; automatic skills skipped')
        return decision
      }
      // Freeze one turn: toggles never alter an in-flight turn or its steering.
      let loaded, failure
      try { loaded = await resolveSelected(agent, value.skillIds, signal) } catch (e) { signal?.throwIfAborted(); loaded = []; failure = e.message }
      snapshot = { turn, value, loaded, failure }
      turns.set(agent, snapshot)
    }
    if (snapshot.unmanaged) return decision
    signal?.throwIfAborted()
    const active = snapshot.loaded.map(s => s.name)
    const status = ['Persistent skill selection for this session (authoritative for this turn): ' + (active.length ? active.join(', ') : 'allOff (no persistent skills active)') + '.', 'This replaces earlier persistent selections. Disabled skills are not automatically applied to future turns; historical instructions are retained, not erased. Manual skill invocation and normal task-specific skill use remain separate.', ...(snapshot.failure ? ['Selected library skills were not applied because they are unavailable or conflict with this session.'] : [])].join('\n')
    const injections = [factory({ source: { kind: 'dsh-skill-manager', form: 'selection', revision: snapshot.value.revision }, content: [{ type: 'text', text: status }] })]
    for (const skill of snapshot.loaded) {
      const already = decision.messages.some(m => m.source?.kind === 'skill-invocation' && m.source.name === skill.name && normalized(m.source.path) === normalized(skill.path))
      if (!already) injections.push(factory({ source: { kind: 'dsh-skill-manager', form: 'instructions', name: skill.name }, content: [{ type: 'text', text: skill.text }] }))
    }
    return { ...decision, messages: [...decision.messages, ...injections] }
  })
  const dispose = () => { stopped = true; if (typeof off === 'function') off(); loaderReady.then(() => loader?.dispose?.()).catch(e => ctx.logger?.warn?.('managed skill loader disposal failed: ' + e.message)) }
  ctx.effect(() => dispose, 'dsh-skill-manager: persistent activation')
  return { handle, dispose, ready }
}

module.exports = { mountActivation, renderSkill, createProtocolUserMessage }
