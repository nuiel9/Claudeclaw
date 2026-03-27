import type {
  ClaudeclawConfig,
  InboundMessage,
  Logger,
  BootstrapFile,
} from "./core/types.js";
import { ClaudeclawEventBus } from "./core/events.js";
import { AgentRegistry } from "./agents/registry/agent-registry.js";
import { AgentCommHub, type CommAuthPolicy } from "./agents/communication/agent-comm.js";
import { HybridRouter } from "./router/hybrid-router.js";
import { WorkflowEngine } from "./flows/workflow-engine.js";
import { ConsensusEngine } from "./consensus/consensus-engine.js";
import { ChannelManager } from "./channels/plugins/channel-manager.js";
import { Tracer } from "./observability/tracer.js";
import { MemorySessionStore } from "./sessions/session-store.js";
import { loadBootstrapFiles } from "./agents/workspace/loader.js";
import { buildAgentSystemPrompt } from "./agents/system-prompt.js";
import {
  createSession,
  buildSessionKey,
  addMessageToSession,
} from "./sessions/session-store.js";
import {
  SessionWriteLock,
  ExecApprovalManager,
  resolveToolPolicy,
  isToolAllowed,
} from "./security/index.js";
import { RateLimiter } from "./security/rate-limiter.js";
import { detectDuplicateTokens } from "./config/config-loader.js";
import { ClaudeClient } from "./agents/claude-client.js";

/**
 * Main Claudeclaw Gateway
 *
 * Orchestrates all subsystems:
 * - Agent Registry & Spawn
 * - Hybrid Router
 * - Agent Communication Hub
 * - Workflow Engine
 * - Consensus Engine
 * - Channel Manager (Telegram, Discord)
 * - Observability & Tracing
 */
export class ClaudeclawGateway {
  private config: ClaudeclawConfig;
  private logger: Logger;

  // Core systems
  private eventBus: ClaudeclawEventBus;
  private agentRegistry: AgentRegistry;
  private commHub: AgentCommHub;
  private router: HybridRouter;
  private workflowEngine: WorkflowEngine;
  private consensusEngine: ConsensusEngine;
  private channelManager: ChannelManager;
  private tracer: Tracer;
  private sessionStore: MemorySessionStore;

  // Security systems
  private sessionWriteLock: SessionWriteLock;
  private execApprovalManager: ExecApprovalManager;
  private rateLimiter: RateLimiter;

  // LLM
  private claudeClient: ClaudeClient | null = null;
  private bootstrapFiles: BootstrapFile[] = [];
  private systemPrompts = new Map<string, string>();

  constructor(config: ClaudeclawConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // Initialize core systems
    this.eventBus = new ClaudeclawEventBus(logger);
    this.sessionStore = new MemorySessionStore();
    this.agentRegistry = new AgentRegistry(this.eventBus, logger);

    // Initialize CommHub with auth policy wired from agent config
    const registeredAgents = new Set(Object.keys(config.agents));
    const commAuthPolicy: CommAuthPolicy = { registeredAgents };
    this.commHub = new AgentCommHub(this.eventBus, logger, commAuthPolicy);

    // Initialize security systems
    this.sessionWriteLock = new SessionWriteLock();
    this.execApprovalManager = new ExecApprovalManager(logger);
    this.rateLimiter = new RateLimiter(undefined, logger);

    // Detect duplicate tokens across channels
    detectDuplicateTokens(config, logger);
    this.workflowEngine = new WorkflowEngine(this.eventBus, logger);
    this.consensusEngine = new ConsensusEngine(this.eventBus, logger);
    this.channelManager = new ChannelManager(logger, this.sessionStore);
    this.tracer = new Tracer(
      logger,
      config.observability.enabled ? config.observability.logPath : undefined
    );

    // Initialize router with agent map
    const agentMap = new Map(
      Object.entries(config.agents).map(([id, def]) => [id, def])
    );
    this.router = new HybridRouter(config.router, agentMap, logger);
  }

  /**
   * Start the gateway
   */
  async start(): Promise<void> {
    this.logger.info("Claudeclaw Gateway starting...");

    // 1. Register all agents
    for (const agent of Object.values(this.config.agents)) {
      this.agentRegistry.registerAgent(agent);
    }
    this.logger.info(
      `Registered ${this.agentRegistry.listAgents().length} agents`
    );

    // 2. Load bootstrap files for workspace
    this.bootstrapFiles = await loadBootstrapFiles(
      this.config.workspace.path,
      { logger: this.logger }
    );

    // 3. Build system prompts for all agents
    for (const agent of Object.values(this.config.agents)) {
      const systemPrompt = buildAgentSystemPrompt({
        agent,
        bootstrapFiles: this.bootstrapFiles,
      });
      this.systemPrompts.set(agent.id, systemPrompt);
      this.logger.info(
        `System prompt built for ${agent.id}: ${systemPrompt.length} chars`
      );
    }

    // 4. Initialize Claude client (tries: config authToken → config apiKey → Claude Code keychain)
    try {
      this.claudeClient = new ClaudeClient(
        this.config.anthropic,
        this.logger
      );
      this.logger.info("Claude API client initialized");
    } catch (err) {
      this.logger.warn(
        "Claude client not available, using echo mode. " +
        "Set anthropic.authToken or anthropic.apiKey in config, " +
        "use env vars, or log in with Claude Code (claude login).",
        { error: String(err) }
      );
    }

    // 5. Initialize channels
    await this.channelManager.initialize(this.config);

    // 6. Set up message routing
    this.channelManager.onMessage(async (message) => {
      await this.handleInboundMessage(message);
    });

    // 7. Start all channels
    await this.channelManager.startAll(this.config.defaultAgent);

    // 8. Set up event listeners
    this.setupEventListeners();

    this.logger.info("Claudeclaw Gateway started successfully");
    this.logger.info(
      `Active channels: ${this.channelManager.listChannels().join(", ") || "none"}`
    );
    this.logger.info("Waiting for messages...");
  }

  /**
   * Stop the gateway
   */
  async stop(): Promise<void> {
    this.logger.info("Claudeclaw Gateway stopping...");
    await this.channelManager.stopAll();
    this.commHub.destroy();
    this.eventBus.removeAllListeners();
    this.logger.info("Claudeclaw Gateway stopped");
  }

  /**
   * Handle an inbound message from any channel
   */
  private async handleInboundMessage(
    message: InboundMessage
  ): Promise<void> {
    // Multi-tier rate limiting (per-sender, per-channel, global)
    const rateResult = this.rateLimiter.check(message.senderId, message.chatId);
    if (rateResult.limited) {
      this.logger.warn(
        `Rate limited (${rateResult.tier}): ${message.senderId} (${message.senderName}), retry after ${rateResult.retryAfterMs}ms`
      );
      return;
    }

    // Start trace
    const trace = this.tracer.startTrace(
      "gateway",
      `message:${message.channel}`
    );
    this.tracer.addEvent(trace, "message_received", {
      channel: message.channel,
      sender: message.senderName,
    });

    try {
      // Route to agent
      const routeSpan = this.tracer.startSpan(
        trace.traceId,
        "router",
        "route"
      );
      const routeResult = await this.router.route(message);
      this.tracer.endSpan(routeSpan);

      this.logger.info(
        `Routed to agent: ${routeResult.agentId} (confidence: ${routeResult.confidence})`
      );

      // Get or create session (with write lock to prevent race conditions)
      const sessionKey = buildSessionKey({
        agentId: routeResult.agentId,
        channel: message.channel,
        chatId: message.chatId,
        peerId: message.senderId,
      });

      const session = await this.sessionWriteLock.withLock(
        sessionKey,
        async () => {
          let s = await this.sessionStore.get(sessionKey);
          if (!s) {
            s = createSession(
              routeResult.agentId,
              sessionKey,
              message.channel,
              message.senderId
            );
          }
          addMessageToSession(s, "user", message.content, {
            channel: message.channel,
            senderId: message.senderId,
            senderName: message.senderName,
          });
          await this.sessionStore.set(sessionKey, s);
          return s;
        }
      );

      // Emit event
      this.eventBus.emit("message:received", {
        type: "message:received",
        message,
      });

      // Process with agent via Claude API
      const agentSpan = this.tracer.startSpan(
        trace.traceId,
        routeResult.agentId,
        "process"
      );

      let responseContent: string;

      if (this.claudeClient) {
        try {
          const agent = this.config.agents[routeResult.agentId];
          const systemPrompt = this.systemPrompts.get(routeResult.agentId);

          const claudeResponse = await this.claudeClient.sendMessage(
            session,
            message.content,
            {
              model: agent?.model,
              systemPrompt,
            }
          );

          responseContent = claudeResponse.content;

          this.tracer.addEvent(agentSpan, "llm_response", {
            model: claudeResponse.model,
            inputTokens: claudeResponse.inputTokens,
            outputTokens: claudeResponse.outputTokens,
            stopReason: claudeResponse.stopReason,
          });
        } catch (err) {
          this.logger.error("Claude API call failed, falling back to echo", {
            error: String(err),
            agentId: routeResult.agentId,
          });
          responseContent =
            `[${routeResult.agentId}] Sorry, I encountered an error processing your message. ` +
            `Please try again later.`;
        }
      } else {
        // Echo mode (no API key configured)
        responseContent =
          `[${routeResult.agentId}] Received: "${message.content.slice(0, 100)}"` +
          `\n\nI'm ${routeResult.agentId}, routed via ${routeResult.reason ?? "default"}. ` +
          `Claude API is not configured — running in echo mode.`;
      }

      this.tracer.endSpan(agentSpan);

      // Send response back through channel
      const sendSpan = this.tracer.startSpan(
        trace.traceId,
        "gateway",
        "send"
      );

      const result = await this.channelManager.send(message.channel, {
        chatId: message.chatId,
        content: responseContent,
        threadId: message.threadId,
        replyToId: message.id,
      });

      this.tracer.endSpan(sendSpan, result.success ? "completed" : "failed");

      // Add response to session
      addMessageToSession(session, "assistant", responseContent);
      await this.sessionStore.set(sessionKey, session);

      // End trace
      const summary = await this.tracer.endTrace(trace.traceId);

      if (this.config.observability.enabled) {
        this.logger.debug(this.tracer.formatDashboard(summary));
      }
    } catch (err) {
      this.tracer.endSpan(trace, "failed");
      this.logger.error("Message handling failed", {
        error: String(err),
        messageId: message.id,
      });
    }
  }

  // --- Event Listeners ---

  private setupEventListeners(): void {
    this.eventBus.on("subagent:spawned", (event) => {
      this.logger.info(
        `Subagent spawned: ${event.record.agentId} (depth: ${event.record.depth})`
      );
    });

    this.eventBus.on("subagent:completed", (event) => {
      this.logger.info(
        `Subagent completed: ${event.record.agentId} (outcome: ${event.record.outcome})`
      );
    });

    this.eventBus.on("workflow:completed", (event) => {
      this.logger.info(
        `Workflow completed: ${event.workflowId} (status: ${event.status})`
      );
    });
  }

  // --- Public Accessors ---

  getAgentRegistry(): AgentRegistry {
    return this.agentRegistry;
  }

  getCommHub(): AgentCommHub {
    return this.commHub;
  }

  getWorkflowEngine(): WorkflowEngine {
    return this.workflowEngine;
  }

  getConsensusEngine(): ConsensusEngine {
    return this.consensusEngine;
  }

  getTracer(): Tracer {
    return this.tracer;
  }

  getClaudeClient(): ClaudeClient | null {
    return this.claudeClient;
  }
}
