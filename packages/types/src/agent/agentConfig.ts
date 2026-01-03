/* eslint-disable sort-keys-fix/sort-keys-fix, typescript-sort-keys/interface */
import { z } from 'zod';

/**
 * Agent 执行模式
 * - auto: 自动决定执行策略
 * - plan: 先规划后执行，适合复杂任务
 * - ask: 执行前询问用户确认
 * - implement: 直接执行，不询问
 */
export type AgentMode = 'auto' | 'plan' | 'ask' | 'implement';

/**
 * Local System 配置（桌面端专用）
 */
export interface LocalSystemConfig {
  /**
   * Local System 工作目录（桌面端专用）
   */
  workingDirectory?: string;

  // 未来可扩展：
  // allowedPaths?: string[];
  // deniedCommands?: string[];
}

/**
 * Agent 模式配置
 * 用于控制 Agent 的执行行为和桌面端 Local System 相关配置
 */
export interface LobeAgentModeConfig {
  /**
   * Agent 执行模式
   * - auto: 自动决定执行策略
   * - plan: 先规划后执行，适合复杂任务
   * - ask: 执行前询问用户确认
   * - implement: 直接执行，不询问
   */
  mode?: AgentMode;

  /**
   * Local System 配置（桌面端专用）
   */
  localSystem?: LocalSystemConfig;
}
/* eslint-enable */

/**
 * Zod schema for LocalSystemConfig
 */
export const LocalSystemConfigSchema = z.object({
  workingDirectory: z.string().optional(),
});

/**
 * Zod schema for LobeAgentModeConfig
 */
export const AgentModeConfigSchema = z.object({
  localSystem: LocalSystemConfigSchema.optional(),
  mode: z.enum(['auto', 'plan', 'ask', 'implement']).optional(),
});
