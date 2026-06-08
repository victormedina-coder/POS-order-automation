export function generateCSV(rows) {
  if (rows.length === 0) return ''

  const headers = Object.keys(rows[0])
  const lines = [headers.join(',')]

  for (const row of rows) {
    const values = headers.map(h => {
      const val = String(row[h] ?? '').replace(/"/g, '""')
      return val.includes(',') ? `"${val}"` : val
    })
    lines.push(values.join(','))
  }

  return lines.join('\n')
}
