// scripts/build-client.mjs — 把 client/index.js（CJS 源码）包成浏览器 bundle，
// 产出 client/bundle.js（window.__ModuleLoader__.load({ id, factory }) 格式）。
// factory(require) 由 dsh 的浏览器模块加载器调用，react / react-dom 由它提供。
//
// 关键：dsh 的 __ModuleLoader__.load 是**以 factory 的返回值作为插件模块**的，
// 所以工厂末尾必须 `return module.exports`——否则加载器拿到 undefined，
// 触发 "invalid plugin, expect ... received undefined"。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const quick = readFileSync(join(root, 'client', 'quick-create.js'), 'utf8')
const source = readFileSync(join(root, 'client', 'index.js'), 'utf8')
// Keep the browser artifact self-contained: DSH only supplies external modules.
const localModule = `(() => { const module = { exports: {} };\n${quick}\nreturn module.exports })()`
const src = source.replace("require('./quick-create')", localModule)

const bundle =
`/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
${src.split('\n').map((l) => '    ' + l).join('\n')}

    return module.exports
  }
})
`

writeFileSync(join(root, 'client', 'bundle.js'), bundle, 'utf8')
console.log('wrote client/bundle.js for ' + pkg.name + ' (with return module.exports)')
