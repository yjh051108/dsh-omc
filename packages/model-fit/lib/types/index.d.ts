/**
 * @dsh-external/dsh-model-fit — 模型适配层 v0.2
 *
 * 两个模块，都挂在 DeepSeek-V4.1-Flash 技术报告的实测结论上：
 *
 * M1 尺子闸（v0.1）
 *   检测「改了东西，尺子却不动」——不同输入读回同一结果，或同一输入反复读回同一结果。
 *   注入自带证据的事实陈述（证据=触发用的那几次入参/读回值）。
 *
 * M2 压缩锚点（v0.2）
 *   论文 §3.2.2：SWA 有界重放「重建出的状态是近似的…依赖缓存命中位置」；
 *   §2.3.2：CSA2 的稀疏检索按块级打分建候选池，没进池的信息后续层找不回来。
 *   而压缩事件自带 shadowedSeqs——精确告诉我们哪些事件刚被埋掉。
 *   据此把「刚被埋掉的开发者原话」重贴回近场（原话，不是我的复述）。
 *
 * 设计原则（为「不烦」服务）：
 *   1. 自带证据：每条干预写明凭什么，模型可据此判断对错
 *   2. 不命令：陈述事实 + 提议动作，不含祈使
 *   3. 有上限：每会话最多 maxPerSession 条，条间有冷却
 *   4. 会闭嘴：干预后若读数仍不动 → 记 ignored，连续 ignored 达阈 → 本会话静默
 *   5. 全程 try-catch 静默：闸故障绝不碰主路
 *
 * 落点：~/.dsh/model-fit/<sid>.jsonl（追加式台账，供事后判对错）
 */
import type { Context } from 'cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-model-fit";
export declare const inject: string[];
export declare const Config: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    /** M1：触发所需的最少连续相同读数次数 */
    minRepeat: z<number, number>;
    /** M1：每会话最多注入几条 */
    maxPerSession: z<number, number>;
    /** M1：两条干预之间的最小间隔（毫秒） */
    cooldownMs: z<number, number>;
    /** M1：判定期（工具调用数） */
    judgeWindow: z<number, number>;
    /** M1：连续 ignored 达几次后本会话静默 */
    silenceAfterIgnored: z<number, number>;
    /** M2：压缩后重贴开发者原话 */
    anchorAfterCompaction: z<boolean, boolean>;
    /** M2：每次重贴最多几条 */
    anchorMax: z<number, number>;
    /** M2：每条截断字符数 */
    anchorChars: z<number, number>;
    /** M2：上下文骤降多少比例算一次压缩（事件缺失时的兜底） */
    compactionDropRatio: z<number, number>;
    /** M2：太短的原话不当锚点（防空话/单词命令噪声——与闭环插件首轮 ≥12 字同口径） */
    anchorMinChars: z<number, number>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    /** M1：触发所需的最少连续相同读数次数 */
    minRepeat: z<number, number>;
    /** M1：每会话最多注入几条 */
    maxPerSession: z<number, number>;
    /** M1：两条干预之间的最小间隔（毫秒） */
    cooldownMs: z<number, number>;
    /** M1：判定期（工具调用数） */
    judgeWindow: z<number, number>;
    /** M1：连续 ignored 达几次后本会话静默 */
    silenceAfterIgnored: z<number, number>;
    /** M2：压缩后重贴开发者原话 */
    anchorAfterCompaction: z<boolean, boolean>;
    /** M2：每次重贴最多几条 */
    anchorMax: z<number, number>;
    /** M2：每条截断字符数 */
    anchorChars: z<number, number>;
    /** M2：上下文骤降多少比例算一次压缩（事件缺失时的兜底） */
    compactionDropRatio: z<number, number>;
    /** M2：太短的原话不当锚点（防空话/单词命令噪声——与闭环插件首轮 ≥12 字同口径） */
    anchorMinChars: z<number, number>;
}>>;
export interface FitConfig {
    enabled: boolean;
    minRepeat: number;
    maxPerSession: number;
    cooldownMs: number;
    judgeWindow: number;
    silenceAfterIgnored: number;
    anchorAfterCompaction: boolean;
    anchorMax: number;
    anchorChars: number;
    compactionDropRatio: number;
    anchorMinChars: number;
}
export declare function apply(ctx: Context, config: FitConfig): void;
