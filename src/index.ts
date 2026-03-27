// ============================================================
// Claudeclaw - Personal AI Assistant
// Multi-agent orchestration | Soul system | Multi-platform
// ============================================================

// Core
export * from "./core/types.js";
export { ClaudeclawEventBus, globalEventBus } from "./core/events.js";
export { createLogger } from "./core/logger.js";

// Config
export { loadConfig, saveConfig, getConfigDir } from "./config/config-loader.js";

// Agent Workspace & Soul
export {
  loadSoul,
  writeSoul,
  buildSoulPromptInjection,
  hasSoulFile,
  mergeDynamicTraits,
} from "./agents/workspace/soul.js";
export {
  loadBootstrapFiles,
  loadBootstrapFile,
  resolveWorkspacePath,
  ensureWorkspace,
} from "./agents/workspace/loader.js";

// System Prompt
export {
  buildAgentSystemPrompt,
  resolvePromptMode,
} from "./agents/system-prompt.js";

// Agent Registry
export { AgentRegistry } from "./agents/registry/agent-registry.js";

// Agent Communication
export { AgentCommHub } from "./agents/communication/agent-comm.js";

// Sessions
export {
  MemorySessionStore,
  FileSessionStore,
  createSession,
  buildSessionKey,
  addMessageToSession,
} from "./sessions/session-store.js";

// Router
export { HybridRouter, buildLLMRouterPrompt } from "./router/hybrid-router.js";

// Workflow Engine
export { WorkflowEngine, WorkflowBuilder } from "./flows/workflow-engine.js";

// Consensus Engine
export { ConsensusEngine } from "./consensus/consensus-engine.js";

// Channel Plugins
export { TelegramChannel } from "./channels/telegram/telegram-channel.js";
export { DiscordChannel } from "./channels/discord/discord-channel.js";
export { ChannelManager } from "./channels/plugins/channel-manager.js";

// Security
export {
  isAllowed,
  isToolAllowed,
  resolveToolPolicy,
  verifyWebhookSignature,
  verifyTelegramSecret,
  SessionWriteLock,
  ExecApprovalManager,
  FilesystemSandbox,
} from "./security/index.js";

// Observability
export { Tracer } from "./observability/tracer.js";

// Gateway
export { ClaudeclawGateway } from "./gateway.js";
