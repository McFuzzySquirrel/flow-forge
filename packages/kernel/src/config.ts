import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DeepSeekProvider,
  ModelRegistry,
  OllamaProvider,
  OpenAICompatibleProvider,
  type ModelProvider
} from '@flowforge/agents';

export type ProviderType = 'ollama' | 'deepseek' | 'openai' | 'hybrid';

export interface TierSpec {
  type: 'ollama' | 'cloud';
  model: string;
}

export interface HybridMapping {
  small: TierSpec;
  medium: TierSpec;
  large: TierSpec;
}

export interface OllamaProviderConfig {
  url: string;
  model: string;
  embeddingModel: string;
}

export interface CloudProviderConfig {
  baseUrl: string;
  model: string;
}

export interface FlowForgeConfig {
  provider: {
    type: ProviderType;
    ollama?: OllamaProviderConfig;
    cloud?: CloudProviderConfig;
    hybrid?: HybridMapping;
  };
  vectorStore: { type: 'file'; dataDir: string } | { type: 'chroma'; url: string };
  identity: { mode: 'dev' } | { mode: 'oidc'; configPath: string };
}

export interface ModelConfigSnapshot {
  configPath?: string;
  provider: FlowForgeConfig['provider'];
  warning?: string;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const SECRET_KEY = /api[_-]?key|secret|token|password/i;

export function repoConfigPath(cwd = process.cwd()): string {
  return join(cwd, 'flowforge.config.json');
}

export function userConfigPath(home = homedir()): string {
  return join(home, '.flowforge', 'config.json');
}

export function defaultConfig(home = homedir()): FlowForgeConfig {
  return {
    provider: {
      type: 'ollama',
      ollama: { url: 'http://localhost:11434', model: 'llama3.2', embeddingModel: 'nomic-embed-text' }
    },
    vectorStore: { type: 'file', dataDir: join(home, '.flowforge') },
    identity: { mode: 'dev' }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge<T>(base: T, overrides: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overrides)) return (overrides ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const existing = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(existing) ? merge(existing, value) : value;
  }
  return out as T;
}

export function assertNoSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item, path);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(
        `Config file ${path} must not contain secrets (found key '${key}'); use environment variables or a .env file instead.`
      );
    }
    assertNoSecrets(entry, path);
  }
}

export function validateConfig(config: FlowForgeConfig): FlowForgeConfig {
  const providers: ProviderType[] = ['ollama', 'deepseek', 'openai', 'hybrid'];
  if (!providers.includes(config.provider.type)) {
    throw new Error(`Unknown provider type '${config.provider.type}'`);
  }
  if (config.provider.type === 'hybrid' && !config.provider.hybrid) {
    throw new Error("hybrid provider requires config.provider.hybrid (run 'flowforge setup' to generate it)");
  }
  const vectorStoreType = (config.vectorStore as { type: string }).type;
  if (vectorStoreType !== 'file' && vectorStoreType !== 'chroma') {
    throw new Error(`Unknown vectorStore type '${vectorStoreType}'`);
  }
  const identityMode = (config.identity as { mode: string }).mode;
  if (identityMode !== 'dev' && identityMode !== 'oidc') {
    throw new Error(`Unknown identity mode '${identityMode}'`);
  }
  return config;
}

export function readConfigFile(path: string, home = homedir()): FlowForgeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Invalid config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertNoSecrets(raw, path);
  return validateConfig(merge(defaultConfig(home), raw));
}

export function loadConfig(
  explicitPath?: string,
  cwd = process.cwd(),
  home = homedir()
): FlowForgeConfig {
  if (explicitPath) return readConfigFile(explicitPath, home);
  const repo = repoConfigPath(cwd);
  if (existsSync(repo)) return readConfigFile(repo, home);
  const user = userConfigPath(home);
  if (existsSync(user)) return readConfigFile(user, home);
  return defaultConfig(home);
}

export function saveConfig(config: FlowForgeConfig, path: string): void {
  assertNoSecrets(config, path);
  validateConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function resolveProvider(
  providerName: string | undefined,
  apiKey: string | undefined,
  config: FlowForgeConfig,
  env: NodeJS.ProcessEnv
): ModelProvider {
  switch (providerName) {
    case 'deepseek': {
      const key = apiKey ?? env.DEEPSEEK_API_KEY;
      if (!key) throw new Error('DeepSeek requires an API key (--api-key or DEEPSEEK_API_KEY)');
      return new DeepSeekProvider(key, config.provider.cloud?.model ?? 'deepseek-chat');
    }
    case 'openai': {
      const key = apiKey ?? env.OPENAI_API_KEY;
      if (!key) throw new Error('OpenAI requires an API key (--api-key or OPENAI_API_KEY)');
      return new OpenAICompatibleProvider(
        config.provider.cloud?.baseUrl ?? 'https://api.openai.com/v1',
        key,
        config.provider.cloud?.model ?? 'gpt-4o-mini'
      );
    }
    case undefined:
    case 'ollama':
      return new OllamaProvider(
        config.provider.ollama?.url ?? 'http://localhost:11434',
        config.provider.ollama?.model ?? 'llama3.2'
      );
    case 'hybrid':
      throw new Error("'hybrid' is resolved per tier; configure a hybrid mapping instead");
    default:
      throw new Error(`Unknown provider '${providerName}' (expected 'ollama', 'deepseek', 'openai' or 'hybrid')`);
  }
}

export function resolveModelRegistry(
  providerName: string | undefined,
  apiKey: string | undefined,
  config: FlowForgeConfig,
  env: NodeJS.ProcessEnv = process.env
): ModelRegistry {
  const name = providerName ?? env.FLOWFORGE_PROVIDER ?? config.provider.type;
  const registry = new ModelRegistry();
  if (name === 'hybrid') {
    const hybrid = config.provider.hybrid;
    if (!hybrid) throw new Error("'hybrid' selected but config.provider.hybrid is missing (run 'flowforge setup')");
    const key = apiKey ?? env.OPENAI_API_KEY;
    for (const tier of ['small', 'medium', 'large'] as const) {
      const spec = hybrid[tier];
      if (spec.type === 'ollama') {
        registry.set(tier, new OllamaProvider(config.provider.ollama?.url ?? 'http://localhost:11434', spec.model));
      } else {
        if (!key) throw new Error('Cloud tier requires an API key (--api-key or OPENAI_API_KEY)');
        registry.set(
          tier,
          new OpenAICompatibleProvider(
            config.provider.cloud?.baseUrl ?? 'https://api.openai.com/v1',
            key,
            spec.model
          )
        );
      }
    }
    return registry;
  }
  const provider = resolveProvider(name, apiKey, config, env);
  return registry.set('small', provider).set('medium', provider).set('large', provider);
}
