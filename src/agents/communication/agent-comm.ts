import type { AgentMessage, PubSubTopic, Logger } from "../../core/types.js";
import { ClaudeclawEventBus } from "../../core/events.js";
import { v4 as uuid } from "uuid";

type MessageHandler = (message: AgentMessage) => Promise<void>;

/**
 * Agent Communication Hub
 * Supports: direct send, yield, broadcast, pub/sub
 */
export interface CommAuthPolicy {
  /** Set of registered agent IDs that can communicate */
  registeredAgents: Set<string>;
  /** Allowlist: agentId -> set of agents it can send to (empty = all) */
  allowlist?: Map<string, Set<string>>;
}

export class AgentCommHub {
  private handlers = new Map<string, MessageHandler[]>();
  private topics = new Map<string, PubSubTopic>();
  private pendingYields = new Map<
    string,
    {
      resolve: (msg: AgentMessage) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private blackboard = new Map<string, unknown>();
  private eventBus: ClaudeclawEventBus;
  private logger: Logger;
  private authPolicy?: CommAuthPolicy;

  constructor(eventBus: ClaudeclawEventBus, logger: Logger, authPolicy?: CommAuthPolicy) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.authPolicy = authPolicy;
  }

  /**
   * Update auth policy (e.g. when agents are registered/unregistered)
   */
  setAuthPolicy(policy: CommAuthPolicy): void {
    this.authPolicy = policy;
  }

  private assertAuthorized(from: string, to: string): void {
    if (!this.authPolicy) return;

    if (!this.authPolicy.registeredAgents.has(from)) {
      throw new Error(`Unauthorized sender: ${from}`);
    }
    if (to !== "*" && !this.authPolicy.registeredAgents.has(to)) {
      throw new Error(`Unknown recipient: ${to}`);
    }
    if (this.authPolicy.allowlist) {
      const allowed = this.authPolicy.allowlist.get(from);
      if (allowed && to !== "*" && !allowed.has(to)) {
        throw new Error(`Agent ${from} not authorized to send to ${to}`);
      }
    }
  }

  // --- Direct Messaging ---

  /**
   * Send a direct message to a specific agent
   */
  async send(
    from: string,
    to: string,
    payload: unknown
  ): Promise<void> {
    this.assertAuthorized(from, to);

    const message: AgentMessage = {
      from,
      to,
      type: "direct",
      payload,
      timestamp: new Date(),
      correlationId: uuid(),
    };

    this.logger.debug(`Message: ${from} → ${to}`);
    await this.deliver(to, message);
  }

  /**
   * Register a message handler for an agent
   */
  onMessage(agentId: string, handler: MessageHandler): void {
    const existing = this.handlers.get(agentId) ?? [];
    existing.push(handler);
    this.handlers.set(agentId, existing);
  }

  /**
   * Remove all handlers for an agent
   */
  removeHandlers(agentId: string): void {
    this.handlers.delete(agentId);
  }

  // --- Yield (Request-Response) ---

  /**
   * Send a yield request and wait for response
   */
  async yield(
    from: string,
    to: string,
    payload: unknown,
    timeoutMs: number = 120_000
  ): Promise<AgentMessage> {
    this.assertAuthorized(from, to);
    const correlationId = uuid();

    const message: AgentMessage = {
      from,
      to,
      type: "yield-request",
      payload,
      timestamp: new Date(),
      correlationId,
    };

    return new Promise<AgentMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingYields.delete(correlationId);
        reject(new Error(`Yield timeout: ${from} → ${to}`));
      }, timeoutMs);

      this.pendingYields.set(correlationId, { resolve, reject, timer });
      this.deliver(to, message).catch(reject);
    });
  }

  /**
   * Respond to a yield request
   */
  async yieldResponse(
    from: string,
    correlationId: string,
    payload: unknown
  ): Promise<void> {
    const pending = this.pendingYields.get(correlationId);
    if (!pending) {
      this.logger.warn(
        `No pending yield for correlationId: ${correlationId}`
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pendingYields.delete(correlationId);

    pending.resolve({
      from,
      to: "",
      type: "yield-response",
      payload,
      timestamp: new Date(),
      correlationId,
    });
  }

  // --- Broadcast ---

  /**
   * Broadcast a message to all registered agents
   */
  async broadcast(
    from: string,
    payload: unknown,
    exclude?: string[]
  ): Promise<void> {
    const message: AgentMessage = {
      from,
      to: "*",
      type: "broadcast",
      payload,
      timestamp: new Date(),
      correlationId: uuid(),
    };

    this.logger.debug(
      `Broadcast from ${from} to ${this.handlers.size} agents`
    );

    const deliveries: Promise<void>[] = [];
    for (const agentId of this.handlers.keys()) {
      if (agentId === from) continue;
      if (exclude?.includes(agentId)) continue;
      deliveries.push(this.deliver(agentId, { ...message, to: agentId }));
    }

    await Promise.allSettled(deliveries);
  }

  // --- Pub/Sub ---

  /**
   * Subscribe an agent to a topic
   */
  subscribe(agentId: string, topicName: string): void {
    let topic = this.topics.get(topicName);
    if (!topic) {
      topic = { name: topicName, subscribers: new Set() };
      this.topics.set(topicName, topic);
    }
    topic.subscribers.add(agentId);
    this.logger.debug(`${agentId} subscribed to topic: ${topicName}`);
  }

  /**
   * Unsubscribe an agent from a topic
   */
  unsubscribe(agentId: string, topicName: string): void {
    const topic = this.topics.get(topicName);
    if (topic) {
      topic.subscribers.delete(agentId);
      if (topic.subscribers.size === 0) {
        this.topics.delete(topicName);
      }
    }
  }

  /**
   * Publish a message to all topic subscribers
   */
  async publish(
    from: string,
    topicName: string,
    payload: unknown
  ): Promise<void> {
    const topic = this.topics.get(topicName);
    if (!topic) {
      this.logger.warn(`Topic not found: ${topicName}`);
      return;
    }

    this.logger.debug(
      `Publish to ${topicName}: ${topic.subscribers.size} subscribers`
    );

    const deliveries: Promise<void>[] = [];
    for (const agentId of topic.subscribers) {
      if (agentId === from) continue;
      deliveries.push(
        this.deliver(agentId, {
          from,
          to: agentId,
          type: "direct",
          payload: { topic: topicName, data: payload },
          timestamp: new Date(),
          correlationId: uuid(),
        })
      );
    }

    await Promise.allSettled(deliveries);
  }

  // --- Shared Blackboard ---

  /**
   * Set a value on the shared blackboard
   */
  setShared(key: string, value: unknown): void {
    this.blackboard.set(key, value);
  }

  /**
   * Get a value from the shared blackboard
   */
  getShared<T = unknown>(key: string): T | undefined {
    return this.blackboard.get(key) as T | undefined;
  }

  /**
   * Delete a value from the shared blackboard
   */
  deleteShared(key: string): void {
    this.blackboard.delete(key);
  }

  /**
   * List all blackboard keys
   */
  listSharedKeys(): string[] {
    return Array.from(this.blackboard.keys());
  }

  // --- Internal ---

  private async deliver(
    agentId: string,
    message: AgentMessage
  ): Promise<void> {
    const handlers = this.handlers.get(agentId);
    if (!handlers || handlers.length === 0) {
      this.logger.warn(`No handlers for agent: ${agentId}`);
      return;
    }

    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (err) {
        this.logger.error(`Handler error for ${agentId}`, {
          error: String(err),
        });
      }
    }
  }

  /**
   * Clean up all state
   */
  destroy(): void {
    for (const pending of this.pendingYields.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CommHub destroyed"));
    }
    this.pendingYields.clear();
    this.handlers.clear();
    this.topics.clear();
    this.blackboard.clear();
  }
}
