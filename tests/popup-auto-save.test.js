import test from 'node:test';
import assert from 'node:assert/strict';

import { STORAGE_KEYS } from '../src/translation-contracts.js';

const popupModuleUrl = new URL('../src/popup.js', import.meta.url);

function createMockElement(initial = {}) {
  const listeners = new Map();

  return {
    ...initial,
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    async dispatch(type, eventInit = {}) {
      const handlers = listeners.get(type) || [];
      const event = {
        type,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...eventInit
      };

      for (const handler of handlers) {
        await handler(event);
      }

      return event;
    }
  };
}

function createPopupDom() {
  const form = createMockElement();
  const statusEl = createMockElement({
    textContent: '',
    style: {
      color: ''
    }
  });
  const baseUrlInput = createMockElement({ value: '' });
  const apiKeyInput = createMockElement({ value: '' });
  const modelInput = createMockElement({ value: '' });

  const elements = {
    'popup-settings-form': form,
    status: statusEl,
    base_url: baseUrlInput,
    api_key: apiKeyInput,
    model: modelInput
  };

  const document = {
    getElementById(id) {
      return elements[id] || null;
    }
  };

  return {
    document,
    form,
    statusEl,
    baseUrlInput,
    apiKeyInput,
    modelInput
  };
}

function createStorageMock(initialStorage = {}) {
  const storage = {
    ...initialStorage
  };
  const calls = {
    get: [],
    set: []
  };

  return {
    storage,
    calls,
    sync: {
      async get(keys) {
        const requestedKeys = Array.isArray(keys) ? keys : [keys];
        calls.get.push(requestedKeys);

        const result = {};
        for (const key of requestedKeys) {
          result[key] = storage[key];
        }

        return result;
      },
      async set(payload) {
        calls.set.push(payload);
        Object.assign(storage, payload);
      }
    }
  };
}

async function flushMicrotasks(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

async function withPopupRuntime(initialStorage, callback) {
  const dom = createPopupDom();
  const storageMock = createStorageMock(initialStorage);
  const previousDocument = globalThis.document;
  const previousChrome = globalThis.chrome;

  globalThis.document = dom.document;
  globalThis.chrome = {
    storage: {
      sync: storageMock.sync
    }
  };

  try {
    await import(`${popupModuleUrl.href}?case=${Date.now()}-${Math.random()}`);
    await flushMicrotasks();

    return await callback({
      ...dom,
      storage: storageMock.storage,
      calls: storageMock.calls
    });
  } finally {
    await flushMicrotasks();

    if (typeof previousDocument === 'undefined') {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }

    if (typeof previousChrome === 'undefined') {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = previousChrome;
    }
  }
}

test('popup blur auto-saves changed valid provider settings', async () => {
  await withPopupRuntime(
    {
      [STORAGE_KEYS.BASE_URL]: 'https://api.example.com/v1',
      [STORAGE_KEYS.API_KEY]: 'token',
      [STORAGE_KEYS.MODEL]: 'qwen-mt-turbo'
    },
    async ({ modelInput, statusEl, calls, storage }) => {
      modelInput.value = ' qwen-mt-plus ';

      await modelInput.dispatch('blur');
      await flushMicrotasks();

      assert.equal(calls.set.length, 1);
      assert.deepEqual(calls.set[0], {
        [STORAGE_KEYS.BASE_URL]: 'https://api.example.com/v1',
        [STORAGE_KEYS.API_KEY]: 'token',
        [STORAGE_KEYS.MODEL]: 'qwen-mt-plus'
      });
      assert.equal(storage[STORAGE_KEYS.MODEL], 'qwen-mt-plus');
      assert.equal(statusEl.textContent, 'Settings auto-saved.');
      assert.equal(statusEl.style.color, '#17663e');
    }
  );
});

test('popup blur does not write unchanged provider settings', async () => {
  await withPopupRuntime(
    {
      [STORAGE_KEYS.BASE_URL]: 'https://api.example.com/v1',
      [STORAGE_KEYS.API_KEY]: 'token',
      [STORAGE_KEYS.MODEL]: 'qwen-mt-turbo'
    },
    async ({ baseUrlInput, statusEl, calls }) => {
      await baseUrlInput.dispatch('blur');
      await flushMicrotasks();

      assert.equal(calls.set.length, 0);
      assert.equal(statusEl.textContent, '');
    }
  );
});

test('popup blur with missing required fields shows validation status and skips write', async () => {
  await withPopupRuntime(
    {
      [STORAGE_KEYS.BASE_URL]: 'https://api.example.com/v1',
      [STORAGE_KEYS.API_KEY]: 'token',
      [STORAGE_KEYS.MODEL]: 'qwen-mt-turbo'
    },
    async ({ apiKeyInput, statusEl, calls }) => {
      apiKeyInput.value = '   ';

      await apiKeyInput.dispatch('blur');
      await flushMicrotasks();

      assert.equal(calls.set.length, 0);
      assert.equal(statusEl.textContent, 'Fill all fields to auto-save.');
      assert.equal(statusEl.style.color, '#c43f2f');
    }
  );
});

test('popup submit keeps manual save path working', async () => {
  await withPopupRuntime(
    {
      [STORAGE_KEYS.BASE_URL]: 'https://api.example.com/v1',
      [STORAGE_KEYS.API_KEY]: 'token',
      [STORAGE_KEYS.MODEL]: 'qwen-mt-turbo'
    },
    async ({ form, statusEl, calls }) => {
      const event = await form.dispatch('submit');
      await flushMicrotasks();

      assert.equal(event.defaultPrevented, true);
      assert.equal(calls.set.length, 1);
      assert.equal(statusEl.textContent, 'Settings saved.');
      assert.equal(statusEl.style.color, '#17663e');
    }
  );
});
