import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, spawnSync } from "child_process";

// --- Error handling ---
class AppError extends Error {
  constructor(
    message: string,
    public code: string = "INTERNAL_ERROR",
    public statusCode: number = 500
  ) {
    super(message);
    this.name = "AppError";
  }
}

class APIError extends AppError {
  constructor(message: string, statusCode: number) {
    super(message, "API_ERROR", statusCode);
    this.name = "APIError";
  }
}

class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

class CommandExecutionError extends AppError {
  constructor(message: string, public exitCode?: number) {
    super(message, "COMMAND_EXECUTION_ERROR", 500);
    this.name = "CommandExecutionError";
  }
}

// Safe command validator
const DANGEROUS_PATTERNS = [
  /(^|\s)(rm|rmdir|del|deltree|rd|unlink)\b/i, // delete commands
  /(^|\s)format\b/i,                           // format drives
  /(^|\s)wipe\b/i,                             // secure wipe
  /(^|\s)shutdown\b/i,                         // shutdown
  /\b(dd|mkfs)\b/i,                            // destructive tools
  /[;|&<>]/,                                     // pipes, redirects, command separators
  /`|\$\(|\)\s*\|/,                          // backticks or command substitution
  /\b(ncat|nc|curl|wget)\b\s+\-O/i,          // common downloaders with -O
  /[<>]/,                                        // output/input redirection
  /\b(tee|xargs)\b/i,                         // piping/chaining tools
];

function validateShellCommand(cmd: string): { safe: boolean; reason?: string } {
  if (!cmd || !cmd.trim()) return { safe: false, reason: "Comando vazio" };

  // normalize spaces to make obfuscation harder
  const normalized = cmd.replace(/\s+/g, " ").trim();

  for (const pattern of DANGEROUS_PATTERNS) {
    try {
      if (pattern.test(normalized)) {
        return { safe: false, reason: `Comando bloqueado por segurança: padrão perigoso detectado (${pattern})` };
      }
    } catch {
      // if a pattern fails, err on the side of safety
      return { safe: false, reason: "Comando bloqueado por segurança: padrão inválido" };
    }
  }

  // reject if contains obvious redirections or subshells even if spaced out
  if (/[<>|;&`]/.test(normalized)) {
    return { safe: false, reason: "Comando contém operadores de shell potencialmente perigosos" };
  }

  return { safe: true };
}

const API_URL_DEFAULTS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  nvidia: "https://integrate.api.nvidia.com/v1/chat/completions", //currently not working well
};

const MODEL_DEFAULT = "z-ai/glm-4.5-air:free";
const FALLBACK_MODEL_DEFAULT = "openai/gpt-oss-120b:free";
const DEFAULT_MODELS = ["openai/gpt-oss-120b:free", "z-ai/glm-4.5-air:free"];
const ALLOWED_MODELS = [
  "z-ai/glm-4.5-air:free",
  "openai/gpt-oss-120b:free",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.3-codex",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.7",
  "qwen/qwen3.6-plus",
];
const MAX_TOOL_ROUNDS = 20;
const MAX_RETRIES = 2; // Número máximo de retries com fallback
const API_TIMEOUT_MS = 60000; // 60 second timeout for fetch

// Caveman mode instructions
const CAVEMAN_INSTRUCTIONS = {
  lite: `
## Caveman Mode: LITE
Respond professional but drop filler. Keep grammar. No fluff.
- Drop: really, just, basically, actually, simply
- Keep: full sentences, articles, proper structure
- Code/commits: normal. Off: "stop caveman" / "normal mode"`,
  
  full: `
## Caveman Mode: FULL (Default)
Terse like caveman. Technical substance exact. Only fluff die.
- Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries (sure/certainly/of course)
- Fragments OK. Short synonyms (big not extensive, fix not "implement a solution for")
- Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Example NO: "Sure! I'd be happy to help. The issue is likely..."
- Example YES: "Bug in auth. Token check use < not <=. Fix:"
- Code/commits/PRs: normal. Off: "stop caveman" / "normal mode"`,
  
  ultra: `
## Caveman Mode: ULTRA
Maximum compression. Telegraphic. Abbreviate everything.
- Use: DB, auth, config, req, res, fn, impl (abbreviations OK)
- Drop: conjunctions (and/but/or → use arrow X → Y)
- Strip articles completely
- One word when one word enough
- Example: "Inline obj prop → new ref → re-render. \`useMemo\`."
- Code/commits/PRs: normal. Off: "stop caveman" / "normal mode"`,
};

type CavemanLevel = "off" | "lite" | "full" | "ultra";

const SYSTEM_PROMPT = `Você é um assistente de programação com acesso a ferramentas para ler e editar arquivos.

Diretório de trabalho: ${process.cwd()}

## MODO PLANEJAMENTO OBRIGATÓRIO
Antes de executar tarefas complexas:
1. Escreva um plano usando <plan>...</plan>
2. Aguarde aprovação do usuário (y/yes/Enter)
3. Execute ferramentas apenas após aprovação

## Ferramentas: <read_file>path</read_file>, <list_dir>path</list_dir>, <search_files>pattern</search_files>, <write_file path="p">content</write_file>
Para comandos: <run_command>cmd</run_command> (sync) ou <run_command_bg>cmd</run_command_bg> (bg)
REGRA: npm start e npm run dev = <run_command_bg>!
Responda em português`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const fsp = fs.promises;

// Global spinner handle so prompts clear spinner before asking
let activeSpinnerStop: (() => void) | null = null;
function clearSpinner() {
  if (activeSpinnerStop) {
    try {
      activeSpinnerStop();
    } catch {}
    activeSpinnerStop = null;
  }
}

// --- Process management ---
type ManagedProc = {
  name: string;
  cmd: string;
  cwd?: string;
  proc: ReturnType<typeof spawn>;
  logPath: string;
  logStream: fs.WriteStream;
};

const managedProcesses = new Map<string, ManagedProc>();
const managedProcessLogs = new Map<string, string>();
let activeProcessName: string | null = null; // Rastreia processo ativo (último iniciado)
const BG_LOG_DIR = path.join(os.tmpdir(), "thchat-bg-logs");

function cleanupManagedProcess(name: string, exitCode?: number | null) {
  const managed = managedProcesses.get(name);
  if (!managed) return;

  managedProcesses.delete(name);
  if (activeProcessName === name) activeProcessName = null;

  try {
    managed.logStream.write(`\n[${new Date().toISOString()}] EXIT ${exitCode ?? "unknown"}\n`);
    managed.logStream.end();
  } catch {}
}

function getTailLines(content: string, lineCount: number): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - lineCount)).join("\n");
}

function readLogTail(filePath: string, lineCount: number): string {
  try {
    const stat = fs.statSync(filePath);
    const readSize = 64 * 1024; // 64KB
    let pos = stat.size;
    let buffer = Buffer.alloc(0);
    const maxRead = 1024 * 1024; // cap total read to 1MB

    const fd = fs.openSync(filePath, "r");
    try {
      while (pos > 0 && buffer.length < maxRead) {
        const toRead = Math.min(readSize, pos);
        const start = pos - toRead;
        const chunk = Buffer.alloc(toRead);
        fs.readSync(fd, chunk, 0, toRead, start);
        buffer = Buffer.concat([chunk, buffer]);
        pos -= toRead;

        // quick check: if we have enough lines, stop
        const lines = buffer.toString("utf8").split(/\r?\n/);
        if (lines.length > lineCount + 1) break;
      }
    } finally {
      try { fs.closeSync(fd); } catch {}
    }

    const chunk = buffer.toString("utf8");
    return getTailLines(chunk, lineCount);
  } catch (e: any) {
    return `[ERRO ao ler logs: ${e.message}]`;
  }
}

function getManagedProcessLogs(nameOrActive?: string, lineCount: number = 80): string {
  const name = nameOrActive || activeProcessName;
  if (!name) return "[ERRO: nenhum processo ativo ou nome especificado]";

  const logPath = managedProcessLogs.get(name);
  if (!logPath) return `[ERRO: logs do processo '${name}' não encontrados]`;
  if (!fs.existsSync(logPath)) return `[ERRO: arquivo de log não existe: ${logPath}]`;

  const safeLineCount = Number.isFinite(lineCount) && lineCount > 0 ? Math.min(500, Math.floor(lineCount)) : 80;
  const tail = readLogTail(logPath, safeLineCount);
  return `[logs: ${name} | últimas ${safeLineCount} linhas | ${logPath}]\n${tail}`;
}

function runCommand(cmd: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const ps = spawn(cmd, { shell: true, cwd, stdio: "inherit" });
      ps.on("error", (err) => reject(new CommandExecutionError(`Erro ao executar: ${(err as any).message}`)));
      ps.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new CommandExecutionError(`Comando falhou com exit code ${code}`, code ?? undefined));
      });
    } catch (err: any) {
      reject(new CommandExecutionError(`Erro ao iniciar processo: ${err.message}`));
    }
  });
}

function startManagedProcess(name: string, cmd: string, cwd?: string): string {
  if (managedProcesses.has(name)) return `[ERRO: processo '${name}' já existe]`;
  try {
    try {
      fs.mkdirSync(BG_LOG_DIR, { recursive: true });
    } catch {}

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const logPath = path.join(BG_LOG_DIR, `${Date.now()}-${safeName}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a", encoding: "utf8" });
    logStream.write(`[${new Date().toISOString()}] START ${cmd} (cwd=${cwd || process.cwd()})\n`);

    // Background process must not share terminal stdin. Output goes to log file.
    const detached = process.platform !== "win32";
    const ps = spawn(cmd, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached,
    });
    if (detached) {
      try {
        ps.unref();
      } catch {}
    }

    ps.stdout?.on("data", (chunk) => {
      try {
        logStream.write(chunk);
      } catch {}
    });
    ps.stderr?.on("data", (chunk) => {
      try {
        logStream.write(chunk);
      } catch {}
    });
    ps.on("error", (err) => {
      try {
        logStream.write(`\n[${new Date().toISOString()}] ERROR ${(err as any).message}\n`);
      } catch {}
    });

    const m: ManagedProc = { name, cmd, cwd, proc: ps, logPath, logStream };
    managedProcesses.set(name, m);
    managedProcessLogs.set(name, logPath);
    activeProcessName = name; // Define como ativo
    ps.on("close", (code) => {
      cleanupManagedProcess(name, code);
      try {
        process.stdout.write(`\n[process ${name} exited ${code}]\n`);
      } catch {}
    });
    return `[OK: processo '${name}' iniciado | logs: ${logPath}]`;
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
    if (m.proc.exitCode !== null) {
      cleanupManagedProcess(name, m.proc.exitCode);
      return `[OK: processo '${name}' já estava finalizado]`;
    }

    const waitForClose = new Promise<number | null>((resolve) => {
      m.proc.once("close", (code) => resolve(code));
    });

    // try graceful (platform-specific): kill process tree on Windows, kill process group on POSIX
    const pid = m.proc.pid;
    try {
      if (pid) {
        if (process.platform === "win32") {
          try {
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
          } catch {}
        } else {
          try {
            process.kill(-pid, "SIGTERM");
          } catch {}
        }
      }
    } catch {}
    let closeCode = await Promise.race<number | null | "timeout">(([
      waitForClose,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1200)),
    ] as const));

    if (closeCode === "timeout" && managedProcesses.has(name)) {
      try {
        if (pid) {
          if (process.platform === "win32") {
            try {
              spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
            } catch {}
          } else {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {}
          }
        }
      } catch {}
      closeCode = await Promise.race<number | null | "timeout">(([
        waitForClose,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1200)),
      ] as const));
    }

    if (managedProcesses.has(name)) {
      cleanupManagedProcess(name, closeCode === "timeout" ? null : closeCode);
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
let cavemanMode: CavemanLevel = "off";
let apiUrl = API_URL_DEFAULTS.openrouter;

// Context map: keep file contents for reuse across messages
const attachedFilesContext = new Map<string, string>();

function ask(prompt: string, acceptEmptyAsYes: boolean = false): Promise<string> {
  return new Promise((resolve) => {
    // ensure any active spinner cleared so prompt appears clean
    try {
      clearSpinner();
      // push newline to separate previous spinner/output from prompt
      process.stdout.write('\n');
    } catch {}

    rl.question(prompt, (answer) => {
      // Se acceptEmptyAsYes está ativo e resposta vazia, retorna "y"
      if (acceptEmptyAsYes && answer.trim() === "") {
        resolve("y");
      } else {
        resolve(answer);
      }
    });
  });
}

function updateSystemPromptWithCaveman(mode: CavemanLevel): void {
  let systemContent = SYSTEM_PROMPT;
  
  // Remove existing caveman instruction if present
  systemContent = systemContent.replace(/## Caveman Mode:[\s\S]*?(?=\n---|\n\n|$)/, "").trim();
  
  // Add new caveman instruction if not "off"
  if (mode !== "off" && CAVEMAN_INSTRUCTIONS[mode]) {
    systemContent += "\n\n" + CAVEMAN_INSTRUCTIONS[mode];
  }
  
  messages[0] = { role: "system", content: systemContent };
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
  const stop = () => {
    clearInterval(interval);
    try {
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
    } catch {}
    // clear global handle
    if (activeSpinnerStop === stop) activeSpinnerStop = null;
  };
  // set global handle so prompts can clear it
  activeSpinnerStop = stop;
  return stop;
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
      if (oldLines[i] === newLines[j]) dp[i]![j] = 1 + (dp[i + 1]?.[j + 1] ?? 0);
      else dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0);
    }
  }

  // backtrack
  const out: { op: " " | "+" | "-"; line: string }[] = [];
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i] === newLines[j]) {
      out.push({ op: " ", line: oldLines[i]! });
      i++;
      j++;
    } else if (j < m && (i === n || (dp[i]?.[j + 1] ?? 0) >= (dp[i + 1]?.[j] ?? 0))) {
      out.push({ op: "+", line: newLines[j]! });
      j++;
    } else if (i < n) {
      out.push({ op: "-", line: oldLines[i]! });
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
      const ans = (await ask("Aceitar modificação? (y/n) [a = aceitar todas, r = rejeitar todas]: ", true)).trim().toLowerCase();
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
        const tryTemp = (await ask(`Permissão negada. Tentar salvar em pasta temporária (${os.tmpdir()})? (y/n): `, true)).trim().toLowerCase();
        if (tryTemp === "y" || tryTemp === "yes") {
          try {
            const altResolved = path.join(os.tmpdir(), path.basename(filePath));
            await fsp.writeFile(altResolved, content, "utf8");
            return `[OK: arquivo escrito em pasta temporária: ${altResolved}]`;
          } catch (e2: any) {
            return `[ERRO ao escrever em temporário ${path.join(os.tmpdir(), path.basename(filePath))}: ${e2.message}]`;
          }
        }

        const tryAlt = (await ask("Tentar caminho alternativo manual? (y/n): ", true)).trim().toLowerCase();
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

  // Remove <plan>...</plan> tags (não são tool calls)
  cleaned = cleaned.replace(/<plan>[\s\S]*?<\/plan>/g, "").trim();

  // Ordem DETERMINÍSTICA: read → list → search → write → commands
  // Isso evita race conditions (read antes de write)

  // Parse <read_file>path</read_file>
  const readRegex = /<read_file>([\s\S]*?)<\/read_file>/g;
  let match: RegExpExecArray | null;
  while ((match = readRegex.exec(text)) !== null) {
    if (match[1]) calls.push({ type: "read_file", path: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(readRegex, "");

  // Parse <list_dir>path</list_dir>
  const listRegex = /<list_dir>([\s\S]*?)<\/list_dir>/g;
  while ((match = listRegex.exec(text)) !== null) {
    if (match[1]) calls.push({ type: "list_dir", path: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(listRegex, "");

  // Parse <search_files>pattern</search_files>
  const searchRegex = /<search_files>([\s\S]*?)<\/search_files>/g;
  while ((match = searchRegex.exec(text)) !== null) {
    if (match[1]) calls.push({ type: "search_files", pattern: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(searchRegex, "");

  // Parse <write_file path="...">content</write_file>
  const writeRegex = /<write_file\s+path="([^"]+)">([\s\S]*?)<\/write_file>/g;
  while ((match = writeRegex.exec(text)) !== null) {
    calls.push({ type: "write_file", path: match[1], content: match[2], raw: match[0] });
  }
  cleaned = cleaned.replace(writeRegex, "");

  // Parse <run_command>comando</run_command>
  const runCmdRegex = /<run_command>([\s\S]*?)<\/run_command>/g;
  while ((match = runCmdRegex.exec(text)) !== null) {
    if (match[1]) calls.push({ type: "run_command", command: match[1].trim(), raw: match[0] });
  }
  cleaned = cleaned.replace(runCmdRegex, "");

  // Parse <run_command_bg>comando</run_command_bg>
  const runCmdBgRegex = /<run_command_bg>([\s\S]*?)<\/run_command_bg>/g;
  while ((match = runCmdBgRegex.exec(text)) !== null) {
    if (match[1]) calls.push({ type: "run_command_bg", command: match[1].trim(), raw: match[0] });
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
          return { ...call, type: "run_command_bg" as const };
        }
      }
    }
    return call;
  }) as ToolCall[];

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
      console.log(`  ${i + 1}. ${runCommands[i]?.command} (síncrono)`);
    }
    for (let i = 0; i < runCommandsBg.length; i++) {
      console.log(`  ${runCommands.length + i + 1}. ${runCommandsBg[i]?.command} (background)`);
    }
    const ok = (await ask(`Executar na sequência? (y/n): `, true)).trim().toLowerCase();
    if (ok === "y" || ok === "yes") {
      let cmdIndex = 1;
      
      // Executar run_command (síncrono)
      for (let i = 0; i < runCommands.length; i++) {
        const cmd = runCommands[i]?.command ?? "";
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
        const cmd = runCommandsBg[i]?.command ?? "";
        console.log(`\n[${cmdIndex}/${totalCmds}] Iniciando em background: ${cmd}`);
        const procName = `bg-${Date.now()}-${i}`;
        const msg = startManagedProcess(procName, cmd, process.cwd());
        console.log(`${msg}`);
        console.log(`Processo: ${procName}. Use /ps para listar, /logs para ver saída, /kill ou /stop para parar.`);
        results.push(`[run_command_bg ${i + 1} iniciado: ${cmd} (${procName})]`);
        cmdIndex++;
      }
    } else {
      console.log("Comandos cancelados pelo usuário.\n");
      for (let i = 0; i < runCommands.length; i++) {
        results.push(`[run_command ${i + 1} cancelado: ${runCommands[i]?.command}]`);
      }
      for (let i = 0; i < runCommandsBg.length; i++) {
        results.push(`[run_command_bg ${i + 1} cancelado: ${runCommandsBg[i]?.command}]`);
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

function saveSettings(updates: Record<string, any>): boolean {
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
    return true;
  } catch (e) {
    console.error("Erro ao gravar settings:", (e as any).message);
    return false;
  }
}

function printHelp(modelUsed: string, fallbackModel?: string) {
  console.log(`\nModelo: ${modelUsed}`);
  console.log(`Fallback: ${fallbackModel || "nenhum"}`);
  console.log(`Caveman: ${cavemanMode !== "off" ? cavemanMode.toUpperCase() : "off"}`);
  console.log(`Modificações: ${sessionAcceptAll ? "aceitar todas" : sessionRejectAll ? "rejeitar todas" : "perguntar"}`);
  console.log(`URL API: ${apiUrl}`);
  console.log(`Diretório: ${process.cwd()}`);
  console.log("\nRecursos:");
  console.log("  - Arquivos mencionados são anexados automaticamente");
  console.log("  - O assistente pode ler, buscar e editar seus arquivos");
  console.log("  - Use @arquivo para forçar anexo de um arquivo");
  console.log("\nComandos:");
  console.log("  /ls [dir]              - lista diretório");
  console.log("  /cd <dir>              - muda diretório");
  console.log("  /model [nome]          - mostra/troca modelo (salvo em settings do usuário)");
  console.log("  /model add <nome>      - adiciona modelo aos permitidos (para testar)");
  console.log("  /model rm <nome>       - remove modelo adicionado");
  console.log("  /fallback [nome]       - mostra/troca modelo de fallback (usado se principal falhar)");
  console.log("  /caveman [lite|full|ultra] - ativa modo caveman (terse, poucos tokens)");
  console.log("  /accept [on|off]       - auto-aceitar modificações (padrão: perguntar)");
  console.log("  /reject [on|off]       - auto-rejeitar modificações (padrão: perguntar)");
  console.log("  /url [preset|url]      - mostra/troca URL da API (openrouter, openai, anthropic, etc)");
  console.log("  /api_key [chave]       - define API key para esta sessão");
  console.log("  /clear                 - limpa histórico");
  console.log("  /run <cmd>             - executa comando com validação");
  console.log("  /start [--fg] <name> <cmd> - inicia processo gerenciado");
  console.log("  /stop [nome]           - para processo (com confirmação)");
  console.log("  /kill [nome]           - mata processo (sem confirmação)");
  console.log("  /ps                    - lista processos gerenciados");
  console.log("  /logs [nome] [linhas]  - mostra logs do processo (padrão: ativo, 80 linhas)");
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
    const tld = candidate?.split(".").pop();
    if (!candidate || ["com", "br", "net", "org", "io", "que", "por", "para"].includes(tld ?? "")) continue;
    if (candidate.length < 3) continue;
    mentioned.add(candidate);
  }

  if (mentioned.size === 0) return input;

  const attached: string[] = [];
  for (const name of mentioned) {
    // Check context first before reading disk
    let content = attachedFilesContext.get(name);
    if (!content) {
      content = await readFileAsync(name);
      if (!content.startsWith("[ERRO") && !content.startsWith("[DIRET")) {
        attachedFilesContext.set(name, content);
      }
    }
    if (!content.startsWith("[ERRO") && !content.startsWith("[DIRET")) {
      attached.push(`[Arquivo mencionado: ${name}]\n\`\`\`\n${content}\n\`\`\``);
    }
  }

  if (attached.length === 0) return input;
  return input + "\n\n--- Arquivos detectados automaticamente ---\n" + attached.join("\n\n");
}
 

// --- Chat API ---

async function chat(apiKey: string, userMessage: string, model: string, fallbackModel?: string): Promise<string> {
  messages.push({ role: "user", content: userMessage });
  
  let currentModel = model;
  let retryCount = 0;
  const maxRetries = fallbackModel ? MAX_RETRIES : 0;

  while (retryCount <= maxRetries) {
    try {
      return await chatWithModel(apiKey, currentModel);
    } catch (err: any) {
      // Se não há fallback ou já tentamos fallback, relança erro
      if (!fallbackModel || retryCount > 0) {
        messages.pop();
        throw err;
      }
      
      // Se falhou e há fallback, tenta com fallback
      if (err instanceof APIError && fallbackModel && fallbackModel !== currentModel) {
        console.log(`\n⚠️  Modelo principal falhou. Tentando fallback: ${fallbackModel}...\n`);
        currentModel = fallbackModel;
        retryCount++;
        // Remove última mensagem user e tenta de novo
        messages.pop();
        messages.push({ role: "user", content: userMessage });
        continue;
      }
      
      messages.pop();
      throw err;
    }
  }
  
  messages.pop();
  return "(erro após tentar fallback)";
}

async function chatWithModel(apiKey: string, model: string): Promise<string> {
  let stopSpinner = startSpinner(`⏳ Processando...`);
  
  try {
    let planApproved = false;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let res: Response;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        try {
          res = await fetch(apiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model, messages }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err: any) {
        if (err.name === "AbortError") {
          throw new APIError(`Timeout na API: nenhuma resposta em ${API_TIMEOUT_MS / 1000}s`, 0);
        }
        throw new APIError(`Falha na conexão com API: ${err.message}`, 0);
      }
      
      if (!res || !res.ok) {
        const err = await res.text();
        const statusCode = res?.status || 500;
        if (statusCode === 401) {
          throw new APIError("API key inválida ou expirada", 401);
        } else if (statusCode === 429) {
          throw new APIError("Rate limit atingido. Aguarde alguns minutos.", 429);
        } else if (statusCode >= 500) {
          throw new APIError(`Erro no servidor OpenRouter: ${statusCode}`, statusCode);
        } else {
          throw new APIError(`Erro na API (${statusCode}): ${err.substring(0, 100)}`, statusCode);
        }
      }

      const data = (await res.json()) as any;
      const assistantMsg = data.choices?.[0]?.message?.content ?? "(sem resposta)";
      messages.push({ role: "assistant", content: assistantMsg });
      // Check for planning tags first
      const planMatch = assistantMsg.match(/<plan>([\s\S]*?)<\/plan>/);
      if (planMatch && !planApproved) {
        // Found a plan - show it and ask for approval
        const plan = planMatch[1].trim();
        stopSpinner();
        console.log(`\n📋 PLANO:\n${plan}\n`);
        const approved = (await ask("Aceitar plano? (y/n/Enter para sim): ", true)).trim().toLowerCase();

        if (approved !== "y" && approved !== "yes") {
          console.log("Plano rejeitado pelo usuário.");
          // Remove the assistant message and the user message that generated it
          messages.pop();
          return `Plano rejeitado. Pode descrever suas mudanças?`;
        }

        planApproved = true;
        console.log("✓ Plano aprovado. Executando...\n");
        stopSpinner = startSpinner(`⏳ Executando plano...`);
        // inject user confirmation so model continues immediately with tool calls
        messages.push({ role: "user", content: "Plano aprovado. Execute as ações descritas no plano." });
        // continue loop to fetch assistant follow-up (which should contain tool calls)
        continue;
      }




      const { calls, cleaned } = parseToolCalls(assistantMsg);

      if (calls.length === 0) {
        // No tool calls — show the response
        stopSpinner();
        return assistantMsg;
      }

      // If there was text alongside tool calls, show it (spinner still active)
      if (cleaned) {
        process.stdout.write(`\n${cleaned}\n`);
      }
      process.stdout.write(`\n[Executando ferramentas...]\n`);
      
      // Execute tool calls and feed results back (spinner still active)
      const toolResults = await executeToolCalls(calls);
      messages.push({
        role: "user",
        content: `[Resultados das ferramentas]:\n\n${toolResults}`,
      });
    }
    
    stopSpinner();
    return "(limite de rodadas de ferramentas atingido)";
  } catch (err: any) {
    stopSpinner();
    throw err;
  }
}

// --- Main ---

async function main() {
  console.log("=== Mini Code Chat - OpenRouter ===\n");

  // parse command-line flags: --api_key <key> or --api_key=<key>
  // and --model <name> or --model=<name>. Order flexible.
  function parseArgs(argv: string[]) {
    const out: { apiKey?: string; model?: string } = {};
    for (let i = 2; i < argv.length; i++) {
      const a = argv[i]!;
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

  function getAllowedModelsList(): string[] {
    const extra: string[] = Array.isArray(settings.allowedExtraModels) ? settings.allowedExtraModels : [];
    return ALLOWED_MODELS.concat(extra);
  }

  function isModelAllowed(m: string): boolean {
    if (!m) return false;
    return getAllowedModelsList().includes(m);
  }

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
  let fallbackModel = settings.fallbackModel || FALLBACK_MODEL_DEFAULT;
  cavemanMode = settings.cavemanMode || "off";
  apiUrl = settings.apiUrl || API_URL_DEFAULTS.openrouter;

  // Restore caveman mode in system prompt if it was saved
  if (cavemanMode !== "off") {
    updateSystemPromptWithCaveman(cavemanMode);
  }

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

  // Validate model is in allowed list
  if (!isModelAllowed(modelUsed)) {
    console.error(`❌ Modelo não permitido: ${modelUsed}`);
    console.error(`Modelos permitidos: ${getAllowedModelsList().join(", ")}`);
    console.error(`Use '/model' para escolher um permitido.\n`);
    rl.close();
    return;
  }

  // persist model to per-user settings (do NOT save API key to project .env)
  if (parsed.model) saveSettings({ model: modelUsed });

  printHelp(modelUsed, fallbackModel);

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
      printHelp(modelUsed, fallbackModel);
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
      const models = getAllowedModelsList();
      if (!arg) {
        console.log(`Modelo atual: ${modelUsed}`);
        console.log("Modelos permitidos:");
        models.forEach((m, i) => console.log(`  [${i + 1}] ${m}`));
        console.log("Use '/model <nome>' ou '/model <número>' para trocar e salvar no settings do usuário");
        console.log("Use '/model add <nome>' para adicionar modelo aos permitidos\n");
        continue;
      }
      // support adding/removing allowed models without editing source
      if (arg.startsWith("add ") || arg.startsWith("rm ") || arg.startsWith("remove ")) {
        const parts = arg.split(/\s+/);
        const cmd = parts[0];
        const name = parts.slice(1).join(" ").trim();
        if (!name) {
          console.log("Uso: /model add <nome>  ou  /model rm <nome>\n");
          continue;
        }
        // ensure settings.allowedExtraModels exists
        if (!Array.isArray(settings.allowedExtraModels)) settings.allowedExtraModels = [];
        if (cmd === "add") {
          if (isModelAllowed(name)) {
            console.log(`Modelo já permitido: ${name}\n`);
            continue;
          }
          settings.allowedExtraModels.push(name);
          saveSettings({ allowedExtraModels: settings.allowedExtraModels });
          console.log(`Modelo adicionado aos permitidos: ${name}\n`);
          continue;
        }
        if (cmd === "rm" || cmd === "remove") {
          const idx = settings.allowedExtraModels.indexOf(name);
          if (idx === -1) {
            console.log(`Modelo não encontrado entre extras: ${name}\n`);
            continue;
          }
          settings.allowedExtraModels.splice(idx, 1);
          saveSettings({ allowedExtraModels: settings.allowedExtraModels });
          console.log(`Modelo removido da lista extra: ${name}\n`);
          continue;
        }
      }

      let chosenModel: string = arg;
      if (/^\d+$/.test(arg)) {
        const idx = parseInt(arg, 10) - 1;
        if (idx >= 0 && idx < models.length) {
          chosenModel = models[idx]!;
        } else {
          console.log(`Índice inválido: ${arg}`);
          continue;
        }
      }

      if (!isModelAllowed(chosenModel)) {
        console.log(`Modelo não permitido: ${chosenModel}`);
        console.log("Ver modelos permitidos com '/model'\n");
        continue;
      }

      modelUsed = chosenModel;
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

    // /fallback command: set or show fallback model
    if (input.startsWith("/fallback")) {
      const arg = input.slice(9).trim();
      if (!arg) {
        console.log(`Modelo de fallback atual: ${fallbackModel}`);
        console.log("Modelos permitidos:");
        for (const m of getAllowedModelsList()) console.log("  - " + m);
        console.log("Use '/fallback <nome>' para trocar e salvar no settings do usuário\n");
        continue;
      }

      if (!isModelAllowed(arg)) {
        console.log(`Modelo não permitido: ${arg}`);
        console.log("Ver modelos permitidos com '/fallback'\n");
        continue;
      }

      fallbackModel = arg;
      saveSettings({ fallbackModel });
      console.log(`Modelo de fallback alterado para: ${fallbackModel} (salvo em settings do usuário)\n`);
      continue;
    }

    // /url command: set or show API URL
    if (input.startsWith("/url")) {
      const arg = input.slice(4).trim();
      const urlEntries = Object.entries(API_URL_DEFAULTS);
      if (!arg) {
        console.log(`URL da API atual: ${apiUrl}`);
        console.log("\nPresets disponíveis:");
        urlEntries.forEach(([name, url], i) => {
          console.log(`  [${i + 1}] ${name.padEnd(12)} - ${url}`);
        });
        console.log("\nUso:");
        console.log("  /url <preset>        - muda para um preset (openrouter, openai, anthropic, etc)");
        console.log("  /url <número>        - muda para preset pelo índice");
        console.log("  /url https://...     - muda para URL customizada\n");
        continue;
      }

      let newUrl: string | undefined;

      if (/^\d+$/.test(arg)) {
        const idx = parseInt(arg, 10) - 1;
        if (idx >= 0 && idx < urlEntries.length) {
          const [presetName, presetUrl] = urlEntries[idx]!;
          newUrl = presetUrl;
          console.log(`✓ URL alterada para preset [${idx + 1}] '${presetName}': ${newUrl}`);
        } else {
          console.log(`Índice inválido: ${arg}`);
          continue;
        }
      } else if (arg.toLowerCase() in API_URL_DEFAULTS) {
        newUrl = API_URL_DEFAULTS[arg.toLowerCase() as keyof typeof API_URL_DEFAULTS];
        console.log(`✓ URL alterada para preset '${arg.toLowerCase()}': ${newUrl}`);
      } else if (arg.startsWith("http://") || arg.startsWith("https://")) {
        // Custom URL
        newUrl = arg;
        console.log(`✓ URL customizada definida: ${newUrl}`);
      } else {
        console.log(`❌ Preset inválido ou URL não começa com http:// ou https://`);
        console.log("Presets conhecidos: " + Object.keys(API_URL_DEFAULTS).join(", ") + "\n");
        continue;
      }

      if (newUrl) {
        apiUrl = newUrl;
        saveSettings({ apiUrl: newUrl });
        console.log("(salvo em settings do usuário)\n");
      }
      continue;
    }

    // /accept command: toggle auto-accept modifications
    if (input.startsWith("/accept")) {
      const arg = input.slice(7).trim().toLowerCase();
      if (!arg || arg === "on") {
        sessionAcceptAll = true;
        sessionRejectAll = false;
        console.log(`✓ Modo: aceitar todas as modificações automaticamente\n`);
      } else if (arg === "off") {
        sessionAcceptAll = false;
        console.log(`✓ Modo: perguntar antes de cada modificação\n`);
      } else {
        console.log("Uso: /accept [on|off]\n");
      }
      continue;
    }

    // /reject command: toggle auto-reject modifications
    if (input.startsWith("/reject")) {
      const arg = input.slice(7).trim().toLowerCase();
      if (!arg || arg === "on") {
        sessionRejectAll = true;
        sessionAcceptAll = false;
        console.log(`✓ Modo: rejeitar todas as modificações automaticamente\n`);
      } else if (arg === "off") {
        sessionRejectAll = false;
        console.log(`✓ Modo: perguntar antes de cada modificação\n`);
      } else {
        console.log("Uso: /reject [on|off]\n");
      }
      continue;
    }

    // /caveman command: activate caveman mode (lite, full, ultra)
    if (input.startsWith("/caveman")) {
      const arg = input.slice(8).trim().toLowerCase();
      if (!arg) {
        console.log(`Modo caveman atual: ${cavemanMode !== "off" ? cavemanMode.toUpperCase() : "OFF"}`);
        console.log("Intensidades disponíveis:");
        console.log("  /caveman lite   - terse, sem fluff, mas gramaticalmente correto");
        console.log("  /caveman full   - caveman completo, fragmentos OK, menos tokens");
        console.log("  /caveman ultra  - máxima compressão, telegráfico, abreviações");
        console.log("  /caveman off    - desativa caveman mode\n");
        continue;
      }

      const validModes = ["lite", "full", "ultra", "off"];
      if (!validModes.includes(arg)) {
        console.log(`Modo inválido: ${arg}`);
        console.log("Modos válidos: lite, full, ultra, off\n");
        continue;
      }

      cavemanMode = arg as CavemanLevel;
      updateSystemPromptWithCaveman(cavemanMode);
      saveSettings({ cavemanMode });
      
      if (cavemanMode === "off") {
        console.log(`🪨 Caveman mode desativado. Voltando ao normal.\n`);
      } else {
        console.log(`🪨 Caveman mode ativado: ${cavemanMode.toUpperCase()}`);
        console.log(`   why use many token when few do trick\n`);
      }
      continue;
    }

    // /run command: run one-off shell command after explicit consent
    if (input.startsWith("/run ")) {
      const cmd = input.slice(5).trim();
      if (!cmd) {
        console.log("Uso: /run <comando>\n");
        continue;
      }
      // Validate command safety
      const validation = validateShellCommand(cmd);
      if (!validation.safe) {
        console.log(`❌ Comando rejeitado: ${validation.reason}\n`);
        continue;
      }
      const ok = (await ask(`Executar comando (projeto ${process.cwd()}): ${cmd} ? (y/n): `, true)).trim().toLowerCase();
      if (ok !== "y" && ok !== "yes") {
        console.log("Cancelado pelo usuário.\n");
        continue;
      }
      try {
        await runCommand(cmd, process.cwd());
        console.log(`✓ Comando '${cmd}' finalizado.\n`);
      } catch (e: any) {
        if (e instanceof CommandExecutionError) {
          console.error(`❌ Erro na execução: ${e.message}`);
          if (e.exitCode) console.error(`   Exit code: ${e.exitCode}`);
        } else {
          console.error(`❌ Erro inesperado: ${(e as any).message}`);
        }
        console.log();
      }
      continue;
    }

    // /start <nome> <comando> - inicia processo gerenciado
    if (input.startsWith("/start ")) {
      const rest = input.slice(7).trim();
      // Suporte a --fg para foreground
      const fg = rest.includes("--fg");
      const cleanRest = rest.replace(/--fg/g, "").trim();
      const parts = cleanRest.split(" ");
      if (parts.length < 2) {
        console.log("Uso: /start [--fg] <nome> <comando>");
        continue;
      }
      const name = parts.shift()!;
      const cmd = parts.join(" ");
      const ok = (await ask(`Iniciar processo '${name}'${fg ? " (foreground)" : ""}: ${cmd} ? (y/n): `, true)).trim().toLowerCase();
      if (ok !== "y" && ok !== "yes") {
        console.log("Cancelado pelo usuário.\n");
        continue;
      }
      if (fg) {
        // Foreground: trava terminal, mostra stdout/stderr ao vivo
        try {
          await runCommand(cmd, process.cwd());
          console.log(`✓ Processo '${name}' (foreground) finalizado.`);
        } catch (e: any) {
          console.error(`Erro ao rodar processo foreground: ${(e && e.message) || e}`);
        }
      } else {
        console.log(startManagedProcess(name, cmd, process.cwd()));
      }
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
      const ok = (await ask(`Parar processo '${targetName}' ? (y/n): `, true)).trim().toLowerCase();
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

    // /logs [nome] [linhas] - exibe logs de processo gerenciado
    if (input === "/logs" || input.startsWith("/logs ")) {
      const rest = input.slice(5).trim();
      const parts = rest ? rest.split(/\s+/) : [];

      let targetName: string | undefined;
      let lineCount = 80;

      if (parts.length === 1) {
        const n = Number(parts[0]);
        if (Number.isFinite(n)) lineCount = n;
        else targetName = parts[0];
      } else if (parts.length >= 2) {
        targetName = parts[0];
        const n = Number(parts[1]);
        if (Number.isFinite(n)) lineCount = n;
      }

      const out = getManagedProcessLogs(targetName, lineCount);
      console.log(out + "\n");
      continue;
    }

    try {
      // Resolve @file references
      let enriched = await resolveAtFiles(input);
      // Auto-attach mentioned files
      enriched = await autoAttachFiles(enriched);

      const reply = await chat(finalApiKey, enriched, modelUsed, fallbackModel);
      console.log(`\nAssistente: ${reply}\n`);
    } catch (e: any) {
      if (e instanceof APIError) {
        console.error(`\n❌ Erro API (${e.code}): ${e.message}\n`);
        if (e.statusCode === 401) console.error("   Dica: Verifique sua API key com /api_key\n");
        if (e.statusCode === 429) console.error("   Dica: Aguarde alguns minutos antes de tentar novamente\n");
      } else if (e instanceof ValidationError) {
        console.error(`\n❌ Erro de validação: ${e.message}\n`);
      } else if (e instanceof AppError) {
        console.error(`\n❌ Erro (${e.code}): ${e.message}\n`);
      } else {
        console.error(`\n❌ Erro inesperado: ${(e as any).message}\n`);
      }
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
    const filePath = match[1]!;
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
