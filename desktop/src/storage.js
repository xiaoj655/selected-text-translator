import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SECRET_PREFIX = 'enc:v1:'
let cryptoTransform = null

export function setCrypto(transform) {
  cryptoTransform = transform
}

function encode(key, value) {
  if (key !== 'api_key' || typeof value !== 'string' || !cryptoTransform?.encrypt) return value
  return SECRET_PREFIX + cryptoTransform.encrypt(value)
}

function decode(key, value) {
  if (typeof value !== 'string' || !value.startsWith(SECRET_PREFIX)) return value
  if (!cryptoTransform?.decrypt) return ''
  try {
    return cryptoTransform.decrypt(value.slice(SECRET_PREFIX.length))
  } catch {
    return ''
  }
}

export function createStorage(userDataDir) {
  const listeners = new Set()
  const stores = new Map()

  function emit(changes, areaName) {
    for (const fn of listeners) {
      try {
        fn(changes, areaName)
      } catch {
        // a failing listener must not break storage writes
      }
    }
  }

  function store(areaName) {
    if (stores.has(areaName)) return stores.get(areaName)
    const file = join(userDataDir, `${areaName}.json`)
    let data = {}
    try {
      if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      data = {}
    }

    function flush() {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(data, null, 2))
    }

    const api = {
      async get(keys) {
        const defaults = keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : null
        const names = keys == null ? Object.keys(data)
          : Array.isArray(keys) ? keys
            : typeof keys === 'string' ? [keys]
              : Object.keys(keys)
        const result = {}
        for (const name of names) {
          if (Object.hasOwn(data, name)) result[name] = decode(name, structuredClone(data[name]))
          else if (defaults && Object.hasOwn(defaults, name)) result[name] = structuredClone(defaults[name])
        }
        return result
      },
      async set(items) {
        const changes = {}
        for (const [name, value] of Object.entries(items)) {
          const oldValue = Object.hasOwn(data, name) ? decode(name, data[name]) : undefined
          data[name] = encode(name, value)
          changes[name] = { oldValue, newValue: value }
        }
        flush()
        emit(changes, areaName)
      },
      async remove(keys) {
        const names = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : [keys]
        const changes = {}
        for (const name of names) {
          if (!Object.hasOwn(data, name)) continue
          changes[name] = { oldValue: decode(name, data[name]) }
          delete data[name]
        }
        if (!Object.keys(changes).length) return
        flush()
        emit(changes, areaName)
      },
    }
    stores.set(areaName, api)
    return api
  }

  return {
    sync: store('sync'),
    local: store('local'),
    onChangedSubscribe(fn) {
      listeners.add(fn)
    },
  }
}
