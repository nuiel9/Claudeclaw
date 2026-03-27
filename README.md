# Claudeclaw

Personal AI assistant with multi-agent orchestration, soul system, and multi-platform channels.

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) — takes the best ideas from OpenClaw's soul/workspace system and Claude's agent architecture, then adds features neither has: DAG workflows, agent consensus, hybrid routing, and configurable spawn depth.

## Architecture

```
                        ┌─────────────────────────┐
                        │     Claudeclaw Gateway   │
                        │                          │
  Telegram ────────────►│  ┌───────────────────┐   │
                        │  │   Hybrid Router    │   │
  Discord  ────────────►│  │ (rule + LLM)       │   │
                        │  └────────┬──────────┘   │
                        │           │              │
                        │  ┌────────▼──────────┐   │
                        │  │  Agent Registry    │   │
                        │  │  ┌──────┐ ┌──────┐│   │
                        │  │  │main  │ │dev   ││   │
                        │  │  │agent │ │agent ││   │
                        │  │  └──┬───┘ └──────┘│   │
                        │  └─────┼─────────────┘   │
                        │        │                 │
                        │  ┌─────▼─────────────┐   │
                        │  │  Communication Hub │   │
                        │  │  send│yield│pubsub │   │
                        │  └───────────────────┘   │
                        │                          │
                        │  ┌──────┐ ┌───────────┐  │
                        │  │ DAG  │ │ Consensus │  │
                        │  │Engine│ │  Engine   │  │
                        │  └──────┘ └───────────┘  │
                        │                          │
                        │  ┌───────────────────┐   │
                        │  │   Observability    │   │
                        │  │   Trace Dashboard  │   │
                        │  └───────────────────┘   │
                        └─────────────────────────┘
```

## Features

### Soul System
User-editable `SOUL.md` defines the agent's personality, tone, boundaries, and values. Injected into every LLM call. Supports dynamic trait merging at runtime.

```markdown
## Core Truths
- Be genuinely helpful, not performatively helpful
- Have opinions — disagree when you see a better way

## Vibe
Be the assistant you'd actually want to talk to.
```

### Multi-Agent Orchestration
- **Agent Registry** — register, spawn, and manage multiple agents with isolated workspaces
- **Configurable spawn depth** — default 2 levels deep (OpenClaw and Claude are limited to 1)
- **Concurrent children limits** — prevent resource exhaustion
- **Timeout enforcement** — auto-terminate hung subagents

### Hybrid Router
Routes messages using a two-tier strategy:
1. **Rule-based** — deterministic matching by peer, channel, guild, pattern (priority-ordered)
2. **LLM fallback** — when no rule matches, the LLM picks the best agent by description

### Agent Communication
| Method | Description |
|---|---|
| `send()` | Direct message between agents |
| `yield()` | Request-response with timeout |
| `broadcast()` | Send to all registered agents |
| `publish()` | Pub/sub topic-based messaging |
| Shared Blackboard | Key-value store accessible to all agents |

### DAG Workflow Engine
Define multi-step agent pipelines with dependency graphs:

```typescript
const workflow = WorkflowEngine.builder("research", "Research Pipeline")
  .addStep("gather", { agentId: "researcher", parallel: true })
  .addStep("analyze", { agentId: "analyst", dependsOn: ["gather"] })
  .addStep("write", { agentId: "writer", dependsOn: ["analyze"] })
  .onFailure("gather", { retry: 3, fallback: "skip" })
  .build();
```

Supports parallel execution, retry with exponential backoff, fallback strategies, timeouts, and cycle detection.

### Consensus Engine
Multiple agents collaborate to reach decisions:

| Mode | Description |
|---|---|
| `majority-vote` | Parallel vote, highest count wins |
| `debate` | Multi-round with visibility of previous votes |
| `ranked-choice` | Confidence-weighted scoring |
| `unanimous` | Iterates until all agree (falls back to majority) |

### Channel Plugins

**Telegram** (via grammY)
- Polling and webhook modes
- Text chunking (4000 char limit), media, threads, forums
- Env var token resolution (`$TELEGRAM_TOKEN`)

**Discord** (via Gateway WebSocket + REST)
- Full gateway lifecycle with auto-reconnect
- Exponential backoff with jitter, max 10 retries
- Text chunking (2000 char limit), threads, media, components
- Snowflake ID validation on all API paths

### Observability
Built-in tracer with ASCII dashboard:

```
┌─ Agent Trace Dashboard ──────────────────────────┐
│ Trace: a1b2c3d4...                               │
│ Status: completed                                │
│ Duration: 1234ms                                 │
│ Agents: 3                                        │
│ Tool calls: 12                                   │
│ Tokens: 45000                                    │
│──────────────────────────────────────────────────│
│ ✓ gateway: message:telegram (50ms)               │
│   ✓ router: route (5ms)                          │
│   ✓ main: process (1100ms)                       │
│     ✓ researcher: search (800ms)                 │
│   ✓ gateway: send (79ms)                         │
└──────────────────────────────────────────────────┘
```

### Bootstrap / Workspace System
Each agent has a workspace with markdown configuration files:

| File | Purpose |
|---|---|
| `SOUL.md` | Personality, tone, boundaries, vibe |
| `AGENTS.md` | Operating instructions, safety defaults |
| `IDENTITY.md` | Agent name and metadata |
| `USER.md` | User preferences (learned over time) |
| `TOOLS.md` | Tool usage guidelines |
| `MEMORY.md` | Persistent facts across sessions |

Files are cached by inode/size/mtime, size-limited (20K per file, 150K total), and subagents receive a restricted subset (no MEMORY.md, HEARTBEAT.md, BOOTSTRAP.md).

## Security

Claudeclaw implements **59/80** security controls, on par with OpenClaw's security posture.

### Core Protections
- **Prototype pollution protection** — blocks `__proto__`, `constructor`, `prototype` in config merge
- **Log secret redaction** — auto-redacts 10 sensitive key patterns (token, secret, password, api_key, etc.)
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
- **Token env var resolution** — store `$DISCORD_TOKEN` in config instead of raw secrets
- **Raw token warnings** — warns on save if tokens aren't using env var references
- **Duplicate token detection** — detects same token used across multiple channels
- **Secret scanning patterns** — `.secret-scan.json` with patterns for Discord, Telegram, AWS, API keys, private keys

### Network & Protocol Security
- **Webhook HMAC verification** — timing-safe HMAC-SHA256 comparison
- **Telegram secret verification** — timing-safe string comparison
- **Discord channel ID validation** — numeric snowflake format enforcement
- **Gateway URL validation** — WSS protocol verification
- **Reconnect safety** — exponential backoff + jitter + max 10 attempts

### Agent Orchestration Security
- **Spawn depth limits** — configurable max depth (default 2) with concurrent children cap
- **Exec approval workflows** — human-in-the-loop for dangerous commands (rm -rf, DROP TABLE, sudo, force push, etc.)

### Roadmap
- Sandbox/container isolation per agent
- Pre-commit hook integration for secret scanning
- Audit log persistence

## Quick Start

```bash
# Install
npm install

# Set up workspace and config
npx claudeclaw setup

# Configure channels (edit ~/.claudeclaw/claudeclaw.json)
# Set tokens via environment variables:
export TELEGRAM_TOKEN="your-bot-token"
export DISCORD_TOKEN="your-bot-token"

# Start the gateway
npx claudeclaw start

# Other commands
npx claudeclaw agents list
npx claudeclaw agents add researcher --name "Researcher" --desc "Web research specialist"
npx claudeclaw channels list
npx claudeclaw status
```

## Configuration

Config lives at `~/.claudeclaw/claudeclaw.json`:

```json
{
  "agents": {
    "main": {
      "id": "main",
      "name": "Claudeclaw",
      "description": "Your personal AI assistant",
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
      "token": "$TELEGRAM_TOKEN"
    },
    "discord": {
      "enabled": true,
      "token": "$DISCORD_TOKEN"
    }
  }
}
```

## Project Structure

```
src/
├── core/               # Types, events, logger (with secret redaction)
├── agents/
│   ├── workspace/      # SOUL.md loader, bootstrap file system
│   ├── registry/       # Multi-agent registry + spawn lifecycle
│   ├── communication/  # Send/yield/broadcast/pub-sub + blackboard
│   └── system-prompt.ts
├── router/             # Hybrid router (rule-based + LLM fallback)
├── channels/
│   ├── telegram/       # grammY plugin (polling + webhook)
│   ├── discord/        # Gateway WebSocket + REST
│   └── plugins/        # Channel manager
├── flows/              # DAG workflow engine
├── consensus/          # Vote/debate/ranked-choice/unanimous
├── sessions/           # Memory + file-backed session store
├── observability/      # Tracer with dashboard
├── config/             # Config loader with prototype pollution protection
├── cli/                # CLI entry point
├── gateway.ts          # Main orchestrator
└── index.ts            # Public API exports
templates/
├── SOUL.md             # Default personality
├── SOUL.dev.md         # C-3PO debug companion persona
├── AGENTS.md           # Operating instructions
├── IDENTITY.md         # Agent identity
├── USER.md             # User profile template
└── TOOLS.md            # Tool usage guidelines
```

## Comparison with OpenClaw

| Feature | OpenClaw | Claude Agent SDK | Claudeclaw |
|---|---|---|---|
| Soul/Personality | SOUL.md | System prompt | SOUL.md + dynamic traits |
| Routing | Deterministic bindings | LLM-based | Hybrid (rule + LLM) |
| Spawn depth | 1 level | 1 level | Configurable (default 2) |
| Agent communication | send/yield | prompt-in, result-out | send/yield/broadcast/pub-sub + blackboard |
| Workflow engine | None | None | DAG with retry/fallback/parallel |
| Consensus | None | None | 4 modes (vote/debate/ranked/unanimous) |
| Channels | 9 platforms | CLI/IDE | Telegram + Discord (extensible) |
| Observability | Basic | Hooks | Trace dashboard |

## License

MIT
