export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
}

export interface CompletionResponse {
  content: string;
  model: string;
}

/**
 * Provider abstraction so a package can declare model needs per agent
 * ("Assessment needs a strong model, Coach can run on a small local one")
 * and deployments can map tiers to Ollama, an OpenAI-compatible API, or mocks.
 */
export interface ModelProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** Deterministic provider for tests and offline development. */
export class MockModelProvider implements ModelProvider {
  readonly name = 'mock';
  constructor(private readonly responder: (request: CompletionRequest) => string) {}
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return { content: this.responder(request), model: 'mock' };
  }
}

/** Local models via the Ollama HTTP API. */
export class OllamaProvider implements ModelProvider {
  readonly name = 'ollama';
  constructor(
    private readonly baseUrl = 'http://localhost:11434',
    private readonly defaultModel = 'llama3.2'
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.defaultModel;
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: request.messages,
        stream: false,
        options: request.temperature !== undefined ? { temperature: request.temperature } : undefined
      })
    });
    if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
    const data = (await response.json()) as { message: { content: string } };
    return { content: data.message.content, model };
  }
}

/** Cloud models via any OpenAI-compatible chat completions API. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultModel: string
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.defaultModel;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model, messages: request.messages, temperature: request.temperature })
    });
    if (!response.ok) throw new Error(`Model request failed: ${response.status}`);
    const data = (await response.json()) as { choices: { message: { content: string } }[] };
    return { content: data.choices[0]?.message.content ?? '', model };
  }
}

export type ModelTier = 'small' | 'medium' | 'large';

/** Maps agent model tiers to concrete providers. Deployment-specific. */
export class ModelRegistry {
  private providers = new Map<ModelTier, ModelProvider>();

  set(tier: ModelTier, provider: ModelProvider): this {
    this.providers.set(tier, provider);
    return this;
  }

  get(tier: ModelTier): ModelProvider {
    const provider = this.providers.get(tier);
    if (!provider) throw new Error(`No model provider registered for tier '${tier}'`);
    return provider;
  }
}
