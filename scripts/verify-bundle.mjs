// scripts/verify-bundle.mjs — 决定性验证客户端 bundle：
// 模拟 dsh 的 window.__ModuleLoader__.load 调用 factory，断言其**返回值**是
// 一个含 name + apply 的模块。若 factory 不返回 module.exports，这里会失败，
// 复现 "invalid plugin, expect ... received undefined"。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'client', 'bundle.js'), 'utf8')

// 拦截 __ModuleLoader__.load：拿到 {id, factory} 后，用和宿主一致的方式调用 factory。
let config = null
global.window = { __ModuleLoader__: { load: (x) => { config = x } } }
vm.runInThisContext(bundle, { filename: 'bundle.js' })
if (!config || typeof config.factory !== 'function') throw new Error('bundle 未正确调用 __ModuleLoader__.load')

// 注入 react / react-dom shim（浏览器平台模块表提供）。
const reactShim = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) }
const mod = config.factory((name) => {
  if (name === 'react') return reactShim
  if (name === 'react-dom') return { createPortal: () => null }
  throw new Error('unexpected require: ' + name)
})

console.log('factory 返回值类型 =', typeof mod)
console.log('name =', mod && mod.name)
console.log('typeof apply =', mod && typeof mod.apply)
if (!mod || typeof mod.apply !== 'function' || mod.name !== 'dsh-skill-manager') {
  throw new Error('FAIL: factory 未返回含 apply 的模块 —— 这就是 invalid plugin 的根因')
}
console.log('VALID: __ModuleLoader__.load 拿到的模块含 apply，不会再触发 invalid plugin')
