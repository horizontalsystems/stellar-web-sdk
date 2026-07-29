import type { ReactNode } from 'react'
import { Providers } from './providers'
import './globals.css'

export const metadata = {
  title: 'stellar-web-sdk — Next.js example',
  description: 'StellarBroker-first swap waterfall driven by the React hooks'
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
