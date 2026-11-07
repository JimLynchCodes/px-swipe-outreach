/** Minimal black-outline pineapple: oval body, a light diamond lattice, three crown leaves. Keep in sync with public/pineapple.svg. */
export function PineappleLogo({ size = 36, title }: { size?: number; title?: string }) {
  return (
    <svg className="brand-logo" width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true} aria-label={title}>
      {title && <title>{title}</title>}
      <path d="M16 12.5c-4.4 0-7 3.6-7 8.2S11.6 30 16 30s7-4.7 7-9.3-2.6-8.2-7-8.2Z" />
      <path d="M12.2 17.5l7.6 7.6M10.6 22.4l4.8 4.8M14.6 14.3l6.5 6.5M19.8 17.5l-7.6 7.6M21.4 22.4l-4.8 4.8M17.4 14.3l-6.5 6.5" strokeWidth={1.1} opacity={0.8} />
      <path d="M16 12.5c-.2-3.4.3-6.6 0-10.5 1.6 2.7 2.4 6.2 0 10.5Z" />
      <path d="M15.4 12.4C13 10.3 11 9.3 8.5 9.4c2-2 5.4-1.6 6.9 3Z" />
      <path d="M16.6 12.4c2.4-2.1 4.4-3.1 6.9-3-2-2-5.4-1.6-6.9 3Z" />
    </svg>
  )
}
