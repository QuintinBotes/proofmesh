export function daily(_req, res) {
  res.json({ period: 'daily' })
}

export function weekly(_req, res) {
  res.json({ period: 'weekly' })
}
