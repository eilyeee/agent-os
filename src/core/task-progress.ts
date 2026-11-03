/**
 * 把高频 CLI 事件收拢成稳定快照。
 * 工具开始与结束可能在几十毫秒内连续出现，飞书刷新速度远低于事件产生速度，
 * 所以卡片渲染读的是这里的快照，而不是原始事件。
 */
import type { CliEvent } from "../cli/types.js";

const MAX_ACTIVITIES = 12;

export interface TaskActivity {
  toolName: string;
  label: string;
  detail?: string;
  durationMs: number;
  failed: boolean;
}

export interface TaskProgressSnapshot {
  current: string;
  currentToolName?: string;
  currentDetail?: string;
  elapsedMs: number;
  toolCount: number;
  completedCount: number;
  activities: TaskActivity[];
  contextUsedTokens?: number;
  contextStartTokens?: number;
  contextWindowTokens?: number;
  startedNewSession?: boolean;
}

interface ActiveTool {
  toolName: string;
  label: string;
  detail?: string;
  startedAt: number;
}

export class TaskProgressTracker {
  private readonly startedAt: number;
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly activities: TaskActivity[] = [];
  private toolCount = 0;
  private completedCount = 0;
  private contextUsedTokens: number | undefined;
  private contextStartTokens: number | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly contextWindowTokens?: number,
    private readonly startedNewSession = false,
  ) {
    this.startedAt = now();
  }

  accept(event: CliEvent): TaskProgressSnapshot {
    if (event.type === "context") {
      // 第一次是本轮起点，之后是当前占用，卡片用两者算出增量。
      this.contextStartTokens ??= event.usedTokens;
      this.contextUsedTokens = event.usedTokens;
    }
    if (event.type === "tool_start") {
      this.toolCount += 1;
      this.activeTools.set(event.toolUseId, {
        toolName: event.toolName,
        label: event.label,
        ...(event.detail ? { detail: event.detail } : {}),
        startedAt: this.now(),
      });
    }
    if (event.type === "tool_end") {
      // 用 toolUseId 配对，多个工具同时运行时不会互相串线。
      const tool = this.activeTools.get(event.toolUseId);
      if (tool) {
        this.activeTools.delete(event.toolUseId);
        this.completedCount += 1;
        this.activities.unshift({
          toolName: tool.toolName,
          label: tool.label,
          ...(tool.detail ? { detail: tool.detail } : {}),
          durationMs: Math.max(0, this.now() - tool.startedAt),
          failed: event.failed,
        });
        this.activities.splice(MAX_ACTIVITIES);
      }
    }
    return this.snapshot();
  }

  snapshot(): TaskProgressSnapshot {
    const active = [...this.activeTools.values()].at(-1);
    return {
      current:
        active?.label ?? (this.toolCount ? "正在分析执行结果" : "正在理解任务"),
      ...(active ? { currentToolName: active.toolName } : {}),
      ...(active?.detail ? { currentDetail: active.detail } : {}),
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      toolCount: this.toolCount,
      completedCount: this.completedCount,
      activities: [...this.activities],
      ...(this.contextUsedTokens !== undefined
        ? { contextUsedTokens: this.contextUsedTokens }
        : {}),
      ...(this.contextStartTokens !== undefined
        ? { contextStartTokens: this.contextStartTokens }
        : {}),
      ...(this.contextWindowTokens !== undefined
        ? { contextWindowTokens: this.contextWindowTokens }
        : {}),
      ...(this.startedNewSession ? { startedNewSession: true } : {}),
    };
  }
}
