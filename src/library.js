'use strict'

// The physical host names never change when a user edits a display label.
const fs = require('node:fs/promises')
const { join, dirname, resolve, basename, relative } = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { renameRetry, reserveBundle, assertOwned, writeNew, PENDING, hostError } = require('./host-files')
const META = '.skill-library.json'
const TTL = 10 * 60 * 1000
const MAX_PENDING = 32
// Metadata is not an imported resource; retain its independent integrity budget.
const MAX_METADATA_BYTES = 16 * 1024 * 1024

module.exports = function createLibrary(h) {
  const { fail, noLinks, exists, safeRemove, contained, safeRelative, scanSkills, prepare, mutate, localFiles, MAX_FILES, frontmatter } = h
  const previews = new Map()
  let currentRoot
  function observeRoot(root) {
    if (currentRoot !== root) { previews.clear(); currentRoot = root }
    cleanup()
  }
  function cleanup() { for (const [token, p] of previews) if (p.expires <= Date.now()) previews.delete(token) }
  const timer = setInterval(cleanup, 60000)
  timer.unref()
  function label(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\x00-\x1f\x7f]/.test(value)) fail('displayName 必须是 1–200 字符的非空名称')
    return value.trim()
  }
  function owner(req) {
    // Bind the capability to the credential context AFTER the host gate accepted it.
    const headers = req.headers || {}
    return createHash('sha256').update(JSON.stringify([headers.authorization || '', headers.cookie || ''])).digest('hex')
  }
  async function cleanupPaths(root, paths) {
    const warnings = []
    for (const path of paths) {
      try { await safeRemove(root, path) } catch (error) { warnings.push(`清理临时路径失败，请解除锁定后清理 ${path}: ${error.message}`) }
    }
    return warnings
  }
  function cleanupFailure(error, warnings) {
    if (warnings.length) { error.message += '；' + warnings.join('；'); error.status = 503 }
  }
  async function save(root, metadata) {
    await noLinks(root)
    await fs.mkdir(root, { recursive: true })
    const target = join(root, META), temp = join(root, '.library-write-' + randomUUID())
    await noLinks(target)
    try {
      await fs.writeFile(temp, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      await renameRetry(temp, target)
    } catch (error) {
      cleanupFailure(error, await cleanupPaths(root, [temp])); throw error
    }
    return cleanupPaths(root, [temp])
  }
  async function load(root) {
    await noLinks(root)
    const target = join(root, META)
    await noLinks(target)
    let metadata = { version: 1, skills: [], collections: [] }
    if (await exists(target)) {
      const stat = await fs.stat(target)
      if (stat.size > MAX_METADATA_BYTES) fail('技能库元数据过大')
      try { metadata = JSON.parse(await fs.readFile(target, 'utf8')) } catch { fail('技能库元数据损坏，拒绝覆盖') }
      if (metadata.version !== 1 || !Array.isArray(metadata.skills) || !Array.isArray(metadata.collections)) fail('不支持的技能库元数据')
      const ids = new Set(), paths = new Set()
      for (const s of metadata.skills) {
        if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(s.id) || typeof s.name !== 'string') fail('技能库元数据损坏')
        label(s.displayName); safeRelative(s.storagePath)
        if (ids.has(s.id) || paths.has(s.storagePath.toLowerCase())) fail('技能库元数据重复')
        ids.add(s.id); paths.add(s.storagePath.toLowerCase())
      }
      const collectionIds = new Set()
      for (const c of metadata.collections) {
        if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(c.id) || collectionIds.has(c.id) || !Array.isArray(c.skillIds) || c.skillIds.some(id => typeof id !== 'string')) fail('集合元数据损坏')
        label(c.displayName); collectionIds.add(c.id)
      }
    }
    const before = JSON.stringify(metadata)
    const scanned = await scanSkills(root, true)
    const taken = new Set()
    const skills = scanned.map(s => {
      const storagePath = relative(root, s.storagePath).replace(/\\/g, '/')
      safeRelative(storagePath)
      let old = metadata.skills.find(x => x.storagePath === storagePath && x.name === s.name && !taken.has(x.id))
      // A legacy overwrite may relocate an oddly named bundle. Preserve its ID.
      if (!old && scanned.filter(x => x.name === s.name).length === 1) old = metadata.skills.find(x => x.name === s.name && !taken.has(x.id))
      const item = { id: old ? old.id : randomUUID(), name: s.name, displayName: old ? old.displayName : s.name, storagePath }
      taken.add(item.id)
      return { ...item, description: s.description, content: s.content }
    })
    metadata.skills = skills.map(({ id, name, displayName, storagePath }) => ({ id, name, displayName, storagePath }))
    metadata.collections = metadata.collections.map(c => ({ id: c.id, displayName: c.displayName, skillIds: [...new Set(c.skillIds.filter(id => taken.has(id)))] }))
    if (before !== JSON.stringify(metadata)) await save(root, metadata)
    return { metadata, skills }
  }
  const publicSkill = ({ storagePath, ...skill }) => skill
  async function list(root) { return mutate(root, async () => { const state = await load(root); return { skills: state.skills.map(publicSkill), collections: state.metadata.collections, root } }) }
  function buffers(files) {
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) fail('files 必须包含 1–2048 个文件')
    const keys = new Set()
    const result = files.map(f => {
      if (!f || !Buffer.isBuffer(f.content)) fail('资源 content 必须为 Buffer')
      const path = safeRelative(f.path), key = path.toLowerCase()
      if (keys.has(key)) fail('重复上传路径: ' + path)
      keys.add(key)
      return { path, content: f.content }
    })
    for (const key of keys) {
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i++) if (keys.has(parts.slice(0, i).join('/'))) fail('文件与目录路径冲突: ' + key)
    }
    return result
  }
  function uploaded(files) {
    if (!Array.isArray(files)) fail('files 必须是数组')
    return buffers(files.map(f => {
      if (!f || f.encoding !== 'base64' || typeof f.content !== 'string' || f.content.length % 4 || /[^A-Za-z0-9+/=]/.test(f.content)) fail('非法 base64 文件')
      const content = Buffer.from(f.content, 'base64')
      if (content.toString('base64') !== f.content) fail('非法 base64 文件')
      return { path: f.path, content }
    }))
  }
  function fallback(value) { return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : 'skill-' + randomUUID().slice(0, 8) }
  async function preview(root, body, req) {
    observeRoot(root)
    const modes = ['files', 'path', 'fileName', 'archive'].filter(key => Object.hasOwn(body, key))
    if (modes.length !== 1) fail('preview 只接受 files、path、fileName+content 或 archive 其中一种')
    let files, sourceName = body.sourceName
    if (modes[0] === 'files') files = uploaded(body.files)
    else if (modes[0] === 'path') {
      if (typeof body.path !== 'string' || !body.path.trim()) fail('导入路径不能为空')
      const path = resolve(body.path.trim())
      if (path === root || contained(path, root) || contained(root, path)) fail('不能从目标技能库或其父目录导入')
      await noLinks(path)
      const stat = await fs.lstat(path)
      sourceName ||= basename(path)
      if (stat.isDirectory()) files = buffers(await localFiles(path))
      else if (stat.isFile() && /\.(md|markdown)$/i.test(path)) {
        files = buffers([{ path: 'SKILL.md', content: await fs.readFile(path) }])
      } else fail('路径必须是技能目录或 .md 文件')
    } else if (modes[0] === 'archive') {
      if (!body.archive || typeof body.archive.fileName !== 'string' || typeof body.archive.content !== 'string') fail('archive 需要 fileName 和 base64 content')
      let archive
      try { archive = require('./archive') } catch (error) { if (error.code === 'MODULE_NOT_FOUND' && /['"]\.\/archive['"]/.test(error.message)) fail('archive 模块尚未安装', 501); throw error }
      files = buffers(await archive.readArchive(body.archive)); sourceName ||= body.archive.fileName
    } else {
      safeRelative(body.fileName)
      if (body.fileName.includes('/') || !/\.(md|markdown)$/i.test(body.fileName) || typeof body.content !== 'string') fail('fileName 必须是 .md 文件名，content 必须是文本')
      sourceName ||= body.fileName
      files = buffers([{ path: 'SKILL.md', content: Buffer.from(body.content) }])
    }
    const mains = files.filter(f => basename(f.path).toLowerCase() === 'skill.md')
    if (!mains.length) fail('没有找到 SKILL.md')
    if (mains.some(f => basename(f.path) !== 'SKILL.md')) fail('SKILL.md 文件名大小写必须完全一致')
    const roots = mains.map(f => f.path === 'SKILL.md' ? '' : f.path.slice(0, -8))
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i].toLowerCase(), b = roots[j].toLowerCase()
      if (!a || !b || a.startsWith(b) || b.startsWith(a)) fail('父子 SKILL.md 归属存在歧义，请拆分后导入')
    }
    const candidates = mains.map((main, i) => {
      const parsed = prepare(main.content.toString('utf8'), fallback(basename(roots[i].replace(/\/$/, '')) || String(sourceName || '').replace(/\.(md|markdown)$/i, '')))
      return { candidateId: randomUUID(), parsed, files: [] }
    })
    const warnings = []
    for (const file of files) {
      const matches = roots.map((prefix, i) => file.path.startsWith(prefix) ? i : -1).filter(i => i >= 0)
      if (!matches.length && /^(?:readme(?:\.[a-z0-9_-]+)?|licen[cs]e(?:\.[a-z0-9_-]+)?|notice(?:\.[a-z0-9_-]+)?|\.gitignore)$/i.test(basename(file.path))) {
        warnings.push('未复制技能目录外的仓库说明文件: ' + file.path)
        continue
      }
      if (matches.length !== 1) fail('资源不属于唯一技能目录，请拆分共享资源后导入: ' + file.path)
      const i = matches[0]
      candidates[i].files.push({ path: file.path.slice(roots[i].length), content: file.content })
    }
    cleanup()
    if (previews.size >= MAX_PENDING) fail('待确认导入过多，请提交或等待过期', 429)
    const token = randomUUID(), kind = candidates.length === 1 ? 'skill' : 'collection'
    const suggestedName = typeof sourceName === 'string' && sourceName.trim() ? sourceName.trim().slice(0, 200) : kind === 'skill' ? candidates[0].parsed.name : '新技能集合'
    if (currentRoot !== root) fail('技能库根目录已改变，请重新预览', 409)
    previews.set(token, { root, owner: owner(req), expires: Date.now() + TTL, candidates, kind, suggestedName })
    return { token, kind, suggestedName, skills: candidates.map(c => ({ candidateId: c.candidateId, name: c.parsed.name, displayName: c.parsed.name, description: c.parsed.description })), warnings }
  }
  function members(metadata, skillIds) {
    if (!Array.isArray(skillIds) || skillIds.some(id => typeof id !== 'string' || !metadata.skills.some(s => s.id === id))) fail('skillIds 包含未知技能')
    return [...new Set(skillIds)]
  }
  async function installBatch(root, state, candidates, displayNames, collectionName) {
    await noLinks(root)
    await fs.mkdir(root, { recursive: true })
    const installed = []
    const output = []
    try {
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]
        let name = c.parsed.name
        if (state.metadata.skills.some(s => s.name === name) || output.some(s => s.name === name) || await exists(join(root, name)) || await exists(join(root, name + '.md'))) name = 'skill-' + randomUUID()
        const parsed = name === c.parsed.name ? c.parsed : prepare(c.parsed.content.replace(/^(name\s*:\s*).*$/m, '$1' + name), name)
        // prepare validated the YAML; replace only its actual top-level name field.
        if (parsed.name !== name) fail('不能安全分配独立内部名称')
        const target = join(root, name)
        const bundle = await reserveBundle(target, noLinks)
        installed.push(bundle)
        await writeNew(bundle, PENDING, JSON.stringify({ version: 1 }), noLinks)
        for (const file of c.files) {
          if (file.path === 'SKILL.md') continue
          if (file.path === PENDING) fail('资源路径与导入事务标记冲突')
          await writeNew(bundle, safeRelative(file.path), file.content, noLinks)
        }
        const skill = { id: randomUUID(), name, displayName: displayNames[i], description: parsed.description, content: parsed.content }
        output.push(skill)
        bundle.content = parsed.content
        state.metadata.skills.push({ id: skill.id, name, displayName: skill.displayName, storagePath: name })
      }
      const collection = collectionName ? { id: randomUUID(), displayName: collectionName, skillIds: output.map(s => s.id) } : undefined
      if (collection) state.metadata.collections.push(collection)
      // Publish only after ALL resources are complete. The host scanner may
      // briefly see complete bundles before metadata commit: this is not an
      // OS-atomic multi-directory transaction. Plugin scans gate on metadata.
      for (const bundle of installed) await writeNew(bundle, 'SKILL.md', bundle.content, noLinks)
      const cleanupWarnings = await save(root, state.metadata)
      for (const bundle of installed) {
        try { await assertOwned(bundle, noLinks); await fs.unlink(join(bundle.target, PENDING)) } catch (error) { cleanupWarnings.push('导入已提交，事务标记清理失败: ' + bundle.target + ': ' + error.message) }
      }
      return { skills: output, ...(collection ? { collection } : {}), ...(cleanupWarnings.length ? { cleanupWarnings } : {}) }
    } catch (error) {
      const remaining = []
      for (const bundle of installed.reverse()) {
        try {
          await assertOwned(bundle, noLinks)
          // Withdraw invocation before attempting recursive cleanup.
          await fs.unlink(join(bundle.target, 'SKILL.md')).catch(error => { if (error.code !== 'ENOENT') throw error })
          await safeRemove(root, bundle.target)
        } catch (rollbackError) { remaining.push(bundle.target + ' (' + rollbackError.message + ')') }
      }
      if (remaining.length) {
        error.status = 503
        error.message += '；集合回滚清理被锁定，已有技能和元数据未被覆盖。请关闭占用后清理以下本次新建目录，再重新预览导入: ' + remaining.join('；')
      }
      throw error
    }
  }
  async function commit(root, body, req) {
    observeRoot(root)
    const p = previews.get(body.token)
    if (!p || p.root !== root || p.owner !== owner(req)) fail('预览 token 无效、过期或不属于当前认证范围', 403)
    const displayName = label(body.displayName)
    const names = body.names === undefined ? {} : body.names
    if (!names || typeof names !== 'object' || Array.isArray(names) || Object.keys(names).some(id => !p.candidates.some(c => c.candidateId === id))) fail('names 包含未知 candidateId')
    const displayNames = p.candidates.map(c => Object.hasOwn(names, c.candidateId) ? label(names[c.candidateId]) : p.kind === 'skill' ? displayName : c.parsed.name)
    // Consume before entering the shared queue: simultaneous replay cannot commit twice.
    previews.delete(body.token)
    return mutate(root, async () => {
      if (currentRoot !== root || p.expires <= Date.now()) fail('预览已失效，请重新预览', 409)
      const state = await load(root)
      return installBatch(root, state, p.candidates, displayNames, p.kind === 'collection' ? displayName : undefined)
    })
  }
  async function create(root, body) {
    const displayName = label(body.displayName)
    const name = 'skill-' + randomUUID()
    const parsed = prepare(body.content, name, body.description)
    return mutate(root, async () => { const state = await load(root); const r = await installBatch(root, state, [{ parsed, files: [] }], [displayName]); return { skill: r.skills[0], ...(r.cleanupWarnings ? { cleanupWarnings: r.cleanupWarnings } : {}) } })
  }
  const revisionOf = content => createHash('sha256').update(content).digest('hex')
  async function editable(root, found) {
    safeRelative(found.storagePath)
    const storage = join(root, found.storagePath)
    if (!contained(root, storage)) fail('非法技能路径')
    await noLinks(storage)
    const entry = await fs.lstat(storage)
    const target = entry.isFile() ? storage : entry.isDirectory() ? join(storage, 'SKILL.md') : undefined
    if (!target) fail('技能存储不是普通文件或目录')
    await noLinks(target)
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.nlink !== 1) fail('编辑目标必须是独立普通文件（不允许链接）')
    // Read through the verified handle, not a second path lookup that could
    // resolve a replacement/link after lstat. Node has no portable rename-CAS;
    // hostile writers with directory access still require OS ACL isolation.
    let handle, bytes
    try {
      handle = await fs.open(target, 'r')
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) fail('读取期间技能文件身份已改变，拒绝编辑', 409)
      bytes = await handle.readFile()
      await noLinks(target)
      const after = await fs.lstat(target)
      if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) fail('读取期间技能文件身份已改变，拒绝编辑', 409)
    } catch (error) { throw hostError(error, 'read-edit-document', undefined, target) } finally { if (handle) await handle.close() }
    const content = bytes.toString('utf8')
    if (!Buffer.from(content).equals(bytes)) fail('技能文件不是有效 UTF-8，拒绝有损编辑')
    const parsed = prepare(content, found.name, found.description, found.name)
    if (parsed.content !== content) fail('现有技能缺少完整 frontmatter，拒绝隐式修改')
    return { target, stat, bytes, content, revision: revisionOf(bytes) }
  }
  async function editContent(root, found, body, state) {
    if (typeof body.content !== 'string' || !body.content.trim()) fail('技能正文（content）不能为空')
    if (typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) fail('expectedRevision 必须是 GET 返回的 sha256 revision')
    const original = await editable(root, found)
    if (original.revision !== body.expectedRevision) fail('技能已被修改，请重新加载后合并修改', 409)
    const oldFm = frontmatter(original.content)
    // Bare Markdown edits replace only the body. Full Markdown may edit YAML,
    // but never the immutable host name or invalid invocation fields.
    const newFm = frontmatter(body.content)
    if (newFm && (newFm.data.name !== found.name || typeof newFm.data.description !== 'string' || !newFm.data.description.trim())) fail('完整 Markdown 必须保留原 name 和非空 description')
    const raw = newFm ? body.content : `---\n${oldFm.yaml}---\n${body.content}`
    const parsed = prepare(raw, found.name, found.description, found.name)
    const nextDisplay = Object.hasOwn(body, 'displayName') ? label(body.displayName) : found.displayName
    const temp = join(dirname(original.target), '.library-edit-' + randomUUID())
    const backup = join(dirname(original.target), '.library-backup-' + randomUUID())
    let replaced = false, keepBackup = false
    let cleanupWarnings = []
    try {
      await fs.writeFile(temp, parsed.content, { flag: 'wx', mode: original.stat.mode & 0o777 })
      await fs.writeFile(backup, original.bytes, { flag: 'wx', mode: original.stat.mode & 0o777 })
      const check = await editable(root, found)
      if (check.stat.dev !== original.stat.dev || check.stat.ino !== original.stat.ino || check.revision !== original.revision) fail('技能文件身份或内容已改变，请重新加载', 409)
      await renameRetry(temp, original.target)
      replaced = true
      if (nextDisplay !== found.displayName) {
        state.metadata.skills.find(s => s.id === found.id).displayName = nextDisplay
        cleanupWarnings.push(...await save(root, state.metadata))
      }
      const revision = revisionOf(Buffer.from(parsed.content))
      cleanupWarnings.push(...await cleanupPaths(root, [temp, backup]))
      return { skill: { ...publicSkill(found), ...parsed, displayName: nextDisplay, revision }, revision, ...(cleanupWarnings.length ? { cleanupWarnings } : {}) }
    } catch (error) {
      if (replaced) {
        try {
          const check = await editable(root, found)
          if (check.revision !== revisionOf(Buffer.from(parsed.content))) fail('回滚前文件又被修改，保留备份，拒绝覆盖', 409)
          await renameRetry(backup, original.target)
        } catch (rollbackError) {
          keepBackup = true
          error.message += `；回滚未完成，原文件备份保留于 ${backup}。请解除锁定后恢复；${rollbackError.message}`
          error.status = 503
        }
      }
      cleanupFailure(error, await cleanupPaths(root, keepBackup ? [temp] : [temp, backup]))
      throw error
    }
  }
  async function skill(root, id, method, body) {
    return mutate(root, async () => {
      const state = await load(root), found = state.skills.find(s => s.id === id)
      if (!found) fail('技能不存在', 404)
      if (method === 'GET') {
        const detail = await editable(root, found)
        return { skill: { ...publicSkill(found), content: detail.content, revision: detail.revision }, revision: detail.revision, document: { path: detail.target, storagePath: found.storagePath, sha256: detail.revision, identity: { dev: String(detail.stat.dev), ino: String(detail.stat.ino), nlink: detail.stat.nlink } } }
      }
      if (method === 'PATCH') {
        if (Object.keys(body).some(key => !['content', 'expectedRevision', 'displayName'].includes(key))) fail('PATCH 仅接受 content、expectedRevision 和 displayName')
        if (Object.hasOwn(body, 'content')) return editContent(root, found, body, state)
        if (Object.hasOwn(body, 'expectedRevision')) fail('expectedRevision 必须与 content 一起提供')
        found.displayName = label(body.displayName)
        state.metadata.skills.find(s => s.id === id).displayName = found.displayName
        await save(root, state.metadata); return { skill: publicSkill(found) }
      }
      const target = join(root, found.storagePath), backup = join(root, '.library-delete-' + randomUUID())
      if (!contained(root, target)) fail('非法技能路径')
      await noLinks(target); await renameRetry(target, backup)
      try {
        state.metadata.skills = state.metadata.skills.filter(s => s.id !== id)
        state.metadata.collections.forEach(c => { c.skillIds = c.skillIds.filter(x => x !== id) })
        await save(root, state.metadata)
      } catch (error) {
        try { await renameRetry(backup, target) } catch (rollbackError) {
          error.status = 503
          error.message += `；回滚未完成，原资源保留在 ${backup}，请解除锁定后恢复，勿删除备份: ${rollbackError.message}`
        }
        throw error
      }
      await safeRemove(root, backup)
      return { id }
    })
  }
  async function open(root, id, openFile) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id)) fail('非法技能 ID')
    return mutate(root, async () => {
      const state = await load(root), found = state.skills.find(s => s.id === id)
      if (!found) fail('技能不存在', 404)
      // Share exactly the edit/read path checks: safe metadata-relative path,
      // ancestors without symlinks/junctions, independent regular file, verified
      // descriptor identity, UTF-8/frontmatter. Never open a request-supplied path.
      const document = await editable(root, found)
      if (!/\.md$/i.test(document.target)) fail('本地打开仅支持受管 Markdown 文件')
      await noLinks(document.target)
      const current = await fs.lstat(document.target)
      if (!current.isFile() || current.nlink !== 1 || current.dev !== document.stat.dev || current.ino !== document.stat.ino) fail('打开前技能文件身份已改变', 409)
      // A default application must reopen by pathname. No portable API can bind
      // its later open to our descriptor; hostile concurrent writers require ACL
      // isolation, just as edit's final rename does. No document is written here.
      await openFile(document.target)
      return { opened: true }
    })
  }
  async function collection(root, id, method, body) {
    return mutate(root, async () => {
      const { metadata } = await load(root)
      let c
      if (method === 'POST') { c = { id: randomUUID(), displayName: label(body.displayName), skillIds: members(metadata, body.skillIds || []) }; metadata.collections.push(c) }
      else {
        c = metadata.collections.find(c => c.id === id)
        if (!c) fail('集合不存在', 404)
        if (method === 'DELETE') metadata.collections = metadata.collections.filter(c => c.id !== id)
        else {
          if (Object.hasOwn(body, 'displayName')) c.displayName = label(body.displayName)
          if (Object.hasOwn(body, 'skillIds')) c.skillIds = members(metadata, body.skillIds)
        }
      }
      await save(root, metadata)
      return method === 'DELETE' ? { id } : { collection: c }
    })
  }
  async function loadLibrary(root) {
    return mutate(root, async () => {
      const state = await load(root)
      return { skills: await Promise.all(state.skills.map(async s => {
        const storagePath = join(root, s.storagePath)
        const flat = (await fs.lstat(storagePath)).isFile()
        const path = flat ? storagePath : join(storagePath, 'SKILL.md')
        const fm = frontmatter(s.content)
        return { ...publicSkill(s), storagePath, path, resourceBase: flat ? dirname(storagePath) : storagePath, invocation: fm ? fm.data : {}, yaml: fm ? fm.yaml : '' }
      })) }
    })
  }
  function dispose() { clearInterval(timer); previews.clear() }
  return { observeRoot, list, preview, commit, create, skill, open, collection, loadLibrary, dispose }
}
