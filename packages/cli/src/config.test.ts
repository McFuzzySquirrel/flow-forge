import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoSecrets,
  defaultConfig,
  loadConfig,
  readConfigFile,
  saveConfig,
  userConfigPath,
  validateConfig,
  repoConfigPath,
  type FlowForgeConfig
} from './config.js';
function tempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'flowforge-config-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('config', () => {
  it('returns full defaults when no config file exists', () => {
    const { dir, cleanup } = tempHome();
    try {
      const config = loadConfig(undefined, join(dir, 'nope'), join(dir, 'home'));
      expect(config.provider.type).toBe('ollama');
      expect(config.provider.ollama).toEqual({
        url: 'http://localhost:11434',
        model: 'llama3.2',
        embeddingModel: 'nomic-embed-text'
      });
      expect(config.vectorStore.type).toBe('file');
      expect(config.identity.mode).toBe('dev');
    } finally {
      cleanup();
    }
  });

  it('round-trips a saved config through an explicit path', () => {
    const { dir, cleanup } = tempHome();
    try {
      const path = join(dir, 'config.json');
      const expected = defaultConfig();
      saveConfig(expected, path);
      expect(loadConfig(path)).toEqual(expected);
    } finally {
      cleanup();
    }
  });

  it('merges a partial config file over defaults', () => {
    const { dir, cleanup } = tempHome();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ provider: { type: 'deepseek' } }), 'utf8');
      const config = readConfigFile(path);
      expect(config.provider.type).toBe('deepseek');
      // untouched branches keep defaults
      expect(config.provider.ollama?.model).toBe('llama3.2');
      expect(config.vectorStore.type).toBe('file');
    } finally {
      cleanup();
    }
  });

  it('prefers the repo config over the user config', () => {
    const { dir, cleanup } = tempHome();
    try {
      const repo = join(dir, 'flowforge.config.json');
      const userHome = join(dir, 'home');
      writeFileSync(repo, JSON.stringify({ provider: { type: 'openai' } }), 'utf8');
      mkdirSync(join(userHome, '.flowforge'), { recursive: true });
      writeFileSync(userConfigPath(userHome), JSON.stringify({ provider: { type: 'deepseek' } }), 'utf8');
      expect(loadConfig(undefined, dir, userHome).provider.type).toBe('openai');
    } finally {
      cleanup();
    }
  });

  it('falls back to the user config when no repo config exists', () => {
    const { dir, cleanup } = tempHome();
    try {
      const userHome = join(dir, 'home');
      mkdirSync(join(userHome, '.flowforge'), { recursive: true });
      writeFileSync(userConfigPath(userHome), JSON.stringify({ provider: { type: 'hybrid', hybrid: { small: { type: 'ollama', model: 'qwen2.5:3b' }, medium: { type: 'ollama', model: 'llama3.2' }, large: { type: 'cloud', model: 'gpt-4o' } } } }), 'utf8');
      expect(loadConfig(undefined, join(dir, 'norepo'), userHome).provider.type).toBe('hybrid');
    } finally {
      cleanup();
    }
  });

  it('rejects config files containing secrets', () => {
    const { dir, cleanup } = tempHome();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ provider: { type: 'openai' }, apiKey: 'sk-123' }), 'utf8');
      expect(() => readConfigFile(path)).toThrow(/must not contain secrets/);
      expect(() => assertNoSecrets({ OPENAI_API_KEY: 'x' }, path)).toThrow(/OPENAI_API_KEY/);
    } finally {
      cleanup();
    }
  });

  it('refuses to save a config that contains secrets', () => {
    const { dir, cleanup } = tempHome();
    try {
      const path = join(dir, 'config.json');
      const leaked = defaultConfig();
      (leaked as unknown as { apiKey?: string }).apiKey = 'sk-123';
      expect(() => saveConfig(leaked, path)).toThrow(/must not contain secrets/);
    } finally {
      cleanup();
    }
  });

  it('rejects an unknown provider type and a missing hybrid mapping', () => {
    const bad = defaultConfig() as FlowForgeConfig;
    (bad.provider as { type: string }).type = 'unknown';
    expect(() => validateConfig(bad)).toThrow(/Unknown provider type/);
    const hybrid = defaultConfig() as FlowForgeConfig;
    hybrid.provider.type = 'hybrid';
    delete hybrid.provider.hybrid;
    expect(() => validateConfig(hybrid)).toThrow(/config.provider.hybrid/);
  });

  it('detects the repo config path relative to a cwd', () => {
    const { dir, cleanup } = tempHome();
    try {
      expect(repoConfigPath(dir)).toBe(join(dir, 'flowforge.config.json'));
    } finally {
      cleanup();
    }
  });
});
