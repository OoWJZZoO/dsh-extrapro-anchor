/**
 * anchor-seed runtime settings: the floating panel's host-side persistence.
 *
 * The panel edits four injected texts plus the injection on/off switch. Those
 * values are cached in the browser and written to this JSON file when the
 * panel is folded or when the next injection happens (the panel observes new
 * session ids and flushes first). The host plugin re-reads the file before
 * every fresh seed, so "the disk is the truth" — whatever was flushed last is
 * exactly what the next seed uses.
 *
 * This module keeps the same contract as lib/runtime.js: no Cordis imports,
 * only node builtins, fully unit-testable. The settings file is deliberately
 * NOT the shared guide file: the guide is per-seed transient state, while this
 * file is the user's durable configuration.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  DEFAULT_ELEVATION_NOTICE,
  DEFAULT_VIRTUAL_COMMAND_TEMPLATE,
  DEFAULT_VIRTUAL_REASONING_TEMPLATE,
  DEFAULT_VIRTUAL_USER_TEMPLATE,
} from './runtime.js'

/** Wire/schema version of the settings document. */
export const SETTINGS_VERSION = 1

/** The panel-editable keys, in display order. */
export const SETTINGS_KEYS = Object.freeze([
  'enabled',
  'elevationNotice',
  'virtualUserTemplate',
  'virtualReasoningTemplate',
  'virtualCommandTemplate',
])

/**
 * Built-in defaults the panel's "恢复默认" resets to. `enabled: false` is the
 * requested out-of-the-box posture: the panel is collapsed and injection is
 * OFF until the user turns it on. The self-contained preset (which ships no
 * panel) sets `enabled: true` in its composition row instead.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  enabled: false,
  elevationNotice: DEFAULT_ELEVATION_NOTICE,
  virtualUserTemplate: DEFAULT_VIRTUAL_USER_TEMPLATE,
  virtualReasoningTemplate: DEFAULT_VIRTUAL_REASONING_TEMPLATE,
  virtualCommandTemplate: DEFAULT_VIRTUAL_COMMAND_TEMPLATE,
})

/** A mutable copy of the built-in defaults. */
export function defaultSettings() {
  return { ...DEFAULT_SETTINGS }
}

/** Global settings file. Overridable for tests/deployments. */
export function settingsFilePath() {
  const override = process.env.DSH_ANCHOR_SEED_SETTINGS_PATH
  if (typeof override === 'string' && override.trim().length > 0) {
    return isAbsolute(override.trim()) ? override.trim() : resolve(override.trim())
  }
  const home = process.env.DSH_HOME
  const root = typeof home === 'string' && home.trim().length > 0 ? resolve(home.trim()) : join(homedir(), '.dsh')
  return join(root, 'storages', 'anchor-seed', 'settings.json')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a template value is usable: non-empty and carries `{path}`. */
export function isValidTemplate(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.includes('{path}')
}

/** Whether a notice value is usable: a non-empty string. */
export function isValidNotice(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Merge a raw settings document over the composition-row fallback, with the
 * built-in defaults as the final layer. Invalid stored values are dropped
 * instead of throwing: a hand-edited file degrades to a sensible value, and
 * the effective result is always seed-safe.
 */
export function effectiveSettings(raw, fallback = {}) {
  const record = isRecord(raw) ? raw : {}
  const base = isRecord(fallback) ? fallback : {}
  const pick = (key, valid) => {
    if (valid(record[key])) return record[key].trim()
    if (valid(base[key])) return base[key].trim()
    return DEFAULT_SETTINGS[key]
  }
  const enabled =
    typeof record.enabled === 'boolean'
      ? record.enabled
      : typeof base.enabled === 'boolean' ? base.enabled : DEFAULT_SETTINGS.enabled
  return {
    version: SETTINGS_VERSION,
    enabled,
    elevationNotice: pick('elevationNotice', isValidNotice),
    virtualUserTemplate: pick('virtualUserTemplate', isValidTemplate),
    virtualReasoningTemplate: pick('virtualReasoningTemplate', isValidTemplate),
    virtualCommandTemplate: pick('virtualCommandTemplate', isValidTemplate),
  }
}

/**
 * Validate a panel write and produce the next document. Unknown fields are
 * ignored (forward compatibility); invalid known fields throw with a concise
 * Chinese message that the panel can surface directly.
 */
export function normalizeSettingsUpdate(patch, current) {
  if (!isRecord(patch)) throw new Error('配置更新必须是对象')
  const next = { ...current }
  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw new Error('注入开关必须是开或关')
      next.enabled = value
      continue
    }
    if (typeof value !== 'string') throw new Error(`${labelOf(key)}格式不正确`)
    const trimmed = value.trim()
    if (key === 'elevationNotice') {
      if (trimmed.length === 0) throw new Error('引导说明不能为空')
      next.elevationNotice = trimmed
      continue
    }
    if (trimmed.length === 0 || !trimmed.includes('{path}')) {
      throw new Error(`${labelOf(key)}必须包含 {path}`)
    }
    next[key] = trimmed
  }
  return next
}

function labelOf(key) {
  switch (key) {
    case 'virtualUserTemplate': return '虚拟提问'
    case 'virtualReasoningTemplate': return '虚拟思考'
    case 'virtualCommandTemplate': return '注入命令'
    default: return key
  }
}

/** Create a directory one segment at a time; never throws, never blocks. */
function ensureDirSync(dir) {
  try {
    if (existsSync(dir)) return true
    const parent = dirname(dir)
    if (parent === dir || parent === '' || parent === '.') return false
    if (!ensureDirSync(parent)) return false
    mkdirSync(dir)
    return true
  } catch {
    return false
  }
}

/** Atomic-enough write: temp file in the same directory, then rename. */
export function saveSettingsFile(path, settings) {
  const dir = dirname(path)
  if (!ensureDirSync(dir)) throw new Error(`无法创建配置目录: ${dir}`)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    // Windows cannot always rename over an existing file; remove and retry.
    try {
      unlinkSync(path)
    } catch {
      // The destination may not exist yet — the rename below is authoritative.
    }
    renameSync(tmp, path)
  }
}

/**
 * Per-plugin-instance settings store. The file is re-read on mtime change, so
 * writes from another tab / another plugin instance / a hand edit are picked
 * up at the next seed without a restart.
 */
export function createSettingsStore({ path = settingsFilePath(), fallback = {} } = {}) {
  let cache = {
    mtimeMs: undefined,
    raw: undefined,
    effective: effectiveSettings(null, fallback),
    warnings: [],
  }

  const probe = () => {
    let mtimeMs = -1
    let text = null
    try {
      const stat = statSync(path)
      if (stat.isFile()) {
        mtimeMs = Number(stat.mtimeMs)
        text = readFileSync(path, 'utf8')
      }
    } catch {
      // Missing file (first run) or a transient stat/read failure: treat as absent.
    }
    return { mtimeMs, text }
  }

  const refresh = () => {
    const { mtimeMs, text } = probe()
    if (cache.mtimeMs !== undefined && mtimeMs === cache.mtimeMs) return cache.effective
    let raw = null
    const warnings = []
    if (text !== null) {
      try {
        raw = JSON.parse(text)
      } catch (error) {
        warnings.push(`anchor-seed: 配置文件解析失败，已使用默认值（${String((error && error.message) || error)}）`)
      }
    }
    cache = { mtimeMs, raw, effective: effectiveSettings(raw, fallback), warnings }
    return cache.effective
  }

  return {
    /** The effective settings, re-read from disk when the file changed. */
    snapshot() {
      return { ...refresh() }
    },

    /** Diagnostics from the last read (JSON errors, invalid stored fields). */
    warnings() {
      refresh()
      return [...cache.warnings]
    },

    /**
     * Validate and atomically persist a full next document. Returns the new
     * effective snapshot; throws on validation/IO failure so the Remote bridge
     * can report it to the panel.
     */
    update(patch) {
      const next = normalizeSettingsUpdate(patch, refresh())
      saveSettingsFile(path, next)
      cache = {
        mtimeMs: Number(statSync(path).mtimeMs),
        raw: next,
        effective: effectiveSettings(next, fallback),
        warnings: [],
      }
      return { ...cache.effective }
    },
  }
}
