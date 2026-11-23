import { parseSql } from './sql'

self.onmessage = async (event: MessageEvent<File | string>) => {
  try {
    const sql = typeof event.data === 'string' ? event.data : await event.data.text()
    self.postMessage({ model: parseSql(sql) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Không thể đọc file SQL.' })
  }
}
