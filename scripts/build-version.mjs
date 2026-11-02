/** Local build stamp for Go -ldflags: YYYYMMDD-HHMMSS */
export function buildVersion(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

export function versionLdflags(extra = '') {
  const parts = [`-X echo/internal/app.BuildVersion=${buildVersion()}`]
  if (extra.trim()) parts.unshift(extra.trim())
  return parts.join(' ')
}
