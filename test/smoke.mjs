// All host regressions use an isolated temporary DSH_HOME and restore it.
import './host-audit.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(root, 'client', 'bundle.js'), 'utf8')
let loaded = null
const originalWindow = global.window
try {
  global.window = { __ModuleLoader__: { load: value => { loaded = value } } }
  require('node:vm').runInThisContext(bundle, { filename: 'client/bundle.js' })
  assert.equal(loaded?.id, 'dsh-skill-manager')
  assert.equal(typeof loaded.factory, 'function')
  const reactShim = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: fn => fn(), useCallback: fn => fn }
  const exported = loaded.factory(name => {
    if (name === 'react') return reactShim
    if (name === 'react-dom') return { createPortal: () => null }
    throw new Error('unexpected require: ' + name)
  })
  // Some loader generations return CommonJS exports, others register internally.
  if (exported) { assert.equal(exported.name, 'dsh-skill-manager'); assert.equal(typeof exported.apply, 'function') }
  assert.match(bundle, /apply/)
  console.log('CLIENT LOAD OK: bundle syntax, ModuleLoader identity and factory dependencies (not a browser/UI proof)')
} finally {
  if (originalWindow === undefined) delete global.window
  else global.window = originalWindow
}
