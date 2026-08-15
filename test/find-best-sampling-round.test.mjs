import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'

import { projectKey, sessionsDirForCwd } from '../scripts/find-best-sampling-round.mjs'

test('projectKey encodes POSIX and Windows cwd the same way DSH persists them', () => {
  assert.equal(projectKey('/home/u/proj'), '--home-u-proj--')
  assert.equal(projectKey('/home/wanwe/global_workspace/agent/dsh-pro-ex-ability-anchor'), '--home-wanwe-global_workspace-agent-dsh-pro-ex-ability-anchor--')
  assert.equal(projectKey('C:\\Users\\u\\proj'), '--C-Users-u-proj--')
  assert.equal(projectKey('C:/Users/u/proj'), '--C-Users-u-proj--')
  assert.equal(projectKey('C:\\Users\\u\\my project'), '--C-Users-u-my~0020project--')
  assert.equal(projectKey('/'), '--root--')
  assert.throws(() => projectKey(''), /empty project path/)
})

test('sessionsDirForCwd joins the durable project key under the dsh sessions root', () => {
  assert.equal(
    sessionsDirForCwd('/home/u/proj', '/home/u/.dsh'),
    join('/home/u/.dsh', 'sessions', '--home-u-proj--'),
  )
  assert.equal(
    sessionsDirForCwd('C:\\Users\\u\\proj', 'D:\\dsh-home'),
    join('D:\\dsh-home', 'sessions', '--C-Users-u-proj--'),
  )
})
