// ============================================================
// Claudeclaw Core Types
// ============================================================

// --- Agent Types ---

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  model?: ModelId;
  tools?: string[];
  workspace?: string;
  maxSpawnDepth?: number;
  soul?: SoulConfig;
  bindings?: AgentBinding[];
  capabilities?: AgentCapabilities;
}

export type ModelId = "opus" | "sonnet" | "haiku" | string;

export interface SoulConfig {
  content: string;
  path?: string;
  traits?: Record<string, string>;
  boundaries?: string[];
  vibe?: string;
}

export interface AgentCapabilities {
  canSpawn: boolean;
  canSend: boolean;
  canYield: boolean;
  canBroadcast: boolean;
  maxConcurrentChildren: number;
}

export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilities = {
  canSpawn: true,
  canSend: true,
  canYield: true,
  canBroadcast: false,
  maxConcurrentChildren: 5,
};

// --- Agent Binding (for routing) ---

export interface AgentBinding {
  priority: number;
  match: BindingMatch;
}

export interface BindingMatch {
  channel?: string;
  peerId?: string;
  guildId?: string;
  roles?: string[];
  teamId?: string;
  accountId?: string;
  pattern?: string; // regex pattern for message content
}

// --- Session Types ---

export interface Session {
  id: string;
  agentId: string;
  key: string;
  channelId?: string;
  peerId?: string;
  createdAt: Date;
  lastActiveAt: Date;
  metadata: Record<string, unknown>;
  history: SessionMessage[];
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

// --- Channel Types ---

export type ChatChannelId =
  | "telegram"
  | "discord"
  | "slack"
  | "whatsapp"
  | "irc"
  | "line"
  | "web";

export interface ChannelPlugin<TConfig = unknown> {
  id: ChatChannelId;
  name: string;
  description: string;
  capabilities: ChannelCapabilities;
  config: TConfig;

  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<SendResult>;
  onMessage(handler: InboundMessageHandler): void;
}

export interface ChannelCapabilities {
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsEditing: boolean;
  supportsMedia: boolean;
  supportsVoice: boolean;
  supportsPolls: boolean;
  supportsComponents: boolean;
  maxMessageLength: number;
}

export interface ChannelContext {
  agentId: string;
  config: Record<string, unknown>;
  logger: Logger;
  sessionStore: SessionStore;
}

// --- Message Types ---

export interface InboundMessage {
  id: string;
  channel: ChatChannelId;
  senderId: string;
  senderName: string;
  chatId: string;
  threadId?: string;
  content: string;
  media?: MediaPayload[];
  timestamp: Date;
  raw?: unknown;
}

export type InboundMessageHandler = (message: InboundMessage) => Promise<void>;

export interface OutboundMessage {
  chatId: string;
  threadId?: string;
  content: string;
  media?: MediaPayload[];
  replyToId?: string;
  components?: MessageComponent[];
  silent?: boolean;
}

export interface SendResult {
  messageId: string;
  success: boolean;
  error?: string;
}

export interface MediaPayload {
  type: "image" | "video" | "audio" | "document" | "sticker" | "gif";
  url?: string;
  path?: string;
  buffer?: Buffer;
  mimeType?: string;
  filename?: string;
  caption?: string;
}

export interface MessageComponent {
  type: "button" | "select" | "text_input";
  id: string;
  label: string;
  options?: { label: string; value: string }[];
}

// --- Workspace / Bootstrap Types ---

export type BootstrapFileName =
  | "SOUL.md"
  | "AGENTS.md"
  | "TOOLS.md"
  | "IDENTITY.md"
  | "USER.md"
  | "HEARTBEAT.md"
  | "BOOTSTRAP.md"
  | "MEMORY.md";

export interface BootstrapFile {
  name: BootstrapFileName;
  path: string;
  content: string;
  size: number;
  lastModified: Date;
}

export interface WorkspaceConfig {
  path: string;
  maxFileChars: number;
  maxTotalChars: number;
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  path: "~/.claudeclaw/workspace",
  maxFileChars: 20_000,
  maxTotalChars: 150_000,
};

// --- Spawn / SubAgent Types ---

export type SpawnMode = "isolated" | "shared-context" | "inherited";

export interface SpawnOptions {
  agentId: string;
  task: string;
  label?: string;
  model?: ModelId;
  timeout?: number;
  maxDepth?: number;
  currentDepth?: number;
  cleanup?: "delete" | "keep";
  contextStrategy?: ContextStrategy;
}

export type ContextStrategyMode =
  | "isolated"
  | "shared-memory"
  | "inherited"
  | "blackboard";

export interface ContextStrategy {
  mode: ContextStrategyMode;
  maxContextTokens?: number;
  sharedKeys?: string[];
}

export interface SubagentRunRecord {
  runId: string;
  agentId: string;
  parentSessionKey: string;
  childSessionKey: string;
  task: string;
  label?: string;
  status: SubagentStatus;
  depth: number;
  startedAt: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
  outcome?: SubagentOutcome;
}

export type SubagentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

export type SubagentOutcome = "ok" | "error" | "timeout";

// --- Router Types ---

export type RouterMode = "rule-based" | "llm-based" | "hybrid";

export interface RouterConfig {
  mode: RouterMode;
  defaultAgentId: string;
  rules?: RoutingRule[];
  llmModel?: ModelId;
}

export interface RoutingRule {
  priority: number;
  match: BindingMatch;
  agentId: string;
}

export interface RouteResult {
  agentId: string;
  confidence: number;
  matchedRule?: RoutingRule;
  reason?: string;
}

// --- Workflow / DAG Types ---

export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  id: string;
  agentId: string;
  task?: string;
  dependsOn?: string[];
  parallel?: boolean;
  retry?: RetryConfig;
  fallback?: "skip" | "abort" | string;
  timeout?: number;
}

export interface RetryConfig {
  maxRetries: number;
  backoffMs?: number;
  backoffFactor?: number;
}

export type WorkflowStepStatus =
  | "pending"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface WorkflowRunState {
  workflowId: string;
  stepStates: Map<string, WorkflowStepState>;
  startedAt: Date;
  completedAt?: Date;
  status: "running" | "completed" | "failed";
}

export interface WorkflowStepState {
  stepId: string;
  status: WorkflowStepStatus;
  result?: string;
  error?: string;
  attempts: number;
  startedAt?: Date;
  completedAt?: Date;
}

// --- Consensus Types ---

export type ConsensusMode = "majority-vote" | "debate" | "ranked-choice" | "unanimous";

export interface ConsensusRequest {
  question: string;
  agents: string[];
  mode: ConsensusMode;
  maxRounds?: number;
  context?: string;
}

export interface ConsensusVote {
  agentId: string;
  answer: string;
  confidence: number;
  reasoning: string;
}

export interface ConsensusResult {
  decision: string;
  votes: ConsensusVote[];
  rounds: number;
  unanimous: boolean;
  confidence: number;
}

// --- Communication Types ---

export interface AgentMessage {
  from: string;
  to: string;
  type: "direct" | "broadcast" | "yield-request" | "yield-response";
  payload: unknown;
  timestamp: Date;
  correlationId?: string;
}

export interface PubSubTopic {
  name: string;
  subscribers: Set<string>;
}

// --- Observability Types ---

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agentId: string;
  operation: string;
  startTime: Date;
  endTime?: Date;
  status: "running" | "completed" | "failed";
  attributes: Record<string, unknown>;
  events: TraceEvent[];
  children: TraceSpan[];
}

export interface TraceEvent {
  name: string;
  timestamp: Date;
  attributes?: Record<string, unknown>;
}

export interface TraceSummary {
  traceId: string;
  totalAgents: number;
  totalToolCalls: number;
  totalTokens: number;
  duration: number;
  status: "completed" | "failed";
  spans: TraceSpan[];
}

// --- Config Types ---

export interface ClaudeclawConfig {
  agents: Record<string, AgentDefinition>;
  defaultAgent: string;
  router: RouterConfig;
  channels: ChannelConfigs;
  anthropic: AnthropicConfig;
  workspace: WorkspaceConfig;
  observability: ObservabilityConfig;
}

export interface AnthropicConfig {
  /** API key or env var reference (e.g. "$ANTHROPIC_API_KEY") */
  apiKey: string;
  /** OAuth token or env var reference (e.g. "$CLAUDE_OAUTH_TOKEN"). Used instead of apiKey when set. */
  authToken?: string;
  /** Default model for agents that don't specify one */
  defaultModel: ModelId;
  /** Max tokens for completion responses */
  maxTokens: number;
  /** Temperature (0-1) */
  temperature?: number;
  /** Base URL override (for proxies or compatible APIs) */
  baseUrl?: string;
  /** Request timeout in ms (default: 120000) */
  timeoutMs?: number;
  /** Enable streaming responses */
  streaming?: boolean;
}

export interface ChannelConfigs {
  telegram?: TelegramConfig;
  discord?: DiscordConfig;
}

export interface TelegramConfig {
  enabled: boolean;
  token: string;
  mode?: "polling" | "webhook";
  webhook?: {
    url: string;
    port: number;
    secret?: string;
  };
  allowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
}

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  intents?: string[];
  guilds?: Record<string, { channels?: string[]; roles?: string[] }>;
  groupPolicy?: "open" | "allowlist" | "disabled";
}

export interface ObservabilityConfig {
  enabled: boolean;
  traceLevel: "minimal" | "standard" | "verbose";
  output: "console" | "file" | "both";
  logPath?: string;
}

// --- Utility Types ---

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export interface SessionStore {
  get(key: string): Promise<Session | undefined>;
  set(key: string, session: Session): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<Session[]>;
}

// --- Event System ---

export type ClaudeclawEvent =
  | { type: "agent:started"; agentId: string }
  | { type: "agent:stopped"; agentId: string }
  | { type: "session:created"; session: Session }
  | { type: "session:ended"; sessionId: string }
  | { type: "message:received"; message: InboundMessage }
  | { type: "message:sent"; message: OutboundMessage; result: SendResult }
  | { type: "subagent:spawned"; record: SubagentRunRecord }
  | { type: "subagent:completed"; record: SubagentRunRecord }
  | { type: "workflow:started"; workflowId: string }
  | { type: "workflow:completed"; workflowId: string; status: string }
  | { type: "consensus:started"; request: ConsensusRequest }
  | { type: "consensus:completed"; result: ConsensusResult };
