import type {
  AgentDefinition,
  SubagentRunRecord,
  SpawnOptions,
  SubagentOutcome,
  Logger,
} from "../../core/types.js";
import { DEFAULT_AGENT_CAPABILITIES } from "../../core/types.js";
import { v4 as uuid } from "uuid";
import { ClaudeclawEventBus } from "../../core/events.js";
import { resolveToolPolicy, isToolAllowed, type ToolPolicy } from "../../security/index.js";

/**
 * Central registry for all agents and their subagent runs
 */
export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>();
  private runs = new Map<string, SubagentRunRecord>();
  private toolPolicies = new Map<string, ToolPolicy>();
  private eventBus: ClaudeclawEventBus;
  private logger: Logger;

  constructor(eventBus: ClaudeclawEventBus, logger: Logger) {
    this.eventBus = eventBus;
    this.logger = logger;
  }

  // --- Agent Management ---

  registerAgent(agent: AgentDefinition): void {
    agent.capabilities = {
      ...DEFAULT_AGENT_CAPABILITIES,
      ...agent.capabilities,
    };
    this.agents.set(agent.id, agent);

    // Resolve and cache tool policy for this agent
    const policy = resolveToolPolicy(agent.tools);
    this.toolPolicies.set(agent.id, policy);
    this.logger.info(
      `Agent registered: ${agent.id} (${agent.name}), tool policy: ${policy.mode}` +
        (policy.tools.length > 0 ? ` [${policy.tools.join(", ")}]` : "")
    );
  }

  /**
   * Check if a tool is allowed for an agent (runtime enforcement)
   */
  isToolAllowedForAgent(agentId: string, toolName: string): boolean {
    const policy = this.toolPolicies.get(agentId);
    if (!policy) {
      this.logger.warn(`No tool policy for agent: ${agentId}, denying`);
      return false;
    }
    const allowed = isToolAllowed(toolName, policy);
    if (!allowed) {
      this.logger.warn(
        `Tool denied for agent ${agentId}: ${toolName} (policy: ${policy.mode})`
      );
    }
    return allowed;
  }

  /**
   * Get tool policy for an agent
   */
  getToolPolicy(agentId: string): ToolPolicy | undefined {
    return this.toolPolicies.get(agentId);
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.logger.info(`Agent unregistered: ${agentId}`);
  }

  getAgent(agentId: string): AgentDefinition | undefined {
    return this.agents.get(agentId);
  }

  listAgents(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  // --- Subagent Spawn ---

  async spawn(options: SpawnOptions): Promise<SubagentRunRecord> {
    const {
      agentId,
      task,
      label,
      currentDepth = 0,
      maxDepth = 2,
      timeout = 120_000,
    } = options;

    // Validate agent exists
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Check spawn depth
    if (currentDepth >= maxDepth) {
      throw new Error(
        `Max spawn depth (${maxDepth}) reached at depth ${currentDepth}`
      );
    }

    // Check capabilities
    if (!agent.capabilities?.canSpawn) {
      throw new Error(`Agent ${agentId} does not have spawn capability`);
    }

    // Check concurrent children limit
    const activeChildren = this.countActiveChildren(agentId);
    const maxChildren =
      agent.capabilities?.maxConcurrentChildren ?? 5;
    if (activeChildren >= maxChildren) {
      throw new Error(
        `Agent ${agentId} has reached max concurrent children (${maxChildren})`
      );
    }

    const runId = uuid();
    const record: SubagentRunRecord = {
      runId,
      agentId,
      parentSessionKey: options.agentId,
      childSessionKey: `subagent:${agentId}:${runId}`,
      task,
      label,
      status: "running",
      depth: currentDepth + 1,
      startedAt: new Date(),
      outcome: undefined,
    };

    this.runs.set(runId, record);
    this.eventBus.emit("subagent:spawned", {
      type: "subagent:spawned",
      record,
    });
    this.logger.info(
      `Spawned subagent: ${agentId} (run: ${runId}, depth: ${record.depth})`
    );

    // Set timeout
    if (timeout > 0) {
      setTimeout(() => {
        const run = this.runs.get(runId);
        if (run && run.status === "running") {
          this.completeRun(runId, undefined, "Timeout exceeded", "timeout");
        }
      }, timeout);
    }

    return record;
  }

  // --- Run Lifecycle ---

  completeRun(
    runId: string,
    result?: string,
    error?: string,
    outcome?: SubagentOutcome
  ): SubagentRunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    run.status = error ? "failed" : "completed";
    run.completedAt = new Date();
    run.result = result;
    run.error = error;
    run.outcome = outcome ?? (error ? "error" : "ok");

    this.eventBus.emit("subagent:completed", {
      type: "subagent:completed",
      record: run,
    });
    this.logger.info(
      `Subagent completed: ${run.agentId} (run: ${runId}, outcome: ${run.outcome})`
    );

    return run;
  }

  getRun(runId: string): SubagentRunRecord | undefined {
    return this.runs.get(runId);
  }

  // --- Queries ---

  listRuns(agentId?: string): SubagentRunRecord[] {
    const all = Array.from(this.runs.values());
    if (!agentId) return all;
    return all.filter((r) => r.agentId === agentId);
  }

  listActiveRuns(agentId?: string): SubagentRunRecord[] {
    return this.listRuns(agentId).filter((r) => r.status === "running");
  }

  countActiveChildren(parentAgentId: string): number {
    return Array.from(this.runs.values()).filter(
      (r) =>
        r.parentSessionKey === parentAgentId && r.status === "running"
    ).length;
  }

  countActiveDescendants(agentId: string): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.status === "running" && run.agentId === agentId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Wait for a specific run to complete
   */
  waitForRun(
    runId: string,
    timeoutMs: number = 120_000
  ): Promise<SubagentRunRecord> {
    return new Promise((resolve, reject) => {
      const run = this.runs.get(runId);
      if (!run) {
        reject(new Error(`Run not found: ${runId}`));
        return;
      }
      if (run.status !== "running") {
        resolve(run);
        return;
      }

      const handler = (event: { record: SubagentRunRecord }) => {
        if (event.record.runId === runId) {
          this.eventBus.off("subagent:completed", handler);
          clearTimeout(timer);
          resolve(event.record);
        }
      };

      const timer = setTimeout(() => {
        this.eventBus.off("subagent:completed", handler);
        reject(new Error(`Timeout waiting for run ${runId}`));
      }, timeoutMs);

      this.eventBus.on("subagent:completed", handler);
    });
  }

  /**
   * Cleanup completed runs older than given age
   */
  cleanup(maxAgeMs: number = 3_600_000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [runId, run] of this.runs) {
      if (
        run.status !== "running" &&
        run.completedAt &&
        now - run.completedAt.getTime() > maxAgeMs
      ) {
        this.runs.delete(runId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} completed runs`);
    }
    return cleaned;
  }
}
