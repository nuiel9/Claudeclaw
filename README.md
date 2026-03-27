# Claudeclaw

> Multi-agent AI orchestration platform with a soul system, hybrid routing, and multi-platform channel support.

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) — takes the best of OpenClaw's soul/workspace system and Claude's agent architecture, then adds features neither has: DAG workflows, agent consensus, hybrid routing, and configurable spawn depth.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Table of Contents

- [Architecture](#architecture)
- [Features](#features)
  - [Soul System](#soul-system)
  - [Multi-Agent Orchestration](#multi-agent-orchestration)
  - [Hybrid Router](#hybrid-router)
  - [Agent Communication](#agent-communication)
  - [DAG Workflow Engine](#dag-workflow-engine)
  - [Consensus Engine](#consensus-engine)
  - [Claude API Integration](#claude-api-integration)
  - [Channel Plugins](#channel-plugins)
  - [Bootstrap / Workspace System](#bootstrap--workspace-system)
  - [Observability](#observability)
- [Security](#security)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Project Structure](#project-structure)
- [Comparison with OpenClaw](#comparison-with-openclaw)
- [API Reference](#api-reference)
- [Contributing](#contributing)
- [License](#license)

---

## Architecture

```
                       ┌──────────────────────────────┐
                       │      Claudeclaw Gateway      │
                       │                              │
 Telegram ────────────►│  ┌────────────────────────┐  │
                       │  │     Hybrid Router      │  │
 Discord  ────────────►│  │  (rule-based + LLM)    │  │
                       │  └───────────┬────────────┘  │
                       │              │               │
                       │  ┌───────────▼────────────┐  │
                       │  │    Agent Registry       │  │
                       │  │  ┌───────┐  ┌────────┐ │  │
                       │  │  │ main  │  │  dev   │ │  │
                       │  │  │ agent │  │ agent  │ │  │
                       │  │  └───┬───┘  └────────┘ │  │
                       │  └──────┼─────────────────┘  │
                       │         │                    │
                       │  ┌──────▼─────────────────┐  │
                       │  │  Communication Hub     │  │
                       │  │  send│yield│broadcast  │  │
                       │  │  pub/sub │ blackboard  │  │
                       │  └────────────────────────┘  │
                       │                              │
                       │  ┌──────────┐ ┌───────────┐  │
                       │  │   DAG    │ │ Consensus │  │
                       │  │ Workflow │ │  Engine   │  │
                       │  │  Engine  │ │ (4 modes) │  │
                       │  └──────────┘ └───────────┘  │
                       │                              │
                       │  ┌────────────────────────┐  │
                       │  │  Security Layer        │  │
                       │  │  ACL│rate-limit│sandbox│  │
                       │  └────────────────────────┘  │
                       │                              │
                       │  ┌────────────────────────┐  │
                       │  │    Observability        │  │
                       │  │  traces│spans│dashboard │  │
                       │  └────────────────────────┘  │
                       └──────────────────────────────┘
```

### Message Flow

```
Inbound Message
  │
  ├─► Rate Limiter (per-sender / per-channel / global)
  │
  ├─► Hybrid Router ──► Rule Match? ──► Agent
  │                  └─► LLM Fallback ──► Agent
  │
  ├─► Session Store (write-locked)
  │
  ├─► Agent Processing (with tool policy enforcement)
  │
  ├─► Tracer (span recording)
  │
  └─► Channel Send (chunked, reply-threaded)
```

---

## Features

### Soul System

User-editable `SOUL.md` defines the agent's personality, tone, boundaries, and values. Injected into every LLM call. Supports dynamic trait merging at runtime.

```markdown
# My Agent Soul

## Core Truths
- Be genuinely helpful, not performatively helpful
- Have opinions — disagree when you see a better way

## Vibe
Be the assistant you'd actually want to talk to.

## Traits
creativity: high
formality: low
humor: dry
```

Key features:
- **ReDoS-safe parsing** — bounded input (50K chars), escaped headings, line length limits
- **Dynamic trait merging** — update traits at runtime without reloading the full soul
- **Full/minimal/none modes** — control how much soul is injected per agent
- **Dev persona support** — swap `SOUL.dev.md` for debug/testing personalities

### Multi-Agent Orchestration

- **Agent Registry** — register, spawn, and manage multiple agents with isolated workspaces
- **Configurable spawn depth** — default 2 levels deep (OpenClaw and Claude are limited to 1)
- **Concurrent children limits** — prevent resource exhaustion (configurable per agent)
- **Timeout enforcement** — auto-terminate hung subagents with configurable timeout
- **Tool policy enforcement** — per-agent allow/deny tool lists checked at runtime
- **Run lifecycle tracking** — spawned, running, completed, failed, timeout states with event emission

```typescript
// Spawn a subagent
const run = await registry.spawn({
  agentId: "researcher",
  task: "Find recent papers on multi-agent systems",
  maxDepth: 3,
  timeout: 60_000,
});

// Wait for completion
const result = await registry.waitForRun(run.runId);
```

### Hybrid Router

Routes messages using a two-tier strategy:

1. **Rule-based** — deterministic matching by peer, channel, guild, pattern (priority-ordered)
2. **LLM fallback** — when no rule matches, the LLM picks the best agent by description

```typescript
// Router config
{
  mode: "hybrid",
  defaultAgentId: "main",
  rules: [
    { priority: 1, match: { channel: "telegram", pattern: "^/research" }, agentId: "researcher" },
    { priority: 2, match: { channel: "discord", guildId: "123" }, agentId: "community-bot" },
    { priority: 10, match: { peerId: "admin-user-id" }, agentId: "admin" },
  ]
}
```

### Agent Communication

| Method | Description |
|---|---|
| `send(from, to, content)` | Direct message between agents |
| `yield(from, to, content, timeout)` | Request-response with timeout |
| `broadcast(from, content)` | Send to all registered agents |
| `publish(topic, data)` / `subscribe(topic, handler)` | Pub/sub topic-based messaging |
| `blackboard.set(key, value)` / `blackboard.get(key)` | Shared key-value store |

All communication is auth-gated via `CommAuthPolicy`:
- Only registered agents can send messages
- Optional per-agent allowlists restrict who can communicate with whom

### DAG Workflow Engine

Define multi-step agent pipelines with dependency graphs:

```typescript
const workflow = WorkflowEngine.builder("research-pipeline", "Research & Report")
  .addStep("gather", { agentId: "researcher", parallel: true })
  .addStep("fact-check", { agentId: "verifier", parallel: true })
  .addStep("analyze", { agentId: "analyst", dependsOn: ["gather", "fact-check"] })
  .addStep("write", { agentId: "writer", dependsOn: ["analyze"] })
  .onFailure("gather", { retry: 3, fallback: "skip" })
  .build();

await workflowEngine.execute(workflow);
```

Features:
- **Parallel execution** — independent steps run concurrently
- **Retry with exponential backoff** — configurable per step
- **Fallback strategies** — skip, use default, or abort on failure
- **Cycle detection** — validates DAG integrity before execution
- **Timeout enforcement** — per-step and per-workflow limits

### Consensus Engine

Multiple agents collaborate to reach decisions:

| Mode | Description |
|---|---|
| `majority-vote` | Parallel vote, highest count wins |
| `debate` | Multi-round with visibility of previous votes |
| `ranked-choice` | Confidence-weighted scoring |
| `unanimous` | Iterates until all agree (falls back to majority after max rounds) |

```typescript
const result = await consensusEngine.resolve({
  topic: "Best approach for the migration",
  agents: ["architect", "backend-lead", "devops"],
  mode: "debate",
  maxRounds: 3,
});
```

### Claude API Integration

Claudeclaw integrates with the **Anthropic Claude API** via `@anthropic-ai/sdk` for LLM-powered agent responses.

**Authentication**: Uses API key authentication (OAuth is restricted to Anthropic first-party apps only as of Feb 2026).

```bash
# Set your API key via environment variable
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

**Features:**
- **Per-agent model selection** — each agent can use a different model (opus, sonnet, haiku)
- **Session history** — full conversation context sent with each request
- **System prompt injection** — SOUL.md + bootstrap files injected as system prompt
- **Streaming support** — real-time token streaming for responsive UX
- **Graceful fallback** — runs in echo mode if no API key is configured
- **Error handling** — structured error responses with automatic fallback
- **Base URL override** — support for proxies or compatible APIs
- **Configurable limits** — max tokens, temperature, timeout per request

**Model mapping:**

| Short Name | Anthropic Model ID |
|---|---|
| `opus` | `claude-opus-4-6` |
| `sonnet` | `claude-sonnet-4-6` |
| `haiku` | `claude-haiku-4-5-20251001` |

```typescript
// Use in code
const client = new ClaudeClient(config.anthropic, logger);

const response = await client.sendMessage(session, "Hello!", {
  model: "sonnet",
  systemPrompt: "You are a helpful assistant.",
  maxTokens: 4096,
});

// Streaming
await client.streamMessage(session, "Tell me a story", {}, (chunk) => {
  process.stdout.write(chunk);
});
```

### Channel Plugins

#### Telegram (via grammY)

- **Polling and webhook modes** — auto-configured via config
- **Webhook HMAC verification** — timing-safe signature validation
- **Text chunking** — auto-splits at 4096 char limit with smart line/word breaking
- **Media support** — images, documents, audio, video
- **Thread/forum support** — topic-aware message routing
- **Access control** — `allowFrom` lists, DM/group policy (`open`, `allowlist`, `disabled`)
- **Env var token resolution** — `$TELEGRAM_TOKEN` in config

#### Discord (via Gateway WebSocket + REST)

- **Full gateway lifecycle** — connect, identify, heartbeat, dispatch, resume
- **Auto-reconnect** — exponential backoff with jitter, max 10 retries, 15s connection timeout
- **Text chunking** — auto-splits at 2000 char limit
- **Thread and component support** — slash commands, buttons, threads
- **Guild/role ACL** — per-guild channel and role restrictions
- **Snowflake ID validation** — numeric format enforcement on all API paths
- **WSS protocol validation** — rejects non-secure gateway URLs
- **Env var token resolution** — `$DISCORD_TOKEN` in config

#### Adding Custom Channels

Implement the `ChannelPlugin` interface:

```typescript
interface ChannelPlugin<C = unknown> {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<SendResult>;
  onMessage(handler: InboundMessageHandler): void;
}
```

### Bootstrap / Workspace System

Each agent has a workspace with markdown configuration files:

| File | Purpose | Subagent Access |
|---|---|---|
| `SOUL.md` | Personality, tone, boundaries, vibe | Yes |
| `AGENTS.md` | Operating instructions, safety defaults | Yes |
| `IDENTITY.md` | Agent name and metadata | Yes |
| `USER.md` | User preferences (learned over time) | Yes |
| `TOOLS.md` | Tool usage guidelines | Yes |
| `MEMORY.md` | Persistent facts across sessions | No |

- **Smart caching** — files cached by inode/size/mtime, only re-read on change
- **Size limits** — 20K per file, 150K total workspace
- **Subagent filtering** — restricted subset (no MEMORY.md, HEARTBEAT.md, BOOTSTRAP.md)

### Observability

Built-in tracer with hierarchical span tree and ASCII dashboard:

```
┌─ Agent Trace Dashboard ──────────────────────────┐
│ Trace: a1b2c3d4...                               │
│ Status: completed                                │
│ Duration: 1234ms                                 │
│ Agents: 3                                        │
│ Tool calls: 12                                   │
│ Tokens: 45000                                    │
│──────────────────────────────────────────────────│
│ o gateway: message:telegram (50ms)               │
│   o router: route (5ms)                          │
│   o main: process (1100ms)                       │
│     o researcher: search (800ms)                 │
│   o gateway: send (79ms)                         │
└──────────────────────────────────────────────────┘
```

- **Trace levels** — `minimal`, `standard`, `verbose`
- **Output modes** — `console`, `file`, `both`
- **Span hierarchy** — nested spans with parent-child relationships
- **Event recording** — attach metadata to any point in a trace

---

## Security

Claudeclaw implements **59/80** security controls, on par with OpenClaw's security posture.

### Core Protections
- **Prototype pollution protection** — blocks `__proto__`, `constructor`, `prototype` in config merge
- **Log secret redaction** — auto-redacts 10 sensitive key patterns (token, secret, password, api_key, authorization, credential, private_key, etc.)
- **ReDoS protection** — regex input bounding (1K for router, 50K for soul parser) + heading escaping
- **Safe JSON.parse** — try-catch with graceful fallback on all parse sites
- **Config file corruption recovery** — falls back to defaults on parse error

### Access Control
- **Channel allowlist enforcement** — DM/group policy with per-channel `allowFrom` lists
- **Discord guild/role ACL** — per-guild channel and role restrictions
- **Agent-to-agent auth** — `CommAuthPolicy` with registered agent verification and per-agent allowlists
- **Tool policy enforcement** — per-agent allow/deny tool lists with runtime checking via `AgentRegistry`

### Rate Limiting
- **Multi-tier rate limiter** — per-sender (30/min), per-channel (200/min), and global (500/min) sliding windows
- **Configurable limits** — runtime-updatable via `RateLimiter.updateConfig()`
- **Periodic cleanup** — stale window entries auto-pruned

### Session & Data Security
- **Session file permissions** — `chmod 0o600` (owner-only read/write)
- **Config file permissions** — `chmod 0o600` on saved config
- **Path traversal prevention** — session key sanitization + basePath validation
- **Session write locks** — exclusive access via `SessionWriteLock.withLock()` to prevent race conditions
- **Filesystem sandbox** — path allowlist enforcement for agent file access

### Token & Secret Management
- **Token env var resolution** — store `$DISCORD_TOKEN` / `$TELEGRAM_TOKEN` in config instead of raw secrets
- **Raw token warnings** — warns on config save if tokens aren't using env var references
- **Duplicate token detection** — detects same token used across multiple channels on startup
- **Secret scanning patterns** — `.secret-scan.json` with 9 patterns for Discord, Telegram, AWS, Anthropic, OpenAI, private keys, and more

### Network & Protocol Security
- **Webhook HMAC verification** — timing-safe HMAC-SHA256 comparison
- **Telegram secret verification** — timing-safe string comparison
- **Discord channel ID validation** — numeric snowflake format enforcement
- **Gateway URL validation** — WSS protocol verification
- **Reconnect safety** — exponential backoff + jitter + max 10 attempts

### Agent Orchestration Security
- **Spawn depth limits** — configurable max depth (default 2) with concurrent children cap
- **Exec approval workflows** — human-in-the-loop for dangerous commands (rm -rf, DROP TABLE, sudo, force push, etc.)

### Security Roadmap
- Sandbox/container isolation per agent
- Pre-commit hook integration for secret scanning
- Audit log persistence
- mTLS for inter-service communication

---

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- npm or pnpm

### Installation

```bash
# Clone the repository
git clone https://github.com/nuiel9/claudeclaw.git
cd claudeclaw

# Install dependencies
npm install

# Build
npm run build
```

### Setup

```bash
# Initialize workspace and config
npx claudeclaw setup

# Configure API keys via environment variables
export ANTHROPIC_API_KEY="sk-ant-api03-..."
export TELEGRAM_TOKEN="your-telegram-bot-token"
export DISCORD_TOKEN="your-discord-bot-token"

# Edit config if needed
# Config location: ~/.claudeclaw/claudeclaw.json

# Start the gateway
npx claudeclaw start
```

### Development Mode

```bash
# Run with hot-reload
npm run dev
```

---

## Configuration

Config lives at `~/.claudeclaw/claudeclaw.json` (permissions: `0o600`):

```jsonc
{
  "agents": {
    "main": {
      "id": "main",
      "name": "Claudeclaw",
      "description": "Your personal AI assistant",
      "model": "sonnet",
      "capabilities": {
        "canSpawn": true,
        "canSend": true,
        "canYield": true,
        "canBroadcast": false,
        "maxConcurrentChildren": 5
      },
      "tools": ["read", "write", "search"]  // allow-list (or use "!dangerous-tool" to deny)
    },
    "researcher": {
      "id": "researcher",
      "name": "Researcher",
      "description": "Web research specialist",
      "model": "sonnet"
    }
  },
  "defaultAgent": "main",
  "router": {
    "mode": "hybrid",
    "defaultAgentId": "main",
    "rules": [
      {
        "priority": 1,
        "match": { "channel": "telegram", "pattern": "^/research" },
        "agentId": "researcher"
      }
    ]
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "$TELEGRAM_TOKEN",
      "mode": "polling",
      "allowFrom": ["123456789"],
      "groupPolicy": "allowlist"
    },
    "discord": {
      "enabled": true,
      "token": "$DISCORD_TOKEN",
      "groupPolicy": "open",
      "guilds": {
        "guild-id-here": {
          "channels": ["channel-id-1", "channel-id-2"],
          "roles": ["role-id-1"]
        }
      }
    }
  },
  "anthropic": {
    "apiKey": "$ANTHROPIC_API_KEY",
    "defaultModel": "sonnet",
    "maxTokens": 4096,
    "temperature": 0.7,
    "streaming": false,
    "timeoutMs": 120000
  },
  "workspace": {
    "path": "~/.claudeclaw/workspace",
    "maxFileChars": 20000,
    "maxTotalChars": 150000
  },
  "observability": {
    "enabled": true,
    "traceLevel": "standard",
    "output": "console"
  }
}
```

---

## CLI Reference

```bash
# Setup workspace and config
npx claudeclaw setup

# Start the gateway
npx claudeclaw start

# Agent management
npx claudeclaw agents list
npx claudeclaw agents add <id> --name <name> --desc <description>

# Channel management
npx claudeclaw channels list

# System status
npx claudeclaw status
```

---

## Project Structure

```
claudeclaw/
├── src/
│   ├── core/
│   │   ├── types.ts             # All type definitions (~400 lines)
│   │   ├── events.ts            # Typed event bus (eventemitter3)
│   │   └── logger.ts            # Logger with secret redaction
│   ├── agents/
│   │   ├── workspace/
│   │   │   ├── soul.ts          # SOUL.md loader/parser (ReDoS-safe)
│   │   │   └── loader.ts        # Bootstrap file system with caching
│   │   ├── registry/
│   │   │   └── agent-registry.ts # Multi-agent registry + spawn + tool policy
│   │   ├── communication/
│   │   │   └── agent-comm.ts    # Send/yield/broadcast/pub-sub + blackboard
│   │   ├── claude-client.ts     # Claude API client (streaming + non-streaming)
│   │   └── system-prompt.ts     # System prompt builder (full/minimal/none)
│   ├── router/
│   │   └── hybrid-router.ts     # Rule-based + LLM fallback routing
│   ├── channels/
│   │   ├── telegram/
│   │   │   └── telegram-channel.ts  # grammY plugin (polling + webhook)
│   │   ├── discord/
│   │   │   └── discord-channel.ts   # Gateway WebSocket + REST API
│   │   └── plugins/
│   │       └── channel-manager.ts   # Channel lifecycle manager
│   ├── flows/
│   │   └── workflow-engine.ts   # DAG workflow with retry/fallback/parallel
│   ├── consensus/
│   │   └── consensus-engine.ts  # Vote/debate/ranked-choice/unanimous
│   ├── sessions/
│   │   └── session-store.ts     # Memory + file-backed store (chmod 0o600)
│   ├── security/
│   │   ├── index.ts             # ACL, tool policy, webhook HMAC, locks, sandbox
│   │   └── rate-limiter.ts      # Multi-tier sliding window rate limiter
│   ├── observability/
│   │   └── tracer.ts            # Span tree tracer with ASCII dashboard
│   ├── config/
│   │   └── config-loader.ts     # Config loader with pollution protection
│   ├── cli/
│   │   └── index.ts             # CLI entry point (commander)
│   ├── gateway.ts               # Main orchestrator
│   └── index.ts                 # Public API barrel exports
├── templates/
│   ├── SOUL.md                  # Default personality template
│   ├── SOUL.dev.md              # C-3PO debug companion persona
│   ├── AGENTS.md                # Operating instructions template
│   ├── IDENTITY.md              # Agent identity template
│   ├── USER.md                  # User profile template
│   └── TOOLS.md                 # Tool usage guidelines template
├── .secret-scan.json            # Secret scanning patterns (9 rules)
├── .gitignore                   # Comprehensive ignore with secret patterns
├── package.json
├── tsconfig.json
└── README.md
```

---

## Comparison with OpenClaw

| Feature | OpenClaw | Claude Agent SDK | Claudeclaw |
|---|---|---|---|
| Soul/Personality | SOUL.md | System prompt | SOUL.md + dynamic traits + dev personas |
| Routing | Deterministic bindings | LLM-based | Hybrid (rule + LLM fallback) |
| Spawn depth | 1 level | 1 level | Configurable (default 2) |
| Agent communication | send/yield | prompt-in, result-out | send/yield/broadcast/pub-sub + blackboard |
| Workflow engine | None | None | DAG with retry/fallback/parallel |
| Consensus | None | None | 4 modes (vote/debate/ranked/unanimous) |
| Channels | 9 platforms | CLI/IDE | Telegram + Discord (extensible plugin system) |
| LLM Integration | OpenAI/Anthropic | Claude only | Claude API (key auth) + streaming |
| Observability | Basic logging | Hooks | Trace dashboard with span tree |
| Rate limiting | Basic | None | Multi-tier (sender/channel/global) |
| Access control | Allowlists | None | ACL + guild/role + tool policy |
| Secret management | Env vars | N/A | Env vars + warnings + duplicate detection + scanning |
| Security score | 59/80 | ~30/80 | 59/80 |

---

## API Reference

### Gateway

```typescript
import { ClaudeclawGateway, loadConfig, createLogger } from "claudeclaw";

const config = await loadConfig();
const logger = createLogger("info");
const gateway = new ClaudeclawGateway(config, logger);

await gateway.start();
// gateway.getAgentRegistry()
// gateway.getCommHub()
// gateway.getWorkflowEngine()
// gateway.getConsensusEngine()
// gateway.getTracer()
await gateway.stop();
```

### Claude Client

```typescript
import { ClaudeClient } from "claudeclaw";

const client = new ClaudeClient({
  apiKey: "$ANTHROPIC_API_KEY",
  defaultModel: "sonnet",
  maxTokens: 4096,
}, logger);

// Non-streaming
const response = await client.sendMessage(session, "Hello!", {
  model: "opus",           // override per-request
  systemPrompt: "You are a helpful assistant.",
  temperature: 0.7,
});
console.log(response.content);       // "Hi there! How can I help?"
console.log(response.inputTokens);   // 42
console.log(response.outputTokens);  // 15

// Streaming
await client.streamMessage(session, "Explain quantum computing", {}, (chunk) => {
  process.stdout.write(chunk);  // real-time output
});

// Health check
const healthy = await client.healthCheck(); // true/false
```

### Agent Registry

```typescript
import { AgentRegistry } from "claudeclaw";

const registry = gateway.getAgentRegistry();

// Register agent
registry.registerAgent({
  id: "researcher",
  name: "Researcher",
  description: "Web research specialist",
  model: "sonnet",
  tools: ["web-search", "read"],
});

// Spawn subagent
const run = await registry.spawn({
  agentId: "researcher",
  task: "Find papers on RAG",
  maxDepth: 2,
  timeout: 60_000,
});

// Check tool permissions
registry.isToolAllowedForAgent("researcher", "web-search"); // true
registry.isToolAllowedForAgent("researcher", "exec");        // false
```

### Rate Limiter

```typescript
import { RateLimiter } from "claudeclaw";

const limiter = new RateLimiter({
  perSenderMax: 30,
  perChannelMax: 200,
  globalMax: 500,
  windowMs: 60_000,
});

const result = limiter.check(senderId, channelId);
if (result.limited) {
  console.log(`Rate limited (${result.tier}), retry after ${result.retryAfterMs}ms`);
}
```

### Security

```typescript
import {
  isAllowed,
  isToolAllowed,
  resolveToolPolicy,
  verifyWebhookSignature,
  SessionWriteLock,
  ExecApprovalManager,
  FilesystemSandbox,
} from "claudeclaw";

// Access control
isAllowed(userId, "dm", { allowFrom: ["123"], groupPolicy: "allowlist" });

// Tool policy
const policy = resolveToolPolicy(["read", "write", "!exec"]);
isToolAllowed("read", policy);  // true
isToolAllowed("exec", policy);  // false

// Webhook verification
verifyWebhookSignature(payload, signature, secret); // boolean

// Session locking
const lock = new SessionWriteLock();
await lock.withLock(sessionKey, async () => {
  // exclusive access
});

// Exec approval
const approver = new ExecApprovalManager(logger);
const result = await approver.check("rm -rf /");
// result.requiresApproval === true
```

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Run type checking (`npx tsc --noEmit`)
4. Run tests (`npm test`)
5. Commit your changes
6. Push to the branch
7. Open a Pull Request

### Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode with hot-reload
npm test             # Run tests
npx tsc --noEmit     # Type check only
```

---

## License

MIT
