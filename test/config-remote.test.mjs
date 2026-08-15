import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createExtraproAnchorConfigBridge, getExtraproAnchorConfigService } from '../lib/config-remote.js'
import { createSettingsStore, defaultSettings } from '../lib/settings.js'

/** Minimal Typert protocol double: Remote records markers, TypertRemoteService sets the binding name. */
function fakeProtocol() {
  const marked = []
  return {
    marked,
    Remote(name) {
      return (_method, context) => {
        marked.push(name)
        context.addInitializer(() => {})
      }
    },
    TypertRemoteService: class {
      constructor(ctx, name) {
        this.ctx = ctx
        this.name = name
      }
    },
  }
}

test('the bridge exposes extraproAnchorConfig.get/set and round-trips the settings store', async () => {
  const protocol = fakeProtocol()
  const dir = mkdtempSync(join(tmpdir(), 'extrapro-anchor-bridge-'))
  try {
    const store = createSettingsStore({ path: join(dir, 'settings.json') })
    const Bridge = createExtraproAnchorConfigBridge(protocol, store)
    const bridge = new Bridge({})

    assert.equal(getExtraproAnchorConfigService(), bridge)
    assert.equal(bridge.name, 'extraproAnchorConfig')
    assert.deepEqual(protocol.marked, ['get', 'set'])

    const initial = await bridge.get()
    assert.equal(initial.value.enabled, false)

    const next = { ...defaultSettings(), enabled: true, elevationNotice: '自定义' }
    const result = await bridge.set(next)
    assert.equal(result.ok, true)
    assert.equal(result.value.enabled, true)
    assert.equal(result.value.elevationNotice, '自定义')
    assert.equal(store.snapshot().enabled, true)

    await assert.rejects(() => bridge.set({ ...next, virtualCommandTemplate: 'missing placeholder' }), /\{path\}/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
