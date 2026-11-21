import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

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

export default defineConfig({ plugins: [gameData()] })
