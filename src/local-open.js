'use strict'

const { execFile } = require('node:child_process')
const { createRequire } = require('node:module')
const { isAbsolute, win32 } = require('node:path')
const { pathToFileURL } = require('node:url')
const { release } = require('node:os')
const PACKAGE = '@deepseek-ai/dsh-native-command'
const failure = (message, code = 'LOCAL_OPEN_FAILED', status = 503) => Object.assign(new Error(message), { code, status, operation: 'open-local-skill' })

async function loadNative() {
  try { return await import('@deepseek-ai/dsh-native-command') } catch (error) {
    if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code) || !error.message.includes(PACKAGE)) throw error
    // Installed plugins need not share node_modules with the host. Anchor only
    // to the already running Electron entry, never cwd or a request parameter.
    if (process.versions.electron && process.argv[1] && isAbsolute(process.argv[1])) {
      let entry
      try { entry = createRequire(process.argv[1]).resolve(PACKAGE) } catch (missing) {
        if (missing.code !== 'MODULE_NOT_FOUND' || !missing.message.includes(PACKAGE)) throw missing
        return undefined
      }
      return import(pathToFileURL(entry).href)
    }
    return undefined
  }
}
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024, ...options }, (error, stdout) => {
      if (error) reject(error)
      else resolve({ stdout })
    })
  })
}
// The path is an environment value, NEVER PowerShell source or a shell string.
// UseShellExecute asks Windows for the default association and reports failures
// (including no association). Do not use cmd /c start or mask nonzero exits.
const WINDOWS_SCRIPT = "$ErrorActionPreference='Stop'; try { $s=New-Object System.Diagnostics.ProcessStartInfo; $s.FileName=$env:DSH_SKM_OPEN_PATH; $s.UseShellExecute=$true; [void][System.Diagnostics.Process]::Start($s); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"

function createLocalOpener(options = {}) {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const execute = options.run || run
  const load = options.loadNative || loadNative
  let nativePromise
  return async function openLocalFile(target) {
    if (typeof target !== 'string' || !(platform === 'win32' ? win32.isAbsolute(target) : isAbsolute(target)) || /[\x00-\x1f\x7f]/.test(target)) throw failure('本地打开目标必须是绝对文件路径', 'LOCAL_OPEN_INVALID_PATH', 400)
    try {
      const native = await (nativePromise ||= load())
      if (native) {
        if (typeof native.canOpenNativePath !== 'function' || typeof native.openNativeAssociatedPath !== 'function') throw failure('宿主本地文件打开能力版本不兼容', 'LOCAL_OPEN_UNAVAILABLE')
        if (!native.canOpenNativePath()) throw failure('宿主没有可用的本地桌面', 'LOCAL_OPEN_UNAVAILABLE')
        await native.openNativeAssociatedPath(target, AbortSignal.timeout(15000))
        return
      }
      const signal = AbortSignal.timeout(15000)
      if (platform === 'win32') {
        const systemRoot = env.SystemRoot || env.WINDIR
        if (!systemRoot || !win32.isAbsolute(systemRoot)) throw failure('无法定位 Windows 系统目录', 'LOCAL_OPEN_UNAVAILABLE')
        await execute(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')], { signal, env: { ...env, DSH_SKM_OPEN_PATH: target } })
      } else if (platform === 'darwin') await execute('/usr/bin/open', [target], { signal })
      else if (platform === 'linux') {
        // Without the host's WSL translator do not pretend xdg-open reaches the
        // Windows desktop. A desktop Linux session uses its default association.
        if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || (options.osRelease || release()).toLowerCase().includes('microsoft')) throw failure('WSL 本地打开需要宿主 native-command 能力', 'LOCAL_OPEN_UNAVAILABLE')
        if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw failure('宿主没有可用的本地桌面', 'LOCAL_OPEN_UNAVAILABLE')
        await execute('xdg-open', [target], { signal })
      } else throw failure('当前平台不支持本地打开: ' + platform, 'LOCAL_OPEN_UNAVAILABLE')
    } catch (error) {
      if (error.operation === 'open-local-skill') throw error
      const result = failure('无法请求默认应用打开技能文件: ' + String(error.message || error), error.name === 'AbortError' || error.name === 'TimeoutError' || error.killed ? 'LOCAL_OPEN_TIMEOUT' : 'LOCAL_OPEN_FAILED')
      result.target = target
      result.cause = error
      throw result
    }
  }
}
module.exports = { createLocalOpener }
