'use strict'

/** Manage the user-dsh library, NOT the cwd/preset-sensitive Session catalog.
 * The host also scans project .dsh/.agents roots, custom roots, user .agents and
 * bundled skills. Project candidates outrank this global library.
 */
const fs = require('node:fs/promises')
const { join, resolve, basename, dirname, relative, isAbsolute, sep } = require('node:path')
const { homedir } = require('node:os')
const { randomUUID, createHash } = require('node:crypto')
const { renameRetry, hostError, PENDING, sameIdentity, reserveBundle, assertOwned, writeNew } = require('./host-files')
// Captured when this main module loads, not inferred from a mutable disk file.
const RUNTIME = Object.freeze({ pluginVersion: require('../package.json').version, apiVersion: 2, implementation: 'exclusive-bundle-publish-v1', capabilities: { localFileOpen: true, contentEdit: true, sha256CAS: true, atomicDocumentReplace: true, exclusiveBundleImport: true, managedSkillActivation: 'native-explicit-path-v1', activationConflictCodes: true } })
const NS = 'dsh-skill-manager'
const BASE = '/' + NS + '/api/skills'
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_FILES = 2048
let yamlParse
try { yamlParse = require('yaml').parse } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error
}

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error }
function skillsRoot() { return join(process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh'), 'skills') }
function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  res.end(body)
}
function readJsonBody(req) {
  return new Promise((done, reject) => {
    const chunks = []
    let settled = false
    const abort = error => { if (!settled) { settled = true; reject(error) } }
    const error = (message, status) => Object.assign(new Error(message), { status })
    req.on('data', chunk => {
      if (settled) return
      chunks.push(Buffer.from(chunk))
    })
    req.on('end', () => {
      if (settled) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const body = text.trim() ? JSON.parse(text) : {}
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON body 必须是对象')
        settled = true
        done(body)
      } catch (e) { abort(error('非法 JSON: ' + e.message, 400)) }
    })
    req.on('error', abort)
    req.on('aborted', () => abort(error('请求已中断', 400)))
  })
}
function validName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) fail('技能名必须是小写 kebab-case（如 my-skill）')
  return name
}

// Standalone fallback for frontmatter's string/boolean scalars. Full YAML is
// used when available in the host. Unsupported core-field YAML is rejected,
// never silently approximated; unrelated nested metadata is preserved verbatim.
function scalar(raw) {
  const text = raw.trim()
  if (text.startsWith('"')) {
    try { return JSON.parse(text) } catch { fail('无效的 YAML 双引号字符串（复杂 YAML 请使用宿主 yaml 模块）') }
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) fail('无效的 YAML 单引号字符串')
    return text.slice(1, -1).replace(/''/g, "'")
  }
  const value = text.replace(/\s+#.*$/, '').trimEnd()
  if (/^[!&*\[{]/.test(value) || /:\s/.test(value)) fail('不支持的 YAML 字段语法')
  if (/^(?:null|~)$/i.test(value) || value === '') return null
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true'
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}
function fallbackYaml(text) {
  const lines = text.split(/\r?\n/)
  const data = Object.create(null)
  const core = new Set(['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable', 'disableModelInvocation', 'modelInvocable', 'userInvocable'])
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) continue
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!match) fail('无效的 YAML frontmatter')
    const [, key, raw] = match
    if (Object.hasOwn(data, key)) fail('重复的 YAML 字段: ' + key)
    data[key] = undefined
    if (!core.has(key)) continue
    const block = raw.match(/^([|>])([+-]?)([1-9]?)(?:\s+#.*)?$/) || raw.match(/^([|>])([1-9])([+-]?)(?:\s+#.*)?$/)
    if (block) {
      let end = i + 1
      while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++
      const following = lines.slice(i + 1, end)
      const explicit = /[1-9]/.exec(raw)
      const first = following.find(l => l.trim())
      const indent = explicit ? Number(explicit[0]) : first ? first.match(/^ */)[0].length : 1
      if (indent < 1 || following.some(l => l.trim() && l.match(/^ */)[0].length < indent)) fail('YAML 多行缩进无效')
      const parts = following.map(l => l.slice(indent))
      let value = ''
      for (let p = 0; p < parts.length; p++) {
        value += parts[p]
        if (p < parts.length - 1) {
          const a = parts[p], b = parts[p + 1]
          value += raw[0] === '>' && a && b && !/^\s/.test(a) && !/^\s/.test(b) ? ' ' : '\n'
        }
      }
      value += '\n'
      if (raw.includes('-')) value = value.replace(/\n+$/, '')
      else if (!raw.includes('+')) value = value.replace(/\n+$/, '\n')
      data[key] = value
      i = end - 1
    } else if (/^["']/.test(raw) && !(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:\s+#.*)?$/.test(raw))) {
      let quoted = raw
      while (++i < lines.length) {
        if (lines[i].trim() && !/^\s/.test(lines[i])) fail('YAML 引号未闭合')
        quoted += '\n' + lines[i].trim()
        if (/['"](?:\s+#.*)?$/.test(lines[i].trim())) break
      }
      data[key] = scalar(quoted.replace(/\n\s*\n/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\\n'))
    } else data[key] = scalar(raw.replace(/(["'])\s+#.*$/, '$1'))
  }
  return data
}
function frontmatter(content) {
  if (!/^---\r?\n/.test(content)) return undefined
  const match = content.match(/^---\r?\n([\s\S]*?)^---\r?$(?:\n|$)/m)
  if (!match) fail('YAML frontmatter 缺少结束分隔符')
  let data
  try { data = yamlParse ? yamlParse(match[1]) : fallbackYaml(match[1]) } catch (error) { fail('无效的 YAML frontmatter: ' + error.message) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('YAML frontmatter 必须是对象')
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(data, key)) fail('不支持的旧 invocation 字段: ' + key)
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (Object.hasOwn(data, key) && ![true, false, 0, 1].includes(data[key]) && !(typeof data[key] === 'string' && /^(?:true|false|yes|no|on|off|0|1)$/i.test(data[key]))) fail(key + ' 必须是布尔值')
  }
  return { data, yaml: match[1], body: content.slice(match[0].length) }
}
function parseSkill(content) {
  const fm = frontmatter(content)
  if (!fm || typeof fm.data.name !== 'string' || typeof fm.data.description !== 'string' || !fm.data.description.length) fail('技能需要 name 和非空 description frontmatter')
  return { name: validName(fm.data.name), description: fm.data.description, content }
}
function prepare(content, fallbackName, description, expectedName) {
  if (typeof content !== 'string' || !content.trim()) fail('技能正文（content）不能为空')
  const fm = frontmatter(content)
  const name = fm && Object.hasOwn(fm.data, 'name') ? validName(fm.data.name) : validName(fallbackName)
  if (expectedName && name !== expectedName) fail('技能名与 frontmatter name 不一致')
  const desc = fm && Object.hasOwn(fm.data, 'description') ? fm.data.description : description || '(未填写描述)'
  if (typeof desc !== 'string' || !desc.trim()) fail('description 必须是非空字符串')
  if (!fm) content = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${content}`
  else if (!Object.hasOwn(fm.data, 'name') || !Object.hasOwn(fm.data, 'description')) {
    const additions = (!Object.hasOwn(fm.data, 'name') ? `name: ${name}\n` : '') + (!Object.hasOwn(fm.data, 'description') ? `description: ${JSON.stringify(desc)}\n` : '')
    content = `---\n${additions}${fm.yaml}---\n${fm.body}`
  }
  return parseSkill(content)
}

function contained(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
async function exists(path) {
  try { return await fs.lstat(path) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}
// Check every existing ancestor, not only the leaf (Windows junctions included).
async function noLinks(path) {
  let current = resolve(path)
  while (true) {
    const stat = await exists(current)
    if (stat && stat.isSymbolicLink()) fail('不允许符号链接或 junction: ' + current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
async function safeRemove(root, path) {
  if (!contained(root, path)) fail('拒绝删除技能根之外的路径')
  await noLinks(path)
  await fs.rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
}
async function scanSkills(root, internal = false) {
  await noLinks(root)
  let entries
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const skills = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = entry.isDirectory() ? join(root, entry.name, 'SKILL.md') : entry.isFile() && entry.name.endsWith('.md') ? join(root, entry.name) : undefined
    if (!path) continue
    try {
      await noLinks(path)
      if (entry.isDirectory() && await exists(join(root, entry.name, PENDING))) {
        // Uncommitted/crashed imports are not adopted as new library skills.
        await noLinks(join(root, '.skill-library.json'))
        let metadata
        try { metadata = JSON.parse(await fs.readFile(join(root, '.skill-library.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (!metadata || !Array.isArray(metadata.skills) || !metadata.skills.some(s => s.storagePath === entry.name)) continue
      }
      const parsed = parseSkill(await fs.readFile(path, 'utf8'))
      skills.push({ ...parsed, ...(internal ? { storagePath: entry.isDirectory() ? dirname(path) : path } : {}) })
    } catch (error) { if (error.status === 400 || error.code === 'ENOENT') continue; throw error }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}
function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.length > 1024) fail('上传路径必须是安全相对路径')
  const parts = path.split('/')
  if (parts.length > 64 || parts.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f<>:"|?*]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) fail('上传路径包含非法片段: ' + path)
  return parts.join('/')
}
function validateFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) fail('files 必须包含 1–2048 个文件')
  const out = []
  const paths = new Set()
  for (const file of files) {
    if (!file || typeof file !== 'object' || file.encoding !== 'base64' || typeof file.content !== 'string') fail('files 需要 {path, content, encoding:"base64"}')
    const path = safeRelative(file.path)
    const key = path.toLowerCase()
    if (paths.has(key)) fail('重复上传路径: ' + path)
    paths.add(key)
    if (file.content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.content)) fail('非法 base64 文件: ' + path)
    const content = Buffer.from(file.content, 'base64')
    if (content.toString('base64') !== file.content) fail('非法 base64 文件: ' + path)
    out.push({ path, content })
  }
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) fail('文件与目录路径冲突: ' + path)
  }
  if (!out.some(file => file.path === 'SKILL.md')) fail('上传文件夹必须包含根目录 SKILL.md')
  return out
}
async function localFiles(path) {
  await noLinks(path)
  const out = []
  let directories = 0
  async function walk(current, prefix = '', depth = 0) {
    if (depth > 64 || ++directories > MAX_FILES) fail('目录深度或数量超过限制', 413)
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = join(current, entry.name)
      const rel = safeRelative(prefix + entry.name)
      await noLinks(file)
      const stat = await fs.lstat(file)
      if (stat.isDirectory()) await walk(file, rel + '/', depth + 1)
      else if (stat.isFile()) {
        if (out.length >= MAX_FILES) fail('资源超过 2048 文件限制', 413)
        const content = await fs.readFile(file)
        out.push({ path: rel, content })
      } else fail('技能目录包含特殊文件或符号链接')
    }
  }
  await walk(path)
  return out
}

// Serialize mutations so simultaneous requests cannot bypass duplicate checks.
const queues = new Map()
async function mutate(root, action) {
  const key = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)
  const previous = queues.get(key) || Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    await noLinks(root)
    await fs.mkdir(root, { recursive: true })
    const path = join(root, '.library-mutation.lock')
    await noLinks(path)
    let handle
    try { handle = await fs.open(path, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') {
        error.status = 409
        error.message = '技能库被另一实例或未完成事务锁定: ' + path + '。请等待正在进行的操作；若进程已退出，请确认无实例写入后人工检查并移除此锁（不会自动删除存活或陈旧锁）。'
      }
      throw hostError(error, 'acquire-library-lock', undefined, path)
    }
    const identity = await handle.stat()
    let primary, result
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() }) + '\n')
      result = await action()
      return result
    } catch (error) { primary = error; throw error } finally {
      await handle.close()
      try {
        await noLinks(path)
        const current = await fs.lstat(path)
        if (!sameIdentity(current, identity)) fail('事务锁身份已改变，拒绝清理: ' + path, 409)
        await fs.unlink(path)
      } catch (error) {
        if (primary) primary.message += '；事务锁清理失败: ' + path + ': ' + error.message
        else if (result && typeof result === 'object') result.cleanupWarnings = [...(result.cleanupWarnings || []), '操作已完成，事务锁清理失败，请确认无写入实例后处理: ' + path + ': ' + error.message]
        else throw hostError(error, 'release-library-lock', undefined, path)
      }
    }
  })
  queues.set(key, next)
  try { return await next } finally { if (queues.get(key) === next) queues.delete(key) }
}
async function install(root, parsed, files, overwrite) {
  await noLinks(root)
  await fs.mkdir(root, { recursive: true })
  const target = join(root, parsed.name)
  await noLinks(target)
  const matching = (await scanSkills(root, true)).filter(skill => skill.name === parsed.name)
  const flat = join(root, parsed.name + '.md')
  await noLinks(flat)
  const targets = new Set(matching.map(skill => skill.storagePath))
  for (const path of [target, flat]) if (await exists(path)) targets.add(path)
  if (targets.size && overwrite !== true) fail('技能已存在，确认后使用 overwrite:true 覆盖: ' + parsed.name, 409)
  // Never replace an arbitrary directory that is not a skill bundle.
  for (const path of targets) {
    if ((await fs.lstat(path)).isDirectory() && !(await exists(join(path, 'SKILL.md')))) fail('目标目录不是技能，拒绝覆盖', 409)
    await noLinks(path)
  }
  if (!targets.size) {
    const bundle = await reserveBundle(target, noLinks)
    try {
      for (const file of files) if (file.path !== 'SKILL.md') await writeNew(bundle, safeRelative(file.path), file.content, noLinks)
      await writeNew(bundle, 'SKILL.md', parsed.content, noLinks)
      return parsed
    } catch (error) {
      try { await assertOwned(bundle, noLinks); await safeRemove(root, target) } catch (cleanupError) {
        error.status = 503; error.message += '；本次新建目录清理失败: ' + target + ': ' + cleanupError.message
      }
      throw error
    }
  }
  const stage = join(root, '.skm-stage-' + randomUUID())
  const backup = join(root, '.skm-backup-' + randomUUID())
  const moved = []
  let committed = false
  let rolledBack = false
  let operationError
  try {
    await fs.mkdir(stage)
    for (const file of files) {
      const dest = join(stage, safeRelative(file.path))
      if (!contained(stage, dest)) fail('非法资源路径')
      await fs.mkdir(dirname(dest), { recursive: true })
      await fs.writeFile(dest, file.path === 'SKILL.md' ? parsed.content : file.content, { flag: 'wx' })
    }
    if (!files.some(file => file.path === 'SKILL.md')) await fs.writeFile(join(stage, 'SKILL.md'), parsed.content, { flag: 'wx' })
    if (targets.size) await fs.mkdir(backup)
    for (const old of targets) {
      const saved = join(backup, String(moved.length))
      await noLinks(old)
      await renameRetry(old, saved)
      moved.push({ old, saved })
    }
    await renameRetry(stage, target)
    committed = true
  } catch (error) {
    operationError = error
    const unrestored = []
    for (const { old, saved } of moved.reverse()) {
      try { await renameRetry(saved, old) } catch (rollbackError) { unrestored.push(`${saved} -> ${old}: ${rollbackError.message}`) }
    }
    rolledBack = unrestored.length === 0
    if (!rolledBack) {
      error.status = 503
      error.message += '；回滚未完成，原资源仍安全保留在备份目录 ' + backup + '，请解除文件锁后恢复，勿删除备份: ' + unrestored.join('；')
    }
    throw error
  } finally {
    const warnings = []
    // Remove backups only after successful install or successful rollback.
    for (const path of committed || rolledBack ? [stage, backup] : [stage]) {
      try { await safeRemove(root, path) } catch (cleanupError) { warnings.push(`请解除锁定后清理 ${path}: ${cleanupError.message}`) }
    }
    if (warnings.length) {
      if (operationError) { operationError.message += '；' + warnings.join('；'); operationError.status = 503 }
      else parsed.cleanupWarnings = warnings
    }
  }
  return parsed
}
async function importSkill(root, body) {
  if (Object.hasOwn(body, 'overwrite') && typeof body.overwrite !== 'boolean') fail('overwrite 必须是布尔值')
  const modes = [typeof body.path === 'string', Object.hasOwn(body, 'files'), typeof body.name === 'string', typeof body.fileName === 'string'].filter(Boolean).length
  if (modes !== 1) fail('import 需要且只接受 path、files、name+content 或 fileName+content 其中一种')
  let parsed, files = []
  if (typeof body.path === 'string') {
    if (!body.path.trim()) fail('导入路径不能为空')
    const path = resolve(body.path.trim())
    await noLinks(path)
    const stat = await fs.lstat(path)
    if (stat.isDirectory()) {
      // Prevent importing a library/ancestor into itself and recursive staging.
      if (path === root || contained(path, root) || contained(root, path)) fail('不能从目标技能库或其父目录导入')
      files = await localFiles(path)
      const main = files.find(file => file.path === 'SKILL.md')
      if (!main) fail('目录需要 SKILL.md')
      parsed = prepare(main.content.toString('utf8'), basename(path))
    } else if (stat.isFile() && /\.(?:md|markdown)$/i.test(path)) {
      parsed = prepare(await fs.readFile(path, 'utf8'), basename(path).replace(/\.(?:md|markdown)$/i, ''))
    } else fail('路径必须是技能目录或 .md 文件')
  } else if (Object.hasOwn(body, 'files')) {
    files = validateFiles(body.files)
    const main = files.find(file => file.path === 'SKILL.md')
    parsed = prepare(main.content.toString('utf8'), typeof body.folderName === 'string' ? body.folderName.trim() : undefined)
  } else if (typeof body.name === 'string') {
    const name = validName(body.name.trim())
    parsed = prepare(body.content, name, typeof body.description === 'string' ? body.description.trim() : '', name)
  } else {
    if (!/\.(?:md|markdown)$/i.test(body.fileName) || /[\\/]/.test(body.fileName)) fail('fileName 必须是 .md 或 .markdown 文件名')
    parsed = prepare(body.content, body.fileName.replace(/\.(?:md|markdown)$/i, ''))
  }
  return install(root, parsed, files, body.overwrite)
}
async function deleteSkill(root, name) {
  validName(name)
  const matching = (await scanSkills(root, true)).filter(skill => skill.name === name)
  if (!matching.length) fail('技能不存在: ' + name, 404)
  // Resolve actual storage locations (frontmatter name may differ from filename).
  for (const skill of matching) await safeRemove(root, skill.storagePath)
  return { name }
}

const createLibrary = require('./library')
const API = '/' + NS + '/api'

module.exports = {
  name: NS,
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const library = createLibrary({ fail, noLinks, exists, safeRemove, contained, safeRelative, scanSkills, prepare, mutate, localFiles, MAX_FILES, frontmatter })
    const openLocalFile = require('./local-open').createLocalOpener()
    ctx.effect(() => () => library.dispose())
    let activation
    try {
      const { mountActivation } = require('./activation')
      if (typeof ctx.on === 'function') activation = mountActivation(ctx, { skillsRoot, loadLibrary: library.loadLibrary, sendJson, readJsonBody })
    } catch (error) {
      if (!(error.code === 'MODULE_NOT_FOUND' && /['"]\.\/activation['"]/.test(error.message))) throw error
    }
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix', path: '/' + NS + '/api',
      handler: async (req, res) => {
        try {
          // Fail closed: no standalone route may bypass the host trust gate.
          if (!ctx.connection || typeof ctx.connection.requestRejection !== 'function') { sendJson(res, 503, { error: '宿主请求认证不可用' }); return }
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
          const pathname = new URL(req.url || '/', 'http://dsh.local').pathname.replace(/\/+$/, '')
          const root = skillsRoot()
          library.observeRoot(root)
          if (activation && await activation.handle(req, res, pathname)) return
          if (req.method === 'GET' && pathname === API + '/library') {
            sendJson(res, 200, { ...await library.list(root), runtime: RUNTIME }); return
          }
          if (req.method === 'POST' && [API + '/import/preview', API + '/import/commit', API + '/library/create'].includes(pathname)) {
            const body = await readJsonBody(req)
            const result = pathname.endsWith('/preview') ? await library.preview(root, body, req) : pathname.endsWith('/commit') ? await library.commit(root, body, req) : await library.create(root, body)
            sendJson(res, 200, result); return
          }
          const localOpen = pathname.match(new RegExp('^' + API + '/library/skills/([^/]+)/open$'))
          if (req.method === 'POST' && localOpen) {
            const body = await readJsonBody(req)
            if (Object.keys(body).length || new URL(req.url || '/', 'http://dsh.local').search) fail('本地打开只接受 URL 中的技能 ID，不接受参数或路径')
            sendJson(res, 200, await library.open(root, decodeURIComponent(localOpen[1]), openLocalFile)); return
          }
          const librarySkill = pathname.match(new RegExp('^' + API + '/library/skills/([^/]+)$'))
          if (librarySkill && ['GET', 'PATCH', 'DELETE'].includes(req.method)) {
            const body = req.method === 'PATCH' ? await readJsonBody(req) : {}
            sendJson(res, 200, await library.skill(root, decodeURIComponent(librarySkill[1]), req.method, body)); return
          }
          const collection = pathname.match(new RegExp('^' + API + '/collections/([^/]+)$'))
          if ((req.method === 'POST' && pathname === API + '/collections') || (collection && ['PATCH', 'DELETE'].includes(req.method))) {
            const body = req.method === 'DELETE' ? {} : await readJsonBody(req)
            sendJson(res, 200, await library.collection(root, collection ? decodeURIComponent(collection[1]) : undefined, req.method, body)); return
          }
          if (req.method === 'GET' && pathname === BASE) {
            sendJson(res, 200, { skills: await mutate(root, () => scanSkills(root)), scope: 'user-dsh', root })
            return
          }
          const detail = pathname.match(new RegExp('^' + BASE + '/([^/]+)$'))
          if (req.method === 'GET' && detail) {
            const name = validName(decodeURIComponent(detail[1]))
            const skill = (await mutate(root, () => scanSkills(root))).find(skill => skill.name === name)
            if (!skill) fail('技能不存在: ' + name, 404)
            sendJson(res, 200, { skill }); return
          }
          if (req.method === 'POST' && (pathname === BASE + '/import' || pathname === BASE + '/create')) {
            const body = await readJsonBody(req)
            if (pathname.endsWith('/create') && typeof body.name !== 'string') fail('create 需要 name+content')
            const skill = await mutate(root, () => importSkill(root, body))
            sendJson(res, 200, { skill }); return
          }
          if (req.method === 'DELETE' && detail) {
            const name = validName(decodeURIComponent(detail[1]))
            sendJson(res, 200, await mutate(root, () => deleteSkill(root, name))); return
          }
          sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          const diagnostic = { code: error.code || 'VALIDATION_ERROR', operation: error.operation || `${req.method} ${new URL(req.url || '/', 'http://dsh.local').pathname}`, ...(error.source ? { source: error.source } : {}), ...(error.target || error.path ? { target: error.target || error.path } : {}), runtime: RUNTIME }
          sendJson(res, error.status || (error.code === 'ENOENT' ? 404 : ['EPERM', 'EBUSY', 'EACCES', 'EIO', 'ENOSPC', 'EROFS'].includes(error.code) ? 503 : 400), { error: String(error.message || error), diagnostic })
        }
      },
    }), NS + ': api route')
  },
}
