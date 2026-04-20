import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL_DEFAULT = "z-ai/glm-4.5-air:free";
const DEFAULT_MODELS = ["openai/gpt-oss-120b:free", "z-ai/glm-4.5-air:free"];
const ALLOWED_MODELS = [
  "openai/gpt-oss-120b:free",
  "z-ai/glm-4.5-air:free",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.3-codex",
  "anthropic/claude-3-haiku",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.7",
  "qwen/qwen3.6-plus",
];
const MAX_TOOL_ROUNDS = 10;

const SYSTEM_PROMPT = `Você é um assistente de programação com acesso a ferramentas para ler e editar arquivos do projeto do usuário.

Diretório de trabalho: ${process.cwd()}

## Ferramentas disponíveis

Para usar uma ferramenta, inclua a tag XML correspondente na sua resposta. Você pode combinar texto normal com chamadas de ferramentas. Pode fazer múltiplas chamadas em uma única resposta.

### Ler arquivo
<read_file>caminho/do/arquivo</read_file>

### Listar diretório
<list_dir>caminho/do/diretorio</list_dir>

### Buscar arquivos por nome
<search_files>padrão de busca</search_files>

### Escrever/editar arquivo
<write_file path="caminho/do/arquivo">conteúdo completo do arquivo aqui</write_file>


### Execução de comandos pela ferramenta

Esta aplicação pode executar comandos do sistema quando executada interativamente.

Segurança: comandos só serão executados após confirmação explícita do usuário.

**DOIS TIPOS DE TAGS XML para comandos:**

**TIPO 1: <run_command>comando</run_command>** — Síncrono APENAS
- Bloqueia até conclusão
- APENAS para: npm install, npm ci, npm run build, npm test, npm run lint
- NUNCA para servidores ou processos contínuos
- Exemplo CORRETO: <run_command>npm install</run_command>
- Exemplo ERRADO: <run_command>npm start</run_command> ❌

**TIPO 2: <run_command_bg>comando</run_command_bg>** — Background/Long-running
- Inicia processo gerenciado, retorna imediatamente
- Para TODOS os servidores e processos contínuos:
  * npm start
  * npm run dev
  * npm run watch
  * npm run server
  * nodemon
  * qualquer coisa que não termina sozinha
- Exemplo CORRETO: <run_command_bg>npm start</run_command_bg>
- Exemplo CORRETO: <run_command_bg>npm run dev</run_command_bg>
- Exemplo ERRADO: <run_command>npm start</run_command> ❌

**REGRA CRÍTICA**: npm start e npm run dev DEVEM SEMPRE ser <run_command_bg>, NUNCA <run_command>.
Se o usuário pedir para "rodar o projeto", "iniciar servidor", "rodar dev", retorne <run_command_bg>.

## Regras
- Sempre use <read_file> para ler arquivos antes de sugerir edições
- Ao editar, escreva o arquivo COMPLETO com <write_file>, nunca use placeholders
- Use <search_files> quando não souber o caminho exato de um arquivo
- Use <list_dir> para explorar a estrutura do projeto
- Depois de editar, confirme o que foi feito
- Responda sempre em português`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const fsp = fs.promises;

// --- Process management ---
type ManagedProc = {
  name: string;
  cmd: string;
  cwd?: string;
  proc: ReturnType<typeof spawn>;
};

const managedProcesses = new Map<string, ManagedProc>();
let activeProcessName: string | null = null; // Rastreia processo ativo (último iniciado)

function runCommand(cmd: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ps = spawn(cmd, { shell: true, cwd, stdio: "inherit" });
    ps.on("error", (err) => reject(err));
    ps.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}`));
    });
  });
}

function startManagedProcess(name: string, cmd: string, cwd?: string): string {
  if (managedProcesses.has(name)) return `[ERRO: processo '${name}' já existe]`;
  try {
    const ps = spawn(cmd, { shell: true, cwd, stdio: "inherit" });
    const m: ManagedProc = { name, cmd, cwd, proc: ps };
    managedProcesses.set(name, m);
    activeProcessName = name; // Define como ativo
    ps.on("close", (code) => {
      managedProcesses.delete(name);
      // Limpa se era o ativo
      if (activeProcessName === name) activeProcessName = null;
      try {
        process.stdout.write(`\n[process ${name} exited ${code}]\n`);
      } catch {}
    });
    return `[OK: processo '${name}' iniciado]`;
  } catch (e: any) {
    return `[ERRO ao iniciar '${name}': ${e.message}]`;
  }
}

async function stopManagedProcess(nameOrActive?: string): Promise<string> {
  // Se não passou nome, usa o ativo
  let name = nameOrActive || activeProcessName;
  if (!name) return `[ERRO: nenhum processo ativo ou especificado]`;
  
  const m = managedProcesses.get(name);
  if (!m) return `[ERRO: processo '${name}' não encontrado]`;
  try {
    // try graceful
    m.proc.kill();
    // wait small time for exit
    await new Promise((res) => setTimeout(res, 800));
    if (managedProcesses.has(name)) {
      try {
        m.proc.kill("SIGKILL");
      } catch {}
    }
    return `[OK: processo '${name}' finalizado]`;
  } catch (e: any) {
    return `[ERRO ao parar '${name}': ${e.message}]`;
  }
}

function listManaged(): string {
  if (managedProcesses.size === 0) return "[Nenhum processo gerenciado ativo]";
  return Array.from(managedProcesses.values())
    .map((m) => `- ${m.name}: ${m.cmd} ${m.cwd ? `(${m.cwd})` : ""}`)
    .join("\n");
}

const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
  { role: "system", content: SYSTEM_PROMPT },
];

// session-wide choices
let sessionAcceptAll = false;
let sessionRejectAll = false;

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// CLI spinner helper
function startSpinner(text = "Thinking...") {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let interval: any = setInterval(() => {
    try {
      process.stdout.write(`\r${frames[i % frames.length]} ${text}`);
    } catch {}
    i++;
  }, 80);
  return () => {
    clearInterval(interval);
    try {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    } catch {}
  };
}

// --- File tools ---

async function readFileAsync(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const stop = startSpinner(`Reading ${path.basename(filePath)}...`);
  try {
    try {
      const stat = await fsp.stat(resolved);
      if (stat.isDirectory()) {
        const entries = await fsp.readdir(resolved);
        stop();
        return `[DIRETÓRIO: ${filePath}]\n` + entries.join("\n");
      }
      if (stat.size > 512 * 1024) {
        stop();
        return `[ERRO: arquivo muito grande (${stat.size} bytes)]`;
      }
    } catch (e: any) {
      stop();
      return `[ERRO: arquivo não encontrado: ${filePath}]`;
    }

    const content = await fsp.readFile(resolved, "utf8");
    stop();
    return content;
  } catch (e: any) {
    stop();
    return `[ERRO ao ler ${filePath}: ${e.message}]`;
  }
}

function coloredDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);
  const n = oldLines.length;
  const m = newLines.length;

  // build LCS dp table
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) dp[i][j] = 1 + dp[i + 1][j + 1];
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // backtrack
  const out: { op: " " | "+" | "-"; line: string }[] = [];
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i] === newLines[j]) {
      out.push({ op: " ", line: oldLines[i] });
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push({ op: "+", line: newLines[j] });
      j++;
    } else if (i < n) {
      out.push({ op: "-", line: oldLines[i] });
      i++;
    }
  }

  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";

  return out
    .map((h) => {
      if (h.op === " ") return DIM + "  " + h.line + RESET;
      if (h.op === "-") return RED + "- " + h.line + RESET;
      return GREEN + "+ " + h.line + RESET;
    })
    .join("\n");
}

async function writeFile(filePath: string, content: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    const dir = path.dirname(resolved);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {}

    let old = "(arquivo não existe)";
    try {
      const s = await fsp.stat(resolved);
      if (s.isFile()) {
        try {
          old = await fsp.readFile(resolved, "utf8");
        } catch {}
      }
    } catch {}

    console.log(`\n--- PROPOSTA: ${filePath} ---`);
    console.log("--- DIFF (vermelho = sai, verde = entra) ---");
    console.log(coloredDiff(old, content));

    if (sessionAcceptAll) {
      // proceed
    } else if (sessionRejectAll) {
      return `[REJEITADO: ${filePath}]`;
    } else {
      const ans = (await ask("Aceitar modificação? (y/n) [a = aceitar todas, r = rejeitar todas]: ")).trim().toLowerCase();
      if (ans === "a" || ans === "all" || ans === "accept_all") {
        sessionAcceptAll = true;
      }
      if (ans === "r" || ans === "reject_all" || ans === "none") {
        sessionRejectAll = true;
        return `[REJEITADO: ${filePath}]`;
      }
      if (ans !== "y" && ans !== "yes") {
        return `[REJEITADO: ${filePath}]`;
      }
    }

    await fsp.writeFile(resolved, content, "utf8");
    return `[OK: arquivo escrito com sucesso: ${filePath}]`;
  } catch (e: any) {
    // handle permission errors by offering alternative path or using temp
    try {
      const code = (e && (e as any).code) || "";
      if (code === "EACCES" || code === "EPERM") {
        console.error(`Erro ao escrever ${filePath}: ${(e as any).message}`);
        const tryTemp = (await ask(`Permissão negada. Tentar salvar em pasta temporária (${os.tmpdir()})? (y/n): `)).trim().toLowerCase();
        if (tryTemp === "y" || tryTemp === "yes") {
          try {
            const altResolved = path.join(os.tmpdir(), path.basename(filePath));
            await fsp.writeFile(altResolved, content, "utf8");
            return `[OK: arquivo escrito em pasta temporária: ${altResolved}]`;
          } catch (e2: any) {
            return `[ERRO ao escrever em temporário ${path.join(os.tmpdir(), path.basename(filePath))}: ${e2.message}]`;
          }
        }

        const tryAlt = (await ask("Tentar caminho alternativo manual? (y/n): ")).trim().toLowerCase();
        if (tryAlt === "y" || tryAlt === "yes") {
          const alt = (await ask("Forneça caminho alternativo (arquivo completo): ")).trim();
          if (!alt) return `[CANCELADO: sem caminho alternativo fornecido]`;
          try {
            const altResolved = path.resolve(alt);
            const altDir = path.dirname(altResolved);
            try {
              await fsp.mkdir(altDir, { recursive: true });
            } catch {}
            await fsp.writeFile(altResolved, content, "utf8");
            return `[OK: arquivo escrito em caminho alternativo: ${alt}]`;
          } catch (e2: any) {
            return `[ERRO ao escrever em caminho alternativo ${alt}: ${e2.message}]`;
          }
        }
      }
    } catch {}
    return `[ERRO ao escrever ${filePath}: ${e.message}]`;
  }
}

function listDir(dirPath: string): string {
  const resolved = path.resolve(dirPath);
  try {
    if (!fs.existsSync(resolved)) return `[ERRO: diretório não encontrado: ${dirPath}]`;
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    if (entries.length === 0) return `[DIRETÓRIO VAZIO: ${dirPath}]`;
    return entries
      .map((e) => {
        if (e.isDirectory()) {
          const sub = fs.readdirSync(path.join(resolved, e.name)).length;
          return `📁 ${e.name}/ (${sub} itens)`;
        }
        const stat = fs.statSync(path.join(resolved, e.name));
        return `📄 ${e.name} (${(stat.size / 1024).toFixed(1)}kb)`;
      })
      .join("\n");
  } catch (e: any) {
    return `[ERRO ao listar ${dirPath}: ${e.message}]`;
  }
}

async function listDirAsync(dirPath: string): Promise<string> {
  const resolved = path.resolve(dirPath);
  const stop = startSpinner(`Listing ${path.basename(resolved)}...`);
  try {
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    if (entries.length === 0) {
      stop();
      return `[DIRETÓRIO VAZIO: ${dirPath}]`;
    }
    const out = entries
      .map((e) => {
        if (e.isDirectory()) {
          const sub = fs.readdirSync(path.join(resolved, e.name)).length;
          return `📁 ${e.name}/ (${sub} itens)`;
        }
        const stat = fs.statSync(path.join(resolved, e.name));
        return `📄 ${e.name} (${(stat.size / 1024).toFixed(1)}kb)`;
      })
      .join("\n");
    stop();
    return out;
  } catch (e: any) {
    stop();
    return `[ERRO ao listar ${dirPath}: ${e.message}]`;
  }
}

function searchFiles(pattern: string): string {
  const cwd = process.cwd();
  const lowerPattern = pattern.toLowerCase();
  const results: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 8 || results.length >= 20) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= 20) break;
        // skip node_modules, .git, etc
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name.toLowerCase().includes(lowerPattern)) {
          results.push(path.relative(cwd, full).replace(/\\/g, "/"));
        }
      }
    } catch {}
  }

  walk(cwd, 0);

  if (results.length === 0) return `[Nenhum arquivo encontrado para: "${pattern}"]`;
  return `[Arquivos encontrados para "${pattern}":]\n` + results.join("\n");
}

async function searchFilesAsync(pattern: string): Promise<string> {
  const cwd = process.cwd();
  const lowerPattern = pattern.toLowerCase();
  const results: string[] = [];
  const stop = startSpinner(`Searching for ${pattern}...`);

  async function walk(dir: string, depth: number) {
    if (depth > 8 || results.length >= 20) return;
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= 20) break;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        } else if (entry.name.toLowerCase().includes(lowerPattern)) {
          results.push(path.relative(cwd, full).replace(/\\/g, "/"));
        }
      }
    } catch {}
  }

  await walk(cwd, 0);
  stop();
  if (results.length === 0) return `[Nenhum arquivo encontrado para: "${pattern}"]`;
  return `[Arquivos encontrados para "${pattern}":]\n` + results.join("\n");
}

// --- Parse tool calls from AI response ---

interface ToolCall {
  type: "read_file" | "write_file" | "list_dir" | "search_files" | "run_command" | "run_command_bg";
  path?: string;
  content?: string;
  pattern?: string;
  command?: string;
  raw: string;
}

function parseToolCalls(text: string): { calls: ToolCall[]; cleaned: string } {
  const calls: ToolCall[] = [];
  let cleaned = text;

  // Parse <write_file path="...">content</write_file>
  const writeRegex = /<write_file\s+path="([^"]+)">([\s\S]*?)<\/write_file>/g;
  let match: RegExpExecArray | null;
  while ((match = writeRegex.exec(text)) !== null) {
    calls.push({ type: "write_file", path: match[1], content: match[2], raw: match[0] });
  }
  cleaned = cleaned.replace(writeRegex, "");

  // Parse <read_file>path</read_file>
  const readRegex = /<read_file>([\s\S]*?)<\/read_file>/g;
  while ((match = readRegex.exec(text)) !== null) {
    calls.push({ type: "read_file", path: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(readRegex, "");

  // Parse <list_dir>path</list_dir>
  const listRegex = /<list_dir>([\s\S]*?)<\/list_dir>/g;
  while ((match = listRegex.exec(text)) !== null) {
    calls.push({ type: "list_dir", path: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(listRegex, "");

  // Parse <search_files>pattern</search_files>
  const searchRegex = /<search_files>([\s\S]*?)<\/search_files>/g;
  while ((match = searchRegex.exec(text)) !== null) {
    calls.push({ type: "search_files", pattern: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(searchRegex, "");

  // Parse <run_command>comando</run_command>
  const runCmdRegex = /<run_command>([\s\S]*?)<\/run_command>/g;
  while ((match = runCmdRegex.exec(text)) !== null) {
    calls.push({ type: "run_command", command: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(runCmdRegex, "");

  // Parse <run_command_bg>comando</run_command_bg>
  const runCmdBgRegex = /<run_command_bg>([\s\S]*?)<\/run_command_bg>/g;
  while ((match = runCmdBgRegex.exec(text)) !== null) {
    calls.push({ type: "run_command_bg", command: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(runCmdBgRegex, "");

  // Auto-correct: se <run_command> contém comandos que devem ser background, converter
  const bgPatterns = ["npm start", "npm run dev", "npm run watch", "npm run server", "nodemon", "bun run dev"];
  const normalizedCalls = calls.map((call) => {
    if (call.type === "run_command") {
      const cmd = call.command || "";
      for (const pattern of bgPatterns) {
        if (cmd.includes(pattern)) {
          console.warn(`⚠️  Auto-correção: "${cmd}" deve ser background, convertendo para <run_command_bg>`);
          return { ...call, type: "run_command_bg" };
        }
      }
    }
    return call;
  });

  return { calls: normalizedCalls, cleaned: cleaned.trim() };
}

async function executeToolCalls(calls: ToolCall[]): Promise<string> {
  const results: string[] = [];

  // Separar comandos do resto
  const runCommands = calls.filter((c) => c.type === "run_command");
  const runCommandsBg = calls.filter((c) => c.type === "run_command_bg");
  const otherCalls = calls.filter((c) => c.type !== "run_command" && c.type !== "run_command_bg");

  // Processar run_command e run_command_bg juntos com uma única confirmação
  if (runCommands.length > 0 || runCommandsBg.length > 0) {
    const totalCmds = runCommands.length + runCommandsBg.length;
    console.log(`\n[IA quer executar ${totalCmds} comando(s)]:`);
    for (let i = 0; i < runCommands.length; i++) {
      console.log(`  ${i + 1}. ${runCommands[i].command} (síncrono)`);
    }
    for (let i = 0; i < runCommandsBg.length; i++) {
      console.log(`  ${runCommands.length + i + 1}. ${runCommandsBg[i].command} (background)`);
    }
    const ok = (await ask(`Executar na sequência? (y/n): `)).trim().toLowerCase();
    if (ok === "y" || ok === "yes") {
      let cmdIndex = 1;
      
      // Executar run_command (síncrono)
      for (let i = 0; i < runCommands.length; i++) {
        const cmd = runCommands[i].command!;
        console.log(`\n[${cmdIndex}/${totalCmds}] Executando (síncrono): ${cmd}`);
        try {
          await runCommand(cmd, process.cwd());
          console.log(`✓ Comando finalizado com sucesso.`);
          results.push(`[run_command ${i + 1} concluído: ${cmd}]`);
        } catch (e: any) {
          console.error(`✗ Erro: ${e.message}`);
          results.push(`[run_command ${i + 1} falhou: ${cmd} - ${e.message}]`);
        }
        cmdIndex++;
      }

      // Executar run_command_bg (background)
      for (let i = 0; i < runCommandsBg.length; i++) {
        const cmd = runCommandsBg[i].command!;
        console.log(`\n[${cmdIndex}/${totalCmds}] Iniciando em background: ${cmd}`);
        const procName = `bg-${Date.now()}-${i}`;
        const msg = startManagedProcess(procName, cmd, process.cwd());
        console.log(`${msg}`);
        console.log(`Processo: ${procName}. Use /ps para listar, /kill ou /stop para parar.`);
        results.push(`[run_command_bg ${i + 1} iniciado: ${cmd} (${procName})]`);
        cmdIndex++;
      }
    } else {
      console.log("Comandos cancelados pelo usuário.\n");
      for (let i = 0; i < runCommands.length; i++) {
        results.push(`[run_command ${i + 1} cancelado: ${runCommands[i].command}]`);
      }
      for (let i = 0; i < runCommandsBg.length; i++) {
        results.push(`[run_command_bg ${i + 1} cancelado: ${runCommandsBg[i].command}]`);
      }
    }
  }

  // Processar outros tool calls
  for (const call of otherCalls) {
    switch (call.type) {
      case "read_file": {
        const content = await readFileAsync(call.path!);
        results.push(`[read_file: ${call.path}]\n${content}`);
        break;
      }
      case "write_file":
        results.push(await writeFile(call.path!, call.content!));
        break;
      case "list_dir": {
        const out = await listDirAsync(call.path || ".");
        results.push(`[list_dir: ${call.path}]\n${out}`);
        break;
      }
      case "search_files": {
        const out = await searchFilesAsync(call.pattern!);
        results.push(out);
        break;
      }
    }
  }

  return results.join("\n\n");
}

// (obsolete) .env helper removed — API keys must be stored in system env or keychain

// --- settings (user model) helper ---
function getSettingsPath(): string {
  const home = os.homedir();
  const base = process.platform === "win32" ? (process.env.APPDATA || path.join(home, "AppData", "Roaming")) : (process.env.XDG_CONFIG_HOME || path.join(home, ".config"));
  return path.join(base, "thchat", "settings.json");
}

function loadSettings(): Record<string, any> {
  try {
    const p = getSettingsPath();
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSettings(updates: Record<string, any>): void {
  try {
    const p = getSettingsPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let data: Record<string, any> = {};
    if (fs.existsSync(p)) {
      try {
        data = JSON.parse(fs.readFileSync(p, "utf8") || "{}");
      } catch {}
    }
    Object.assign(data, updates);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
    try {
      if (process.platform !== "win32") fs.chmodSync(p, 0o600);
    } catch {}
  } catch (e) {
    console.error("Erro ao gravar settings:", (e as any).message);
  }
}

function printHelp(modelUsed: string) {
  console.log(`\nModelo: ${modelUsed}`);
  console.log(`Diretório: ${process.cwd()}`);
  console.log("\nRecursos:");
  console.log("  - Arquivos mencionados são anexados automaticamente");
  console.log("  - O assistente pode ler, buscar e editar seus arquivos");
  console.log("  - Use @arquivo para forçar anexo de um arquivo");
  console.log("\nComandos:");
  console.log("  /ls [dir]              - lista diretório");
  console.log("  /cd <dir>              - muda diretório");
  console.log("  /model [nome]          - mostra/troca modelo (salvo em settings do usuário)");
  console.log("  /api_key [chave]       - define API key para esta sessão");
  console.log("  /clear                 - limpa histórico");
  console.log("  /stop [nome]           - para processo (sem nome = para ativo)");
  console.log("  /kill [nome]           - mata processo (sem confirmação, sem nome = ativo)");
  console.log("  /ps                    - lista processos gerenciados");
  console.log("  /h, /help              - mostra esta ajuda");
  console.log("  sair                   - encerra\n");
}

// --- Auto-attach files mentioned by user ---

async function autoAttachFiles(input: string): Promise<string> {
  // Match filenames like "index.ts", "src/app.js", "./foo.py", etc
  const filePattern = /(?:^|\s)([\w.\/\\-]+\.[a-zA-Z]{1,10})(?:\s|$|,|;|\?|!)/g;
  const mentioned = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = filePattern.exec(input)) !== null) {
    const candidate = m[1];
    // Skip obvious non-files
    if (["com", "br", "net", "org", "io", "que", "por", "para"].includes(candidate.split(".").pop()!)) continue;
    if (candidate.length < 3) continue;
    mentioned.add(candidate);
  }

  if (mentioned.size === 0) return input;

  const attached: string[] = [];
  for (const name of mentioned) {
    const content = await readFileAsync(name);
    if (!content.startsWith("[ERRO") && !content.startsWith("[DIRET")) {
      attached.push(`[Arquivo mencionado: ${name}]\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  if (attached.length === 0) return input;
  return input + "\n\n--- Arquivos detectados automaticamente ---\n" + attached.join("\n\n");
}
 

// --- Chat API ---

async function chat(apiKey: string, userMessage: string, model: string): Promise<string> {
  messages.push({ role: "user", content: userMessage });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stopSpinner = startSpinner();
    let res: Response;
    try {
      res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      });
    } finally {
      stopSpinner();
    }
    if (!res || !res.ok) {
      const err = await res.text();
      messages.pop();
      throw new Error(`API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
    const assistantMsg = data.choices?.[0]?.message?.content ?? "(sem resposta)";
    messages.push({ role: "assistant", content: assistantMsg });

    const { calls, cleaned } = parseToolCalls(assistantMsg);

    if (calls.length === 0) {
      // No tool calls — show the response
      return assistantMsg;
    }

    // Execute tool calls and feed results back
    const toolResults = await executeToolCalls(calls);
    messages.push({
      role: "user",
      content: `[Resultados das ferramentas]:\n\n${toolResults}`,
    });

    // If there was text alongside tool calls, show it
    if (cleaned) {
      process.stdout.write(`\n${cleaned}\n\n[Executando ferramentas...]\n`);
    } else {
      process.stdout.write(`[Executando ferramentas...]\n`);
    }
  }

  return "(limite de rodadas de ferramentas atingido)";
}

// --- Main ---

async function main() {
  console.log("=== Mini Code Chat - OpenRouter ===\n");

  // parse command-line flags: --api_key <key> or --api_key=<key>
  // and --model <name> or --model=<name>. Order flexible.
  function parseArgs(argv: string[]) {
    const out: { apiKey?: string; model?: string } = {};
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith("--api_key=")) {
        out.apiKey = a.slice("--api_key=".length);
      } else if (a === "--api_key") {
        if (i + 1 < argv.length) out.apiKey = argv[++i];
      } else if (a.startsWith("--model=")) {
        out.model = a.slice("--model=".length);
      } else if (a === "--model") {
        if (i + 1 < argv.length) out.model = argv[++i];
      }
    }
    return out;
  }

  const parsed = parseArgs(process.argv);

  const settings = loadSettings();

  function readEnvApiKey(): string | undefined {
    const names = ["API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "THCHAT_API_KEY"];
    for (const n of names) {
      const v = process.env[n];
      if (v && v.trim()) return v.trim();
    }
    return undefined;
  }

  function readEnvModel(): string | undefined {
    const names = ["MODEL", "OPENROUTER_MODEL", "OPENAI_MODEL", "THCHAT_MODEL"];
    for (const n of names) {
      const v = process.env[n];
      if (v && v.trim()) return v.trim();
    }
    return undefined;
  }

  let finalApiKey = (parsed.apiKey || readEnvApiKey() || settings.apiKey || "").trim();
  let modelUsed = (parsed.model || readEnvModel() || settings.model || DEFAULT_MODELS[0] || MODEL_DEFAULT).trim();

  let askedApiKey = false;
  if (!finalApiKey) {
    const askKey = (await ask("Insira sua API key do OpenRouter: ")).trim();
    if (!askKey) {
      console.log("API key obrigatória. Saindo...");
      rl.close();
      return;
    }
    finalApiKey = askKey;
    askedApiKey = true;
    // persist API key to user settings
    try {
      saveSettings({ apiKey: finalApiKey });
    } catch {}
  } else {
    // if we obtained apiKey from parsed/env/settings and it's new, persist to settings
    try {
      if (settings.apiKey !== finalApiKey) saveSettings({ apiKey: finalApiKey });
    } catch {}
  }

  if (!modelUsed) modelUsed = DEFAULT_MODELS[0] || MODEL_DEFAULT;

  // persist model to per-user settings (do NOT save API key to project .env)
  if (parsed.model) saveSettings({ model: modelUsed });

  printHelp(modelUsed);

  while (true) {
    const input = (await ask("Você: ")).trim();
    if (!input) continue;

    if (input.toLowerCase() === "sair") break;

    if (input === "/clear") {
      messages.length = 1;
      console.log("Histórico limpo.\n");
      continue;
    }

    if (input === "/h" || input === "/help") {
      printHelp(modelUsed);
      continue;
    }

    if (input.startsWith("/ls")) {
      const dir = input.slice(3).trim() || ".";
      const out = await listDirAsync(dir);
      console.log(out + "\n");
      continue;
    }

    if (input.startsWith("/cd ")) {
      const dir = input.slice(4).trim();
      try {
        process.chdir(dir);
        console.log(`Diretório: ${process.cwd()}\n`);
        // Update system prompt with new cwd
        messages[0] = { role: "system", content: SYSTEM_PROMPT.replace(/Diretório de trabalho: .*/, `Diretório de trabalho: ${process.cwd()}`) };
      } catch {
        console.log(`Diretório não encontrado: ${dir}\n`);
      }
      continue;
    }

    // /model command: show list or set model
    if (input.startsWith("/model")) {
      const arg = input.slice(6).trim();
      if (!arg) {
        console.log(`Modelo atual: ${modelUsed}`);
        console.log("Modelos permitidos:");
        for (const m of ALLOWED_MODELS) console.log("  - " + m);
        console.log("Use '/model <nome>' para trocar e salvar no settings do usuário\n");
        continue;
      }

        if (!ALLOWED_MODELS.includes(arg)) {
          console.log(`Modelo não permitido: ${arg}`);
          console.log("Ver modelos permitidos com '/model'\n");
          continue;
        }

        modelUsed = arg;
        saveSettings({ model: modelUsed });
        console.log(`Modelo alterado para: ${modelUsed} (salvo em settings do usuário)\n`);
      continue;
    }

    // /api_key command: set or show
    if (input.startsWith("/api_key")) {
      const arg = input.slice(8).trim();
      let newKey = arg;
      if (!newKey) {
        newKey = (await ask("Insira nova API key: ")).trim();
      }
      if (!newKey) {
        console.log("Nenhuma API key informada.\n");
        continue;
      }
      finalApiKey = newKey;
      // persist to user settings
      try {
        saveSettings({ apiKey: finalApiKey });
      } catch {}
      console.log("API key atualizada e salva nas settings do usuário.\n");
      continue;
    }

    // /run command: run one-off shell command after explicit consent
    if (input.startsWith("/run ")) {
      const cmd = input.slice(5).trim();
      if (!cmd) {
        console.log("Uso: /run <comando>\n");
        continue;
      }
      const ok = (await ask(`Executar comando (projeto ${process.cwd()}): ${cmd} ? (y/n): `)).trim().toLowerCase();
      if (ok !== "y" && ok !== "yes") {
        console.log("Cancelado pelo usuário.\n");
        continue;
      }
      try {
        await runCommand(cmd, process.cwd());
        console.log(`Comando '${cmd}' finalizado.`);
      } catch (e: any) {
        console.error(`Erro: ${e.message}`);
      }
      continue;
    }

    // /start <nome> <comando> - inicia processo gerenciado
    if (input.startsWith("/start ")) {
      const rest = input.slice(7).trim();
      const parts = rest.split(" ");
      if (parts.length < 2) {
        console.log("Uso: /start <nome> <comando>");
        continue;
      }
      const name = parts.shift()!;
      const cmd = parts.join(" ");
      const ok = (await ask(`Iniciar processo '${name}': ${cmd} ? (y/n): `)).trim().toLowerCase();
      if (ok !== "y" && ok !== "yes") {
        console.log("Cancelado pelo usuário.\n");
        continue;
      }
      console.log(startManagedProcess(name, cmd, process.cwd()));
      continue;
    }

    // /stop [nome] - para processo gerenciado (sem nome = para ativo)
    if (input === "/stop" || input.startsWith("/stop ")) {
      const name = input.slice(5).trim();
      const targetName = name || activeProcessName;
      if (!targetName) {
        console.log("[Nenhum processo ativo. Use /ps para listar.]\n");
        continue;
      }
      const ok = (await ask(`Parar processo '${targetName}' ? (y/n): `)).trim().toLowerCase();
      if (ok !== "y" && ok !== "yes") {
        console.log("Cancelado pelo usuário.\n");
        continue;
      }
      console.log(await stopManagedProcess(targetName));
      if (targetName === activeProcessName) activeProcessName = null;
      continue;
    }

    // /kill [nome] - alias para /stop (mata ativo se nenhum nome, sem confirmação)
    if (input === "/kill" || input.startsWith("/kill ")) {
      const name = input.slice(5).trim();
      const targetName = name || activeProcessName;
      if (!targetName) {
        console.log("[Nenhum processo ativo. Use /ps para listar.]\n");
        continue;
      }
      console.log(await stopManagedProcess(targetName));
      if (targetName === activeProcessName) activeProcessName = null;
      continue;
    }

    // /ps - lista processos gerenciados
    if (input === "/ps") {
      if (activeProcessName) {
        console.log(`[Processo ativo: ${activeProcessName}]\n`);
      }
      console.log(listManaged() + "\n");
      continue;
    }

    try {
      // Resolve @file references
      let enriched = await resolveAtFiles(input);
      // Auto-attach mentioned files
      enriched = await autoAttachFiles(enriched);

      const reply = await chat(finalApiKey, enriched, modelUsed);
      console.log(`\nAssistente: ${reply}\n`);
    } catch (e: any) {
      console.error(`\nErro: ${e.message}\n`);
    }
  }

  console.log("\nAté logo!");
  rl.close();
}

async function resolveAtFiles(input: string): Promise<string> {
  const filePattern = /@([\w./\\:-]+)/g;
  const files = new Map<string, string>();
  let match: RegExpExecArray | null;

  while ((match = filePattern.exec(input)) !== null) {
    const filePath = match[1];
    const content = await readFileAsync(filePath);
    if (!content.startsWith("[ERRO")) {
      files.set(filePath, content);
    } else {
      files.set(filePath, `(arquivo não encontrado: ${filePath})`);
    }
  }

  if (files.size === 0) return input;

  let enriched = input;
  enriched += "\n\n--- Arquivos anexados via @ ---\n";
  for (const [fp, content] of files) {
    enriched += `\n📄 ${fp}:\n\`\`\`\n${content}\n\`\`\`\n`;
  }
  return enriched;
}

main();
