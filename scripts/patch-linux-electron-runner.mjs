#!/usr/bin/env node
// Linux Electron hosts must launch the DSH subprocess runner in Node mode.
//
// packages/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-*.js sets
// ELECTRON_RUN_AS_NODE=1 for the runner child only when
// (selection === WINDOWS_RUNNER_SELECTION && process.platform === 'win32').
// On Linux the Electron host therefore spawns `dsh-plugin-desktop <runner.js>`
// as a *GUI* process: the single-instance lock quits it immediately and the
// launch request is never consumed, so every tool call and every plugin install
// fails with "subprocess scope exited before its bootstrap consumed the launch
// request". Real node hosts (the dsh CLI) are unaffected because a plain node
// binary ignores the flag, so upstream never noticed.
//
// This script rewrites that guard so the flag is also injected on Linux, which
// is a no-op for non-Electron hosts. It runs before electron-builder so the
// patched dependency is what gets packed into app.asar.
//
// usage: node scripts/patch-linux-electron-runner.mjs <--write|--check>

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OLD_GUARD = 'WINDOWS_RUNNER_SELECTION && process.platform === "win32"'
const NEW_GUARD = 'WINDOWS_RUNNER_SELECTION || process.platform === "linux"'
const PKG_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh-subprocess-local']

const root = resolve(import.meta.dirname, '..')
const mode = process.argv[2]
if (mode !== '--write' && mode !== '--check') {
  console.error('usage: node scripts/patch-linux-electron-runner.mjs <--write|--check>')
  process.exit(2)
}
const fail = message => {
  console.error(`patch-linux-electron-runner: ${message}`)
  process.exit(1)
}

const appPackageNames = ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']

// Every install layout yarn may produce: hoisted, nested under the app package,
// or nested under a sibling dependency.
function candidateDirs() {
  const seeds = [
    join(root, ...PKG_SEGMENTS),
    ...appPackageNames.map(name => join(root, name, ...PKG_SEGMENTS)),
  ]
  const bases = [
    join(root, 'node_modules'),
    ...appPackageNames.map(name => join(root, name, 'node_modules')),
  ]
  for (const base of bases) {
    if (!existsSync(base)) continue
    for (const scope of readdirSync(base)) {
      if (!scope.startsWith('@')) continue
      const scopeDir = join(base, scope)
      for (const pkg of readdirSync(scopeDir)) {
        seeds.push(join(scopeDir, pkg, ...PKG_SEGMENTS))
      }
    }
  }
  return [...new Set(seeds)].filter(dir => existsSync(join(dir, 'lib')))
}

function runnerFiles(dir) {
  const lib = join(dir, 'lib')
  return readdirSync(lib)
    .filter(name => name.startsWith('runner-launch') && name.endsWith('.js'))
    .map(name => join(lib, name))
}

function patchedAsars() {
  const found = []
  const dist = join(root, 'dsh-plugin-desktop', 'dist')
  const candidates = [
    join(dist, 'linux-unpacked', 'resources', 'app.asar'),
    join(dist, 'linux-arm64-unpacked', 'resources', 'app.asar'),
  ]
  for (const file of candidates) if (existsSync(file) && statSync(file).isFile()) found.push(file)
  return found
}

if (mode === '--write') {
  const dirs = candidateDirs()
  if (dirs.length === 0) fail('no @deepseek-ai/dsh-subprocess-local install found; run yarn install first')
  let patched = 0
  let already = 0
  for (const dir of dirs) {
    const files = runnerFiles(dir)
    if (files.length === 0) fail(`no runner-launch chunk under ${dir}/lib`)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const oldCount = source.split(OLD_GUARD).length - 1
      if (oldCount === 0) {
        if (source.includes(NEW_GUARD)) {
          console.log(`already patched: ${file}`)
          already += 1
          continue
        }
        fail(`guard not found in ${file}; upstream renamed it, revisit this patch`)
      }
      if (oldCount !== 1) fail(`guard appears ${oldCount}x in ${file}; refusing to patch`)
      writeFileSync(file, source.replace(OLD_GUARD, NEW_GUARD))
      console.log(`patched: ${file}`)
      patched += 1
    }
  }
  if (patched === 0 && already === 0) fail('nothing patched')
  console.log(`patch-linux-electron-runner: ${patched} patched, ${already} already patched`)
}

if (mode === '--check') {
  const asars = patchedAsars()
  if (asars.length === 0) fail('no packaged app.asar under dsh-plugin-desktop/dist; build first')
  for (const file of asars) {
    const source = readFileSync(file)
    const stale = source.includes(Buffer.from(OLD_GUARD))
    const fixed = source.includes(Buffer.from(NEW_GUARD))
    if (stale || !fixed) {
      fail(`packaged asar is not patched (${file}); the Linux runner would boot as a GUI process`)
    }
    console.log(`ok: ${file}`)
  }
  console.log('patch-linux-electron-runner: packaged asar carries the Linux runner patch')
}
