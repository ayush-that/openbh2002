import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Dev only: serves the local game copy at /gamedata/. Game files are never bundled.
const GAME_DIR = path.resolve(process.env.BH2002_DIR ?? '../BEACHHEAD2002')

function walk(dir: string, base = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel]
  })
}

function gameData(): Plugin {
  return {
    name: 'gamedata',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/gamedata', (req, res, next) => {
        if (!fs.existsSync(GAME_DIR)) return next()
        const url = decodeURIComponent((req.url ?? '/').split('?')[0])
        if (url === '/__index.json') {
          res.setHeader('Content-Type', 'application/json')
          return res.end(JSON.stringify(walk(GAME_DIR)))
        }
        const file = path.join(GAME_DIR, url)
        if (!file.startsWith(GAME_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404
          return res.end()
        }
        res.setHeader('Content-Type', 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
  }
}

// Dev only: the autoplay harness (src/debug/autoplay.ts) posts its report and level-end screenshots here.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const E2E_DIR = path.join(ROOT, 'artifacts', 'e2e')
const MAX_BODY = 5 * 1024 * 1024

function e2eArtifacts(): Plugin {
  const readBody = (req: import('node:http').IncomingMessage) =>
    new Promise<Buffer | null>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size <= MAX_BODY) chunks.push(c)
      })
      req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks)))
      req.on('error', reject)
    })
  const write = (name: string, data: Buffer | string) => {
    const file = path.resolve(E2E_DIR, name)
    if (!file.startsWith(E2E_DIR + path.sep)) throw new Error('bad path')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
    return path.relative(ROOT, file)
  }
  return {
    name: 'e2e-artifacts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (req.method !== 'POST' || (url.pathname !== '/__report' && url.pathname !== '/__shot')) return next()
        const reply = (code: number, body: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        try {
          const body = await readBody(req)
          if (!body) return reply(413, { error: 'body over 5 MB' })
          if (url.pathname === '/__shot') {
            const name = url.searchParams.get('name') ?? ''
            if (!/^[\w.-]+\.png$/.test(name)) return reply(400, { error: 'bad name' })
            return reply(200, { path: write(`shots/${name}`, body) })
          }
          const json = JSON.stringify(JSON.parse(body.toString('utf8')), null, 2)
          const latest = write('latest.json', json)
          if (url.searchParams.has('partial')) return reply(200, { path: latest })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          reply(200, { path: write(`report-${stamp}.json`, json) })
        } catch (e) {
          reply(400, { error: (e as Error).message })
        }
      })
    },
  }
}

// Dev only: src/debug/recorder.ts appends MediaRecorder chunks here (POST /__video?name=<file>&part=<n>; part 0 truncates).
const VIDEO_DIR = path.join(ROOT, 'artifacts', 'video')
const MAX_VIDEO = 1024 ** 3

function videoArtifacts(): Plugin {
  return {
    name: 'video-artifacts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__video', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const url = new URL(req.url ?? '/', 'http://x')
        const reply = (code: number, body: unknown) => {
          if (res.headersSent) return
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        const name = url.searchParams.get('name') ?? ''
        const part = Number(url.searchParams.get('part') ?? 0)
        if (!/^\w[\w.-]*\.(mp4|webm)$/.test(name) || !Number.isInteger(part) || part < 0) return reply(400, { error: 'bad name or part' })
        const file = path.join(VIDEO_DIR, name)
        fs.mkdirSync(VIDEO_DIR, { recursive: true })
        let size = part > 0 && fs.existsSync(file) ? fs.statSync(file).size : 0
        const out = fs.createWriteStream(file, { flags: part > 0 ? 'a' : 'w' })
        let failed = false
        const fail = (code: number, error: string) => {
          if (failed) return
          failed = true
          req.unpipe(out)
          req.resume()
          out.destroy()
          fs.rmSync(file, { force: true })
          reply(code, { error })
        }
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_VIDEO) fail(413, 'video over 1 GB')
        })
        req.on('error', (e) => fail(400, e.message))
        out.on('error', (e) => fail(500, e.message))
        out.on('finish', () => failed || reply(200, { path: path.relative(ROOT, file), bytes: size }))
        req.pipe(out)
      })
    },
  }
}

// E2E_NO_HMR=1: no hot reload, so long autoplay runs survive edits to other files.
// BASE_PATH: public path when hosted under a subfolder (default /).
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [gameData(), e2eArtifacts(), videoArtifacts()],
  server: { hmr: !process.env.E2E_NO_HMR },
})
