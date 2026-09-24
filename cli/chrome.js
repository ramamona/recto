// Minimal Chrome DevTools Protocol driver over --remote-debugging-pipe (stdlib only).
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const FLAGS = [
  '--headless=new',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--font-render-hinting=none'
]

const LOAD_TIMEOUT = 30000

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function candidates() {
  const env = process.env
  if (process.platform === 'darwin') {
    return ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser']
      .map(app => `/Applications/${app}.app/Contents/MacOS/${app}`)
  }
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    const exes = ['Google\\Chrome\\Application\\chrome.exe', 'Chromium\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']
    return exes.flatMap(exe => roots.map(root => `${root}\\${exe}`))
  }
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
    .flatMap(name => dirs.map(dir => join(dir, name)))
}

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  return candidates().find(isExecutable) ?? null
}

export function countPdfPages(buf) {
  return (buf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length
}

export async function launch({ executable = findChrome(), args = [] } = {}) {
  if (!executable) throw new Error('Chrome/Chromium not found. Install it or set CHROME_PATH.')
  const profile = await mkdtemp(join(tmpdir(), 'recto-chrome-'))
  const proc = spawn(executable, [...FLAGS, `--user-data-dir=${profile}`, ...args], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
  })
  const toChrome = proc.stdio[3]
  const fromChrome = proc.stdio[4]
  const pending = new Map()
  const waiters = new Set()
  let nextId = 0
  let dead = null
  let stderr = ''

  const exited = new Promise(done => {
    const die = reason => {
      if (dead) return
      dead = new Error(`${reason}${stderr ? `\n${stderr.trim()}` : ''}`)
      for (const p of pending.values()) p.reject(dead)
      for (const w of waiters) w.fail(dead)
      pending.clear()
      done()
    }
    proc.once('error', err => die(`Could not start ${executable}: ${err.message}`))
    proc.once('exit', (code, signal) => die(`Chrome exited (${signal ?? code})`))
  })
  proc.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  // Write errors (EPIPE) surface through the exit/error handlers above
  toChrome.on('error', () => {})
  fromChrome.on('error', () => {})

  function dispatch(msg) {
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    for (const w of waiters) if (w.method === msg.method && w.sessionId === msg.sessionId) w.done(msg.params)
  }

  // Messages are NUL-delimited; collect parts so large payloads (PDF base64) stay linear
  let parts = []
  fromChrome.setEncoding('utf8').on('data', chunk => {
    let start = 0
    let end
    while ((end = chunk.indexOf('\0', start)) !== -1) {
      parts.push(chunk.slice(start, end))
      dispatch(JSON.parse(parts.join('')))
      parts = []
      start = end + 1
    }
    if (start < chunk.length) parts.push(chunk.slice(start))
  })

  function send(method, params = {}, sessionId) {
    if (dead) return Promise.reject(dead)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method })
      toChrome.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0')
    })
  }

  function waitFor(method, sessionId, ms) {
    return new Promise((resolve, reject) => {
      const settle = fn => value => {
        clearTimeout(timer)
        waiters.delete(w)
        fn(value)
      }
      const w = { method, sessionId, done: settle(resolve), fail: settle(reject) }
      const timer = setTimeout(() => w.fail(new Error(`Timed out after ${ms} ms waiting for ${method}`)), ms)
      waiters.add(w)
    })
  }

  async function newPage(url) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    const loaded = waitFor('Page.loadEventFired', sessionId, LOAD_TIMEOUT)
    const { errorText } = await send('Page.navigate', { url }, sessionId)
    if (errorText) {
      loaded.catch(() => {})
      for (const w of waiters) if (w.sessionId === sessionId) w.fail(new Error(errorText))
      throw new Error(`Could not load ${url}: ${errorText}`)
    }
    await loaded
    return {
      sessionId,
      async evaluate(expression, { awaitPromise = true } = {}) {
        const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
        return result.value
      },
      async pdf(options = {}) {
        const { data } = await send('Page.printToPDF', {
          preferCSSPageSize: true,
          printBackground: true,
          displayHeaderFooter: false,
          ...options
        }, sessionId)
        return Buffer.from(data, 'base64')
      },
      close: () => send('Target.closeTarget', { targetId })
    }
  }

  async function close() {
    if (!dead) {
      // SIGKILL only if Chrome ignores SIGTERM
      const force = setTimeout(() => proc.kill('SIGKILL'), 5000)
      proc.kill()
      await exited
      clearTimeout(force)
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }

  try {
    await send('Browser.getVersion')
  } catch (err) {
    await close()
    throw err
  }
  return { send, newPage, close }
}
