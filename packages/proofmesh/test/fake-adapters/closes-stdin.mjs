// Read the initialize frame directly. The fixture owns fd 0 and never opens a libuv stdin stream.
import { closeSync, read } from 'node:fs'
import { INITIALIZED, reply } from './dying-lib.mjs'

const buffer = Buffer.alloc(4096)
let frame = ''
function readInitialize() {
  read(0, buffer, 0, buffer.length, null, (error, length) => {
    if (error?.code === 'EAGAIN') return setImmediate(readInitialize)
    if (error) throw error
    if (!length) throw new Error('stdin ended before initialize')
    frame += buffer.toString('utf8', 0, length)
    if (!frame.includes('\n')) return readInitialize()
    closeSync(0)
    reply(JSON.parse(frame).id, INITIALIZED)
    setInterval(() => {}, 1000)
  })
}
readInitialize()
