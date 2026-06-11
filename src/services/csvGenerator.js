// Neutraliza CSV injection
function sanitizeCsvValue(raw) {
  const s = String(raw ?? '')
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

export function generateCSV(rows) {
  if (rows.length === 0) return ''

  const headers = Object.keys(rows[0])
  const lines = [headers.join(',')]

  for (const row of rows) {
    const values = headers.map(h => {
      const val = sanitizeCsvValue(row[h]).replace(/"/g, '""')
      return val.includes(',') ? `"${val}"` : val
    })
    lines.push(values.join(','))
  }

  return lines.join('\n')
}
