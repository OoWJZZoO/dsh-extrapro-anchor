/**
 * Environment self-check guard for anchor-seed (host side).
 *
 * The plugin's whole effect is appending synthetic session events and writing
 * one file into the project. Both ride on harness internals that can change
 * shape on upgrade. A plugin whose apply() throws, pends, or fails to import
 * takes the WHOLE harness down with it ("N entries did not activate" boot
 * audit), so the only safe failure mode is: apply() returns normally while
 * installing nothing — the plugin is inert, the harness runs.
 *
 * checkHostEnvironment() verifies the small set of harness contracts the
 * plugin touches. On failure the caller writes the full diagnostics to a log
 * file, logs ONE short bilingual notice, and returns before installing any
 * hook. Bypass with `guard.enabled: false` in the composition row config, or
 * force the failure path with DSH_ANCHOR_SEED_FORCE_GUARD_FAIL=1 (tests).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Where the full diagnostics of a failed self-check are written. */
export function guardLogPath() {
  return join(homedir(), '.dsh', 'logs', 'dsh-anchor-seed-guard.log')
}

/**
 * Create a directory one segment at a time (existsSync-checked, non-recursive
 * mkdir). NEVER use recursive mkdirSync here: on pseudo-filesystems such as
 * /proc it can HANG, and this function runs on the boot path — the guard
 * itself must never block the harness.
 */
function ensureDir(dir) {
  try {
    if (existsSync(dir)) return true
    const parent = dirname(dir)
    if (parent === dir || parent === '' || parent === '.') return false
    if (!ensureDir(parent)) return false
    mkdirSync(dir)
    return true
  } catch {
    return false
  }
}

/** Write the full self-check diagnostics; never throws, never blocks. */
export function writeGuardLog(problems, path = guardLogPath()) {
  if (!ensureDir(dirname(path))) return null
  try {
    const stamp = new Date().toISOString()
    const body = problems.map((p) => `- ${p.name}: ${p.detail}`).join('\n')
    writeFileSync(path, `[${stamp}] anchor-seed environment self-check FAILED\n${body}\n`, 'utf8')
    return path
  } catch {
    return null
  }
}

/** The ONE log line the user sees when the guard fails (bilingual). */
export function guardFailNotice(logPath) {
  const where = logPath || '<日志写入失败 / log write failed>'
  const zh =
    'anchor-seed 插件加载自检未通过，已取消加载流程，完整诊断日志已写入 ' + where + '。' +
    '若你清楚自己在做什么，可在 preset 组合行的 config 中将 guard.enabled 置为 false，跳过自检并强行加载插件。'
  const en =
    'anchor-seed plugin environment self-check FAILED and loading was cancelled; the full diagnostic log is at ' + where + '. ' +
    'If you know what you are doing, set guard.enabled to false in the composition row config to skip the self-check and force-load the plugin.'
  return zh + '\n' + en
}

/**
 * Verify every harness contract this plugin relies on. NEVER throws — every
 * probe is isolated. Reports ALL problems at once so a single upgrade can be
 * diagnosed in one log file.
 *
 * Runtime contracts that cannot be probed statically (the session `append`
 * surface metadata contract) are instead checked defensively at seed time:
 * any append failure degrades to a logged warning and the session continues
 * without the anchor — never a thrown hook.
 */
export function checkHostEnvironment(ctx) {
  const problems = []
  const probe = (name, detail, ok) => {
    let pass = false
    try {
      pass = Boolean(ok())
    } catch {
      pass = false
    }
    if (!pass) problems.push({ name, detail })
  }
  // cordis context surface (system-prompt/assemble is dispatched as a
  // waterfall; listener-style ctx.on callbacks with next() work for it, as
  // dsh-anchored-standard's tool-bootstrap demonstrates)
  probe('ctx.on', '插件事件机制缺失（system-prompt/assemble 钩子依赖它）', () => typeof ctx?.on === 'function')
  // cordis exposes ctx.logger as a CALLABLE (ctx.logger() creates a named
  // logger; ctx.logger.warn/error also exist) — typeof is 'function', not
  // 'object'. Accept either shape as long as the warn/error methods exist.
  probe(
    'ctx.logger',
    '日志服务缺失（降级告警依赖它）',
    () => {
      const logger = ctx?.logger
      return (typeof logger === 'function' || typeof logger === 'object')
        && typeof logger?.warn === 'function'
        && typeof logger?.error === 'function'
    },
  )
  return { ok: problems.length === 0, problems }
}
