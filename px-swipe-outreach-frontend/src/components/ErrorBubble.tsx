import { AlertCircle } from 'lucide-react'

/** API error under the button that triggered it: red text in a rounded, light-red bubble. Renders nothing without an error. */
export function ErrorBubble({ error, id, className = '' }: { error: string | null | undefined; id?: string; className?: string }) {
  if (!error) return null
  return (
    <p className={`error-bubble ${className}`} role="alert" id={id}>
      <AlertCircle size={15} aria-hidden /> <span>{error}</span>
    </p>
  )
}
