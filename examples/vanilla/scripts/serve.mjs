// Minimal static server for the vanilla example — serves public/. Usage: node scripts/serve.mjs [port].
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize } from 'node:path'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const port = Number(process.argv[2] || process.env.PORT || 5173)

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.map': 'application/json',
  '.css': 'text/css',
  '.json': 'application/json'
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`)
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    const filePath = normalize(join(webRoot, pathname))
    if (!filePath.startsWith(webRoot)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': `${MIME[extname(filePath)] || 'application/octet-stream'}; charset=utf-8` })
    res.end(body)
  } catch (err) {
    if (err && err.code === 'ENOENT') res.writeHead(404).end('Not found')
    else res.writeHead(500).end(`Server error: ${err?.message || err}`)
  }
}).listen(port, () => console.log(`\n  Stellar vanilla example → http://localhost:${port}\n`))
