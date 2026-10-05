'use strict'

const fs = require('node:fs/promises')
const { join, dirname } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const PENDING = '.library-pending.json'

function hostError(error, operation, source, target) {
  error.operation = operation
  if (source) error.source = source
  if (target) error.target = target
  if (['EPERM', 'EBUSY', 'EACCES', 'EIO', 'ENOSPC', 'EROFS'].includes(error.code)) error.status = 503
  return error
}
// Replacing an existing document must remain atomic. A persistent lock is a
// failure, never permission to truncate/copy over the live document.
async function renameRetry(source, target) {
  const waits = [20, 40, 80, 160]
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(source, target) } catch (error) {
      if (['EPERM', 'EBUSY'].includes(error.code) && attempt < waits.length) {
        await delay(waits[attempt]); continue
      }
      if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        error.message = `无法原子重命名 (${error.code}): ${source} -> ${target}。已停止操作，未使用复制覆盖；请关闭正在打开这些文件的编辑器/预览器，等待杀毒或索引扫描结束后重试；若仍失败，请检查目录写入权限。` + error.message
      }
      throw hostError(error, 'atomic-rename', source, target)
    }
  }
}
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino
// Reserve a NEW directory using mkdir (no recursive merge). No directory
// rename is needed, so scanners holding stage handles cannot block publication.
// Return ownership BEFORE any resource write so callers can roll back failures.
async function reserveBundle(target, noLinks) {
  await noLinks(target)
  try { await fs.mkdir(target) } catch (error) {
    if (error.code === 'EEXIST') { error.status = 409; error.message = '导入目标在准备期间出现，拒绝覆盖: ' + target }
    throw hostError(error, 'reserve-new-directory', undefined, target)
  }
  const stat = await fs.lstat(target)
  return { target, stat }
}
async function assertOwned(bundle, noLinks) {
  await noLinks(bundle.target)
  const stat = await fs.lstat(bundle.target)
  if (!stat.isDirectory() || !sameIdentity(stat, bundle.stat)) {
    const error = new Error('本次新建目录身份已改变，拒绝写入或清理: ' + bundle.target)
    error.status = 409; throw error
  }
}
async function writeNew(bundle, path, content, noLinks) {
  await assertOwned(bundle, noLinks)
  const target = join(bundle.target, path)
  await noLinks(dirname(target))
  await fs.mkdir(dirname(target), { recursive: true })
  await noLinks(target)
  try { await fs.writeFile(target, content, { flag: 'wx' }) } catch (error) {
    throw hostError(error, 'write-new-resource', undefined, target)
  }
  // Detect replacement even if an external writer raced the pre-check.
  await assertOwned(bundle, noLinks)
}
module.exports = { renameRetry, hostError, sameIdentity, reserveBundle, assertOwned, writeNew, PENDING }
