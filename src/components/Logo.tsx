export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" width="42" height="42" role="img" aria-label="Echo">
      <circle className="logo-paper" cx="32" cy="32" r="30" />
      <circle className="logo-keyline" cx="32" cy="32" r="29.4" />
      <g className="logo-echo">
        <circle cx="39.13" cy="38.2" r="16.1" />
        <circle cx="39.13" cy="38.2" r="10.5" />
      </g>
      <circle className="logo-ink" cx="24.87" cy="25.8" r="14" />
    </svg>
  )
}
