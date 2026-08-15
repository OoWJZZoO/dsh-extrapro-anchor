/**
 * extrapro-anchor host-side Typert Remote bridge.
 *
 * The browser floating panel reads and writes the panel settings file through
 * the `extraproAnchorConfig.get/set` endpoints. Like dsh-read-image, this exists
 * because the api-proxy settings wire is allowlisted and answers
 * `settings-not-exposed` for plugin-owned namespaces — a plugin cannot expose
 * its own settings over that wire, but the Typert gateway auto-discovers any
 * Cordis service with a `typertRemote` binding plus @Remote markers.
 *
 * The module intentionally imports NOTHING from `@deepseek-ai/dsh-typert-protocol`:
 * the self-contained preset copy of lib/ has no node_modules to resolve that
 * package from, so a top-level import would take the preset boot down. The
 * caller passes the already-resolved protocol namespace in, and only builds the
 * class when the namespace exists.
 */

/** Most recently constructed bridge instance, for startup diagnostics. */
let serviceInstance = null

/** Return the live bridge instance (or null before construction). */
export function getExtraproAnchorConfigService() {
  return serviceInstance
}

/**
 * Apply a @Remote(...) marker without decorator syntax (same hand-rolled
 * `context.addInitializer` trick dsh-read-image uses; the Node runtime that
 * hosts dsh web runs without the decorators flag).
 */
function markRemote(protocol, instance, method, exportName) {
  const prototype = Object.getPrototypeOf(instance)
  const key = exportName ?? method
  if (!markRemote.seen) markRemote.seen = new WeakMap()
  let seen = markRemote.seen.get(prototype)
  if (seen === undefined) {
    seen = new Set()
    markRemote.seen.set(prototype, seen)
  }
  if (seen.has(key)) return
  seen.add(key)
  protocol.Remote(key)(instance[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      initializer.call(instance)
    },
  })
}

/**
 * Build the config-bridge Service class. Called by lib/index.js ONLY when the
 * typert protocol was resolvable, so the `extends` cannot hit undefined.
 *
 * @param protocol - the resolved `@deepseek-ai/dsh-typert-protocol` namespace.
 * @param store - the plugin instance's settings store (disk-backed).
 */
export function createExtraproAnchorConfigBridge(protocol, store) {
  const { TypertRemoteService } = protocol
  return class ExtraproAnchorConfigService extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'extraproAnchorConfig')
      markRemote(protocol, this, 'get', 'get')
      markRemote(protocol, this, 'set', 'set')
      serviceInstance = this
    }

    /** The effective settings the panel edits. */
    async get() {
      return { value: store.snapshot() }
    }

    /** Persist one full settings document atomically; invalid values throw. */
    async set(settings) {
      // The parameter NAME is part of the wire contract: the Typert gateway
      // derives the authoritative descriptor from this method's real parameter
      // names, and the browser bundle's contribution declares the same name
      // (`{ name: "settings", wire: "settings" }` in panel/client.js). Renaming
      // it here breaks every panel write with "arguments-invalid".
      const value = store.update(settings)
      return { ok: true, value }
    }
  }
}
