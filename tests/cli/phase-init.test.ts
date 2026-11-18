import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url))
const roots: string[] = []

function project() {
  const root = mkdtempSync(join(tmpdir(), 'orca-phase-init-'))
  roots.push(root)
  mkdirSync(join(root, 'openspec/changes'), { recursive: true })
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
  const dir = (name: string) => join(root, 'openspec/changes', name)
  return { root, run, dir }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('phase.json creation (call path for createPhaseJson)', () => {
  it('orca phase init creates phase.json for an existing change', () => {
    const p = project()
    expect(p.run('intent', 'demo').status).toBe(0)
    expect(existsSync(join(p.dir('demo'), 'phase.json'))).toBe(false)
    const init = p.run('phase', 'init', 'demo')
    expect(init.status, init.stderr + init.stdout).toBe(0)
    const pj = JSON.parse(readFileSync(join(p.dir('demo'), 'phase.json'), 'utf8'))
    expect(pj.change_id).toBe('demo')
    expect(pj.current_phase).toBe('intent')
    expect(Object.values(pj.phases).every(ph => (ph as { status: string }).status === 'pending')).toBe(true)
  })

  it('orca intent --phase-json creates the change and its phase.json together', () => {
    const p = project()
    const result = p.run('intent', 'demo', '--phase-json')
    expect(result.status, result.stderr + result.stdout).toBe(0)
    expect(existsSync(join(p.dir('demo'), 'intent.md'))).toBe(true)
    expect(JSON.parse(readFileSync(join(p.dir('demo'), 'phase.json'), 'utf8')).change_id).toBe('demo')
  })

  it('plain orca intent stays as before: no phase.json, so existing flows keep working', () => {
    const p = project()
    expect(p.run('intent', 'demo').status).toBe(0)
    expect(existsSync(join(p.dir('demo'), 'phase.json'))).toBe(false)
  })

  it('refuses to overwrite an existing phase.json, an unknown change and a missing name', () => {
    const p = project()
    p.run('intent', 'demo', '--phase-json')
    const file = join(p.dir('demo'), 'phase.json')
    const before = readFileSync(file, 'utf8')
    writeFileSync(file, before.replace('"current_phase": "intent"', '"current_phase": "apply"'))
    const edited = readFileSync(file, 'utf8')
    const again = p.run('phase', 'init', 'demo')
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('already exists')
    expect(readFileSync(file, 'utf8')).toBe(edited)
    expect(p.run('phase', 'init', 'nope').status).toBe(1)
    expect(p.run('phase', 'init').status).toBe(1)
    expect(p.run('phase', 'bogus', 'demo').status).toBe(1)
  })

  it('a change without phase.json warns in degraded mode and names the real remedy', () => {
    const p = project()
    p.run('intent', 'demo')
    const gate = p.run('gate-code', 'demo')
    expect(gate.stderr).toContain('degraded mode')
    expect(gate.stderr).toContain('orca phase init demo')
    expect(gate.stderr).not.toContain('run orca init')
  })

  it('after phase init the guard enforces order and no longer warns about degraded mode', () => {
    const p = project()
    p.run('intent', 'demo', '--phase-json')
    const gate = p.run('gate-code', 'demo')
    expect(gate.status).toBe(1)
    expect(gate.stderr).not.toContain('degraded mode')
    expect(gate.stderr).toContain('cannot enter gate-code: apply not complete')
  })
})
