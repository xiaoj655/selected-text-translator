import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProviderSettings,
  validateProviderSettings,
  readProviderSettings,
  saveProviderSettings,
  PROVIDER_STORAGE_KEYS,
  DEFAULT_PROVIDER_SETTINGS
} from '../src/provider-settings.js';
import { STORAGE_KEYS } from '../src/translation-contracts.js';

function withMockChrome(initialStorage, callback) {
  const storage = {
    ...initialStorage
  };
  const calls = {
    get: [],
    set: []
  };

  const previousChrome = globalThis.chrome;

  globalThis.chrome = {
    storage: {
      sync: {
        async get(keys) {
          calls.get.push(keys);
          const result = {};
          for (const key of keys) {
            result[key] = storage[key];
          }
          return result;
        },
        async set(payload) {
          calls.set.push(payload);
          Object.assign(storage, payload);
        }
      }
    }
  };

  return Promise.resolve(callback({ calls, storage })).finally(() => {
    if (typeof previousChrome === 'undefined') {
      delete globalThis.chrome;
      return;
    }

    globalThis.chrome = previousChrome;
  });
}

test('normalizeProviderSettings trims all provider values', () => {
  assert.deepEqual(
    normalizeProviderSettings({
      baseUrl: ' https://example.com/v1 ',
      apiKey: '  secret-key  ',
      model: '  qwen-mt-turbo  '
    }),
    {
      baseUrl: 'https://example.com/v1',
      apiKey: 'secret-key',
      model: 'qwen-mt-turbo'
    }
  );
});

test('validateProviderSettings reports missing required fields', () => {
  const result = validateProviderSettings({
    baseUrl: '  ',
    apiKey: 'x',
    model: ''
  });

  assert.equal(result.isValid, false);
  assert.deepEqual(result.missingFields, [
    STORAGE_KEYS.BASE_URL,
    STORAGE_KEYS.MODEL
  ]);
});

test('readProviderSettings reads and normalizes existing storage values', async () => {
  await withMockChrome(
    {
      [STORAGE_KEYS.BASE_URL]: ' https://api.example.com/v1 ',
      [STORAGE_KEYS.API_KEY]: ' abc123 ',
      [STORAGE_KEYS.MODEL]: ' qwen-mt-plus '
    },
    async ({ calls }) => {
      const settings = await readProviderSettings();

      assert.deepEqual(calls.get, [PROVIDER_STORAGE_KEYS]);
      assert.deepEqual(settings, {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'abc123',
        model: 'qwen-mt-plus'
      });
    }
  );
});

test('readProviderSettings falls back to default base_url and model when missing', async () => {
  await withMockChrome({}, async ({ calls }) => {
    const settings = await readProviderSettings();

    assert.deepEqual(calls.get, [PROVIDER_STORAGE_KEYS]);
    assert.deepEqual(settings, {
      baseUrl: DEFAULT_PROVIDER_SETTINGS.baseUrl,
      apiKey: '',
      model: DEFAULT_PROVIDER_SETTINGS.model
    });
  });
});

test('saveProviderSettings rejects empty values and does not write storage', async () => {
  await withMockChrome({}, async ({ calls }) => {
    const result = await saveProviderSettings({
      baseUrl: '',
      apiKey: 'token',
      model: 'model'
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFields, [STORAGE_KEYS.BASE_URL]);
    assert.equal(calls.set.length, 0);
  });
});

test('saveProviderSettings writes existing provider storage keys', async () => {
  await withMockChrome({}, async ({ calls, storage }) => {
    const result = await saveProviderSettings({
      baseUrl: ' https://api.example.com/v1 ',
      apiKey: ' secret ',
      model: ' qwen-mt-turbo '
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.set, [
      {
        [STORAGE_KEYS.BASE_URL]: 'https://api.example.com/v1',
        [STORAGE_KEYS.API_KEY]: 'secret',
        [STORAGE_KEYS.MODEL]: 'qwen-mt-turbo'
      }
    ]);
    assert.equal(storage[STORAGE_KEYS.BASE_URL], 'https://api.example.com/v1');
    assert.equal(storage[STORAGE_KEYS.API_KEY], 'secret');
    assert.equal(storage[STORAGE_KEYS.MODEL], 'qwen-mt-turbo');
  });
});
