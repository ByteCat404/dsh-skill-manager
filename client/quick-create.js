'use strict'
const { createElement: h, useState, useRef } = require('react')
const TYPES = ['程序开发', 'UI 设计', '写作与内容', '研究与分析', '其他工作']
const CHECK_LABELS = { type: '工作类型', goal: '明确目标', context: '环境与对象', input: '输入与缺失处理', workflow: '执行步骤', constraints: '约束与禁止事项', output: '输出格式', acceptance: '验收标准', example: '使用示例', displayName: '技能名称' }
const BRANCHES = {
  '程序开发': { question: '使用什么语言、框架和项目环境？', example: '例如 TypeScript + React，已有项目；先读代码，保持现有架构。', steps: ['阅读项目说明、现有代码和测试，确认语言、框架与约束。', '提出最小改动方案，确认不清楚的接口与需求。', '实现功能，补充边界、错误处理和回归测试。', '运行检查与测试，报告改动、结果及未验证项。'] },
  'UI 设计': { question: '为哪种界面设计？需要遵循什么风格和设备要求？', example: '例如桌面聊天工具，简洁风格，同时支持窄屏、键盘和深浅色主题。', steps: ['理解用户流程、主要操作、目标设备与现有设计系统。', '规划信息层级，明确布局、状态与交互。', '实施界面，覆盖加载、空态、错误、键盘与窄屏。', '检查对比度、主题兼容与交互，说明实际验证范围。'] },
  '写作与内容': { question: '写给谁看？需要什么语气、体裁和长度？', example: '例如面向新手的中文教程，清晰自然，分步骤并提供例子。', steps: ['明确读者、用途、事实依据与内容边界。', '组织大纲，区分已知事实、观点和待核实信息。', '按指定风格起草内容，提供必要例子。', '检查准确性、结构、语气和篇幅，标注不确定信息。'] },
  '研究与分析': { question: '研究什么对象？允许使用哪些资料和分析方法？', example: '例如比较三种方案，优先官方来源，按成本、风险与适用性评价。', steps: ['明确问题、评价维度、范围与资料时效。', '收集可信依据，记录来源与缺失信息。', '比较证据和替代解释，区分事实与推断。', '给出结论、限制和建议，标注引用与不确定性。'] },
  '其他工作': { question: '描述工作环境、对象和需要使用的工具。', example: '例如整理客户反馈，按类别汇总问题，输出可执行的改进建议。', steps: ['理解任务目标、输入、环境与约束。', '确认缺失信息，规划执行步骤。', '按步骤完成工作，保留必要依据。', '对照验收标准检查结果，报告限制与下一步。'] },
}
// Every answer is a concrete, editable starting point, not a promise of task success.
const PRESETS = {
  '程序开发': {
    goal: [['修复一个报错', '根据提供的复现步骤定位并修复一个程序报错，补充回归测试并说明未验证内容。'], ['实现一个小功能', '在现有项目中实现一个范围明确的小功能，保持现有架构并交付代码改动与测试结果。']],
    context: [['已有 Web 项目', '已有 TypeScript 与 React Web 项目，沿用现有依赖、目录和代码风格；实际版本以项目文件为准。'], ['已有 Python 项目', '已有 Python 脚本或服务，先阅读依赖说明和测试约定，保持公共接口兼容。']],
    input: [['需求、代码与复现步骤', '提供需求、相关代码、运行命令和报错复现步骤；缺少关键接口或运行环境时先询问，不猜测。'], ['问题描述与测试', '提供问题描述、相关文件和现有测试；先确认预期行为，无法复现时说明缺失信息并请求补充。']],
    constraints: [['最小改动，先确认风险', '保持现有架构和接口，不泄漏密钥、不删除数据；新增依赖、破坏性操作或外部提交前先确认。'], ['限定文件与依赖', '只修改用户授权的文件，优先复用已有依赖；不更改真实生产配置，不声称未运行的测试通过。']],
    output: [['改动说明与测试结果', '交付代码改动、修改原因、实际运行的测试结果，以及未验证项和必要的运行说明。'], ['补丁与复现记录', '交付可审阅的补丁、问题复现与修复步骤、边界用例和实际验证记录。']],
    acceptance: [['回归与边界检查', '原问题按复现步骤不再出现，相关测试通过且边界错误有处理；未能运行的检查须明确列出。'], ['需求逐项核对', '逐项核对需求和接口兼容性，检查正常、空输入和异常路径；如实报告运行结果与验证限制。']],
    example: [['修复空列表报错', '请求：修复列表为空时页面报错。期望：显示清晰空态，不影响正常列表，并提供空列表回归测试和实际结果。'], ['增加表单校验', '请求：为登录页增加邮箱格式与空值校验。期望：错误反馈明确、键盘可操作，并附测试结果与未验证项。']],
    displayName: [['程序修复助手', '程序修复助手'], ['小功能开发助手', '小功能开发助手']],
  },
  'UI 设计': {
    goal: [['改善一个界面流程', '优化一个现有界面的信息层级和主要操作流程，覆盖关键状态并交付可验证的界面改动。'], ['检查界面可用性', '检查一个页面的布局、可读性和交互问题，给出按优先级排序的改进方案与验收清单。']],
    context: [['桌面与窄屏 Web', '面向桌面和窄屏 Web 页面，保持现有设计语言，兼顾键盘操作、深浅色主题和可读性。'], ['移动端表单', '面向手机触屏表单，沿用现有组件和视觉规范，关注输入反馈、焦点顺序和小屏布局。']],
    input: [['页面与操作目标', '提供页面截图或源码、主要用户操作和现有设计规范；缺少目标设备或关键流程时先询问。'], ['设计稿与状态说明', '提供设计稿、组件清单和加载、错误、空态说明；未知交互不自行编造，先确认。']],
    constraints: [['沿用规范与无障碍', '沿用现有设计系统，不擅自添加依赖；保持文字对比度和键盘可达性，重大交互变化先确认。'], ['不改业务逻辑', '限定在授权界面范围，不改变业务逻辑或泄漏用户数据；避免只适配单一屏幕，验证不足须说明。']],
    output: [['界面改动与检查清单', '输出界面改动或可实施设计说明，附布局、状态、键盘与窄屏检查清单和实际验证结果。'], ['问题清单与方案', '输出按影响排序的问题清单、改进方案、关键状态说明和可检查的验收步骤。']],
    acceptance: [['操作与状态可用', '主要操作可完成，加载、空态与错误有反馈；窄屏无横向溢出、键盘可达，并标注未实际验证的设备。'], ['逐状态检查', '逐项核对信息层级、文字对比度、焦点顺序和关键状态；以实际检查记录为准，不声称全面适配。']],
    example: [['改善设置页', '请求：整理设置页的分组和保存反馈。期望：重要设置易找到，保存成功与失败有反馈，窄屏和键盘检查有记录。'], ['改善登录表单', '请求：改善手机登录表单。期望：标签清晰，校验错误能定位，提交过程有状态提示，并说明实际检查范围。']],
    displayName: [['界面优化助手', '界面优化助手'], ['界面可用性检查', '界面可用性检查']],
  },
  '写作与内容': {
    goal: [['撰写新手教程', '把提供的材料整理成面向新手的中文教程，包含可执行步骤、必要例子和需要核实的信息。'], ['改写已有文章', '改善已有文章的结构和表达，保留原意与事实边界，交付修订稿和重要修改说明。']],
    context: [['中文新手教程', '面向初次接触主题的中文读者，语气清晰自然，以短段落和分步骤说明为主，长度按用户要求确认。'], ['团队知识文章', '面向团队成员的知识说明文章，沿用已有术语，区分事实、建议和待核实事项，篇幅以任务要求为准。']],
    input: [['主题与参考材料', '提供主题、读者、参考材料和发布用途；关键事实或读者背景缺失时先询问，不编造资料。'], ['原稿与修改要求', '提供原稿、要保留的要点和篇幅要求；存在矛盾事实时标注并请用户确认。']],
    constraints: [['事实与引用可靠', '不编造数据、引用或经历；尊重原意和隐私，区分已知事实与推测，无法核实的信息须标注。'], ['保留原意与术语', '不擅自更改关键结论和专有术语，不抄袭未授权材料；删改重要内容时解释原因并标记待确认项。']],
    output: [['教程与核实清单', '输出带标题、分步骤正文和具体例子的中文教程，附参考依据与待核实信息清单。'], ['修订稿与修改说明', '输出可阅读的修订稿，附重要结构调整、事实核实事项和简短修改说明。']],
    acceptance: [['读者可照步骤操作', '内容符合读者和用途，步骤可理解且配有例子；事实有依据，未知项已标注，篇幅和术语逐项检查。'], ['原意与结构核对', '关键事实和原意未变，段落逻辑清晰、语气统一；引用来源和待核实内容可辨认，无夸大结论。']],
    example: [['写安装教程', '请求：依据官方说明写一篇新手安装教程。期望：说明前提、安装步骤、常见失败和检查方法，未知版本差异须标注。'], ['改写项目介绍', '请求：把项目介绍改写得更易懂。期望：保留关键事实，解释术语，提供修订稿和重大修改说明。']],
    displayName: [['新手教程写作', '新手教程写作'], ['文章改写助手', '文章改写助手']],
  },
  '研究与分析': {
    goal: [['比较候选方案', '根据可信资料比较候选方案的成本、风险和适用条件，给出有依据的建议与结论限制。'], ['分析一个问题', '围绕明确问题收集证据并分析可能原因，区分事实和推断，给出可验证的下一步建议。']],
    context: [['方案比较与官方资料', '比较用户指定的候选方案，优先官方和一手资料，按成本、风险、维护与适用性评价并注明时效。'], ['公开资料分析', '分析用户指定的主题和时间范围，使用可追溯公开资料，说明样本范围、分析方法和资料限制。']],
    input: [['候选与评价维度', '提供候选方案、预算、评价维度和参考资料；缺少关键条件时先询问，无法获取来源时说明限制。'], ['问题与资料范围', '提供研究问题、时间范围和已有资料；证据不足时标注未知，先请求补充，不编造来源或数据。']],
    constraints: [['证据可追溯', '不编造来源或数据，区分事实与推断；涉及个人信息先匿名化，外部付费或提交操作须获授权。'], ['说明时效与限制', '标注资料时间和样本限制，不把相关性当因果；不作无依据的确定性结论，不泄漏保密材料。']],
    output: [['比较表与建议', '输出含来源和资料日期的比较表、关键权衡、适用条件、建议以及证据不足和待核实清单。'], ['分析报告与下一步', '输出问题定义、证据摘要、分析方法、结论限制和可验证的下一步，引用来源可追溯。']],
    acceptance: [['来源与权衡可核对', '主要结论对应可追溯证据，各候选按一致维度比较；标注时效、缺失信息和限制，建议说明适用条件。'], ['事实推断分开', '事实和推断明确区分，替代解释得到讨论；引用与数据可核查，证据不足不形成确定性结论。']],
    example: [['比较三种工具', '请求：比较三种项目管理工具。期望：按费用、协作、迁移风险列出带来源的表格，给出适用条件和待核实项。'], ['分析反馈原因', '请求：分析用户反馈中重复出现的问题。期望：给出证据、可能原因与替代解释，不以有限样本断言因果。']],
    displayName: [['方案比较助手', '方案比较助手'], ['证据分析助手', '证据分析助手']],
  },
  '其他工作': {
    goal: [['整理客户反馈', '把提供的客户反馈按主题分类，保留可追溯依据，输出主要问题和可执行的改进建议。'], ['整理执行清单', '将一个明确任务整理成有顺序的执行清单，说明输入、风险、责任边界和完成检查方法。']],
    context: [['反馈整理与表格', '在用户提供的反馈文本和表格范围内工作，按问题类别、影响和频次整理，保持原始材料不变。'], ['日常任务规划', '针对用户说明的日常工作环境与工具制定清单，按现有资源安排步骤，未知权限和对象先确认。']],
    input: [['反馈与分类要求', '提供反馈材料、分类目标和使用范围；材料不足或分类标准有歧义时先询问，不自行补造记录。'], ['目标与资源清单', '提供任务目标、可用资源和时间要求；关键输入、权限或责任人缺失时先确认再执行。']],
    constraints: [['保护原始资料', '不删除或修改原始资料，匿名化敏感信息；不编造记录，外部发送、提交或破坏性操作前先确认。'], ['遵守范围与授权', '只在用户授权范围内工作，不擅自作承诺或更改外部系统；信息不确定时标注并询问。']],
    output: [['分类表与改进建议', '输出带依据的分类汇总表、主要问题、改进建议和缺失信息清单，说明实际处理范围。'], ['步骤与验收清单', '输出按顺序排列的执行步骤、需要的输入、风险提示、完成检查和待确认事项。']],
    acceptance: [['分类可追溯', '每类结论能对应原始反馈，计数口径一致；隐私已处理，建议可执行，缺失信息与处理范围清晰。'], ['执行步骤可检查', '目标、输入与步骤相互对应，每步有可检查结果；风险和授权边界明确，未完成内容如实标注。']],
    example: [['整理一批反馈', '请求：整理本周客户反馈。期望：按主题汇总并注明原始记录依据，保护个人信息，给出优先处理建议。'], ['准备活动清单', '请求：整理小型活动筹备清单。期望：列出前提、步骤、风险和验收方法，未知预算与权限先询问。']],
    displayName: [['反馈整理助手', '反馈整理助手'], ['工作清单助手', '工作清单助手']],
  },
}
function branchFor(type) { return Object.prototype.hasOwnProperty.call(BRANCHES, type) ? type : '其他工作' }
function questions(type) {
  const branch = branchFor(type)
  const list = [
    { key: 'type', title: '你希望这个技能帮助完成哪类工作？', options: TYPES, min: 2 },
    { key: 'goal', title: '想解决什么具体问题？怎样才算完成？', min: 12 },
    { key: 'context', title: BRANCHES[branch].question, example: BRANCHES[branch].example, min: 8 },
    { key: 'input', title: '开始前提供什么？缺少信息怎么办？', min: 8 },
    { key: 'workflow', title: '你希望它按哪些步骤工作？', min: 20 },
    { key: 'constraints', title: '有哪些必须遵守的要求和不能做的事？', min: 8 },
    { key: 'output', title: '最终结果要以什么形式交给你？', min: 8 },
    { key: 'acceptance', title: '如何验收？选择可以检查的标准。', min: 16 },
    { key: 'example', title: '选择一个典型请求与期待结果。', min: 20 },
    { key: 'displayName', title: '给这个技能取个名称。', min: 1 },
  ]
  return list.map(q => {
    const rows = q.key === 'type' ? TYPES.map(t => [t, t]) : q.key === 'workflow' ? [
      ['按四步完成并检查', BRANCHES[branch].steps.map((s, i) => `${i + 1}. ${s}`).join('\n')],
      ['先确认方案，再执行检查', ['先列出任务范围、缺失信息和拟执行方案；存在歧义或风险时先确认。', ...BRANCHES[branch].steps].map((s, i) => `${i + 1}. ${s}`).join('\n')],
    ] : PRESETS[branch][q.key]
    return { ...q, allowCustom: true, presets: rows.map(([label, value], i) => ({ id: q.key === 'type' ? value : `preset-${i}`, label, value })) }
  })
}
function createSelectionState(type = TYPES[0]) {
  const state = { answers: {}, modes: {}, presetIds: {}, customValues: {} }
  for (const q of questions(type)) {
    const preset = q.key === 'type' ? q.presets.find(p => p.value === type) : q.presets[0]
    state.answers[q.key] = preset ? preset.value : type
    state.modes[q.key] = preset ? 'preset' : 'custom'
    state.presetIds[q.key] = preset ? preset.id : null
    if (!preset) state.customValues[q.key] = type
  }
  return state
}
// Pure transitions keep explicit custom answers, and rebase every preset on the new branch.
function selectAnswer(state, key, choice) {
  const next = { answers: { ...state.answers }, modes: { ...state.modes }, presetIds: { ...state.presetIds }, customValues: { ...state.customValues } }
  const q = questions(state.answers.type).find(item => item.key === key)
  if (!q) throw new Error(`Unknown quick-create question: ${key}`)
  if (choice.mode === 'custom') {
    const value = choice.value === undefined ? (next.customValues[key] ?? next.answers[key] ?? '') : choice.value
    next.answers[key] = value; next.customValues[key] = value; next.modes[key] = 'custom'; next.presetIds[key] = null
  } else {
    const preset = q.presets.find(p => p.id === choice.presetId) || q.presets[0]
    next.answers[key] = preset.value; next.modes[key] = 'preset'; next.presetIds[key] = preset.id
  }
  if (key === 'type') for (const item of questions(next.answers.type)) {
    if (item.key === 'type' || next.modes[item.key] === 'custom') continue
    const preset = item.presets.find(p => p.id === next.presetIds[item.key]) || item.presets[0]
    next.answers[item.key] = preset.value; next.presetIds[item.key] = preset.id
  }
  return next
}
function assess(answers) {
  return questions(answers.type).map(q => ({ key: q.key, title: q.title, passed: typeof answers[q.key] === 'string' && answers[q.key].trim().length >= q.min }))
}
function generate(answers) {
  const fallback = createSelectionState(answers.type || '其他工作').answers
  const value = key => typeof answers[key] === 'string' && answers[key].trim() ? answers[key].trim() : fallback[key].trim()
  const description = `用于${value('type')}：${value('goal')}`
  const content = `# ${value('displayName')}\n\n## 目标与使用场景\n${value('goal')}\n\n## 环境与对象\n${value('context')}\n\n## 输入与信息不足时的处理\n${value('input')}\n\n## 执行步骤\n${value('workflow')}\n\n## 约束与禁止事项\n${value('constraints')}\n\n## 输出要求\n${value('output')}\n\n## 验收标准\n${value('acceptance')}\n\n## 使用示例\n${value('example')}\n\n## 通用可靠性要求\n- 关键需求或输入有歧义时先询问，不擅自编造。\n- 对有副作用、破坏性或外部提交操作，遵循用户授权范围；未获授权先确认。\n- 保存或运行结果必须如实报告；区分已完成、未验证和受阻内容。\n- 若与用户当前要求或更高优先级规则冲突，遵循更高优先级规则。\n`
  return { displayName: value('displayName'), description, content }
}
function QuickCreate({ onDone, request, Field, ErrorMessage }) {
  const [selection, setSelection] = useState(() => createSelectionState())
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(null)
  const lock = useRef(false)
  const answers = selection.answers, list = questions(answers.type), q = list[step]
  const choose = choice => { setSelection(s => selectAnswer(s, q.key, choice)); setError('') }
  const next = e => {
    e.preventDefault()
    if (!assess(answers)[step].passed) { setError(`请选择一个预设，或补充自定义答案（至少 ${q.min} 个字符）。`); return }
    if (step === list.length - 1) {
      if (assess(answers).some(c => !c.passed)) { setError('请返回补充未通过检查的自定义答案。'); return }
      setDraft(generate(answers)); setStep(list.length)
    } else setStep(step + 1)
    setError('')
  }
  const save = async () => {
    if (lock.current) return
    if (!draft?.content?.trim() || !draft.displayName.trim() || !draft.description.trim() || assess(answers).some(c => !c.passed)) { setError('名称、使用场景、正文和问答检查必须全部完成。'); return }
    lock.current = true; setBusy(true); setError('')
    try { const data = await request('POST', '/library/create', draft); onDone(data.skill?.displayName || draft.displayName); setSelection(createSelectionState()); setStep(0); setDraft(null) } catch (e) { setError(e.message) } finally { lock.current = false; setBusy(false) }
  }
  return h('div', { className: 'skm-quick-create' },
    h('h3', { className: 'skm-section-title' }, '一起把工作方式变成技能'),
    h('p', { className: 'skm-hint' }, '本地引导，不调用模型、不产生模型费用。每题已选推荐答案，可直接下一问，也可选择预设或自定义；结构检查不是效果保证。'),
    h('p', { className: 'skm-summary', role: 'status' }, step < list.length ? `问题 ${step + 1} / ${list.length}` : '问答完成 · 检查并编辑后保存'),
    h(ErrorMessage, { message: error }),
    step < list.length ? h('form', { onSubmit: next },
      h('div', { className: 'skm-note', style: { marginBottom: 16 } }, q.title),
      h('div', { className: 'skm-upload-actions', role: 'group', 'aria-label': q.title },
        q.presets.map((preset, i) => {
          const selected = selection.modes[q.key] === 'preset' && selection.presetIds[q.key] === preset.id
          return h('button', { key: preset.id, type: 'button', className: selected ? 'skm-primary' : 'skm-secondary', 'aria-pressed': selected, disabled: busy, onClick: () => choose({ mode: 'preset', presetId: preset.id }) }, preset.label + (i === 0 ? '（推荐）' : ''))
        }),
        h('button', { type: 'button', className: selection.modes[q.key] === 'custom' ? 'skm-primary' : 'skm-secondary', 'aria-pressed': selection.modes[q.key] === 'custom', disabled: busy, onClick: () => choose({ mode: 'custom' }) }, q.key === 'type' ? '自定义类型' : '自定义答案')),
      selection.modes[q.key] === 'custom' ? h(Field, { id: 'skm-quick-' + q.key, label: q.key === 'type' ? '你的工作类型' : '你的回答', multiline: q.key !== 'displayName' && q.key !== 'type', hint: q.example || `可修改当前答案；至少 ${q.min} 个字符。`, value: answers[q.key] || '', onChange: value => choose({ mode: 'custom', value }), disabled: busy }) : h('div', { className: 'skm-note', style: { marginTop: 12, whiteSpace: 'pre-wrap' } }, answers[q.key]),
      q.key === 'type' && selection.modes.type === 'custom' ? h('p', { className: 'skm-hint' }, '自定义类型使用通用工作预设；其他题仍可逐题自定义。') : null,
      h('div', { className: 'skm-form-actions' }, h('button', { type: 'button', className: 'skm-secondary', disabled: step === 0 || busy, onClick: () => { setStep(s => s - 1); setError('') } }, '上一问'), h('button', { type: 'submit', className: 'skm-primary', disabled: busy }, step === list.length - 1 ? '生成并检查' : '下一问'))) :
      h('div', null,
        h('div', { className: 'skm-note', style: { marginBottom: 16 } }, h('div', null, h('strong', null, '结构检查 ', assess(answers).filter(c => c.passed).length, ' / ', list.length), h('ul', null, assess(answers).map(c => h('li', { key: c.key }, (c.passed ? '✓ ' : '待补充 ') + CHECK_LABELS[c.key]))))),
        h(Field, { id: 'skm-quick-result-name', label: '技能名称', value: draft.displayName, onChange: displayName => setDraft(d => ({ ...d, displayName })), disabled: busy }),
        h(Field, { id: 'skm-quick-result-description', label: '使用场景', value: draft.description, onChange: description => setDraft(d => ({ ...d, description })), disabled: busy }),
        h(Field, { id: 'skm-quick-result-content', label: '生成的技能（可编辑）', hint: '请确认预设与实际任务相符。保存后先在低风险任务中试用，再调整；不保证精准或完美。', multiline: true, value: draft.content, onChange: content => setDraft(d => ({ ...d, content })), disabled: busy }),
        h('div', { className: 'skm-form-actions' }, h('button', { className: 'skm-secondary', disabled: busy, onClick: () => { setStep(0); setError('') } }, '返回完善回答'), h('button', { className: 'skm-primary', disabled: busy, onClick: save }, busy ? '保存中…' : '确认并创建技能'))))
}
module.exports = { QuickCreate, questions, assess, generate, createSelectionState, selectAnswer }
