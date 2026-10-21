const paths = {
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  key: 'M15 7a4 4 0 1 1-3.9 4.9L4 19v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7zm1.5 2.5h.01',
  tunnel: 'M3 12h4m10 0h4M7 8l-4 4 4 4m10-8 4 4-4 4M10 12h4',
  code: 'M8 8l-4 4 4 4m8-8 4 4-4 4m-6 2 4-12',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z m-3 9 2 2 4-4',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm8 3 2-1-1-3-2 .2-1.3-1.3L18 5l-3-1-1 2h-2L11 4 8 5l.3 1.9L7 8.2 5 8 4 11l2 1v0l-2 1 1 3 2-.2 1.3 1.3L8 19l3 1 1-2h2l1 2 3-1-.3-1.9 1.3-1.3 2 .2 1-3z',
  terminal: 'M4 5h16v14H4zM7 10l3 2-3 2m5 0h5',
  folder: 'M3 6h6l2 2h10v11H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  trash: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13',
  play: 'M7 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  up: 'M12 19V5m-6 6 6-6 6 6',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4',
  plug: 'M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  import: 'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M18 15l-6-6-6 6',
  group: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4v5l3 2',
  minus: 'M5 12h14',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
  broadcast: 'M4.9 19.1A10 10 0 0 1 4.9 4.9M7.8 16.2A6 6 0 0 1 7.8 7.8M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm4.2 2.2a6 6 0 0 0 0-8.4m2.9 11.3a10 10 0 0 0 0-14.2',
  splitHorizontal: 'M4 4h16v16H4zm8 0v16',
  splitVertical: 'M4 4h16v16H4zm0 8h16',
  maximize: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7',
  workspace: 'M3 3h7v7H3zm11 0h7v7h-7zm0 11h7v7h-7zm-11 0h7v7H3z',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8',
  palette: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5S13 18 13 17s.7-1.5 1.5-1.5H17a4 4 0 0 0 4-4C21 6.9 17 3 12 3zM7.5 11h.01M10 7.5h.01M14 7.5h.01'
} as const

export type IconName = keyof typeof paths

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name]} />
    </svg>
  )
}
