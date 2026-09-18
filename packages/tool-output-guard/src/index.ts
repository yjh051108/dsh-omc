/**
 * @dsh-external/dsh-tool-output-guard — 工具结果消息契约守卫。
 *
 * 接缝：`tools/post-execute`（waterfall，最外层）。任何工具调用的最终
 * content 在落成 durable 消息之前经过这里：不是 `ContentBlock[]` 就归一成
 * 合法块数组，并留痕（logger.warn + $DSH_HOME/tool-output-guard.log）。
 *
 * 为什么必须有这道守卫（2026-09-10 案底·session-852e1d99）：
 * 官方 `dsh-tools` 只校验 execute 的 **value**（`tool.output.schema`），
 * **不校验 render 的返回值**；而 render 的返回值会被原样写进 tool-result 块
 * 的 `content`。于是插件一次渲染疏忽（回裸字符串）＝ 会话档落下一条非法消息：
 * 重载被拒（"message must contain one tool-result block"）+ 活着的会话下一轮
 * 死在 `content.some is not a function`（脏消息永远在上下文里，每轮都死）。
 * 边界归一让"一个插件的疏忽"降级为"一条日志"，而不是"一个会话报废"。
 *
 * 这是**守卫**不是**校验**：故意不抛错——工具结果进模型上下文是主链路，
 * 宁可控损也不断链；源头问题靠日志推动修复。
 *
 * @module @dsh-external/dsh-tool-output-guard
 */
import type { Context } from 'cordis'
import type ToolRegistry from '@deepseek-ai/dsh-tools'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeToolContent } from './guard.js'

export const name = '@dsh-external/dsh-tool-output-guard'
export const inject = ['tools']

/** 日志落盘路径（$DSH_HOME 优先，跨重启可审计）。 */
function logPath(): string {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'tool-output-guard.log')
}

/** 尽力留痕：落盘/logger 失败都不影响主链路。 */
function trace(ctx: Context, line: string): void {
  try {
    const path = logPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 落盘只是审计，不因它断链 */
  }
  try {
    ctx.logger.warn(line)
  } catch {
    /* logger 不可用（极早期/已卸载）同样不影响主链路 */
  }
}

export function apply(ctx: Context): void {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // 只接成功的 accept：block（拒绝）自带合法 feedback；替换 value 的决策会在
    // 自己的路径上重新 render（那条路径同样以"最终 content"形态流经本守卫的下一次调用）。
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const current = Object.hasOwn(decision, 'content') ? decision.content : result.content
    const { content, fixes } = normalizeToolContent(current)
    if (fixes.length === 0) return decision
    trace(ctx, `tool "${exec.name}"(call ${exec.callId}) 的 output.render 违反消息契约 → 已归一：${fixes.join('; ')}。请修该插件 render 的返回值（必须回 ContentBlock[]）。`)
    return {
      ...decision,
      content: content as never,
      ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
    }
  }, { prepend: true })
}
