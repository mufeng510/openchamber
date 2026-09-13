import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';
import { ProviderDiscoveryError } from './provider-models-discovery.js';

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    fsPromises: { mkdir: vi.fn(async () => undefined) },
    validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
    readSettingsFromDisk: vi.fn(async () => ({ projects: [] })),
    sanitizeProjects: (projects) => projects,
    persistSettings: vi.fn(async (settings) => settings),
    discoverProviderModels: vi.fn(() => Promise.reject(new Error('discoverProviderModels not stubbed'))),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('provider model discovery route', () => {
  it('requires a base URL', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/provider/models/discover')
      .send({})
      .expect(400);
    expect(response.body).toEqual({ error: 'Base URL is required', code: 'INVALID_URL' });
  });

  it('returns the discovered models', async () => {
    const discoverProviderModels = vi.fn(async () => [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
    ]);
    const { app } = createApp({ discoverProviderModels });

    const response = await request(app)
      .post('/api/provider/models/discover')
      .send({ baseURL: 'https://api.example.com/v1' })
      .expect(200);

    expect(response.body).toEqual({
      models: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
      ],
    });
    expect(discoverProviderModels).toHaveBeenCalledWith({
      baseURL: 'https://api.example.com/v1',
      apiKey: undefined,
      providerId: undefined,
      headers: undefined,
    });
  });

  it('forwards the key and provider id for edited providers', async () => {
    const discoverProviderModels = vi.fn(async () => []);
    const { app } = createApp({ discoverProviderModels });

    await request(app)
      .post('/api/provider/models/discover')
      .send({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        providerId: 'campus-llm',
        headers: { 'X-Campus': 'east' },
      })
      .expect(200);

    expect(discoverProviderModels).toHaveBeenCalledWith({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      providerId: 'campus-llm',
      headers: { 'X-Campus': 'east' },
    });
  });

  it('maps discovery error codes to statuses', async () => {
    const discoverProviderModels = vi.fn(() =>
      Promise.reject(new ProviderDiscoveryError('AUTH_FAILED', 'The provider rejected the credentials.')),
    );
    const { app } = createApp({ discoverProviderModels });

    const response = await request(app)
      .post('/api/provider/models/discover')
      .send({ baseURL: 'https://api.example.com/v1' })
      .expect(401);

    expect(response.body).toMatchObject({
      error: 'The provider rejected the credentials.',
      code: 'AUTH_FAILED',
    });
  });

  it('falls back to 500 for unexpected failures without swallowing the message', async () => {
    const discoverProviderModels = vi.fn(() =>
      Promise.reject(new Error('boom')),
    );
    const { app } = createApp({ discoverProviderModels });

    const response = await request(app)
      .post('/api/provider/models/discover')
      .send({ baseURL: 'https://api.example.com/v1' })
      .expect(500);

    expect(response.body).toMatchObject({ error: 'boom' });
  });
});