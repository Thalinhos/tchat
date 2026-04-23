# tchat

Interactive CLI chat with AI models via OpenRouter API. Execute file operations, run commands, and manage background processes.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

Or with arguments:

```bash
bun run index.ts --api_key <key> --model <model-name>
```

## Features

- **Multi-model support**: Switch between OpenRouter models in real-time
- **File operations**: Read, write, search files with AI assistance
- **Command execution**: Run shell commands (validated for safety)
- **Process management**: Start/stop/monitor background processes
- **Fallback models**: Automatic retry with fallback model on API failure
- **Caveman mode**: Token-efficient response mode (lite/full/ultra)
- **Auto-attach files**: Automatically include mentioned files in context
- **Settings persistence**: Save API key, model, and preferences per user
- **Plan approval**: Review and approve AI plans before execution

## Build

```bash
bun build ./index.ts --compile --outfile tchat.exe
```

## Link globally

```bash
bun link
```

Now you can call it everywhere by typing `tchat`

## Documentation

### Commands

- `/ls [dir]` - List directory
- `/cd <dir>` - Change directory  
- `/model [name]` - Show/switch model (saves to user settings)
- `/model add <name>` - Add model to allowed list
- `/model rm <name>` - Remove model from allowed list
- `/fallback [name]` - Show/switch fallback model (used if primary fails)
- `/caveman [lite|full|ultra|off]` - Activate caveman mode (terse, fewer tokens)
- `/accept [on|off]` - Auto-accept all modifications (default: ask)
- `/reject [on|off]` - Auto-reject all modifications (default: ask)
- `/url [preset|url]` - Show/switch API URL (openrouter, openai, anthropic, groq, deepseek, nvidia)
- `/api_key [key]` - Set API key for this session
- `/clear` - Clear chat history
- `/run <cmd>` - Execute shell command (validated)
- `/start [--fg] <name> <cmd>` - Start managed process (--fg for foreground)
- `/stop [name]` - Stop process (with confirmation)
- `/kill [name]` - Kill process (no confirmation)
- `/ps` - List managed processes
- `/logs [name] [lines]` - Show process logs (default: active, 80 lines)
- `/h, /help` - Show help
- `sair` - Exit

### Planning Flow

When the AI proposes a plan (wrapped in `<plan>...</plan>`):

1. Plan is displayed to user
2. User confirms: `y/yes/Enter` to approve, anything else to reject
3. If approved, AI continues with execution (tool calls, edits, commands)
4. If rejected, user can describe changes and start over

**Example:**
```
IA: <plan>
I will:
1. Read current config
2. Update settings
3. Restart service
</plan>

Você: (prompt asks for approval)
y
(AI executes the plan)
```

### Fallback Model Behavior

When the primary model fails:

- **401 (Auth)**: No retry, shows "API key inválida ou expirada"
- **429 (Rate limit)**: No retry, shows "Rate limit atingido"
- **500+ (Server error)**: Auto-retry with fallback model
- **Connection error**: Auto-retry with fallback model

**Set fallback:**
```
/fallback <model-name>
```

**View current:**
```
/fallback
```

### File Attachment

Auto-attach files mentioned in messages:
```
Você: Can you review index.ts and fix the bug?
(index.ts automatically included in context)
```

Force attach with `@`:
```
Você: Look at @src/config.ts and compare with @src/default.ts
```

**Note:** Files are cached in context for reuse across messages.

### Caveman Mode

Reduce token usage by ~75% with compressed responses:

- `lite`: Terse, no fluff, grammatically correct
- `full`: Classic caveman (fragments OK, short synonyms)
- `ultra`: Maximum compression (abbreviations, arrows →, minimal words)

**Example (full):**
```
/caveman full
```

### Tool Call Execution

AI can execute tools in specific order to prevent race conditions:

1. **Read** files first
2. **List** directories
3. **Search** for patterns
4. **Write** files (with user confirmation)
5. **Run** commands (with user confirmation)

All file writes require user approval. You can:
- Approve individual writes: `y`
- Accept all for session: `a`
- Reject all for session: `r`

Or use commands:
```
/accept on   # Auto-approve all writes
/reject on   # Auto-reject all writes
/accept off  # Return to asking
```

### API Keys

Store API key in environment variables:
- `API_KEY`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `THCHAT_API_KEY`

Or pass at startup:
```bash
bun run index.ts --api_key sk-xxx
```

### Model Selection

Set model via environment or CLI:
- `MODEL` env var
- `OPENROUTER_MODEL` env var
- `--model` CLI argument
- `/model` command in chat

Default: `z-ai/glm-4.5-air:free`

### Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed component documentation.