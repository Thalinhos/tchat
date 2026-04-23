# tchat - Arquitetura e Documentação

**tchat** é um chat CLI interativo que comunica com modelos de IA via OpenRouter API. Permite editar, ler e gerenciar arquivos do projeto através de comandos do assistente.

---

## 📋 Visão Geral

```
┌─────────────────────────┐
│   Terminal (readline)   │  Entrada do usuário
└────────────┬────────────┘
             │
      ┌──────▼──────┐
      │  Main Loop  │  Processa comandos /ls, /cd, /model, etc
      └──────┬──────┘
             │
      ┌──────▼──────────────────┐
      │  Command Dispatcher     │
      │  ┌─────────────────┐    │
      │  │ Chat (API)      │    │
      │  │ File I/O        │    │
      │  │ Process Mgmt    │    │
      │  │ Shell Exec      │    │
      │  └─────────────────┘    │
      └──────────────────────────┘
```

---

## 🔧 Componentes Principais

### 1. **Error Handling** (Classes de Erro)

Erros estruturados para melhor debugging:

```typescript
class AppError extends Error
  ├─ code: string        // "INTERNAL_ERROR", "API_ERROR", etc
  ├─ statusCode: number  // HTTP-like status codes
  └─ name: string        // Nome da classe

class APIError extends AppError       // Erros da API OpenRouter
class ValidationError extends AppError // Erros de validação
class CommandExecutionError extends AppError // Erros ao executar comandos
```

**Benefícios:**
- Tratamento específico por tipo de erro
- Mensagens de dica contextual (ex: "Verifique sua API key")
- Logging estruturado

### 2. **Validação de Comandos Shell** (`validateShellCommand()`)

Bloqueia padrões perigosos:

```javascript
❌ BLOQUEADO: rm -rf /
❌ BLOQUEADO: del C:\*.*
❌ BLOQUEADO: format D:
❌ BLOQUEADO: npm install && rm -rf src
✅ PERMITIDO: npm install
✅ PERMITIDO: tsc --noEmit
```

**Padrões perigosos detectados:**
- Comandos de delete: `rm`, `rmdir`, `del`, `deltree`, `wipe`
- Comandos de formatação: `format`
- Comandos de shutdown: `shutdown`
- Encadeamentos perigosos: `&&`, `|` com delete

### 3. **Fallback Automático** (`chat()` + `chatWithModel()`)

Quando requisição para a API falha, tenta automaticamente com modelo de fallback:

```
Requisição 1 (Modelo Principal) → Falha
  ↓
⚠️  "Modelo principal falhou. Tentando fallback..."
  ↓
Requisição 2 (Modelo Fallback) → Sucesso ✓
```

**Configuração:**
- Padrão: `openai/gpt-oss-120b:free`
- Customizável com `/fallback <modelo>`
- Armazenado em `settings.fallbackModel`

**Quando ativa:**
- Qualquer erro de API (exceto 401, 429)
- Falha de conexão
- Erro 500+ do servidor

**Casos onde NÃO tenta fallback:**
- API key inválida (401)
- Rate limit (429)
- Fallback = Modelo principal (evita loop)

### 4. **File I/O Tools**

Ferramentas para o assistente IA manipular arquivos:

```xml
<read_file>caminho/arquivo</read_file>
<write_file path="caminho">conteúdo</write_file>
<list_dir>caminho</list_dir>
<search_files>padrão</search_files>
```

**Ordem de execução determinística (evita race conditions):**
1. Read files
2. List directories
3. Search files
4. Write files (com confirmação do usuário)
5. Run commands (com confirmação do usuário)

### 5. **Tool Call Parsing & Serialization** (`parseToolCalls()`)

Extrai tool calls da resposta IA e garante ordem segura:

```typescript
function parseToolCalls(text: string): { calls: ToolCall[]; cleaned: string }
  ├─ Remover <plan> tags
  ├─ Parse read_file (1º)
  ├─ Parse list_dir (2º)
  ├─ Parse search_files (3º)
  ├─ Parse write_file (4º)
  ├─ Parse run_command (5º)
  ├─ Parse run_command_bg (6º)
  └─ Auto-correct run_command → run_command_bg se necessário
```

### 6. **Auto-Attach Files Context** (`attachedFilesContext`)

Map que cacheializa conteúdo de arquivos mencionados:

```typescript
const attachedFilesContext = new Map<string, string>()

Fluxo:
1. User: "Can you review index.ts?"
2. autoAttachFiles() detecta "index.ts"
3. attachedFilesContext.set("index.ts", content)
4. Próxima mensagem: "Also check config.ts"
5. attachedFilesContext já tem index.ts em cache
6. Só lê disco se arquivo novo
```

### 7. **Process Management**

Gerencia processos em background:

```bash
/start servidor npm run dev      # Inicia em background
/ps                              # Lista processos
/kill servidor                   # Mata processo
/stop                            # Para processo ativo
```

Mapa interno: `Map<name, ManagedProc>`

### 8. **Settings Persistência**

Armazena em `~/.config/thchat/settings.json` (Linux/Mac) ou `%APPDATA%\thchat\settings.json` (Windows):

```json
{
  "apiKey": "sk-...",
  "model": "anthropic/claude-haiku-4.5",
  "fallbackModel": "openai/gpt-oss-120b:free",
  "cavemanMode": "full",
  "apiUrl": "https://openrouter.ai/api/v1/chat/completions",
  "allowedExtraModels": ["custom/model-1", "custom/model-2"]
}
```

---

## 🎯 Comandos CLI

| Comando | Descrição | Exemplo |
|---------|-----------|---------|
| `/ls [dir]` | Lista diretório | `/ls src` |
| `/cd <dir>` | Muda diretório | `/cd ../project` |
| `/model` | Mostra/muda modelo | `/model` ou `/model gpt-4` |
| `/model add <nome>` | Adiciona modelo permitido | `/model add custom/model-v1` |
| `/model rm <nome>` | Remove modelo extra | `/model rm custom/model-v1` |
| `/fallback [nome]` | Mostra/muda modelo fallback | `/fallback` ou `/fallback gpt-oss-120b` |
| `/api_key` | Atualiza API key | `/api_key sk-...` |
| `/run <cmd>` | Executa comando shell | `/run npm install` |
| `/start <nome> <cmd>` | Inicia processo background | `/start server npm run dev` |
| `/stop [nome]` | Para processo | `/stop` ou `/stop server` |
| `/kill [nome]` | Mata processo | `/kill server` |
| `/ps` | Lista processos | `/ps` |
| `/clear` | Limpa histórico | `/clear` |
| `/help` | Mostra ajuda | `/help` |
| `sair` | Encerra programa | `sair` |

---

## 🚨 Tratamento de Erros

### API Errors

```typescript
401 Unauthorized     → "API key inválida ou expirada"
                        Dica: Verifique sua API key com /api_key
429 Too Many Requests → "Rate limit atingido. Aguarde alguns minutos."
500+ Server Error    → "Erro no servidor OpenRouter"
0 (Connection)       → "Falha na conexão com API"
```

### Command Execution Errors

```typescript
⚠️  Exit code não-zero → "Comando falhou com exit code X"
❌ Padrão perigoso    → "Comando bloqueado por segurança"
```

### Validation Errors

Detecta nomes de arquivo inválidos, modelos bloqueados, etc.

---

## 🔐 Segurança

### Shell Command Validation
- **Whitelist**: Nenhuma
- **Blacklist**: Padrões perigosos (delete, format, shutdown)
- **Confirmação**: Todos os `/run` pedem confirmação "y/n"

### API Key
- Armazenado localmente em settings (usuário)
- Nunca salvo em `.env` do projeto
- Pode usar env vars: `OPENROUTER_API_KEY`, `API_KEY`, etc

### File Size Limits
- Máximo 512KB por arquivo (previne memória cheia)

---

## � Planning Flow

Quando IA propõe um plano (envolvido em `<plan>...</plan>`):

```
1. IA responde com <plan>...</plan>
   │
2. Cliente extrai conteúdo do plano
   │
3. Mostra para usuário:
   "📋 PLANO:
    I will:
    1. Ler index.ts
    2. Atualizar config
    3. Reiniciar serviço"
   │
4. Pergunta: "Aceitar plano? (y/n/Enter para sim): "
   │
   ├─ Usuário pressiona Enter/y → Aprova
   │  │
   │  └─ IA continua com execução (tool calls, edits)
   │
   └─ Usuário digita "n" → Rejeita
      │
      └─ Cliente remove plano e pede novamente: "Plano rejeitado. Pode descrever suas mudanças?"
```

**Implementação:**
```typescript
if (planMatch && !planApproved) {
  stopSpinner();
  console.log(`\n📋 PLANO:\n${plan}\n`);
  const approved = await ask("Aceitar plano? (y/n/Enter para sim): ", true);
  
  if (approved !== "y" && approved !== "yes") {
    messages.pop();  // Remove plano rejeitado
    return `Plano rejeitado. Pode descrever suas mudanças?`;
  }
  
  planApproved = true;
  console.log("✓ Plano aprovado. Executando...\n");
  messages.push({ role: "user", content: "Plano aprovado. Execute as ações descritas no plano." });
  continue;  // Next loop executa tool calls
}
```

---

## 🔄 Fallback Decision Tree

Estratégia automática de fallback em caso de falha:

```
API Request (model = primary)
  ↓
API responds?
├─ ✓ SIM → Parse resposta, continuar
│
└─ ✗ NÃO → catch erro
   ├─ Status 401 (Unauthorized)
   │  └─ ❌ Não tenta fallback
   │     └─ Throw: "API key inválida ou expirada"
   │
   ├─ Status 429 (Too Many Requests)
   │  └─ ❌ Não tenta fallback
   │     └─ Throw: "Rate limit atingido. Aguarde alguns minutos."
   │
   ├─ Status 500+ (Server Error)
   │  └─ ✓ Tenta fallback
   │     └─ model = fallback
   │        └─ Retry API Request
   │
   └─ ConnectionError (timeout, network down)
      └─ ✓ Tenta fallback
         └─ model = fallback
            └─ Retry API Request
```

**Código:**
```typescript
async function chat(apiKey, userMessage, model, fallbackModel) {
  let currentModel = model;
  let retryCount = 0;
  const maxRetries = fallbackModel ? MAX_RETRIES : 0;

  while (retryCount <= maxRetries) {
    try {
      return await chatWithModel(apiKey, currentModel);
    } catch (err) {
      // Não tentar fallback para 401, 429
      if (err instanceof APIError && (err.statusCode === 401 || err.statusCode === 429)) {
        throw err;  // Falha e não retenta
      }
      
      // Se não há fallback ou já tentou, relança
      if (!fallbackModel || retryCount > 0) {
        throw err;
      }
      
      // Tenta com fallback
      console.log(`⚠️  Modelo principal falhou. Tentando fallback: ${fallbackModel}...`);
      currentModel = fallbackModel;
      retryCount++;
    }
  }
}
```

---

## 🎯 Command Dispatcher

Fluxo principal que processa entrada do usuário:

```
┌──────────────────────┐
│  Entrada do usuário  │
└──────────┬───────────┘
           │
           ▼
    ┌─────────────────┐
    │ É comando (/) ? │
    └────────┬────────┘
    ┌────────▼────────┐
    │ /ls, /cd, /run, │
    │ /model, /help,  │
    │ /accept, /reject│
    │ /start, /ps...  │
    └────────┬────────┘
             │
    ┌────────▼────────────────┐
    │ Execute comando local   │
    │ (sem enviar para IA)    │
    └────────┬────────────────┘
             │
             ├─ /help → printHelp()
             ├─ /ls → listDirAsync()
             ├─ /cd → process.chdir()
             ├─ /model → ler/mudar modelo
             ├─ /run → validar + executar comando
             ├─ /accept on/off → mudar sessionAcceptAll
             ├─ /reject on/off → mudar sessionRejectAll
             ├─ /start → iniciar processo background
             ├─ /stop → parar processo
             ├─ /ps → listar processos
             └─ ...
             
             NÃO é comando
             │
             ▼
    ┌─────────────────────────┐
    │ Processar mensagem IA   │
    │ 1. Auto-attach files    │
    │ 2. Resolve @files       │
    │ 3. chat(input)          │
    │ 4. Parse tool calls     │
    │ 5. Execute tools        │
    │ 6. Loop até resposta    │
    └─────────────────────────┘
```

---

## 🔄 Fluxo de Chat com Ferramentas

```
1. Usuário: "leia index.ts e explique"
   │
2. Cliente → OpenRouter API:
   message: "leia index.ts..."
   model: "anthropic/claude-haiku-4.5"
   │
3. API responde com:
   <read_file>index.ts</read_file>
   "Vou ler o arquivo para você..."
   │
4. Cliente executa ferramenta:
   readFileAsync("index.ts") → conteúdo
   │
5. Cliente → OpenRouter API (round 2):
   message: "[Resultados das ferramentas]\n\n[read_file: index.ts]\n<conteúdo>"
   │
6. API responde com explicação
   │
7. Máximo 20 rodadas de ferramentas (MAX_TOOL_ROUNDS = 20)
```

---

## 📦 Estrutura de Pastas (Futuro)

Sugestão para modularização:

```
tchat/
├── index.ts              (entrada principal)
├── modules/
│   ├── api.ts           (chamadas OpenRouter)
│   ├── cli.ts           (interface readline)
│   ├── files.ts         (file I/O tools)
│   ├── process.ts       (gerenciamento de processos)
│   ├── errors.ts        (classes de erro)
│   └── validators.ts    (validações)
├── tests/
│   ├── api.test.ts
│   ├── validators.test.ts
│   └── ...
├── ARCHITECTURE.md      (este arquivo)
├── package.json
└── tsconfig.json
```

---

## 🚀 Quick Start

```bash
# 1. Instalar dependências
bun install

# 2. Rodar
bun run index.ts --api_key sk-xxx

# 3. Usar
Você: analise meu código
Assistente: <lê arquivos> Análise...

# 4. Compilar para executável
bun build ./index.ts --compile --outfile tchat.exe
```

---

## 🐛 Debugging

### Ativar logs detalhados (futuro)
```bash
DEBUG=tchat:* bun run index.ts
```

### Verificar settings
```bash
cat ~/.config/thchat/settings.json  # Linux/Mac
type %APPDATA%\thchat\settings.json  # Windows
```

### Testar validação de comando
```bash
Você: /run rm -rf /
❌ Comando rejeitado: Comando bloqueado por segurança: padrão perigoso detectado
```

---

## 📝 Roadmap

- [ ] Logging estruturado (winston/pino)
- [ ] Modularização (separar em arquivos)
- [ ] Testes unitários (vitest)
- [ ] Readline history persistente
- [ ] Auto-complete para modelos/comandos
- [ ] Rate limiting local
- [ ] Schema validation para settings (zod)
- [ ] CLI progress bar para arquivo grande

---

## 📄 Licença

Privado

---

**Última atualização**: 2026-04-21
