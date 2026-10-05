import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { readArchive, _test } = require('../src/archive.js')
// Table-based CRC keeps the real 19 MiB store-ZIP fixture cheap to construct.
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const locals = [], central = []
  let offset = 0
  for (const { path, content = '', attrs = 0, size } of entries) {
    const name = Buffer.from(path), data = Buffer.isBuffer(content) ? content : Buffer.from(content), crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size ?? data.length, 22); local.writeUInt16LE(name.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50); head.writeUInt16LE(0x314, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x800, 8)
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(size ?? data.length, 24); head.writeUInt16LE(name.length, 28)
    head.writeUInt32LE(attrs >>> 0, 38); head.writeUInt32LE(offset, 42)
    locals.push(local, name, data); central.push(head, name); offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
// Minimal real RAR4 store archive, no proprietary RAR writer needed.
function rar(path, content) {
  const name = Buffer.from(path), data = Buffer.from(content)
  const main = Buffer.alloc(13); main[2] = 0x73; main.writeUInt16LE(13, 5); main.writeUInt16LE(crc32(main.subarray(2)) & 65535)
  const file = Buffer.alloc(32 + name.length); file[2] = 0x74; file.writeUInt16LE(0x8000, 3); file.writeUInt16LE(file.length, 5)
  file.writeUInt32LE(data.length, 7); file.writeUInt32LE(data.length, 11); file[15] = 2; file.writeUInt32LE(crc32(data), 16); file[24] = 20; file[25] = 0x30
  file.writeUInt16LE(name.length, 26); file.writeUInt32LE(0x20, 28); name.copy(file, 32); file.writeUInt16LE(crc32(file.subarray(2)) & 65535)
  const end = Buffer.alloc(7); end[2] = 0x7b; end.writeUInt16LE(7, 5); end.writeUInt16LE(crc32(end.subarray(2)) & 65535)
  return Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0]), main, file, data, end])
}
const input = (bytes, type = 'zip') => ({ fileName: 'skills.' + type, content: bytes.toString('base64') })
test('strict base64 and magic validation', async () => {
  // Valid large base64 must not trigger V8 regexp-stack overflow.
  const large = zip([{ path: 'large.bin', content: Buffer.alloc(8 * 1024 * 1024, 97) }])
  assert.deepEqual(_test.decodeInput(input(large)).bytes, large)
  for (const content of ['a', '!!!!', 'YWJj\n', 'AB==', 'AAAA====', 'AA=A', '=AAA']) await assert.rejects(readArchive({ fileName: 'x.zip', content }), /base64/)
  await assert.rejects(readArchive(input(Buffer.from('bad'))), /签名/)
  await assert.rejects(readArchive({ fileName: 'x.exe', content: 'AAAA' }), /仅支持/)
})
test('portable paths reject traversal, ADS, devices, ambiguous names', () => {
  for (const path of ['../a', 'a/../b', '/a', '\\server\\a', 'C:/a', 'a:x', 'a/NUL.txt', 'COM¹', 'a.', 'a ', 'a//b', 'a\nb', 'a/*', 'a/./b']) assert.throws(() => _test.safePath(path))
  assert.equal(_test.safePath('wrapper\\中文技能\\SKILL.md'), 'wrapper/中文技能/SKILL.md')
})
test('ZIP preflight rejects links, collisions, bombs and header disagreement', async () => {
  for (const entries of [
    [{ path: '../SKILL.md' }], [{ path: 'NUL.txt' }], [{ path: 'a:stream' }],
    [{ path: 'link', attrs: 0xa1ff0000 }], [{ path: 'fifo', attrs: 0x11ff0000 }],
    [{ path: 'A.md' }, { path: 'a.md' }],
  ]) await assert.rejects(readArchive(input(zip(entries))))
  // Tiny packed content with huge declared output must still hit the ratio
  // guard, rather than relying on the removed absolute 16 MiB threshold.
  const bomb = zip([{ path: 'bomb', content: 'x', size: 19 * 1024 * 1024 }])
  assert.throws(() => _test.preflightZip(bomb), /压缩比/)
  await assert.rejects(readArchive(input(bomb)), error => error.status === 413 && /压缩比/.test(error.message))
  assert.throws(() => _test.preflightZip(zip(Array.from({ length: 2049 }, (_, i) => ({ path: 'f' + i })))), /超限/)
  const mismatch = zip([{ path: 'a.md' }]); mismatch[30] = 'b'.charCodeAt(0)
  assert.throws(() => _test.preflightZip(mismatch), /不一致/)
})
test('listing metadata rejects special files and directory-file collisions', () => {
  for (const text of [
    'Path = a\nSize = 0\nSymbolic Link = target',
    'Path = a\nSize = 0\nAttributes = A lrwxrwxrwx',
    'Path = a\nSize = 0\nEncrypted = +',
    'Path = a\nSize = 0\nPath = b',
    'Path = a\nSize = 0\n\nPath = a/b\nSize = 0',
    'Path = a\nSize = 0\nmalformed',
  ]) assert.throws(() => _test.parseListing(text))
})
test('real ZIP and RAR preserve nested binary and Chinese paths', async () => {
  const binary = Buffer.from([0, 255, 1, 2, 128])
  const entries = await readArchive(input(zip([{ path: 'wrapper/中文/skill/SKILL.md', content: '# skill' }, { path: 'wrapper/中文/skill/assets/a.bin', content: binary }])))
  assert.deepEqual(entries.map(x => x.path), ['wrapper/中文/skill/SKILL.md', 'wrapper/中文/skill/assets/a.bin'])
  assert.deepEqual(entries[1].content, binary)
  const rarEntries = await readArchive(input(rar('wrapper/skill/SKILL.md', '# rar skill'), 'rar'))
  assert.equal(rarEntries[0].path, 'wrapper/skill/SKILL.md'); assert.equal(rarEntries[0].content.toString(), '# rar skill')
})
test('real store ZIP above 16 MiB decodes, lists and extracts exact bytes without triggering ratio guard', async () => {
  const bytes = Buffer.alloc(19 * 1024 * 1024, 0xa5)
  bytes[0] = 0; bytes[bytes.length - 1] = 0xff
  // Method 0 stores data directly, so packed and unpacked resource sizes match.
  const archive = zip([{ path: 'skill/SKILL.md', content: '# large skill' }, { path: 'skill/huge.bin', content: bytes }])
  assert.ok(archive.length > 16 * 1024 * 1024)
  assert.equal(_test.preflightZip(archive), 2)
  const entries = await readArchive(input(archive))
  assert.equal(entries.length, 2)
  assert.equal(entries[0].content.toString(), '# large skill')
  assert.equal(entries[1].path, 'skill/huge.bin')
  assert.deepEqual(entries[1].content, bytes)
})
test('listing large valid sizes accepts bytes but still rejects compression ratios and excessive file counts', () => {
  const size = 19 * 1024 * 1024
  const entries = _test.parseListing(`Path = huge.bin\nSize = ${size}\nPacked Size = ${size}`)
  assert.equal(entries.length, 1); assert.equal(entries[0].size, size)
  assert.throws(() => _test.parseListing(`Path = bomb\nSize = ${size}\nPacked Size = 1`), /压缩比/)
  assert.throws(() => _test.parseListing(Array.from({ length: 2049 }, (_, i) => `Path = f${i}\nSize = 0`).join('\n\n')), /超限/)
  assert.throws(() => _test.parseListing('Path = invalid\nSize = 9007199254740992'))
})
test('real 7z fixture and corruption fail closed', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'archive-test-'))
  try {
    await mkdir(join(temp, 'wrapper', 'skill'), { recursive: true })
    await writeFile(join(temp, 'wrapper', 'skill', 'SKILL.md'), '# seven skill')
    const binary = require('7zip-bin-full').path7z
    const created = spawnSync(binary, ['a', '-t7z', '-bd', '-y', '--', join(temp, 'fixture.7z'), 'wrapper'], { cwd: temp, stdio: 'inherit', windowsHide: true })
    assert.equal(created.status, 0)
    const bytes = await readFile(join(temp, 'fixture.7z'))
    const entries = await readArchive(input(bytes, '7z'))
    assert.equal(entries.length, 1); assert.equal(entries[0].path, 'wrapper/skill/SKILL.md'); assert.equal(entries[0].content.toString(), '# seven skill')
    await assert.rejects(readArchive(input(bytes.subarray(0, bytes.length - 4), '7z')))
  } finally { await rm(temp, { recursive: true, force: true }) }
})
test('CRC mismatch rejects and parallel jobs are bounded', async () => {
  const bytes = zip([{ path: 'skill/SKILL.md', content: '# skill' }])
  const corrupted = Buffer.from(bytes); corrupted[30 + Buffer.byteLength('skill/SKILL.md')] ^= 1
  await assert.rejects(readArchive(input(corrupted)), /7-Zip 拒绝/)
  const first = readArchive(input(bytes)), second = readArchive(input(bytes))
  await assert.rejects(readArchive(input(bytes)), error => error.status === 429)
  await Promise.all([first, second])
})
test('export reusable browser fixtures when ARCHIVE_EXPORT_FIXTURES is set', { skip: !process.env.ARCHIVE_EXPORT_FIXTURES }, async () => {
  const root = process.env.ARCHIVE_EXPORT_FIXTURES
  await mkdir(root, { recursive: true })
  const fixtures = [
    { path: 'download/release/alpha-demo/SKILL.md', content: '---\nname: alpha-demo\ndescription: Archive browser verification alpha\n---\n\n# Alpha\n' },
    { path: 'download/release/alpha-demo/references/reference.md', content: '# Alpha reference\nComplete copied resource.\n' },
    { path: 'download/release/beta-demo/SKILL.md', content: '---\nname: beta-demo\ndescription: Archive browser verification beta\n---\n\n# Beta\n' },
    { path: 'download/release/beta-demo/assets/data.bin', content: Buffer.from([0, 255, 1, 2, 128]) },
  ]
  const zipBytes = zip(fixtures)
  const singleRars = fixtures.map(f => rar(f.path, f.content))
  const rarBytes = Buffer.concat([singleRars[0].subarray(0, 20), ...singleRars.map(b => b.subarray(20, b.length - 7)), singleRars[0].subarray(singleRars[0].length - 7)])
  await writeFile(join(root, 'safe-multi.zip'), zipBytes)
  await writeFile(join(root, 'safe-multi.rar'), rarBytes)
  const temp = await mkdtemp(join(tmpdir(), 'archive-fixture-'))
  try {
    for (const f of fixtures) { await mkdir(join(temp, ...f.path.split('/').slice(0, -1)), { recursive: true }); await writeFile(join(temp, ...f.path.split('/')), f.content) }
    const status = spawnSync(require('7zip-bin-full').path7z, ['a', '-t7z', '-bd', '-y', '--', join(root, 'safe-multi.7z'), 'download'], { cwd: temp, stdio: 'inherit', windowsHide: true })
    assert.equal(status.status, 0)
  } finally { await rm(temp, { recursive: true, force: true }) }
  for (const type of ['zip', 'rar', '7z']) {
    const output = await readArchive(input(await readFile(join(root, 'safe-multi.' + type)), type))
    assert.equal(output.length, fixtures.length)
    for (const f of fixtures) assert.deepEqual(output.find(e => e.path === f.path)?.content, Buffer.from(f.content))
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ skills: ['alpha-demo', 'beta-demo'], files: fixtures.map(f => ({ path: f.path, base64: Buffer.from(f.content).toString('base64') })), formats: ['zip', 'rar4-store', '7z'], rar5: 'not verified' }, null, 2) + '\n')
})
test('subprocess stdout limit, stderr limit and timeout', async () => {
  await assert.rejects(_test.run(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(4096))'], 1024, 5000, tmpdir()), /输出超过/)
  await assert.rejects(_test.run(process.execPath, ['-e', 'process.stderr.write(Buffer.alloc(100000))'], 0, 5000, tmpdir()), /错误输出超限/)
  await assert.rejects(_test.run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], 0, 100, tmpdir()), /超时/)
})
