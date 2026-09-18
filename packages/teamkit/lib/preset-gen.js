/**
 * preset-gen.js —— **预设生成器的内核**（task-99）：模板 + 参数 → **完整文件**。
 *
 * ## 为什么是"生成完整文件"，不是"只存差异"（设计判定，已 CEO 批）
 * 技能 fork 的"只存差异"**依赖一条已存在的 overlay 机制**（nearest layer wins，实测过）；
 * 而 **DSH 的 preset 是整体挂载，没有逐行合并语义** ⇒ 要"只存差异"就必须**新造一层合并语义**
 * ⇒ **不许发明**（会与 DSH 机制打架）。⇒ 本内核**渲染出完整文件**：
 *   · **不复制基线**：不与 `omc` 或任何已有预设共享字节，也不绑定它们的内容；
 *   · **不引用基线**：输出自足（预设是整体挂载）；
 *   · **可复跑**：⚠️ 手改过的输出**再跑一次会被覆盖回模板的样子** —— 这条要在 README 里明写。
 *
 * ## ⚠️ 为什么不拿 `presets/omc/agent.cordis.yml` 当模板
 * `omc` 里含**真机验证过的可移植表达式**（`!!js` 读 `$DSH_HOME`）、技能隔离、上游链闭合、预设闸门。
 * 用它当模板 ⇒ **再造一个事实来源**，正是本任务（`R10` SOT）要消灭的东西。
 * ⇒ **`omc` 保持人工维护**；本内核只服务**新预设**。（`presets/omc/raw/_generate-agent-cordis.mjs`
 *   那次教训同源：它产出的东西含开发机绝对路径，已被自带护栏判过期。）
 *
 * ## 三态口径
 *   · **名字合法性** = **代码强制**（照抄 `dsh-agent-presets/lib/types/preset.js:10` 的正则）；
 *   · **"不覆盖已有预设"** = **代码强制**（本内核的 `plan()` 判 `existsSync` 后拒绝）；
 *   · **渲染出的 YAML 能被 DSH 挂上** = **实测**（判据是 `mountPreset` 零 import 失败；
 *     见 `MULTI-INSTANCE.md`/`PRESET-GEN.md` 的读数）—— 本内核**不自己声称**这点；
 *   · **模板本身的正确性** = **只由"真挂一次"证明**，不是由本文件的注释证明。
 *
 * 零依赖：只用 node 内置（与 `plugin/lib` 的口径一致）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 预设 id 的合法形态 —— **逐字照抄** DSH 自己的正则。
 * 依据：`dsh-agent-presets/lib/types/preset.js:10` `export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/`
 * ⚠️ **不自己发明更严或更松的规则** —— 宽了会让生成物被 DSH 判成不存在（
 *    `discovery.js:293` 用同一条正则跳过非法目录），严了会拒绝 DSH 其实接受的名字。
 */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/** 生成器的占位符前缀。用 `@` 是为了与 **DSH 自己的** `{{cwd}}` / `{{model}}` 区分开。 */
const PH = '@'
/**
 * ⚠️ **必须与 DSH 的占位符区分**：`persona` 里本来就有 `{{cwd}}` / `{{model}}`
 * （由 DSH 在该 agent 自己的路由/工作区上解析）。第一版我把生成器占位符写成 `{{name}}`
 * ⇒ **一旦有人真去替换它，就会与 DSH 的变量空间撞车**。
 * ⇒ 生成器的占位符统一加 `@`：`{{@name}}` / `{{@presetId}}` / `{{@persona}}`。
 */
const PLACEHOLDERS = ['name', 'presetId', 'persona']

/** 默认模板 id（两个形态里的轻的那个）。 */
export const DEFAULT_TEMPLATE = 'lite'

/** 模板 id 的形态（与 preset id 同规；模板是目录名）。 */
export const TEMPLATE_ID_RE = PRESET_ID_RE

/**
 * 内置人格默认值（**只用于生成时占位符替换**，不是"岗位数据"）。
 * ⚠️ 刻意**不含任何岗位字段**：岗位数据在 `talents/*.md`（→ 生成 `roles/*.json`），
 *    预设只做**装配**（读 `roles.dir`）。判据见 `check-preset-overlap.mjs` 第 ④ 条。
 */
export const DEFAULT_PERSONA = [
  'You are a capable engineer working inside DeepSeek Harness.',
  'Work in small complete steps: it runs, it is tested, it connects.',
  'Numbers come from two places: what actually ran, or what is on disk. Everything else is a hypothesis.',
  'When you are blocked, report the blocker with the readout you have — do not guess your way past it.',
].join('\n')

/**
 * 校验预设名。
 *
 * 三态：**代码强制**。返回 `{ok, why}`，**永不抛**（调用方要拿到 why 去打印）。
 * @param name 用户给的名字
 * @returns {{ok: boolean, why: string}}
 */
export function validatePresetName(name) {
  if (typeof name !== 'string') return { ok: false, why: `预设名必须是字符串（收到 ${typeof name}）` }
  if (name === '') return { ok: false, why: '预设名不能为空' }
  if (!PRESET_ID_RE.test(name)) {
    // 报错要**可执行**：说清规则 + 给一个合法示例，而不是只说"不合法"。
    return {
      ok: false,
      why: `预设名 "${name}" 不合法：DSH 要求 /${PRESET_ID_RE.source}/ `
        + '（小写字母或数字开头，之后是小写字母/数字/连字符；不能有大写、下划线、点、空格、中文）'
        + `；合法示例：my-team`,
    }
  }
  return { ok: true, why: 'ok' }
}

/**
 * 列出可用模板（读目录，**每次现读** —— 与 `dsh-skill-filesystem` 的"每次读都现扫磁盘"同形）。
 *
 * 判据：目录里有 `agent.cordis.yml.tmpl` 才算一个可用模板。
 * ⚠️ **`.tmpl` 后缀是承重的**：安装器按"目录下有没有 `agent.cordis.yml`"挑预设
 *    （`install-teamkit.mjs:349`）⇒ 模板**不会被当成预设装到用户机器上**。
 * @param templatesDir 模板根（含 `<id>/agent.cordis.yml.tmpl`）
 * @returns {{ok: boolean, why: string, templates: string[]}}
 */
export function listTemplates(templatesDir) {
  if (typeof templatesDir !== 'string' || templatesDir === '') {
    return { ok: false, why: 'templatesDir 为空', templates: [] }
  }
  if (!existsSync(templatesDir)) {
    return { ok: false, why: `模板目录不存在：${templatesDir}`, templates: [] }
  }
  let entries = []
  try {
    entries = readdirSync(templatesDir, { withFileTypes: true })
  } catch (err) {
    return { ok: false, why: `模板目录读不到：${err?.message ?? String(err)}`, templates: [] }
  }
  const templates = entries
    .filter((e) => e.isDirectory() && TEMPLATE_ID_RE.test(e.name))
    .filter((e) => existsSync(join(templatesDir, e.name, 'agent.cordis.yml.tmpl')))
    .map((e) => e.name)
    .sort()
  if (templates.length === 0) {
    return { ok: false, why: `模板目录里没有可用模板（${templatesDir}）：每个模板目录要含 agent.cordis.yml.tmpl`, templates: [] }
  }
  return { ok: true, why: 'ok', templates }
}

/**
 * 读一个模板的原文。
 * @returns {{ok: boolean, why: string, text?: string}}
 */
export function readTemplate(templatesDir, templateId) {
  const v = validatePresetName(templateId) // 模板 id 与预设 id 同规
  if (!v.ok) return { ok: false, why: `模板 id 不合法：${v.why}` }
  const file = join(templatesDir, templateId, 'agent.cordis.yml.tmpl')
  if (!existsSync(file)) return { ok: false, why: `模板不存在：${file}` }
  try {
    return { ok: true, why: 'ok', text: readFileSync(file, 'utf8') }
  } catch (err) {
    return { ok: false, why: `模板读不到：${err?.message ?? String(err)}` }
  }
}

/**
 * 渲染 composition（`agent.cordis.yml`）。**纯函数**：不读盘、不写盘。
 *
 * @param opts.templateText 模板原文（由调用方用 `readTemplate` 取，便于单测）
 * @param opts.name         预设名（同时作为 `preset.id`，除非显式给 presetId）
 * @param opts.presetId     预设闸门用的 id（缺省 = name）
 * @param opts.persona      persona 正文（缺省 `DEFAULT_PERSONA`）
 * @returns {{ok: boolean, why: string, text?: string, unreplaced?: string[]}}
 */
export function renderComposition({ templateText, name, presetId, persona }) {
  if (typeof templateText !== 'string' || templateText === '') {
    return { ok: false, why: '模板原文为空' }
  }
  const v = validatePresetName(name)
  if (!v.ok) return { ok: false, why: v.why }
  const pid = presetId === undefined ? name : presetId
  const pv = validatePresetName(pid)
  if (!pv.ok) return { ok: false, why: `presetId 不合法：${pv.why}` }

  const values = {
    name,
    presetId: pid,
    // ⚠️ persona 是多行文本。**模板里占位符自己带缩进**（`{{@persona}}` 顶格写在模板第 6 列之后），
    //    所以这里**只做首行前的缩进 + 后续行缩进**，并且**以占位符所在行的列位为准**。
    //    ★ 我第一版写错了两次、都是**真 YAML 解析器**抓出来的（不是"看起来不对"）：
    //      ① 先做成"每行加 6 空格" ⇒ 模板那行本身已有缩进 ⇒ **12 空格** ⇒
    //         `bad indentation of a mapping entry`（JS-YAML 原话）；
    //      ② 所以缩进**不能由内核拍一个常量**，必须**从模板里那个占位符的位置推**。
    //    ⇒ 现在：占位符在模板里**独占一行**，内核把该行的前导空格当基准，后续行对齐到同一列。
    persona: String(persona === undefined ? DEFAULT_PERSONA : persona).replace(/\r\n/g, '\n'),
  }

  let out = templateText
  for (const key of PLACEHOLDERS) {
    const token = `{{${PH}${key}}}`
    // ★ **多行占位符要按"它所在那一行的列位"对齐后续行**（否则 YAML 块级标量会被判缩进错）。
    //   做法：逐行找 token；找到就把它替换成 value，并把 value 的第 2..n 行**补上该行的前导空格**。
    out = substituteAtColumn(out, token, values[key])
  }

  // ★ **反向自证**：渲染完**不许再残留生成器占位符**（否则生成物是坏的 YAML/注释）。
  //   只查 `{{@…}}`（带 @ 的），**不碰** DSH 自己的 `{{cwd}}` / `{{model}}`。
  const left = [...new Set([...out.matchAll(/\{\{@[a-zA-Z][a-zA-Z0-9]*\}\}/g)].map((m) => m[0]))]
  if (left.length > 0) {
    return { ok: false, why: `渲染后仍残留生成器占位符：${left.join(', ')}（模板里写错名字了？）`, unreplaced: left }
  }
  return { ok: true, why: 'ok', text: out }
}

/**
 * 渲染显示元数据（`preset.yml`）。**纯函数**。
 *
 * 依据（实读 `dsh-agent-presets/lib/index.js:51-74` 的 `readPresetMetadata`）：
 *   · 只读 `name`(string) / `description`(string) / `order`(number)；
 *   · **其余键被忽略**（`parsed` 只取这三个）⇒ 多写不会报错，但也**不起作用** ⇒ 本内核只写这三个。
 * @returns {{ok: boolean, why: string, text?: string}}
 */
export function renderMetadata({ name, description, order }) {
  const v = validatePresetName(name)
  if (!v.ok) return { ok: false, why: v.why }
  const lines = []
  lines.push(`name: ${yamlScalar(name)}`)
  if (description !== undefined && String(description).trim() !== '') {
    lines.push(`description: ${yamlScalar(String(description))}`)
  }
  if (order !== undefined) {
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      return { ok: false, why: `order 必须是有限数字（收到 ${JSON.stringify(order)}）` }
    }
    lines.push(`order: ${order}`)
  }
  return { ok: true, why: 'ok', text: lines.join('\n') + '\n' }
}

/**
 * **纯决策**函数：算出"该写哪两个文件、内容是什么"，或**拒绝**。
 *
 * ⚠️ 本函数**不写盘**（写盘在 CLI 里）⇒ 单测可以不碰文件系统。
 * ⚠️ **拒绝的第一条理由就是"不许覆盖已有预设"**（task-99 的红线）：
 *    预设目录已存在 ⇒ 直接拒（**不静默跳过、不半覆盖**）。
 *
 * @param opts.targetDir  预设根（`<...>/presets` 或 `$DSH_HOME/.agent-presets`）
 * @param opts.templatesDir 模板根
 * @param opts.name
 * @param opts.template
 * @param opts.presetId / opts.persona / opts.description / opts.order
 * @returns {{ok, why, files?: Array<{path, text}>, template?: string}}
 */
export function plan(opts) {
  const { targetDir, templatesDir, name } = opts ?? {}
  if (typeof targetDir !== 'string' || targetDir === '') return { ok: false, why: 'targetDir 为空' }

  const nv = validatePresetName(name)
  if (!nv.ok) return { ok: false, why: nv.why }

  const templateId = opts.template === undefined ? DEFAULT_TEMPLATE : opts.template
  const avail = listTemplates(templatesDir)
  if (!avail.ok) return { ok: false, why: avail.why }
  if (!avail.templates.includes(templateId)) {
    // 报错要**可执行**：列出可用的，而不是只说"模板不存在"。
    return { ok: false, why: `模板 "${templateId}" 不存在；可用模板：${avail.templates.join(', ')}` }
  }

  // ★ **不覆盖已有预设** —— 顺序上放在"渲染"之前（先拒，再做无用功）。
  const dir = join(targetDir, name)
  if (existsSync(dir)) {
    return {
      ok: false,
      why: `预设 "${name}" 已存在（${dir}）⇒ 拒绝覆盖。`
        + '换一个名字，或先把那个目录移走（本工具**永不**覆盖已有预设）。',
    }
  }

  const tpl = readTemplate(templatesDir, templateId)
  if (!tpl.ok) return { ok: false, why: tpl.why }

  const comp = renderComposition({
    templateText: tpl.text,
    name,
    ...(opts.presetId === undefined ? {} : { presetId: opts.presetId }),
    ...(opts.persona === undefined ? {} : { persona: opts.persona }),
  })
  if (!comp.ok) return { ok: false, why: comp.why }

  const meta = renderMetadata({
    name,
    ...(opts.description === undefined ? {} : { description: opts.description }),
    ...(opts.order === undefined ? {} : { order: opts.order }),
  })
  if (!meta.ok) return { ok: false, why: meta.why }

  return {
    ok: true,
    why: 'ok',
    template: templateId,
    files: [
      { path: join(dir, 'agent.cordis.yml'), text: comp.text },
      { path: join(dir, 'preset.yml'), text: meta.text },
    ],
  }
}

// ── 小工具（纯函数，导出供测试直接钉）────────────────────────────────────────

/**
 * 把 `token` 替换成 `value`；**若该 token 所在行有前导空格，value 的后续行对齐到同一列**。
 *
 * 为什么需要它：模板里 persona 是 YAML 块级标量（`|-`）的正文，占位符写在**块内**。
 * 多行值直接塞进去 ⇒ 第 2 行起**没有任何缩进** ⇒ YAML 解析器报
 * `bad indentation of a mapping entry`（我实测到的原文）。
 * 单行值（`{{@name}}`）走同一路径也不会被改坏（没有"后续行"）。
 *
 * @param text 模板原文
 * @param token 形如 `{{@persona}}`
 * @param value 替换值（可多行）
 */
export function substituteAtColumn(text, token, value) {
  if (!text.includes(token)) return text
  const lines = text.split('\n')
  const vlines = String(value).split('\n')
  const out = []
  for (const line of lines) {
    const at = line.indexOf(token)
    if (at === -1) { out.push(line); continue }
    const lead = line.slice(0, at)            // token 之前的内容（含缩进）
    // token 独占一行是最常见形态；若同一行还有别的字符，也照样把后续行对齐到 `lead` 的宽度。
    if (vlines.length === 1) { out.push(lead + vlines[0] + line.slice(at + token.length)); continue }
    out.push(lead + vlines[0])
    for (let i = 1; i < vlines.length; i++) {
      out.push(vlines[i] === '' ? '' : lead + vlines[i])
    }
    // token 独占一行时 remainder 是空串 ⇒ **不要**再 push（否则留一行多余空行）。
    const rest = line.slice(at + token.length)
    if (rest !== '') out.push(rest)
  }
  return out.join('\n')
}

/**
 * 把多行文本按给定缩进量归一化（用于 YAML 块级标量 `|-` 的正文）。
 * 空行保持空（不补空格），避免尾随空白影响逐字节比对。
 * @param text 多行文本
 * @param spaces 缩进的空格数
 */
export function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces)
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line.trimStart()))
    .join('\n')
}

/**
 * 把标量渲染成 YAML 安全形态：**一律用单引号 + 转义内部单引号**。
 * 为什么一律加引号：`description` 里可能有 `:`、`#`、`*`、`|` 等（我们自己的预设描述就含 `**` 与 `/`）
 * ⇒ 不加引号会被 YAML 解释成别的东西（`preset.yml` 曾被误写成 markdown 风格就是同族问题）。
 */
export function yamlScalar(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}
