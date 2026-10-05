import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Real client functions/components, mocked React hooks and fetch only. No host,
// filesystem writes, production credentials, skill activation or bundle build.
const source = await readFile(new URL('../client/index.js', import.meta.url), 'utf8')
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : []
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree && typeof tree === 'object' ? tree.children.map(text).join('') : ''
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const runtime = { apiVersion: 2, capabilities: { contentEdit: true, sha256CAS: true, localFileOpen: true } }
function harness(fetcher) {
  const slots = [], pending = [], cleanups = []; let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(c => c !== undefined && c !== null && c !== false) }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }] },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i] },
    useEffect(effect, deps) {
      const i = cursor++, old = slots[i]
      if (!old || deps.some((dep, index) => dep !== old.deps[index])) { pending.push(() => { old?.cleanup?.(); const cleanup = effect(); slots[i] = { deps, cleanup }; if (cleanup) cleanups.push(cleanup) }); if (!old) slots[i] = { deps } }
    },
  }
  const box = { module: { exports: {} }, require(name) { if (name === 'react') return react; if (name === 'react-dom') return { createPortal: () => {} }; if (name === './quick-create') return {}; throw new Error(name) }, AbortController, AbortSignal, DOMException, fetch: fetcher, window: { confirm: () => true } }
  vm.runInNewContext(source + '\nmodule.exports.__test = { api, LibraryTab, activationRevisionConflict };', box)
  const calls = [], updates = []
  const props = { sessionId: 'isolated-fixture-session', refreshKey: 0, request: async (...args) => { calls.push(args); return box.module.exports.__test.api(...args) }, onActivation: data => updates.push(data), registerGuard: () => {}, onNavigate: () => {} }
  function render() { cursor = 0; const tree = box.module.exports.__test.LibraryTab(props); while (pending.length) pending.shift()(); return tree }
  function toggle(tree, label) {
    let found = nodes(tree).find(node => node.props.label === label && typeof node.props.onClick === 'function')
    if (!found && label.startsWith('在当前会话启用 ')) {
      tree = render()
      found = nodes(tree).find(node => node.props.label === label && typeof node.props.onClick === 'function')
    }
    if (!found && label.startsWith('在当前会话启用 ')) {
      // Collection members are intentionally no longer rendered as standalone rows.
      const collection = nodes(tree).find(node => node.props.className === 'skm-collection-name' && node.props['aria-expanded'] === false)
      collection?.props.onClick(); tree = render()
      found = nodes(tree).find(node => node.props.label === label && typeof node.props.onClick === 'function')
    }
    assert.ok(found, label); return found
  }
  const alerts = tree => nodes(tree).filter(node => node.type.name === 'ErrorMessage' && node.props.message).map(node => node.props.message)
  return { render, calls, updates, toggle, alerts, api: box.module.exports.__test.api, classify: box.module.exports.__test.activationRevisionConflict, close: () => cleanups.reverse().forEach(fn => fn()) }
}
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data })
const library = { runtime, skills: [{ id: 'one', name: 'one', displayName: '技能一' }, { id: 'two', name: 'two', displayName: '技能二' }], collections: [{ id: 'group', displayName: '刚导入集合', skillIds: ['one', 'two'] }] }
let groups = 0
async function test(name, fn) { await fn(); groups++; console.log('PASS ' + name) }
await test('request preserves typed code, reason and raw error across statuses', async () => {
  for (const status of [409, 403, 503]) {
    const ui = harness(async () => response(status, { error: '具体原因：资源身份不一致', code: 'ACTIVATION_SOURCE_CONFLICT', reason: '原始资源原因' }))
    try { await assert.rejects(ui.api('POST', '/activation', {}), error => { assert.equal(error.status, status); assert.equal(error.code, 'ACTIVATION_SOURCE_CONFLICT'); assert.equal(error.reason, '原始资源原因'); assert.equal(error.backendMessage, '具体原因：资源身份不一致'); assert.ok(error.message.includes('具体原因：资源身份不一致')); return true }) } finally { ui.close() }
  }
  const ui = harness(async () => response(409, { error: { message: '嵌套错误', code: 'UNKNOWN_CODE' }, reason: '嵌套原因' }))
  await assert.rejects(ui.api('POST', '/activation', {}), e => e.code === 'UNKNOWN_CODE' && e.reason === '嵌套原因' && e.message === '嵌套错误')
  ui.close()
})
await test('revision classifier matches only typed revision or exact legacy message', async () => {
  const ui = harness()
  assert.equal(ui.classify({ status: 409, code: 'ACTIVATION_REVISION_CONFLICT', message: '任何版本消息' }), true)
  assert.equal(ui.classify({ status: 409, message: '技能开关已在其他窗口更改，请刷新重试' }), true)
  for (const error of [{ status: 409, code: 'UNKNOWN', message: '技能开关已在其他窗口更改，请刷新重试' }, { status: 409, message: '当前会话同名技能冲突: one' }, { status: 409, message: '这是另一个版本冲突消息' }, { status: 503, code: 'ACTIVATION_REVISION_CONFLICT' }]) assert.equal(ui.classify(error), false)
  ui.close()
})
const failures = [
  ['typed revision', 'ACTIVATION_REVISION_CONFLICT', '技能开关版本已变化', true],
  ['legacy exact revision', undefined, '技能开关已在其他窗口更改，请刷新重试', true],
  ['duplicate source', 'ACTIVATION_SOURCE_CONFLICT', '当前会话同名技能冲突: one；未启用其他来源的技能', false],
  ['body conflict', 'ACTIVATION_CONTENT_CONFLICT', '技能正文已变化，请刷新技能库后重试: one', false],
  ['missing skill', 'ACTIVATION_SKILL_UNAVAILABLE', '所选技能已不可用: one', false],
  ['unknown typed', 'CUSTOM_UNKNOWN', '第三方自定义失败：禁止操作', false],
  ['legacy source', undefined, '当前会话同名技能冲突: one', false],
  ['legacy body', undefined, '技能正文已变化，请刷新技能库后重试: one', false],
  ['legacy missing', undefined, '所选技能已不可用: one', false],
  ['legacy unknown', undefined, '未知409：自定义原因', false],
]
for (const [name, code, message, revision] of failures) await test(name + ' retains reason, refreshes authority, never retries POST', async () => {
  let reads = 0, posts = 0
  const ui = harness(async (url, options) => {
    if (url.endsWith('/library')) return response(200, library)
    if (options.method === 'POST') { posts++; return response(409, { error: message, reason: message, ...(code ? { code } : {}) }) }
    reads++; return response(200, { skillIds: reads === 1 ? [] : ['two'], revision: reads === 1 ? 3 : 4, available: true })
  })
  try {
    ui.render(); await settle(); let tree = ui.render()
    ui.toggle(tree, '启用集合 刚导入集合').props.onClick(); await settle(); tree = ui.render()
    assert.equal(posts, 1); assert.equal(reads, 2)
    const alert = ui.alerts(tree).find(value => value.includes(message)); assert.ok(alert, 'Original backend reason retained')
    assert.ok(alert.includes('本次'))
    assert.equal(alert.includes('请重新操作'), revision)
    assert.equal(alert.includes('会话开关版本已更新'), revision)
    assert.equal(alert.includes('不要重复开启'), !revision)
    assert.equal(ui.toggle(tree, '启用集合 刚导入集合').props.mixed, true)
    assert.equal(ui.toggle(tree, '在当前会话启用 技能一').props.checked, false)
    assert.equal(ui.toggle(tree, '在当前会话启用 技能二').props.checked, true)
    assert.equal(ui.updates.at(-1).revision, 4)
    assert.deepEqual(Array.from(ui.updates.at(-1).skillIds), ['two'])
    assert.equal(ui.toggle(tree, '启用集合 刚导入集合').props.disabled, false, 'Mutation lock released')
  } finally { ui.close() }
})
await test('failed conflict refresh keeps both original refusal and refresh failure', async () => {
  let reads = 0, posts = 0
  const ui = harness(async (url, options) => {
    if (url.endsWith('/library')) return response(200, library)
    if (options.method === 'POST') { posts++; return response(409, { error: '正文拒绝原因', code: 'ACTIVATION_CONTENT_CONFLICT' }) }
    if (++reads === 1) return response(200, { skillIds: [], revision: 0, available: true })
    return response(503, { error: '读取磁盘失败' })
  })
  try { ui.render(); await settle(); ui.toggle(ui.render(), '启用集合 刚导入集合').props.onClick(); await settle(); const tree = ui.render(); assert.equal(posts, 1); assert.ok(ui.alerts(tree).some(message => message.includes('正文拒绝原因') && message.includes('读取磁盘失败'))); assert.equal(ui.updates.at(-1), null); assert.equal(ui.toggle(tree, '启用集合 刚导入集合').props.disabled, true) } finally { ui.close() }
})
await test('unavailable authority refresh does not replace original refusal with GET reason', async () => {
  let reads = 0, posts = 0
  const ui = harness(async (url, options) => {
    if (url.endsWith('/library')) return response(200, library)
    if (options.method === 'POST') { posts++; return response(409, { error: '原始集合资源冲突', code: 'ACTIVATION_SOURCE_CONFLICT' }) }
    return response(200, ++reads === 1 ? { skillIds: [], revision: 2, available: true } : { skillIds: ['two'], revision: 3, available: false, reason: 'GET 当前正文不可用', reasonCode: 'ACTIVATION_CONTENT_CONFLICT', canDisable: true })
  })
  try { ui.render(); await settle(); ui.toggle(ui.render(), '启用集合 刚导入集合').props.onClick(); await settle(); const tree = ui.render(); assert.equal(posts, 1); assert.ok(ui.alerts(tree).some(message => message.includes('原始集合资源冲突') && !message.includes('请重新操作'))); assert.equal(ui.updates.at(-1).reasonCode, 'ACTIVATION_CONTENT_CONFLICT'); assert.equal(ui.toggle(tree, '启用集合 刚导入集合').props.disabled, true) } finally { ui.close() }
})
await test('non-409 refusal preserves reason and invalidates unconfirmed state', async () => {
  const ui = harness(async (url, options) => url.endsWith('/library') ? response(200, library) : options.method === 'POST' ? response(503, { error: '真实宿主原因：写入锁定', code: 'ELOCKED' }) : response(200, { skillIds: [], revision: 1, available: true }))
  try { ui.render(); await settle(); ui.toggle(ui.render(), '在当前会话启用 技能一').props.onClick(); await settle(); assert.ok(ui.alerts(ui.render()).some(message => message.includes('真实宿主原因：写入锁定'))); assert.equal(ui.updates.at(-1), null) } finally { ui.close() }
})
await test('queued explicit toggles remain serialized and use confirmed revision', async () => {
  let value = { skillIds: [], revision: 7, available: true }; const writes = []
  const ui = harness(async (url, options) => {
    if (url.endsWith('/library')) return response(200, library)
    if (options.method === 'POST') { const body = JSON.parse(options.body); writes.push(body); assert.equal(body.expectedRevision, value.revision); value = { skillIds: body.skillIds, revision: value.revision + 1, available: true }; return response(200, value) }
    return response(200, value)
  })
  try { ui.render(); await settle(); const tree = ui.render(); ui.toggle(tree, '在当前会话启用 技能一').props.onClick(); ui.toggle(tree, '在当前会话启用 技能二').props.onClick(); await settle(); assert.equal(writes.length, 2); assert.equal(writes[1].expectedRevision, 8); assert.deepEqual(writes[1].skillIds, ['one', 'two']); assert.equal(ui.alerts(ui.render()).length, 0) } finally { ui.close() }
})
await test('collection membership hides top-level duplicates but keeps shared/empty/search results accessible', async () => {
  const fixture = { ...library, skills: [...library.skills, { id: 'solo', displayName: '独立技能' }], collections: [...library.collections, { id: 'shared', displayName: '共享集合', skillIds: ['one'] }, { id: 'empty', displayName: '空集合', skillIds: [] }] }
  const ui = harness(async url => response(200, url.endsWith('/library') ? fixture : { skillIds: [], revision: 0, available: true }))
  try {
    ui.render(); await settle(); let tree = ui.render()
    const rows = tree => nodes(tree).filter(n => n.props.className === 'skm-row skm-skill-row')
    assert.equal(rows(tree).length, 1); assert.match(text(rows(tree)[0]), /独立技能/)
    assert.equal(nodes(tree).filter(n => n.props.className === 'skm-collection').length, 3)
    nodes(tree).filter(n => n.props.className === 'skm-collection-name').forEach(n => n.props.onClick())
    tree = ui.render(); assert.equal(rows(tree).length, 4, 'one skill shared in two collections plus other member and standalone')
    const search = nodes(tree).find(n => n.props['aria-label'] === '搜索技能或集合')
    search.props.onChange({ target: { value: '技能一' } }); tree = ui.render()
    assert.equal(nodes(tree).filter(n => n.props.className === 'skm-collection').length, 2)
    const rootList = nodes(tree).find(n => n.props['aria-label'] === '全部技能列表')
    assert.equal(rootList.children.filter(n => n.props?.className === 'skm-row skm-skill-row').length, 0)
  } finally { ui.close() }
})
await test('more expands all members with adjacent icon actions and no inline body editor', async () => {
  const ui = harness(async url => response(200, url.endsWith('/library') ? library : { skillIds: [], revision: 0, available: true }))
  try {
    ui.render(); await settle(); let tree = ui.render()
    const more = nodes(tree).find(n => n.props['aria-label'] === '刚导入集合 的更多操作')
    assert.equal(more.type, 'button'); assert.equal(more.props['aria-expanded'], false)
    more.props.onClick(); tree = ui.render()
    assert.equal(nodes(tree).filter(n => n.props.className === 'skm-row skm-skill-row').length, 2)
    for (const name of ['技能一', '技能二']) {
      const actions = nodes(tree).find(n => n.props['aria-label'] === name + ' 的操作')
      assert.equal(actions.children.length, 4)
      assert.ok(actions.children[0].props.label.startsWith('在当前会话启用'))
      for (const label of ['打开本地文件 ', '重命名 ', '删除 ']) {
        const button = actions.children.find(n => n.props['aria-label'] === label + name)
        assert.ok(button); assert.equal(button.props.disabled, false); assert.equal(button.children[0].type.name, 'Icon')
      }
    }
    assert.equal(nodes(tree).some(n => n.type === 'textarea' || n.type?.name === 'SkillEditor'), false)
    assert.equal(ui.calls.some(([method, path]) => method === 'GET' && /^\/library\/skills\//.test(path)), false)
  } finally { ui.close() }
})
await test('local open sends ID-only POST once, locks repeated clicks, never edits or activates', async () => {
  let done; const posts = []
  const ui = harness(async (url, options) => {
    if (url.endsWith('/library')) return response(200, library)
    if (url.endsWith('/open')) { posts.push({ url, options }); return new Promise(resolve => { done = resolve }) }
    return response(200, { skillIds: [], revision: 0, available: true })
  })
  try {
    ui.render(); await settle(); nodes(ui.render()).find(n => n.props.className === 'skm-collection-more-button').props.onClick()
    const button = nodes(ui.render()).find(n => n.props['aria-label'] === '打开本地文件 技能一')
    const first = button.props.onClick(); button.props.onClick(); await settle()
    assert.equal(posts.length, 1); assert.equal(posts[0].url, '/dsh-skill-manager/api/library/skills/one/open'); assert.equal(posts[0].options.method, 'POST'); assert.equal(posts[0].options.body, undefined)
    assert.equal(nodes(ui.render()).find(n => n.props['aria-label'] === '打开本地文件 技能一').props.disabled, true)
    done(response(200, { opened: true })); await first; await settle()
    const tree = ui.render(); assert.match(text(tree), /已请求本机默认程序/)
    assert.equal(nodes(tree).find(n => n.props['aria-label'] === '打开本地文件 技能一').props.disabled, false)
    assert.equal(ui.calls.some(([method, path]) => method === 'PATCH' || method === 'POST' && path === '/activation'), false)
  } finally { ui.close() }
})
await test('local opener capability unavailable fails closed with restart hint', async () => {
  const ui = harness(async url => response(200, url.endsWith('/library') ? { ...library, runtime: { apiVersion: 2, capabilities: {} } } : { skillIds: [], revision: 0, available: true }))
  try {
    ui.render(); await settle(); nodes(ui.render()).find(n => n.props.className === 'skm-collection-more-button').props.onClick()
    const tree = ui.render(), button = nodes(tree).find(n => n.props['aria-label'] === '打开本地文件 技能一')
    assert.equal(button.props.disabled, true); button.props.onClick(); await settle()
    assert.equal(ui.calls.some(([method]) => method === 'POST'), false)
    assert.ok(ui.alerts(tree).some(message => message.includes('本地文件打开能力') && message.includes('重新打开')))
  } finally { ui.close() }
})
await test('local opener failure preserves backend reason without a success notice', async () => {
  const ui = harness(async url => response(url.endsWith('/open') ? 503 : 200, url.endsWith('/library') ? library : url.endsWith('/open') ? { error: '未配置 Markdown 默认程序' } : { skillIds: [], revision: 0, available: true }))
  try {
    ui.render(); await settle(); nodes(ui.render()).find(n => n.props.className === 'skm-collection-more-button').props.onClick()
    await nodes(ui.render()).find(n => n.props['aria-label'] === '打开本地文件 技能一').props.onClick(); await settle()
    const tree = ui.render(); assert.ok(ui.alerts(tree).some(message => message.includes('未配置 Markdown 默认程序')))
    assert.equal(text(tree).includes('已请求本机默认程序'), false)
  } finally { ui.close() }
})
console.log(`ACTIVATION CLIENT OK: ${groups} groups; real component/API functions with isolated hooks/fetch, no production writes`)
