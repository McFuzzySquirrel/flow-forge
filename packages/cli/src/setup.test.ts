import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeIO, scriptAnswers } from './io.js';
import { loadConfig } from './config.js';
import { checkBuild, checkDeps, checkNode, runSetup, writeEnv, doctorChecks, type SetupOptions } from './setup.js';

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'flowforge-setup-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function baseOptions(dir: string, overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    nonInteractive: true,
    cwd: dir,
    home: dir,
    configPath: join(dir, 'config.json'),
    ...overrides
  };
}

describe('doctor checks', () => {
  it('reports node as ok on a supported runtime', () => {
    const major = Number.parseInt(process.version.slice(1).split('.')[0] ?? '', 10);
    expect(checkNode().status).toBe(major >= 20 ? 'ok' : 'fail');
  });

  it('flags a directory without node_modules', () => {
    const { dir, cleanup } = tempDir();
    try {
      expect(checkDeps(dir).status).toBe('fail');
      expect(checkDeps(dir).fix).toContain('pnpm install');
    } finally {
      cleanup();
    }
  });

  it('flags a directory without compiled packages', () => {
    const { dir, cleanup } = tempDir();
    try {
      expect(checkBuild(dir).status).toBe('warn');
      expect(checkBuild(dir).fix).toContain('pnpm build');
    } finally {
      cleanup();
    }
  });

  it('passes on the real repository root', () => {
    expect(checkDeps(process.cwd()).status).toBe('ok');
  });

  it('returns a full report from doctorChecks', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    try {
      const checks = await doctorChecks({ cwd: process.cwd() });
      const names = checks.map((c) => c.name);
      expect(names).toEqual(['node', 'pnpm', 'dependencies', 'build', 'ollama', 'docker']);
      for (const check of checks) expect(['ok', 'warn', 'fail']).toContain(check.status);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('writeEnv', () => {
  it('writes new keys and overwrites existing ones without duplicating', () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, '.env');
      writeEnv(file, { OPENAI_API_KEY: 'k1' });
      expect(readFileSync(file, 'utf8')).toContain('OPENAI_API_KEY=k1');
      writeEnv(file, { OPENAI_API_KEY: 'k2', DEEPSEEK_API_KEY: 'dk' });
      const content = readFileSync(file, 'utf8');
      expect(content).toContain('OPENAI_API_KEY=k2');
      expect(content).toContain('DEEPSEEK_API_KEY=dk');
      expect(content.split('OPENAI_API_KEY').length - 1).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('preserves unrelated lines', () => {
    const { dir, cleanup } = tempDir();
    try {
      const file = join(dir, '.env');
      writeFileSync(file, 'EXISTING=keep\n', 'utf8');
      writeEnv(file, { DEEPSEEK_API_KEY: 'dk' });
      expect(readFileSync(file, 'utf8')).toContain('EXISTING=keep');
    } finally {
      cleanup();
    }
  });
});

describe('runSetup — non-interactive', () => {
  it('writes an Ollama config from flags alone', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const options = baseOptions(dir, {
        provider: 'ollama',
        ollamaModel: 'qwen2.5:3b',
        dataDir: join(dir, 'data')
      });
      const code = await runSetup(options);
      expect(code).toBe(0);
      const config = loadConfig(options.configPath!);
      expect(config.provider.type).toBe('ollama');
      expect(config.provider.ollama?.model).toBe('qwen2.5:3b');
      expect(config.vectorStore.type).toBe('file');
      expect((config.vectorStore as { dataDir: string }).dataDir).toBe(join(dir, 'data'));
      expect(config.identity.mode).toBe('dev');
    } finally {
      cleanup();
    }
  });

  it('writes cloud config and secrets to .env, skipping live validation', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const options = baseOptions(dir, { provider: 'deepseek', apiKey: 'sk-test', skipValidation: true });
      const code = await runSetup(options);
      expect(code).toBe(0);
      const config = loadConfig(options.configPath!);
      expect(config.provider.type).toBe('deepseek');
      expect(config.provider.cloud?.baseUrl).toBe('https://api.deepseek.com');
      const env = readFileSync(join(options.cwd!, '.env'), 'utf8');
      expect(env).toContain('DEEPSEEK_API_KEY=sk-test');
    } finally {
      cleanup();
    }
  });

  it('fails fast when a cloud provider has no API key', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const options = baseOptions(dir, { provider: 'deepseek', skipValidation: true });
      await expect(runSetup(options)).rejects.toThrow(/API key/);
    } finally {
      cleanup();
    }
  });

  it('requires an existing hybrid mapping in non-interactive mode', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const options = baseOptions(dir, { provider: 'hybrid', skipValidation: true });
      await expect(runSetup(options)).rejects.toThrow(/provider.hybrid/);
    } finally {
      cleanup();
    }
  });

  it('keeps a pre-existing hybrid mapping in non-interactive mode', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const options = baseOptions(dir, { provider: 'hybrid', apiKey: 'sk-hybrid', skipValidation: true });
      const hybrid = {
        small: { type: 'ollama', model: 'qwen2.5:3b' },
        medium: { type: 'ollama', model: 'llama3.2' },
        large: { type: 'cloud', model: 'gpt-4o' }
      };
      writeFileSync(options.configPath!, JSON.stringify({ provider: { type: 'hybrid', hybrid } }), 'utf8');
      const code = await runSetup(options);
      expect(code).toBe(0);
      expect(loadConfig(options.configPath!).provider.hybrid).toEqual(hybrid);
    } finally {
      cleanup();
    }
  });
});

describe('runSetup — interactive', () => {
  it('accepts scripted answers via stdin', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const options = baseOptions(dir, { skipValidation: true });
      const answers = ['2', '', '', 'sk-interactive', '', '', ''];
      scriptAnswers(answers);
      const code = await runSetup({ ...options, nonInteractive: false });
      expect(code).toBe(0);
      const config = loadConfig(options.configPath!);
      expect(config.provider.type).toBe('deepseek');
      const env = readFileSync(join(options.cwd!, '.env'), 'utf8');
      expect(env).toContain('DEEPSEEK_API_KEY=sk-interactive');
    } finally {
      closeIO();
      cleanup();
    }
  });
});
