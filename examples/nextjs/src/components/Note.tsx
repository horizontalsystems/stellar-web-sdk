import type { ReactNode } from 'react'

/** Coloured status paragraph. `kind` is one of 'info' | 'ok' | 'error'. */
export function Note({ kind = 'info', children }: { kind?: 'info' | 'ok' | 'error'; children: ReactNode }) {
  return <p className={`note ${kind}`}>{children}</p>
}
