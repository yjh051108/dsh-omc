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
import type { Context } from 'cordis';
import z from 'schemastery';
type AppContext = Context & {
    setInterval(fn: () => void, ms: number): any;
};
export declare const name = "@dsh-external/dsh-issue-watch";
export declare const inject: string[];
export interface Config {
    intervalMs: number;
    script: string;
    repos: string;
    autoMerge: boolean;
    logFile: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    intervalMs: z<number, number>;
    script: z<string, string>;
    repos: z<string, string>;
    autoMerge: z<boolean, boolean>;
    logFile: z<string, string>;
}>, Schemastery.ObjectT<{
    intervalMs: z<number, number>;
    script: z<string, string>;
    repos: z<string, string>;
    autoMerge: z<boolean, boolean>;
    logFile: z<string, string>;
}>>;
export declare function apply(ctx: AppContext, config: Config): void;
export {};
