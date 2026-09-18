import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeToolContent } from './guard.js';
export const name = '@dsh-external/dsh-tool-output-guard';
export const inject = ['tools'];
/** 日志落盘路径（$DSH_HOME 优先，跨重启可审计）。 */
function logPath() {
    const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    return join(home, 'tool-output-guard.log');
}
/** 尽力留痕：落盘/logger 失败都不影响主链路。 */
function trace(ctx, line) {
    try {
        const path = logPath();
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8');
    }
    catch {
        /* 落盘只是审计，不因它断链 */
    }
    try {
        ctx.logger.warn(line);
    }
    catch {
        /* logger 不可用（极早期/已卸载）同样不影响主链路 */
    }
}
export function apply(ctx) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next();
        // 只接成功的 accept：block（拒绝）自带合法 feedback；替换 value 的决策会在
        // 自己的路径上重新 render（那条路径同样以"最终 content"形态流经本守卫的下一次调用）。
        if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value'))
            return decision;
        const current = Object.hasOwn(decision, 'content') ? decision.content : result.content;
        const { content, fixes } = normalizeToolContent(current);
        if (fixes.length === 0)
            return decision;
        trace(ctx, `tool "${exec.name}"(call ${exec.callId}) 的 output.render 违反消息契约 → 已归一：${fixes.join('; ')}。请修该插件 render 的返回值（必须回 ContentBlock[]）。`);
        return {
            ...decision,
            content: content,
            ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
        };
    }, { prepend: true });
}
//# sourceMappingURL=index.js.map