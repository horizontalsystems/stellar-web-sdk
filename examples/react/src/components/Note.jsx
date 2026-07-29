// Coloured status paragraph. `kind` is one of 'info' | 'ok' | 'error'.
export function Note({ kind = 'info', children }) {
  return <p className={`note ${kind}`}>{children}</p>
}
