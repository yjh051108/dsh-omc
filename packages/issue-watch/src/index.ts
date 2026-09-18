/**
 * @dsh-external/dsh-issue-watch — 每小时巡检 GitHub issue/PR 并处理（daemon-loop 形态）。
 *
 * 形态：timer 驱动 → 调用确定性巡检脚本 `D:/dsh/03-dev-infra/issue-pr-watch.mjs`
 *      （PR 先隔离 worktree 验证，全绿且路径白名单内才合并；issue 只登记报告）→ 写日志。
 *
 * 为什么是确定性脚本而不是 LLM 决策：合并/评论是不可逆动作，规则要能审计、能复算；
 * 需要判断的部分（issue 复现与修复）留给下一次人工/agent 会话，脚本只负责"发现 + 低风险自动化"。
 *
 * 插件自身的参数（intervalMs / 脚本路径 / 是否允许自动合并）皆可改 → build → dev_reload_package。
 */
import type { Context } from 'cordis'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import z from 'schemastery'

type AppContext = Context & {
  setInterval(fn: () => void, ms: number): any
}

export const name = '@dsh-external/dsh-issue-watch'
export const inject = ['timer']

export interface Config {
  intervalMs: number
  script: string
  repos: string
  autoMerge: boolean
  logFile: string
}

export const Config = z.object({
  intervalMs: z.number().min(60000).default(3600000), // 每小时
  script: z.string().default('D:/dsh/03-dev-infra/issue-pr-watch.mjs'),
  repos: z.string().default('yjh051108/dsh-agi-harness,yjh051108/dsh-routing-suite'),
  autoMerge: z.boolean().default(true),
  logFile: z.string().default(''),
})

export function apply(ctx: AppContext, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const logFile = config.logFile || join(dshHome, 'super-injector', 'dsh-issue-watch.log')
  let cycles = 0
  let running = false

  const log = (msg: string): void => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n')
    } catch { /* 日志失败静默 */ }
  }

  const runOnce = (): void => {
    if (running) { log('上一轮仍在跑，跳过本轮'); return }
    running = true
    cycles += 1
    const argv = [config.script, '--repos', config.repos]
    if (config.autoMerge) argv.push('--merge')
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { out += d })
    child.on('error', (e) => { running = false; log(`cycle=${cycles} 启动失败: ${String(e).slice(0, 120)}`) })
    child.on('close', (code) => {
      running = false
      const tail = out.trim().split('\n').slice(-6).join(' | ')
      log(`cycle=${cycles} exit=${code} ${tail.slice(0, 400)}`)
    })
  }

  // 启动先跑一轮（宿主重启后立刻对账一次），之后每 intervalMs 一轮
  setTimeout(runOnce, 8000)
  ctx.setInterval(runOnce, config.intervalMs)
  ctx.logger?.info?.(`[${name}] 巡检启动（每 ${Math.round(config.intervalMs / 60000)} 分钟一轮，autoMerge=${config.autoMerge}）`)
}
