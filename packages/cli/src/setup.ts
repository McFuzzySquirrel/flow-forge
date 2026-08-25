import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekProvider, OpenAICompatibleProvider } from '@flowforge/agents';
import { confirm, prompt, promptChoice } from './io.js';
import {
  loadConfig,
  saveConfig,
  type FlowForgeConfig,
  type HybridMapping,
  type ProviderType
} from './config.js';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const RECOMMENDED_CHAT_MODELS = ['llama3.2', 'qwen2.5:3b'] as const;
const RECOMMENDED_EMBEDDING_MODEL = 'nomic-embed-text';

// ---------------------------------------------------------------------------
// System exec helpers
// ---------------------------------------------------------------------------

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: string[]): ExecResult {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error) return { ok: false, stdout: '', stderr: String(result.error.message ?? result.error) };
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// Ollama helpers
// ---------------------------------------------------------------------------

export async function ollamaTags(url: string): Promise<string[]> {
  const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  const data = (await response.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}

export async function checkOllamaServer(url: string): Promise<boolean> {
  try {
    await ollamaTags(url);
    return true;
  } catch {
    return false;
  }
}

export function pullOllamaModel(model: string): boolean {
  return exec('ollama', ['pull', model]).ok;
}

export function startChroma(): boolean {
  return exec('docker', ['run', '-d', '-p', '8000:8000', '--name', 'flowforge-chroma', 'chromadb/chroma']).ok;
}

// ---------------------------------------------------------------------------
// Doctor checks
// ---------------------------------------------------------------------------

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckReport {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export function checkNode(): CheckReport {
  const version = process.version.slice(1);
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  const ok = Number.isFinite(major) && major >= 20;
  return {
    name: 'node',
    status: ok ? 'ok' : 'fail',
    detail: ok ? `Node ${version} (>= 20 required)` : `Node ${version} is too old (>= 20 required)`,
    fix: ok ? undefined : 'install Node 20 or newer (https://nodejs.org)'
  };
}

export function checkPnpm(): CheckReport {
  const result = exec('pnpm', ['--version']);
  if (!result.ok) {
    return {
      name: 'pnpm',
      status: 'fail',
      detail: 'pnpm not found',
      fix: 'corepack enable && corepack prepare pnpm@11.5.2 --activate'
    };
  }
  const version = result.stdout.trim();
  const ok = /^11\./.test(version);
  return {
    name: 'pnpm',
    status: ok ? 'ok' : 'warn',
    detail: `pnpm ${version} (project pins 11.5.2)`,
    fix: ok ? undefined : 'corepack use pnpm@11.5.2'
  };
}

export function checkDeps(cwd = process.cwd()): CheckReport {
  const ok = existsSync(join(cwd, 'node_modules'));
  return {
    name: 'dependencies',
    status: ok ? 'ok' : 'fail',
    detail: ok ? 'workspace node_modules present' : 'dependencies not installed',
    fix: ok ? undefined : 'pnpm install'
  };
}

const BUILD_PACKAGES = ['core', 'agents', 'memory', 'audit', 'workflow', 'identity', 'kernel', 'workforce-packages', 'cli'] as const;

export function checkBuild(cwd = process.cwd()): CheckReport {
  const missing = BUILD_PACKAGES.filter((p) => !existsSync(join(cwd, 'packages', p, 'dist', 'index.js')));
  const ok = missing.length === 0;
  return {
    name: 'build',
    status: ok ? 'ok' : 'warn',
    detail: ok ? 'all packages compiled' : `missing dist for: ${missing.join(', ')}`,
    fix: ok ? undefined : 'pnpm build'
  };
}

export async function checkOllama(url = DEFAULT_OLLAMA_URL): Promise<CheckReport> {
  const reached = await checkOllamaServer(url);
  return reached
    ? { name: 'ollama', status: 'ok', detail: `server reachable at ${url}` }
    : {
        name: 'ollama',
        status: 'warn',
        detail: `server not reachable at ${url}`,
        fix: 'install ollama (https://ollama.com/download) and run `ollama serve`'
      };
}

export function checkDocker(): CheckReport {
  const result = exec('docker', ['--version']);
  return result.ok
    ? { name: 'docker', status: 'ok', detail: result.stdout.trim() }
    : {
        name: 'docker',
        status: 'warn',
        detail: 'docker not found (only needed for the Chroma vector store)',
        fix: 'https://docs.docker.com/get-docker/'
      };
}

export async function doctorChecks(options: { ollamaUrl?: string; cwd?: string } = {}): Promise<CheckReport[]> {
  const url = options.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  return [
    checkNode(),
    checkPnpm(),
    checkDeps(options.cwd),
    checkBuild(options.cwd),
    await checkOllama(url),
    checkDocker()
  ];
}

export function printChecks(checks: CheckReport[]): void {
  const icon: Record<CheckStatus, string> = { ok: '✔', warn: '⚠', fail: '✘' };
  for (const check of checks) {
    console.log(`  ${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.fix && check.status !== 'ok') console.log(`      fix: ${check.fix}`);
  }
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------

export interface SetupOptions {
  nonInteractive?: boolean;
  configPath?: string;
  provider?: ProviderType;
  apiKey?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  embeddingModel?: string;
  cloudBaseUrl?: string;
  cloudModel?: string;
  vectorStore?: 'file' | 'chroma';
  chromaUrl?: string;
  dataDir?: string;
  identityMode?: 'dev' | 'oidc';
  identityConfigPath?: string;
  apply?: boolean;
  skipValidation?: boolean;
  cwd?: string;
  home?: string;
}

async function promptText(question: string, def?: string): Promise<string> {
  const suffix = def !== undefined ? ` [${def}]` : '';
  const answer = (await prompt(`${question}${suffix} `)).trim();
  return answer === '' && def !== undefined ? def : answer;
}

async function validateCloudProvider(
  isDeepseek: boolean,
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<string> {
  const provider = isDeepseek ? new DeepSeekProvider(apiKey) : new OpenAICompatibleProvider(baseUrl, apiKey, model);
  const response = await provider.complete({ messages: [{ role: 'user', content: 'Reply with OK' }], temperature: 0 });
  if (!response.content.trim()) throw new Error('empty response from provider');
  return response.content.trim();
}

function applyModelPulls(url: string, interactive: boolean): Promise<void> {
  return (async () => {
    const recommended = [...RECOMMENDED_CHAT_MODELS, RECOMMENDED_EMBEDDING_MODEL];
    if (!interactive) {
      try {
        const installed = new Set(await ollamaTags(url));
        for (const model of recommended) {
          if (!installed.has(model)) {
            console.log(`  pulling ${model}…`);
            if (pullOllamaModel(model)) console.log(`  ✔ pulled ${model}`);
            else console.warn(`  ✘ failed to pull ${model}`);
          }
        }
      } catch {
        console.warn('  ⚠ could not reach Ollama to check models; skipping pulls');
      }
      return;
    }
    const reached = await checkOllamaServer(url);
    if (!reached) {
      console.log(
        `\n⚠ Ollama server not reachable at ${url}. Pull models manually later:\n` +
          `    ollama pull ${RECOMMENDED_CHAT_MODELS[0]}\n    ollama pull ${RECOMMENDED_EMBEDDING_MODEL}`
      );
      return;
    }
    const installed = new Set(await ollamaTags(url));
    for (const model of recommended) {
      if (installed.has(model)) continue;
      if (await confirm(`Pull recommended model '${model}'?`, false)) {
        if (pullOllamaModel(model)) console.log(`  ✔ pulled ${model}`);
        else console.warn(`  ✘ failed to pull ${model}`);
      }
    }
  })();
}

async function configureOllama(
  config: FlowForgeConfig,
  options: SetupOptions,
  interactive: boolean
): Promise<void> {
  const previous = config.provider.ollama;
  const url =
    options.ollamaUrl ??
    (interactive
      ? await promptText('Ollama server URL', previous?.url ?? DEFAULT_OLLAMA_URL)
      : previous?.url ?? DEFAULT_OLLAMA_URL);
  const model =
    options.ollamaModel ??
    (interactive
      ? await promptText('Default chat model', previous?.model ?? RECOMMENDED_CHAT_MODELS[0])
      : previous?.model ?? RECOMMENDED_CHAT_MODELS[0]);
  const embeddingModel =
    options.embeddingModel ??
    (interactive
      ? await promptText('Embedding model', previous?.embeddingModel ?? RECOMMENDED_EMBEDDING_MODEL)
      : previous?.embeddingModel ?? RECOMMENDED_EMBEDDING_MODEL);

  config.provider.ollama = { url, model, embeddingModel };

  if (interactive) {
    const reached = await checkOllamaServer(url);
    if (reached) {
      const installed = await ollamaTags(url);
      if (installed.length > 0) console.log(`  Installed models: ${installed.join(', ')}`);
      else console.log('  No models installed yet — Ollama pulls a model on first use.');
    }
  }
  if (interactive || options.apply) await applyModelPulls(url, interactive);
}

async function configureCloud(
  config: FlowForgeConfig,
  options: SetupOptions,
  interactive: boolean,
  secrets: Record<string, string>
): Promise<void> {
  const isDeepseek = config.provider.type === 'deepseek';
  const previous = config.provider.cloud;
  const defaultBaseUrl = isDeepseek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1';
  const defaultModel = isDeepseek ? 'deepseek-chat' : 'gpt-4o-mini';
  const baseUrl =
    options.cloudBaseUrl ??
    (interactive ? await promptText('API base URL', previous?.baseUrl ?? defaultBaseUrl) : previous?.baseUrl ?? defaultBaseUrl);
  const model =
    options.cloudModel ??
    (interactive ? await promptText('Default model', previous?.model ?? defaultModel) : previous?.model ?? defaultModel);

  let apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  if (!apiKey && interactive) apiKey = (await prompt(isDeepseek ? 'DeepSeek API key: ' : 'API key: ')).trim();
  if (!apiKey) {
    throw new Error('A cloud provider requires an API key (--api-key, DEEPSEEK_API_KEY or OPENAI_API_KEY)');
  }

  if (!options.skipValidation) {
    try {
      const reply = await validateCloudProvider(isDeepseek, apiKey, baseUrl, model);
      console.log(`  ✔ provider reachable (sample reply: ${reply.slice(0, 40)})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (interactive && (await confirm(`Provider validation failed (${message}). Continue anyway?`, false))) {
        // fall through — user accepts an unvalidated provider
      } else {
        throw new Error(`Provider validation failed: ${message}`);
      }
    }
  }

  config.provider.cloud = { baseUrl, model };
  secrets[isDeepseek ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'] = apiKey;
}

async function configureHybrid(
  config: FlowForgeConfig,
  options: SetupOptions,
  interactive: boolean,
  secrets: Record<string, string>
): Promise<void> {
  if (!interactive) {
    if (!config.provider.hybrid) {
      throw new Error(
        "hybrid provider requires an existing config.provider.hybrid mapping (run 'flowforge setup' interactively, or edit flowforge.config.json)"
      );
    }
  } else {
    const defaultMapping: HybridMapping = {
      small: { type: 'ollama', model: 'qwen2.5:3b' },
      medium: { type: 'ollama', model: 'llama3.2' },
      large: { type: 'cloud', model: 'gpt-4o' }
    };
    const mapping: HybridMapping = config.provider.hybrid ?? defaultMapping;
    const tiers = ['small', 'medium', 'large'] as const;
    for (const tier of tiers) {
      const current = mapping[tier];
      const type = await promptChoice<'ollama' | 'cloud'>(
        `Tier '${tier}' provider`,
        [
          { value: 'ollama', label: 'Ollama (local)' },
          { value: 'cloud', label: 'Cloud (OpenAI-compatible)' }
        ],
        current.type
      );
      const model = await promptText(`  '${tier}' model`, current.model);
      mapping[tier] = { type, model };
    }
    config.provider.hybrid = mapping;
  }

  const mapping = config.provider.hybrid!;
  const needsKey = [mapping.small, mapping.medium, mapping.large].some((tier) => tier.type === 'cloud');
  if (!needsKey) return;

  let apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  if (!apiKey && interactive) apiKey = (await prompt('API key for cloud tiers: ')).trim();
  if (!apiKey) throw new Error('Cloud tiers require an API key (--api-key or OPENAI_API_KEY)');

  if (!options.skipValidation) {
    const baseUrl = options.cloudBaseUrl ?? config.provider.cloud?.baseUrl ?? 'https://api.openai.com/v1';
    try {
      await validateCloudProvider(false, apiKey, baseUrl, mapping.large.model);
      console.log('  ✔ provider reachable');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (interactive && (await confirm(`Provider validation failed (${message}). Continue anyway?`, false))) {
        // fall through
      } else {
        throw new Error(`Provider validation failed: ${message}`);
      }
    }
  }
  secrets.OPENAI_API_KEY = apiKey;
}

async function configureVectorStore(
  config: FlowForgeConfig,
  options: SetupOptions,
  interactive: boolean,
  home: string
): Promise<void> {
  const previousDataDir = config.vectorStore.type === 'file' ? config.vectorStore.dataDir : join(home, '.flowforge');
  const previousChromaUrl = config.vectorStore.type === 'chroma' ? config.vectorStore.url : 'http://localhost:8000';

  const type =
    options.vectorStore ??
    (interactive
      ? await promptChoice<'file' | 'chroma'>(
          'Vector store',
          [
            { value: 'file', label: 'File-backed (default, no dependencies)' },
            { value: 'chroma', label: 'Chroma (requires Docker)' }
          ],
          config.vectorStore.type
        )
      : config.vectorStore.type);

  if (type === 'file') {
    const dataDir =
      options.dataDir ??
      (interactive ? await promptText('Data directory', previousDataDir) : previousDataDir);
    config.vectorStore = { type: 'file', dataDir };
    return;
  }

  const url =
    options.chromaUrl ?? (interactive ? await promptText('Chroma URL', previousChromaUrl) : previousChromaUrl);
  config.vectorStore = { type: 'chroma', url };

  const docker = checkDocker();
  if (docker.status !== 'ok' && interactive) console.warn(`  ⚠ ${docker.detail} ${docker.fix ?? ''}`.trim());
  if ((interactive && (await confirm('Start Chroma via Docker now?', false))) || (!interactive && options.apply)) {
    if (startChroma()) console.log('  ✔ Chroma started on http://localhost:8000');
    else console.warn('  ✘ failed to start Chroma via Docker (run `docker run -d -p 8000:8000 chromadb/chroma` manually)');
  }
}

async function configureIdentity(
  config: FlowForgeConfig,
  options: SetupOptions,
  interactive: boolean
): Promise<void> {
  const mode =
    options.identityMode ??
    (interactive
      ? await promptChoice<'dev' | 'oidc'>(
          'Identity',
          [
            { value: 'dev', label: 'Dev mock (no real sign-in)' },
            { value: 'oidc', label: 'OIDC device flow (production)' }
          ],
          config.identity.mode
        )
      : config.identity.mode);

  if (mode === 'dev') {
    config.identity = { mode: 'dev' };
    return;
  }

  const configPath =
    options.identityConfigPath ??
    (interactive
      ? await promptText('Path to OIDC identity config JSON', config.identity.mode === 'oidc' ? config.identity.configPath : undefined)
      : config.identity.mode === 'oidc'
        ? config.identity.configPath
        : undefined);
  if (!configPath) throw new Error('OIDC identity requires --oidc-config <path> (or a pre-existing config)');
  config.identity = { mode: 'oidc', configPath };
}

/** Upsert key=value pairs into a .env file, preserving unrelated lines. */
export function writeEnv(path: string, entries: Record<string, string>): void {
  const keys = new Set(Object.keys(entries));
  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    // no existing file
  }
  const kept = existing
    .split('\n')
    .filter((line) => {
      const match = /^([A-Z0-9_]+)=/.exec(line.trim());
      return !(match && keys.has(match[1]!));
    })
    .join('\n')
    .trim();
  const additions = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
  const body = kept.length > 0 ? `${kept}\n${additions.join('\n')}\n` : `${additions.join('\n')}\n`;
  writeFileSync(path, body, 'utf8');
  console.log(`✔ Wrote secrets to ${path}`);
}

export async function runSetup(options: SetupOptions = {}): Promise<number> {
  const interactive = !options.nonInteractive;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();

  if (interactive) {
    console.log('\nFlowForge setup — checking your environment first\n');
    printChecks(await doctorChecks({ ollamaUrl: options.ollamaUrl, cwd }));
  }

  const config =
    options.configPath && existsSync(options.configPath)
      ? loadConfig(options.configPath)
      : loadConfig(undefined, cwd, home);

  const providerType =
    options.provider ??
    (interactive
      ? await promptChoice<ProviderType>('Model provider', [
          { value: 'ollama', label: 'Ollama — local, free (recommended)' },
          { value: 'deepseek', label: 'DeepSeek — cloud API' },
          { value: 'openai', label: 'OpenAI-compatible — cloud API (OpenAI/Azure/Groq/Mistral/LM Studio)' },
          { value: 'hybrid', label: 'Hybrid — per-tier mapping (local + cloud)' }
        ], config.provider.type)
      : config.provider.type);
  config.provider.type = providerType;

  const secrets: Record<string, string> = {};

  if (providerType === 'ollama') {
    await configureOllama(config, options, interactive);
  } else if (providerType === 'deepseek' || providerType === 'openai') {
    await configureCloud(config, options, interactive, secrets);
  } else {
    await configureHybrid(config, options, interactive, secrets);
  }

  await configureVectorStore(config, options, interactive, home);
  await configureIdentity(config, options, interactive);

  const target = options.configPath ?? join(home, '.flowforge', 'config.json');
  saveConfig(config, target);
  console.log(`✔ Wrote config to ${target}`);

  if (Object.keys(secrets).length > 0) {
    writeEnv(join(cwd, '.env'), secrets);
  }

  console.log('\nSetup complete. Next steps:');
  console.log('  node packages/cli/dist/index.js validate fixtures/Grade7-Maths.workforce');
  console.log('  node packages/cli/dist/index.js run fixtures/Grade7-Maths.workforce assignment');
  return 0;
}
