import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

const SECRET_KEY = /api[_-]?key|secret|token|password/i;

export function repoConfigPath(cwd = process.cwd()): string {
  return join(cwd, 'flowforge.config.json');
}

export function userConfigPath(home = homedir()): string {
  return join(home, '.flowforge', 'config.json');
}

export function defaultConfig(): FlowForgeConfig {
  return {
    provider: {
      type: 'ollama',
      ollama: { url: 'http://localhost:11434', model: 'llama3.2', embeddingModel: 'nomic-embed-text' }
    },
    vectorStore: { type: 'file', dataDir: join(homedir(), '.flowforge') },
    identity: { mode: 'dev' }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge plain object graphs; overrides win, undefined values are skipped. */
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

/** Config files must never hold credentials; secrets live in env vars / .env. */
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

export function readConfigFile(path: string): FlowForgeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Invalid config file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertNoSecrets(raw, path);
  return validateConfig(merge(defaultConfig(), raw));
}

/**
 * Load config: explicit path > repo flowforge.config.json > user
 * ~/.flowforge/config.json > defaults.
 */
export function loadConfig(
  explicitPath?: string,
  cwd = process.cwd(),
  home = homedir()
): FlowForgeConfig {
  if (explicitPath) return readConfigFile(explicitPath);
  const repo = repoConfigPath(cwd);
  if (existsSync(repo)) return readConfigFile(repo);
  const user = userConfigPath(home);
  if (existsSync(user)) return readConfigFile(user);
  return defaultConfig();
}

export function saveConfig(config: FlowForgeConfig, path: string): void {
  assertNoSecrets(config, path);
  validateConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
