import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reset the @rag-system/shared module between tests so each test sees its own
// freshly-evaluated config built from the env vars the test sets.
function resetSharedModule() {
  vi.resetModules();
}

describe('createChatBackend — backend selector', () => {
  beforeEach(() => {
    resetSharedModule();
    delete process.env.LLM_BACKEND;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.LLM_URL;
  });
  afterEach(() => {
    delete process.env.LLM_BACKEND;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.LLM_URL;
  });

  it('returns OllamaClient when LLM_BACKEND=ollama', async () => {
    process.env.LLM_BACKEND = 'ollama';
    const { createChatBackend } = await import('../backend.js');
    const { OllamaClient } = await import('../ollama-client.js');
    expect(createChatBackend()).toBeInstanceOf(OllamaClient);
  });

  it('returns LlamaSwapClient when LLM_BACKEND=llamacpp', async () => {
    process.env.LLM_BACKEND = 'llamacpp';
    const { createChatBackend } = await import('../backend.js');
    const { LlamaSwapClient } = await import('../llamaswap-client.js');
    expect(createChatBackend()).toBeInstanceOf(LlamaSwapClient);
  });

  it('default (no env) returns OllamaClient (backwards-compat until v1.32-d Phase F)', async () => {
    const { createChatBackend } = await import('../backend.js');
    const { OllamaClient } = await import('../ollama-client.js');
    expect(createChatBackend()).toBeInstanceOf(OllamaClient);
  });

  it('uses the explicit override if passed', async () => {
    process.env.LLM_BACKEND = 'llamacpp';
    const { createChatBackend } = await import('../backend.js');
    const { OllamaClient } = await import('../ollama-client.js');
    const override = new OllamaClient('http://override');
    expect(createChatBackend(override)).toBe(override);
  });
});

describe('createEmbedBackend — embed backend selector', () => {
  beforeEach(() => {
    resetSharedModule();
    delete process.env.LLM_BACKEND;
    delete process.env.EMBED_BACKEND;
  });
  afterEach(() => {
    delete process.env.LLM_BACKEND;
    delete process.env.EMBED_BACKEND;
  });

  it('mirrors LLM_BACKEND when EMBED_BACKEND is unset', async () => {
    process.env.LLM_BACKEND = 'llamacpp';
    const { createEmbedBackend } = await import('../backend.js');
    const { LlamaSwapClient } = await import('../llamaswap-client.js');
    expect(createEmbedBackend()).toBeInstanceOf(LlamaSwapClient);
  });

  it('hybrid mode: LLM_BACKEND=llamacpp + EMBED_BACKEND=ollama → OllamaClient for embed', async () => {
    process.env.LLM_BACKEND = 'llamacpp';
    process.env.EMBED_BACKEND = 'ollama';
    const { createEmbedBackend } = await import('../backend.js');
    const { OllamaClient } = await import('../ollama-client.js');
    expect(createEmbedBackend()).toBeInstanceOf(OllamaClient);
  });
});
