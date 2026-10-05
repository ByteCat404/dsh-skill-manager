import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
const source = await readFile(new URL('../client/quick-create.js', import.meta.url), 'utf8')
const box = { module: { exports: {} }, require: name => { assert.equal(name, 'react'); return {} } }
vm.runInNewContext(source, box)
const { questions, assess, generate, createSelectionState, selectAnswer } = box.module.exports
const types = ['程序开发', 'UI 设计', '写作与内容', '研究与分析', '其他工作']
const headings = ['目标与使用场景', '环境与对象', '输入与信息不足时的处理', '执行步骤', '约束与禁止事项', '输出要求', '验收标准', '使用示例', '通用可靠性要求']
for (const type of types) {
  // New users can finish all ten questions without entering text.
  const initial = createSelectionState(type)
  assert.equal(questions(type).length, 10)
  assert.ok(assess(initial.answers).every(c => c.passed), type)
  const draft = generate(initial.answers)
  assert.ok(draft.description.includes(type))
  for (const heading of headings) assert.ok(draft.content.includes('## ' + heading))
  for (const q of questions(type)) {
    assert.ok(q.allowCustom)
    assert.ok(q.presets.length >= 2)
    // Every selectable preset, not just the recommended one, passes its gate.
    for (const preset of q.presets) {
      const selected = selectAnswer(initial, q.key, { mode: 'preset', presetId: preset.id })
      assert.ok(assess(selected.answers).every(c => c.passed), `${type}/${q.key}/${preset.id}`)
      assert.equal(selected.answers[q.key], preset.value)
    }
    const custom = q.key === 'type' ? '数据清理与归档' : q.key === 'displayName' ? '我的中文技能' : '自定义任务必须提供明确的输入、执行步骤和可检查结果，缺少关键资料时先询问。'
    let selected = selectAnswer(initial, q.key, { mode: 'custom', value: custom })
    assert.equal(selected.modes[q.key], 'custom')
    assert.equal(selected.answers[q.key], custom)
    assert.ok(assess(selected.answers).every(c => c.passed), `${type}/${q.key}/custom`)
    selected = selectAnswer(selected, q.key, { mode: 'preset', presetId: q.presets[0].id })
    selected = selectAnswer(selected, q.key, { mode: 'custom' })
    assert.equal(selected.answers[q.key], custom, 'Switching back to custom restores explicit text')
    assert.equal(initial.answers.type, type, 'Selection transitions must not mutate their input')
    const blank = selectAnswer(initial, q.key, { mode: 'custom', value: '' })
    assert.equal(assess(blank.answers).find(c => c.key === q.key).passed, false)
    if (q.min > 1) {
      const short = selectAnswer(initial, q.key, { mode: 'custom', value: '好' })
      assert.equal(assess(short.answers).find(c => c.key === q.key).passed, false)
    }
  }
  // Custom answers remain explicit while every untouched preset is recalculated.
  let selected = selectAnswer(initial, 'context', { mode: 'custom', value: '明确自定义环境：保留这个范围和工具，不随分支改变。' })
  selected = selectAnswer(selected, 'output', { mode: 'preset', presetId: 'preset-1' })
  for (const nextType of types) {
    selected = selectAnswer(selected, 'type', { mode: 'preset', presetId: nextType })
    assert.equal(selected.answers.context, '明确自定义环境：保留这个范围和工具，不随分支改变。')
    assert.equal(selected.answers.output, questions(nextType).find(q => q.key === 'output').presets[1].value)
    for (const q of questions(nextType)) if (!['type', 'context', 'output'].includes(q.key)) assert.equal(selected.answers[q.key], q.presets[0].value)
    assert.ok(assess(selected.answers).every(c => c.passed))
  }
  const unsafe = selectAnswer(initial, 'constraints', { mode: 'custom', value: '删除所有数据' })
  assert.equal(assess(unsafe.answers).find(c => c.key === 'constraints').passed, false)
}
assert.ok(assess({}).every(c => !c.passed))
assert.notEqual(questions('程序开发')[2].title, questions('UI 设计')[2].title)
for (const customType of ['档案管理', '__proto__', 'constructor']) {
  const selected = createSelectionState(customType)
  assert.ok(assess(selected.answers).every(c => c.passed))
  assert.equal(selected.modes.type, 'custom')
  assert.equal(selected.answers.workflow, createSelectionState('其他工作').answers.workflow)
  assert.ok(generate(selected.answers).description.includes(customType))
  assert.doesNotThrow(() => generate({ type: customType }))
  assert.ok(!generate({ type: customType }).content.includes('undefined'))
}
// Minimal hook renderer exercises the real component without adding test dependencies.
function componentHarness() {
  const slots = []; let cursor = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined) }),
    useState: initial => {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], update => { slots[index] = typeof update === 'function' ? update(slots[index]) : update }]
    },
    useRef: initial => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
  }
  const uiBox = { module: { exports: {} }, require: () => react }
  vm.runInNewContext(source, uiBox)
  const calls = [], completed = []
  const props = { Field: 'Field', ErrorMessage: 'ErrorMessage', request: async (...args) => { calls.push(args); return { skill: { displayName: args[2].displayName } } }, onDone: name => completed.push(name) }
  const render = () => { cursor = 0; return uiBox.module.exports.QuickCreate(props) }
  return { render, calls, completed }
}
function nodes(tree) {
  if (typeof tree !== 'object' || tree === null) return []
  return [tree, ...tree.children.flatMap(nodes)]
}
function text(tree) { return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : tree && typeof tree === 'object' ? tree.children.map(text).join('') : '' }
function button(tree, label) { const found = nodes(tree).find(n => n.type === 'button' && text(n) === label); assert.ok(found, label); return found }
function submit(tree) { nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }) }
for (const type of types) {
  const ui = componentHarness(); let tree = ui.render()
  button(tree, type === types[0] ? type + '（推荐）' : type).props.onClick()
  for (let i = 0; i < 10; i++) {
    tree = ui.render()
    assert.equal(nodes(tree).filter(n => n.type === 'Field').length, 0, 'Preset mode must not mount a hidden required input')
    assert.ok(text(tree).includes(`问题 ${i + 1} / 10`))
    submit(tree)
  }
  tree = ui.render()
  assert.equal(nodes(tree).filter(n => n.type === 'Field').length, 3)
  assert.ok(text(tree).includes('结构检查 10 / 10'))
  assert.equal(ui.calls.length, 0, 'No API calls before explicitly saving')
  nodes(tree).find(n => n.props.id === 'skm-quick-result-name').props.onChange('已编辑技能')
  nodes(tree).find(n => n.props.id === 'skm-quick-result-description').props.onChange('已编辑使用场景')
  nodes(tree).find(n => n.props.id === 'skm-quick-result-content').props.onChange('# 已编辑正文\n\n保留用户确认的内容。')
  tree = ui.render()
  await button(tree, '确认并创建技能').props.onClick()
  assert.equal(ui.calls.length, 1)
  assert.equal(ui.calls[0][0], 'POST'); assert.equal(ui.calls[0][1], '/library/create')
  assert.equal(ui.calls[0][2].displayName, '已编辑技能')
  assert.equal(ui.calls[0][2].description, '已编辑使用场景')
  assert.equal(ui.calls[0][2].content, '# 已编辑正文\n\n保留用户确认的内容。')
  assert.deepEqual(ui.completed, ['已编辑技能'])
}
// Every question renders custom input on demand; going back preserves it.
const ui = componentHarness()
for (let i = 0; i < 10; i++) {
  let tree = ui.render()
  button(tree, i === 0 ? '自定义类型' : '自定义答案').props.onClick()
  tree = ui.render()
  const field = nodes(tree).find(n => n.type === 'Field')
  assert.ok(field)
  const value = i === 0 ? '档案管理' : i === 9 ? '归档助手' : '自定义处理流程需要明确输入和可检查结果，关键资料缺失时先确认。'
  field.props.onChange(value)
  tree = ui.render(); submit(tree)
  if (i < 9) {
    tree = ui.render(); button(tree, '上一问').props.onClick()
    tree = ui.render()
    assert.equal(nodes(tree).find(n => n.type === 'Field').props.value, value)
    submit(tree)
  }
}
assert.ok(text(ui.render()).includes('结构检查 10 / 10'))
// Empty and unsafe short custom text blocks progression and cannot fall back silently.
const invalid = componentHarness()
let tree = invalid.render(); submit(tree)
tree = invalid.render(); button(tree, '自定义答案').props.onClick()
tree = invalid.render(); nodes(tree).find(n => n.type === 'Field').props.onChange('')
tree = invalid.render(); submit(tree)
tree = invalid.render()
assert.ok(text(tree).includes('问题 2 / 10'))
assert.ok(nodes(tree).find(n => n.type === 'ErrorMessage').props.message.includes('至少 12'))
assert.equal(invalid.calls.length, 0)
// Revisit type in the real component: custom context survives and presets update.
const rebasing = componentHarness()
tree = rebasing.render(); submit(tree)
tree = rebasing.render(); submit(tree)
tree = rebasing.render(); button(tree, '自定义答案').props.onClick()
tree = rebasing.render(); nodes(tree).find(n => n.type === 'Field').props.onChange('我的授权环境只包含本地页面和现有组件。')
tree = rebasing.render(); button(tree, '上一问').props.onClick()
tree = rebasing.render(); button(tree, '上一问').props.onClick()
tree = rebasing.render(); button(tree, 'UI 设计').props.onClick()
tree = rebasing.render(); submit(tree)
tree = rebasing.render()
assert.ok(text(tree).includes(createSelectionState('UI 设计').answers.goal))
submit(tree); tree = rebasing.render()
assert.equal(nodes(tree).find(n => n.type === 'Field').props.value, '我的授权环境只包含本地页面和现有组件。')
for (let i = 2; i < 5; i++) { tree = rebasing.render(); submit(tree) }
tree = rebasing.render(); button(tree, '自定义答案').props.onClick()
tree = rebasing.render(); nodes(tree).find(n => n.type === 'Field').props.onChange('删除所有数据')
tree = rebasing.render(); submit(tree); tree = rebasing.render()
assert.ok(text(tree).includes('问题 6 / 10'))
assert.ok(nodes(tree).find(n => n.type === 'ErrorMessage').props.message.includes('至少 8'))
assert.equal(rebasing.calls.length, 0)
console.log('quick-create: five zero-input branches, all presets/custom gates, safe type fallback, branch rebasing, UI navigation and editable save passed')
