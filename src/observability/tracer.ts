import type {
  TraceSpan,
  TraceEvent,
  TraceSummary,
  Logger,
} from "../core/types.js";
import { v4 as uuid } from "uuid";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Agent Observability & Tracing System
 *
 * Tracks: agent spawns, tool calls, message flow, token usage, timing
 * Output: console dashboard, JSONL file
 */
export class Tracer {
  private traces = new Map<string, TraceSpan>();
  private logger: Logger;
  private outputPath?: string;

  constructor(logger: Logger, outputPath?: string) {
    this.logger = logger;
    this.outputPath = outputPath;
  }

  /**
   * Start a new trace
   */
  startTrace(agentId: string, operation: string): TraceSpan {
    const span: TraceSpan = {
      traceId: uuid(),
      spanId: uuid(),
      agentId,
      operation,
      startTime: new Date(),
      status: "running",
      attributes: {},
      events: [],
      children: [],
    };

    this.traces.set(span.traceId, span);
    return span;
  }

  /**
   * Start a child span within an existing trace
   */
  startSpan(
    traceId: string,
    agentId: string,
    operation: string,
    parentSpanId?: string
  ): TraceSpan {
    const root = this.traces.get(traceId);
    if (!root) throw new Error(`Trace not found: ${traceId}`);

    const span: TraceSpan = {
      traceId,
      spanId: uuid(),
      parentSpanId: parentSpanId ?? root.spanId,
      agentId,
      operation,
      startTime: new Date(),
      status: "running",
      attributes: {},
      events: [],
      children: [],
    };

    // Add to parent
    const parent = this.findSpan(root, parentSpanId ?? root.spanId);
    if (parent) {
      parent.children.push(span);
    }

    return span;
  }

  /**
   * Add an event to a span
   */
  addEvent(
    span: TraceSpan,
    name: string,
    attributes?: Record<string, unknown>
  ): void {
    span.events.push({
      name,
      timestamp: new Date(),
      attributes,
    });
  }

  /**
   * Set attributes on a span
   */
  setAttributes(
    span: TraceSpan,
    attributes: Record<string, unknown>
  ): void {
    Object.assign(span.attributes, attributes);
  }

  /**
   * End a span
   */
  endSpan(span: TraceSpan, status: "completed" | "failed" = "completed"): void {
    span.endTime = new Date();
    span.status = status;
  }

  /**
   * End a trace and generate summary
   */
  async endTrace(traceId: string): Promise<TraceSummary> {
    const root = this.traces.get(traceId);
    if (!root) throw new Error(`Trace not found: ${traceId}`);

    if (root.status === "running") {
      root.endTime = new Date();
      root.status = "completed";
    }

    const summary = this.buildSummary(root);

    // Persist if output path configured
    if (this.outputPath) {
      await this.persistTrace(summary);
    }

    return summary;
  }

  /**
   * Get trace summary without ending it
   */
  getSummary(traceId: string): TraceSummary | null {
    const root = this.traces.get(traceId);
    if (!root) return null;
    return this.buildSummary(root);
  }

  /**
   * Format trace as console dashboard
   */
  formatDashboard(summary: TraceSummary): string {
    const lines: string[] = [];
    const border = "─".repeat(50);

    lines.push(`┌─ Agent Trace Dashboard ${border.slice(24)}┐`);
    lines.push(`│ Trace: ${summary.traceId.slice(0, 8)}...`);
    lines.push(`│ Status: ${summary.status}`);
    lines.push(`│ Duration: ${summary.duration}ms`);
    lines.push(`│ Agents: ${summary.totalAgents}`);
    lines.push(`│ Tool calls: ${summary.totalToolCalls}`);
    lines.push(`│ Tokens: ${summary.totalTokens}`);
    lines.push(`│${border}─│`);

    // Render span tree
    for (const span of summary.spans) {
      this.renderSpanTree(span, lines, "│ ", 0);
    }

    lines.push(`└${"─".repeat(51)}┘`);
    return lines.join("\n");
  }

  // --- Internal ---

  private findSpan(
    root: TraceSpan,
    spanId: string
  ): TraceSpan | null {
    if (root.spanId === spanId) return root;
    for (const child of root.children) {
      const found = this.findSpan(child, spanId);
      if (found) return found;
    }
    return null;
  }

  private buildSummary(root: TraceSpan): TraceSummary {
    const agents = new Set<string>();
    let toolCalls = 0;
    let tokens = 0;

    const collectStats = (span: TraceSpan) => {
      agents.add(span.agentId);
      if (span.operation.startsWith("tool:")) toolCalls++;
      tokens += (span.attributes.tokens as number) ?? 0;
      for (const child of span.children) {
        collectStats(child);
      }
    };
    collectStats(root);

    const duration = root.endTime
      ? root.endTime.getTime() - root.startTime.getTime()
      : Date.now() - root.startTime.getTime();

    return {
      traceId: root.traceId,
      totalAgents: agents.size,
      totalToolCalls: toolCalls,
      totalTokens: tokens,
      duration,
      status: root.status === "failed" ? "failed" : "completed",
      spans: [root],
    };
  }

  private renderSpanTree(
    span: TraceSpan,
    lines: string[],
    prefix: string,
    depth: number
  ): void {
    const indent = "  ".repeat(depth);
    const duration = span.endTime
      ? `${span.endTime.getTime() - span.startTime.getTime()}ms`
      : "running";
    const icon =
      span.status === "completed"
        ? "✓"
        : span.status === "failed"
          ? "✗"
          : "⟳";

    lines.push(
      `${prefix}${indent}${icon} ${span.agentId}: ${span.operation} (${duration})`
    );

    for (const event of span.events) {
      lines.push(
        `${prefix}${indent}  → ${event.name}`
      );
    }

    for (const child of span.children) {
      this.renderSpanTree(child, lines, prefix, depth + 1);
    }
  }

  private async persistTrace(summary: TraceSummary): Promise<void> {
    if (!this.outputPath) return;

    try {
      await mkdir(this.outputPath, { recursive: true });
      const filename = `trace-${summary.traceId.slice(0, 8)}.json`;
      const filePath = join(this.outputPath, filename);
      await writeFile(filePath, JSON.stringify(summary, null, 2), "utf-8");
      this.logger.debug(`Trace persisted: ${filePath}`);
    } catch (err) {
      this.logger.error("Failed to persist trace", {
        error: String(err),
      });
    }
  }

  /**
   * Clean up old traces
   */
  cleanup(maxAgeMs: number = 3_600_000): void {
    const now = Date.now();
    for (const [id, span] of this.traces) {
      if (span.endTime && now - span.endTime.getTime() > maxAgeMs) {
        this.traces.delete(id);
      }
    }
  }
}
