/**
 * probe-source.js —— **探针源码的机械判据**（`RULES.yml` 的 `R2`；2026-09-14 / task-85 实现、task-92 移入 lib）。
 *
 * ## 为什么单独一个 lib 模块（**单一事实来源**）
 * 判据有**两个消费者**，且**必须用同一份代码**（否则"离线检"与"在线拦"会出现两套判据 ⇒ 两份事实）：
 *   ① **离线检**：`teamkit probe-check <file|--stdin>`（`bin/teamkit.mjs`，作者自查 / CI）；
 *   ② **在线拦**：`tools.guard()`（`lib/probe-gate.js`，装 `dev_stage_add` 之前必过闸）。
 * ⇒ 本文件**在 lib/ 里**（`bin/` 不能作为被 lib 依赖的模块：那份文件的底部就是 CLI 入口 `switch (cmd)`，
 *   **import 它会重跑整个 CLI**）。
 *
 * ⚠️ **零依赖**：只用 JS 原生（无 import）—— 满足 `plugin/lib/**` "只允许 node: 内置与相对导入"的纪律（`H12`）。
 */

// ── R2 探针纪律的**机械校验**（`H46`；2026-09-14 / task-85）─────────────────────
/**
 * ★★ **探针"写共享对象却无回读校验"的机械判据**（`RULES.yml` 的 `R2`）。
 *
 * ## 为什么要有它（P0 事故，不是假想）
 * ```
 * 一支探针为了验证"包视图能否让字段可见"，包了 `at.journal.state` 并做
 *   s.tasks = s.tasks.map(t => ({ ...t, e2rProbe: 'INST-WRAP' }))
 * 本意是只读验证，但那个 task 对象**会被底座经 `team/task` 事件持久化**，
 * 而 `teamTaskSnapshotSchema` 是 `.strict()` ⇒ 多一个键 ⇒ `parsePersisted` 抛
 * ⇒ `state.failure` 置位，且 `projection.js:157` `if (state.failure !== undefined) return`
 *   ⇒ **此后所有 Team 事件一律被跳过（永不自愈）** ⇒ **全公司读不到板**。
 * ```
 * ⇒ 见 `runs/005-role-skills/INCIDENT-P0-BOARD-CORRUPTION.md`。
 *
 * ## 判据（两半，缺一不可）
 * **触发面**：出现"**对对象写字段 / 改原型**"的形态；
 * **豁免面**：**同一函数作用域内**存在**回读校验**（"改完读回来比对"）才算合规。
 * ⚠️ **只写注释说"会还原"不算** —— 那是 `H41` 家族（**文案不是机制**）。
 *
 * ## ★ 为什么做成**导出函数**（这是本任务最要紧的一点）
 * **真正危险的那支探针从不落盘**：`dev_stage_add` 的 `inline execute` 只在宿主内存里跑。
 * 纯文件扫描**永远抓不到它**（事故那支就是这种）。⇒ 必须有一个**可复用**的入口：
 *   · `teamkit probe-check <file>`（落盘探针）；
 *   · `teamkit probe-check --stdin`（**把 inline snippet 管道进来**）—— **这才覆盖真出事的形态**；
 *   · 或由将来的探针作者 `import { checkProbeSource } from 'teamkit'` 自查。
 *
 * @param source 探针源码（或 snippet）
 * @returns `{ ok, violations:[{line, kind, text}], exempted:boolean, why }`
 */
export function checkProbeSource(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  // ⚠️ **先剥注释再扫**（本项目老坑：`H12`/`H32` 都栽在"把注释里的反面写法当真在用"）。
  //   这里剥注释有**双重目的**：① 不误报"注释里举的例子"；
  //   ② ★ **正面堵住"只写注释声称会还原"** —— 那种文案剥掉后**不产生任何回读证据**。
  const blank = (s) => ' '.repeat(s.length)
  const code = lines.map((l) => {
    let out = l
    out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => blank(m)) // 块注释（同行内）
    out = out.replace(/(^|[^:])\/\/.*$/, (m, p1) => p1 + blank(m.slice(p1.length))) // 行注释（避开 `https://`）
    return out
  })
  // 跨行块注释：`/*`…`*/` 分段屏蔽（简单状态机，够用且不引依赖）
  {
    let inBlock = false
    for (let i = 0; i < code.length; i += 1) {
      const l = code[i]
      if (inBlock) {
        const end = l.indexOf('*/')
        if (end === -1) { code[i] = blank(l); continue }
        code[i] = blank(l.slice(0, end + 2)) + l.slice(end + 2)
        inBlock = false
        continue
      }
      const start = l.indexOf('/*')
      if (start !== -1 && l.indexOf('*/', start) === -1) {
        code[i] = l.slice(0, start) + blank(l.slice(start))
        inBlock = true
      }
    }
  }

  // ── 触发面：对**共享对象**写字段 / 改原型 ────────────────────────────────
  // ⚠️ **必须限定"写的是【共享】对象"**，不能把普通局部赋值判红（那会造出 `H29` 那种恒红没人看的判据）。
  //   ★ **"共享"的判据（这条是精度关键）**：写的目标**不是本文件自己造出来的**。
  //     反例（**必须放过**）：`class FakeJournal {}` + `FakeJournal.prototype.state = …`
  //       —— 那是**本文件自己的假类**，改它**伤不到宿主**（`exp/board-diag/release-restore-proof.mjs` 就是这种，
  //       我第一版把它判红了 ⇒ **假阳性**，靠跑真语料抓到）。
  const LOCAL_CLASS = new Set()
  for (const line of code) {
    let m = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (m) LOCAL_CLASS.add(m[1])
    m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*class\b/.exec(line)
    if (m) LOCAL_CLASS.add(m[1])
  }
  // ★★ **"本文件自己造的"对象**（可安全写）—— 但**必须与"来自宿主的"严格区分**：
  //   ✅ 算：`const j = new FakeJournal()` / `const o = { … }` / `= []`
  //   ❌ **不算**：RHS 里出现 `ctx.get(` / `require(` / `import` / 参数 —— 那些是**宿主给的对象**
  //     （`const at = ctx.get('agentTeams')` ⇒ `at.journal.state = …` **正是事故原形，必须判红**）。
  const LOCAL_SAFE = new Set()
  for (const line of code) {
    const m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*)/.exec(line)
    if (m === null) continue
    const rhs = m[2]
    if (/ctx\.get\s*\(|require\s*\(|\bimport\b|\bargs\b|\bctx\b/.test(rhs)) continue // 宿主来的 ⇒ 不安全
    if (/^\s*new\s+[A-Za-z_$]/.test(rhs) || /^\s*\{/.test(rhs) || /^\s*\[/.test(rhs)) LOCAL_SAFE.add(m[1])
  }
  /** 这一行的写入目标是不是"本文件自己造的/自己的类"（⇒ 伤不到宿主） */
  const writesOnlyLocal = (line) => {
    // ① `<LocalClass>.prototype.<m> =` ⇒ 改自己的类
    let m = /\b([A-Za-z_$][\w$]*)\.prototype\.[\w$]+\s*=/.exec(line)
    if (m !== null && LOCAL_CLASS.has(m[1])) return true
    // ② `<localVar>.<prop> =` ⇒ 写自己造的对象（**只认根标识符在 LOCAL_SAFE 里**）
    m = /\b([A-Za-z_$][\w$]*)\./.exec(line)
    if (m !== null && LOCAL_SAFE.has(m[1]) && !/\.prototype\./.test(line)) return true
    return false
  }
  const TRIGGERS = [
    { kind: 'defineProperty', re: /Object\.defineProperty\s*\(\s*[^'"]/ },
    // ⚠️ 两个 `applies` 语义**必须一致**（= "这条触发成立吗"）——
    //   我第一版把 `prototype-write` 写反了（传 `writesOnlyLocal` 而非取反）⇒
    //   **自己的假类被判红**（假阳性），靠**跑真语料**+**逐行核**抓到。
    { kind: 'prototype-write', re: /\.prototype\.[\w$]+\s*=/, applies: (l) => !writesOnlyLocal(l) },
    { kind: 'namespace-write', re: /\b[\w$.]+\.(?:journal|roster|config|state|tasks|members)\s*=\s*(?!==)/, applies: (l) => !writesOnlyLocal(l) },
    { kind: 'inject-into-shared', re: /\.tasks\s*=\s*[^;\n]*\.map\s*\(\s*\w+\s*=>\s*\(\s*\{\s*\.\.\./, applies: (l) => !writesOnlyLocal(l) },
  ]
  // ── 豁免面：同一（近似）作用域内的**回读校验**（"改完读回来比对"）─────────────────
  //   ⚠️ **只在代码里找**（注释已剥）⇒ **"我会还原"那句注释不产生豁免**。
  //   ⚠️ **大小写不敏感**：真语料里 `ORIGINAL` / `ORIG` 是常见写法
  //     （我第一版区分大小写 ⇒ 漏判 ⇒ 把 `=== ORIGINAL` 的回读当"没有回读"⇒ 假阳性）。
  const READBACK = [
    /===\s*(?:orig|original|before|prev|saved|source|pristine)[\w$]*/i,   // `x === origState` / `=== ORIGINAL`
    /\b(?:orig|original|before|prev|saved|source|pristine)[\w$]*\s*===/i, // `origState === x`
    /readback|readBack|回读/i,                                             // 显式回读
    /restored\s*[:=]/i,                                                    // `restored=true/…`
    /已还原/,                                                               // 中文回读标记（**代码串**里）
  ]
  // 「同一函数作用域」的**廉价近似**：以**函数体块**为界（`function`/箭头函数的 `{`…`}`）。
  // ⚠️ 这是近似：真正的词法作用域要解析器。⇒ **近似要标出来**（见 `why`），
  //   宁可**偏严**（把"证据在别处"的判红），也不放过事故形态 —— 但**已知偏严的代价**。
  const scopesOf = (codeLines) => {
    const scopes = []
    for (let i = 0; i < codeLines.length; i += 1) {
      if (!/\bfunction\b|=>\s*\{|\bdo\s*\{|\btry\s*\{|\bfor\s*\(|\bif\s*\(|\bwhile\s*\(/.test(codeLines[i])) continue
      // 从这一行往后按大括号配平，取一个"块"
      let depth = 0, started = false, end = -1
      for (let j = i; j < codeLines.length && j < i + 400; j += 1) {
        const l = codeLines[j]
        for (const ch of l) {
          if (ch === '{') { depth += 1; started = true } else if (ch === '}') { depth -= 1 }
        }
        if (started && depth <= 0) { end = j; break }
      }
      if (started && end > i) scopes.push([i, end])
    }
    return scopes
  }
  const scopes = scopesOf(code)
  const violations = []
  for (let i = 0; i < code.length; i += 1) {
    const l = code[i]
    if (l.trim() === '') continue
    // ⚠️ `applies` = "这条触发成立吗"（默认成立；`writesOnlyLocal` 那条用来**排除自己的假类**）
    const hit = TRIGGERS.find((t) => t.re.test(l) && (t.applies === undefined || t.applies(l)))
    if (hit === undefined) continue
    // 找**包含这一行的最小函数作用域**；没有再退化成"全文件找回读"
    const enclosing = scopes.filter(([a, b]) => a <= i && i <= b).sort((x, y) => (x[1] - x[0]) - (y[1] - y[0]))[0]
    const [a, b] = enclosing ?? [0, code.length - 1]
    // ★★ **回读证据在【含触发行的整个作用域】里找**。
    //   ⚠️ 我第一版把**触发行本身排除掉**（怕 `x = orig` 的 RHS 被当证据）——
    //   那在**单行/压缩**代码上会**把整个作用域排除光** ⇒ 绿样本被误判红（真 bug，靠文件级变异测试抓到）。
    //   ⇒ 改用"**不排除、但把 READBACK 正则写得只认真比对形态**"：
    //     它们都要求 `===` 两侧成对，而 `x = orig`（单个 `=`）**不会**命中（已逐条核过）。
    const scopeText = code.slice(a, b + 1).join('\n')
    const hasReadback = READBACK.some((re) => re.test(scopeText))
    if (!hasReadback) violations.push({ line: i + 1, kind: hit.kind, text: lines[i].trim().slice(0, 120) })
  }
  const anyReadback = READBACK.some((re) => re.test(code.join('\n')))
  return {
    ok: violations.length === 0,
    violations,
    exempted: violations.length === 0 && anyReadback,
    why:
      violations.length === 0
        ? anyReadback
          ? '有"写共享对象"的形态，且**作用域内有回读校验** ⇒ 合规'
          : '**没有**"写共享对象"的形态 ⇒ 不适用（合规）'
        : `${violations.length} 处"写共享对象"**且作用域内无回读校验** ⇒ 违规（R2）`,
    note: '作用域判定是**大括号块的廉价近似**（无解析器依赖）；宁可偏严',
  }
}
