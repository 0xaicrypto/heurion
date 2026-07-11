# Nexus — Architecture

## Relationship to SDK

```
┌────────────────────────────────────────────────┐
│  Nexus (Intelligence Layer)               │
│  DigitalTwin, LLM, Evolution, Projection       │
├────────────────────────────────────────────────┤
│  BNBChain Agent SDK (Infrastructure Layer)     │
│  EventLog, Contracts, Tools, MCP, Skills       │
└────────────────────────────────────────────────┘
```

Nexus depends on SDK. SDK does not know Nexus exists. Shared utilities (`robust_json_parse`, `load_dotenv`, `CuratedMemory`, `EventLog`, `ContractEngine`) live in SDK. Nexus adds LLM-dependent features.

## DigitalTwin Lifecycle

```
DigitalTwin.create()
    ├── Build Rune provider (SDK)
    ├── Initialize LLMClient (Gemini/GPT/Claude)
    ├── Create EventLog (SQLite, append-only)
    ├── Load ContractSpec (system.yaml + user_rules.json)
    ├── Create EvolutionEngine
    ├── Register tools (WebSearch, URLReader, custom)
    ├── Load installed skills
    ├── Load ERC-8004/8183 identity (if chain mode)
    └── Resume previous session (if exists)
```

## Chat Flow (DPM + ABC)

```
twin.chat(user_message)
    │
    ├── 1. Contract pre-check (hard governance)
    │     └── Blocked? → return error
    │
    ├── 2. EventLog.append("user_message", msg) [instant]
    │
    ├── 3. Projection π(E, T, B)
    │     └── 1 LLM call → FACTS + CONTEXT + USER_PROFILE
    │
    ├── 4. Build system prompt:
    │     persona + date + identity + projected memory + skill index + capabilities
    │
    ├── 5. LLM chat (with function calling if tools registered)
    │
    ├── 6. Contract post-check (invariants)
    │     ├── Hard violation → append warning
    │     └── Soft violation → track, recover in k steps
    │
    ├── 7. Update drift score D(t)
    │
    ├── 8. EventLog.append("assistant_response", response)
    │
    └── 9. Background: session save + evolution (lighter than before)
```

## Evolution Engine

Runs after each turn as background task. With DPM, much lighter — no per-turn LLM memory extraction needed.

| Evolver | What it does | LLM calls |
|---------|-------------|-----------|
| MemoryEvolver | Extract insights → CuratedMemory | 1 per turn |
| SkillEvolver | Detect skills from conversation | 1 per turn |
| PersonaEvolver | Adapt communication style | Periodic |
| KnowledgeCompiler | Distill into articles | Periodic |

## LLM Client

Unified interface across providers:

| Provider | Default Model | Function Calling |
|----------|--------------|-----------------|
| Gemini | gemini-2.5-flash | google-genai native |
| OpenAI | gpt-4o | openai tools API |
| Anthropic | claude-sonnet-4-20250514 | anthropic tools API |
| Kimi (Moonshot AI) | kimi-k2.7-code | openai tools API (OpenAI-compatible, base_url https://api.moonshot.ai/v1, key: KIMI_API_KEY or MOONSHOT_API_KEY) |

JSON mode deliberately NOT used for Gemini (truncates at ~277 chars). `robust_json_parse()` from SDK handles formatting.

## Web Demo

```
Browser (web_ui.html)
    ├── Passkey login (WebAuthn)
    ├── Chat: POST /api/chat → twin.chat()
    ├── File upload: POST /api/upload → EventLog
    ├── Skill install: POST /api/skills/install → LobeHub/GitHub
    ├── MCP search: POST /api/skills/search → LobeHub MCP
    ├── Session restore: sessionStorage auto-resume
    └── Rendering: marked.js + mermaid.js + KaTeX

FastAPI (web_demo.py)
    ├── Passkey auth (py_webauthn)
    ├── Twin lifecycle (create/resume/close)
    ├── File storage (uploads/ + outputs/)
    └── Skill catalog + LobeHub integration
```
