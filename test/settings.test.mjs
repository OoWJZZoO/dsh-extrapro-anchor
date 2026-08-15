import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  createSettingsStore,
  defaultSettings,
  effectiveSettings,
  normalizeSettingsUpdate,
  saveSettingsFile,
  settingsFilePath,
} from '../lib/settings.js'

test('default settings are OFF with the four built-in injected texts', () => {
  const settings = defaultSettings()
  assert.equal(settings.enabled, false)
  assert.equal(DEFAULT_SETTINGS.enabled, false)
  for (const key of ['elevationNotice', 'virtualUserTemplate', 'virtualReasoningTemplate', 'virtualCommandTemplate']) {
    assert.equal(typeof settings[key], 'string')
    assert.ok(settings[key].length > 0)
  }
  for (const key of SETTINGS_KEYS.slice(2)) {
    assert.ok(settings[key].includes('{path}'))
  }
})

test('settingsFilePath: DSH_EXTRAPRO_ANCHOR_SETTINGS_PATH wins, DSH_HOME is the default root', () => {
  const previous = process.env.DSH_EXTRAPRO_ANCHOR_SETTINGS_PATH
  const previousHome = process.env.DSH_HOME
  try {
    process.env.DSH_EXTRAPRO_ANCHOR_SETTINGS_PATH = '/tmp/custom/anchor.json'
    assert.equal(settingsFilePath(), '/tmp/custom/anchor.json')
    delete process.env.DSH_EXTRAPRO_ANCHOR_SETTINGS_PATH
    process.env.DSH_HOME = '/tmp/dsh-home'
    assert.equal(settingsFilePath(), join('/tmp/dsh-home', 'storages', 'extrapro-anchor', 'settings.json'))
  } finally {
    if (previous === undefined) delete process.env.DSH_EXTRAPRO_ANCHOR_SETTINGS_PATH
    else process.env.DSH_EXTRAPRO_ANCHOR_SETTINGS_PATH = previous
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('effectiveSettings: raw document overrides fallback and invalid values degrade', () => {
  const fallback = {
    enabled: true,
    elevationNotice: 'row notice',
    virtualUserTemplate: 'row {path}',
    virtualReasoningTemplate: 'row {path}',
    virtualCommandTemplate: 'row {path}',
  }
  const effective = effectiveSettings({
    enabled: false,
    elevationNotice: 'panel notice',
    virtualCommandTemplate: 'panel {path}',
    virtualUserTemplate: 'no placeholder',
  }, fallback)
  assert.equal(effective.enabled, false)
  assert.equal(effective.elevationNotice, 'panel notice')
  assert.equal(effective.virtualCommandTemplate, 'panel {path}')
  // Invalid stored value falls back to the row value, then to the built-in.
  assert.equal(effective.virtualUserTemplate, 'row {path}')
  assert.equal(effective.virtualReasoningTemplate, 'row {path}')

  const allDefaults = effectiveSettings(null, {})
  assert.deepEqual(allDefaults, DEFAULT_SETTINGS)
})

test('normalizeSettingsUpdate: validates the panel-editable fields', () => {
  const current = defaultSettings()
  const next = normalizeSettingsUpdate({
    enabled: true,
    elevationNotice: ' 自定义 ',
    virtualUserTemplate: '读 {path}',
    virtualReasoningTemplate: '想 {path}',
    virtualCommandTemplate: 'cat {path}',
    unknownFutureField: 'ignored',
  }, current)
  assert.equal(next.enabled, true)
  assert.equal(next.elevationNotice, '自定义')
  assert.equal(next.virtualUserTemplate, '读 {path}')
  assert.equal(Object.hasOwn(next, 'unknownFutureField'), false)

  assert.throws(() => normalizeSettingsUpdate({ enabled: 'on' }, current), /注入开关/)
  assert.throws(() => normalizeSettingsUpdate({ elevationNotice: '   ' }, current), /引导说明/)
  assert.throws(() => normalizeSettingsUpdate({ virtualUserTemplate: 'missing placeholder' }, current), /虚拟提问/)
  assert.throws(() => normalizeSettingsUpdate({ virtualReasoningTemplate: '' }, current), /虚拟思考/)
  assert.throws(() => normalizeSettingsUpdate({ virtualCommandTemplate: null }, current), /注入命令/)
  assert.throws(() => normalizeSettingsUpdate(null, current), /对象/)
})

test('createSettingsStore: update persists atomically and later reads see the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extrapro-anchor-settings-'))
  const path = join(dir, 'settings.json')
  try {
    const store = createSettingsStore({ path, fallback: { enabled: true } })
    assert.equal(store.snapshot().enabled, true) // no file → row fallback

    store.update({ enabled: false, elevationNotice: 'first', virtualUserTemplate: 'u {path}', virtualReasoningTemplate: 'r {path}', virtualCommandTemplate: 'c {path}' })
    assert.equal(store.snapshot().enabled, false)
    assert.match(readFileSync(path, 'utf8'), /"enabled": false/)

    // Simulate another tab / panel flush writing the file directly.
    const written = { ...defaultSettings(), enabled: true, elevationNotice: 'second' }
    saveSettingsFile(path, written)
    const now = new Date(Date.now() + 2000)
    utimesSync(path, now, now)
    assert.equal(store.snapshot().enabled, true)
    assert.equal(store.snapshot().elevationNotice, 'second')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createSettingsStore: a corrupt file degrades to defaults with a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extrapro-anchor-settings-'))
  const path = join(dir, 'settings.json')
  try {
    writeFileSync(path, '{not json', 'utf8')
    const store = createSettingsStore({ path })
    assert.equal(store.snapshot().enabled, false)
    assert.equal(store.warnings().length, 1)
    assert.match(store.warnings()[0], /解析失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createSettingsStore: update rejects invalid drafts without touching the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extrapro-anchor-settings-'))
  const path = join(dir, 'settings.json')
  try {
    const store = createSettingsStore({ path })
    store.update(defaultSettings())
    assert.throws(() => store.update({ virtualCommandTemplate: 'no placeholder' }), /\{path\}/)
    assert.equal(store.snapshot().virtualCommandTemplate, DEFAULT_SETTINGS.virtualCommandTemplate)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
