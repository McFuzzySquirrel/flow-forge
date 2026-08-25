import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider, OpenAICompatibleProvider } from './providers.js';

const originalFetch = globalThis.fetch;

function stubFetch(response: { status: number; body: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.body
  })) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;
  return fetchMock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('DeepSeekProvider', () => {
  it('posts to the DeepSeek chat completions endpoint with a Bearer key', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: { choices: [{ message: { content: 'hello from deepseek' } }] }
    });

    const provider = new DeepSeekProvider('sk-test-key');
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result.content).toBe('hello from deepseek');
    expect(result.model).toBe('deepseek-chat');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-test-key');
  });

  it('uses the requested model when one is provided', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: { choices: [{ message: { content: 'ok' } }] }
    });

    const provider = new DeepSeekProvider('sk-test-key');
    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'deepseek-reasoner'
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init!.body as string).model).toBe('deepseek-reasoner');
  });

  it('throws on a non-OK response', async () => {
    stubFetch({ status: 401, body: {} });

    const provider = new DeepSeekProvider('sk-test-key');
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('Model request failed: 401');
  });
});

describe('OpenAICompatibleProvider', () => {
  it('posts to the given base URL chat completions endpoint', async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: { choices: [{ message: { content: 'ok' } }] }
    });

    const provider = new OpenAICompatibleProvider('https://api.openai.com/v1', 'sk-test', 'gpt-4o-mini');
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });
});
