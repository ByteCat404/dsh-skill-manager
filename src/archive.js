'use strict'

// Never extract archive paths onto the filesystem. List and validate first, then
// stream each exact regular entry to stdout, bounded by its declared size.
const fs = require('node:fs/promises')
const { join, extname, isAbsolute } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const MAX_ENTRIES = 2048
const MAX_LIST = 4 * 1024 * 1024
const MAX_STDERR = 64 * 1024
const JOB_TIMEOUT = 120000
let active = 0

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }) }
function safePath(raw, directory = false) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || /[\x00-\x1f\x7f]/.test(raw)) fail('归档包含非法路径')
  const name = raw.replace(/\\/g, '/')
  if (name.startsWith('/') || name.includes(':')) fail('归档不允许绝对路径或 ADS')
  const parts = (directory ? name.replace(/\/$/, '') : name).split('/')
  if (parts.length > 32 || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p))) fail('归档包含不安全路径或设备名')
  return parts.join('/')
}
function decodeInput({ fileName, content } = {}) {
  const type = typeof fileName === 'string' ? extname(fileName).slice(1).toLowerCase() : ''
  if (!['zip', 'rar', '7z'].includes(type)) fail('仅支持 ZIP、RAR、7z 归档')
  if (typeof content !== 'string' || !content) fail('归档内容必须为非空 base64')
  // Avoid a repeated-group regexp: valid multi-MiB payloads can overflow V8's
  // regexp stack. Buffer round-trip below checks padding and unused bits.
  if (content.length % 4 || /[^A-Za-z0-9+/=]/.test(content)) fail('归档内容不是严格 base64')
  const bytes = Buffer.from(content, 'base64')
  if (bytes.toString('base64') !== content) fail('归档内容不是规范 base64')
  const magic = type === 'zip' ? bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 5, 6]))
    : type === '7z' ? bytes.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
      : bytes.subarray(0, 7).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0])) || bytes.subarray(0, 8).equals(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 1, 0]))
  if (!magic) fail('归档扩展名与文件签名不符（不支持自解压文件）')
  return { type, bytes }
}
// ZIP central-directory metadata is checked independently of the CLI listing,
// including Unix file types which Windows extraction tools can otherwise hide.
function preflightZip(bytes) {
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
  }
  if (end < 0) fail('ZIP 中央目录损坏')
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || offset === 0xffffffff || size === 0xffffffff) fail('不支持分卷或 ZIP64 归档')
  if (count > MAX_ENTRIES || offset + size !== end) fail('ZIP 中央目录超限或损坏')
  let pos = offset
  const paths = new Set()
  for (let n = 0; n < count; n++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) fail('ZIP entry 损坏')
    const flags = bytes.readUInt16LE(pos + 8), packed = bytes.readUInt32LE(pos + 20), unpacked = bytes.readUInt32LE(pos + 24)
    const length = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32)
    const attrs = bytes.readUInt32LE(pos + 38), local = bytes.readUInt32LE(pos + 42)
    const next = pos + 46 + length + extra + comment
    if (next > end || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(pos + 34)) fail('ZIP entry 边界损坏')
    if (flags & 1 || unpacked === 0xffffffff || packed === 0xffffffff) fail('不支持加密或 ZIP64 entry')
    const raw = bytes.subarray(pos + 46, pos + 46 + length)
    const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28)
    if (local + 30 + localLength + localExtra + packed > offset || !raw.equals(bytes.subarray(local + 30, local + 30 + localLength))) fail('ZIP 本地路径与中央目录不一致')
    let name
    try { name = flags & 0x800 ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : raw.toString('latin1') } catch { fail('ZIP 路径编码损坏') }
    const unixType = (attrs >>> 16) & 0xf000
    if (unixType && unixType !== 0x8000 && unixType !== 0x4000) fail('归档不允许 links 或特殊文件')
    // Unicode path extra fields can override the legacy filename in 7-Zip.
    let ep = pos + 46 + length
    while (ep < pos + 46 + length + extra) {
      if (ep + 4 > pos + 46 + length + extra) fail('ZIP extra 损坏')
      const tag = bytes.readUInt16LE(ep), len = bytes.readUInt16LE(ep + 2)
      if (ep + 4 + len > pos + 46 + length + extra) fail('ZIP extra 损坏')
      if (tag === 0x7075) {
        if (len < 5) fail('ZIP Unicode path 损坏')
        try { safePath(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(ep + 9, ep + 4 + len)), name.endsWith('/')) } catch { fail('ZIP Unicode path 不安全') }
      }
      ep += 4 + len
    }
    const normalized = safePath(name, name.endsWith('/') || unixType === 0x4000).normalize('NFC').toLowerCase()
    if (paths.has(normalized)) fail('归档路径重复或大小写冲突')
    paths.add(normalized)
    if (unpacked > 1024 * 1024 && unpacked > Math.max(1, packed) * 1000) fail('归档压缩比超限', 413)
    pos = next
  }
  if (pos !== end) fail('ZIP entry 数量不一致')
  return count
}
function parseListing(text, expectedCount) {
  const body = text.replace(/(?:\r?\n)+$/, '')
  const records = body ? body.split(/\r?\n\r?\n/) : []
  if (records.length > MAX_ENTRIES || (expectedCount !== undefined && records.length !== expectedCount)) fail('归档 entry 数量超限或列表不一致', 413)
  const files = [], seen = new Map()
  for (const record of records) {
    const fields = Object.create(null)
    for (const line of record.split(/\r?\n/)) {
      const at = line.indexOf(' = ')
      if (at <= 0) fail('无法安全解析归档列表（文件名不可含换行）: ' + JSON.stringify(line).slice(0, 160))
      const key = line.slice(0, at), value = line.slice(at + 3)
      if (Object.hasOwn(fields, key) || !/^[A-Za-z][A-Za-z0-9 ()/-]*$/.test(key)) fail('归档列表字段歧义')
      fields[key] = value
    }
    if (!Object.hasOwn(fields, 'Path') || !Object.hasOwn(fields, 'Size')) fail('归档列表缺少路径或大小')
    if (fields.Encrypted === '+' || fields.SplitBefore === '+' || fields.SplitAfter === '+') fail('不支持加密或分卷归档')
    for (const [key, value] of Object.entries(fields)) {
      if (/link|reparse|alternate stream/i.test(key) && value && value !== '-') fail('归档不允许 links、reparse 或 ADS')
    }
    const attrs = fields.Attributes || ''
    const mode = attrs.match(/(?:^|\s)([bcdlps-])[rwxstST-]{9}(?:\s|$)/)
    if (mode && !['d', '-'].includes(mode[1])) fail('归档不允许 links 或特殊文件')
    if (/\b(?:Symbolic|Hard|Reparse)\b/i.test(attrs)) fail('归档不允许 links')
    const directory = fields.Folder === '+' || /^D/.test(attrs) || (mode && mode[1] === 'd') || /[\\/]$/.test(fields.Path)
    const path = safePath(fields.Path, directory), canonical = path.normalize('NFC').toLowerCase()
    if (seen.has(canonical)) fail('归档路径重复或大小写冲突')
    seen.set(canonical, directory)
    if (!/^\d+$/.test(fields.Size)) fail('归档 entry 大小无效')
    const size = Number(fields.Size)
    if (!Number.isSafeInteger(size)) fail('归档 entry 大小无效', 413)
    if (directory) { if (size) fail('归档目录包含数据'); continue }
    if (fields['Packed Size'] && /^\d+$/.test(fields['Packed Size'])) {
      const packed = Number(fields['Packed Size'])
      if (size > 1024 * 1024 && packed > 0 && size > packed * 1000) fail('归档压缩比超限', 413)
    }
    files.push({ path, original: fields.Path, size })
  }
  for (const [path] of seen) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) if (seen.get(parts.slice(0, i).join('/')) === false) fail('归档文件与目录路径冲突')
  }
  return files
}
function run(binary, args, maxOutput, timeout, cwd) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(binary, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { reject(error); return }
    const chunks = [], errors = []
    let size = 0, errorSize = 0, failure
    const stop = error => { if (!failure) { failure = error; child.kill('SIGKILL') } }
    const timer = setTimeout(() => stop(Object.assign(new Error('归档处理超时'), { status: 413 })), Math.max(1, timeout))
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxOutput) stop(Object.assign(new Error('归档输出超过安全限额'), { status: 413 })); else if (!failure) chunks.push(chunk) })
    child.stderr.on('data', chunk => { errorSize += chunk.length; if (errorSize > MAX_STDERR) stop(Object.assign(new Error('归档错误输出超限'), { status: 413 })); else errors.push(chunk) })
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(new Error('无法启动捆绑的 7-Zip: ' + error.message), { status: 503 })) })
    child.on('close', code => {
      clearTimeout(timer)
      if (failure) reject(failure)
      else if (code !== 0) reject(Object.assign(new Error('7-Zip 拒绝该归档（损坏、加密、分卷或不支持）: ' + Buffer.concat(errors).toString('utf8').slice(0, 512)), { status: 400 }))
      else resolve(Buffer.concat(chunks, size))
    })
  })
}
async function readArchive(input) {
  if (active >= 2) fail('归档处理忙，请稍后重试', 429)
  active++
  let temp
  try {
    const { type, bytes } = decodeInput(input)
    const count = type === 'zip' ? preflightZip(bytes) : undefined
    let binary
    try { binary = require('7zip-bin-full').path7z } catch { fail('缺少捆绑的 7-Zip 依赖，请重新安装插件', 503) }
    if (typeof binary !== 'string' || !isAbsolute(binary)) fail('当前平台没有可用的捆绑 7-Zip（禁止 USE_SYSTEM_7Z 系统回退）', 503)
    try { await fs.access(binary, require('node:fs').constants.X_OK) } catch { fail('捆绑 7-Zip 不存在或不可执行，请检查插件依赖/平台与执行权限', 503) }
    temp = await fs.mkdtemp(join(tmpdir(), 'dsh-skill-archive-'))
    const archive = join(temp, 'input.' + type)
    await fs.writeFile(archive, bytes, { flag: 'wx', mode: 0o600 })
    const deadline = Date.now() + JOB_TIMEOUT
    const remaining = () => { const value = deadline - Date.now(); if (value <= 0) fail('归档处理超时', 413); return Math.min(30000, value) }
    const common = ['-bd', '-y', '-sccUTF-8', '-mmt1', '-p__dsh_no_encrypted_archives__']
    const listed = await run(binary, ['l', '-slt', '-ba', ...common, '--', archive], MAX_LIST, remaining(), temp)
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(listed) } catch { fail('归档列表编码无效') }
    const entries = parseListing(text, count)
    const result = []
    for (const entry of entries) {
      const content = await run(binary, ['x', '-so', '-spd', '-ssc', ...common, '--', archive, entry.original], entry.size, remaining(), temp)
      if (content.length !== entry.size) fail('归档 entry 实际大小与预检不符')
      result.push({ path: entry.path, content })
    }
    return result
  } finally {
    try { if (temp) await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) } finally { active-- }
  }
}
module.exports = { readArchive, _test: { safePath, decodeInput, preflightZip, parseListing, run } }
