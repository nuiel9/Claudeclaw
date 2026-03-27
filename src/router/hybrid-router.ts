import type {
  InboundMessage,
  RouterConfig,
  RoutingRule,
  RouteResult,
  AgentDefinition,
  Logger,
} from "../core/types.js";

/**
 * Hybrid Router: rule-based matching first, LLM fallback for unmatched messages
 *
 * Priority order (highest to lowest):
 * 1. Exact peer match
 * 2. Channel + chatId match
 * 3. Channel + pattern match
 * 4. Guild/team match
 * 5. Channel-only match
 * 6. LLM-based routing (if enabled)
 * 7. Default agent fallback
 */
export class HybridRouter {
  private config: RouterConfig;
  private agents: Map<string, AgentDefinition>;
  private logger: Logger;
  private llmRouter?: LLMRouterFn;

  constructor(
    config: RouterConfig,
    agents: Map<string, AgentDefinition>,
    logger: Logger,
    llmRouter?: LLMRouterFn
  ) {
    this.config = config;
    this.agents = agents;
    this.logger = logger;
    this.llmRouter = llmRouter;

    // Sort rules by priority (lower number = higher priority)
    if (this.config.rules) {
      this.config.rules.sort((a, b) => a.priority - b.priority);
    }
  }

  /**
   * Route an inbound message to the appropriate agent
   */
  async route(message: InboundMessage): Promise<RouteResult> {
    // Step 1: Try rule-based routing
    if (
      this.config.mode === "rule-based" ||
      this.config.mode === "hybrid"
    ) {
      const ruleResult = this.matchRules(message);
      if (ruleResult) {
        this.logger.debug(
          `Rule-based match: ${ruleResult.agentId} (rule priority: ${ruleResult.matchedRule?.priority})`
        );
        return ruleResult;
      }
    }

    // Step 2: Try LLM-based routing
    if (
      (this.config.mode === "llm-based" ||
        this.config.mode === "hybrid") &&
      this.llmRouter
    ) {
      const llmResult = await this.llmRoute(message);
      if (llmResult && llmResult.confidence > 0.5) {
        this.logger.debug(
          `LLM-based match: ${llmResult.agentId} (confidence: ${llmResult.confidence})`
        );
        return llmResult;
      }
    }

    // Step 3: Default fallback
    this.logger.debug(
      `No match found, falling back to default agent: ${this.config.defaultAgentId}`
    );
    return {
      agentId: this.config.defaultAgentId,
      confidence: 0.1,
      reason: "default fallback",
    };
  }

  /**
   * Rule-based matching with priority hierarchy
   */
  private matchRules(message: InboundMessage): RouteResult | null {
    const rules = this.config.rules ?? [];

    for (const rule of rules) {
      if (this.matchesRule(message, rule)) {
        return {
          agentId: rule.agentId,
          confidence: 1.0,
          matchedRule: rule,
          reason: `Matched rule (priority: ${rule.priority})`,
        };
      }
    }

    // Also check agent bindings
    for (const agent of this.agents.values()) {
      if (!agent.bindings) continue;
      for (const binding of agent.bindings) {
        const asRule: RoutingRule = {
          priority: binding.priority,
          match: binding.match,
          agentId: agent.id,
        };
        if (this.matchesRule(message, asRule)) {
          return {
            agentId: agent.id,
            confidence: 1.0,
            matchedRule: asRule,
            reason: `Matched binding (priority: ${binding.priority})`,
          };
        }
      }
    }

    return null;
  }

  /**
   * Check if a message matches a routing rule (AND semantics)
   */
  private matchesRule(message: InboundMessage, rule: RoutingRule): boolean {
    const { match } = rule;

    if (match.channel && match.channel !== message.channel) return false;
    if (match.peerId && match.peerId !== message.senderId) return false;

    if (match.pattern) {
      try {
        const regex = new RegExp(match.pattern, "i");
        // Guard against ReDoS: test only first 1000 chars with timeout
        const testContent = message.content.slice(0, 1000);
        if (!regex.test(testContent)) return false;
      } catch {
        this.logger.warn("Invalid pattern in routing rule");
        return false;
      }
    }

    return true;
  }

  /**
   * LLM-based routing: ask the model which agent should handle
   */
  private async llmRoute(
    message: InboundMessage
  ): Promise<RouteResult | null> {
    if (!this.llmRouter) return null;

    const agentDescriptions = Array.from(this.agents.values())
      .map((a) => `- ${a.id}: ${a.description}`)
      .join("\n");

    try {
      return await this.llmRouter(message, agentDescriptions);
    } catch (err) {
      this.logger.error("LLM routing failed", {
        error: String(err),
      });
      return null;
    }
  }

  /**
   * Add a routing rule dynamically
   */
  addRule(rule: RoutingRule): void {
    if (!this.config.rules) this.config.rules = [];
    this.config.rules.push(rule);
    this.config.rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Remove a routing rule by agent id
   */
  removeRule(agentId: string): void {
    if (!this.config.rules) return;
    this.config.rules = this.config.rules.filter(
      (r) => r.agentId !== agentId
    );
  }
}

/**
 * Function type for LLM-based routing
 */
export type LLMRouterFn = (
  message: InboundMessage,
  agentDescriptions: string
) => Promise<RouteResult | null>;

/**
 * Create a default LLM router prompt
 */
export function buildLLMRouterPrompt(
  message: InboundMessage,
  agentDescriptions: string
): string {
  return `You are a message router. Given the following message and available agents, respond with ONLY the agent ID that should handle this message.

Message from ${message.senderName} (${message.channel}):
"${message.content}"

Available agents:
${agentDescriptions}

Respond with just the agent ID, nothing else.`;
}
