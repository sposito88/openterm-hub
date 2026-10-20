import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  id: string
  name: string
  light?: boolean
  colors: ITheme
}

type Ansi = [string, string, string, string, string, string, string, string]

/** Builds a theme from the 8 normal + 8 bright ANSI colors. */
function theme(id: string, name: string, base: { bg: string; fg: string; cursor: string; sel: string }, normal: Ansi, bright: Ansi, light = false): TerminalTheme {
  const [black, red, green, yellow, blue, magenta, cyan, white] = normal
  const [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = bright
  return {
    id,
    name,
    light,
    colors: {
      background: base.bg,
      foreground: base.fg,
      cursor: base.cursor,
      cursorAccent: base.bg,
      selectionBackground: base.sel,
      black, red, green, yellow, blue, magenta, cyan, white,
      brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite
    }
  }
}

const solarized: Ansi = ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5']
const solarizedBright: Ansi = ['#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']

export const TERMINAL_THEMES: TerminalTheme[] = [
  theme('openterm-dark', 'OpenTerm Dark', { bg: '#0b0d11', fg: '#e6e8ee', cursor: '#3ddc97', sel: '#3ddc9755' },
    ['#1b1f27', '#ff6b6b', '#3ddc97', '#ffcf5c', '#5eaaff', '#c792ea', '#4fd6e0', '#c9ced8'],
    ['#5c6577', '#ff8787', '#6cf2b4', '#ffe08a', '#8cc4ff', '#ddb3f5', '#80e8f0', '#ffffff']),
  theme('openterm-light', 'OpenTerm Light', { bg: '#fbfbfc', fg: '#1b1f27', cursor: '#0f9d66', sel: '#0f9d6640' },
    ['#1b1f27', '#c92a2a', '#0f9d66', '#a16207', '#1c64d1', '#9333ea', '#0e7490', '#6b7280'],
    ['#4b5563', '#e03131', '#12b37a', '#854d0e', '#3b82f6', '#a855f7', '#0891b2', '#4b5563'], true),
  theme('dracula', 'Dracula', { bg: '#282a36', fg: '#f8f8f2', cursor: '#f8f8f2', sel: '#44475a' },
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  theme('nord', 'Nord', { bg: '#2e3440', fg: '#d8dee9', cursor: '#d8dee9', sel: '#434c5e' },
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
    ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  theme('tokyo-night', 'Tokyo Night', { bg: '#1a1b26', fg: '#c0caf5', cursor: '#c0caf5', sel: '#33467c' },
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'],
    ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  theme('catppuccin-mocha', 'Catppuccin Mocha', { bg: '#1e1e2e', fg: '#cdd6f4', cursor: '#f5e0dc', sel: '#585b70' },
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'],
    ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  theme('one-dark', 'One Dark', { bg: '#282c34', fg: '#abb2bf', cursor: '#528bff', sel: '#3e4451' },
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
    ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  theme('gruvbox-dark', 'Gruvbox Dark', { bg: '#282828', fg: '#ebdbb2', cursor: '#ebdbb2', sel: '#504945' },
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
    ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  theme('monokai', 'Monokai', { bg: '#272822', fg: '#f8f8f2', cursor: '#f8f8f0', sel: '#49483e' },
    ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2'],
    ['#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
  theme('kanagawa-wave', 'Kanagawa Wave', { bg: '#1f1f28', fg: '#dcd7ba', cursor: '#c8c093', sel: '#2d4f67' },
    ['#090618', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093'],
    ['#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba']),
  theme('kanagawa-dragon', 'Kanagawa Dragon', { bg: '#181616', fg: '#c5c9c5', cursor: '#c8c093', sel: '#2d4f67' },
    ['#0d0c0c', '#c4746e', '#8a9a7b', '#c4b28a', '#8ba4b0', '#a292a3', '#8ea4a2', '#c8c093'],
    ['#a6a69c', '#e46876', '#87a987', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#c5c9c5']),
  theme('kanagawa-lotus', 'Kanagawa Lotus', { bg: '#f2ecbc', fg: '#545464', cursor: '#43436c', sel: '#c9cbd1' },
    ['#1f1f28', '#c84053', '#6f894e', '#77713f', '#4d699b', '#b35b79', '#597b75', '#545464'],
    ['#8a8980', '#d7474b', '#6e915f', '#836f4a', '#6693bf', '#624c83', '#5e857a', '#43436c'], true),
  theme('flexoki-dark', 'Flexoki Dark', { bg: '#100f0f', fg: '#cecdc3', cursor: '#cecdc3', sel: '#403e3c' },
    ['#100f0f', '#d14d41', '#879a39', '#d0a215', '#4385be', '#ce5d97', '#3aa99f', '#878580'],
    ['#575653', '#af3029', '#66800b', '#ad8301', '#205ea6', '#a02f6f', '#24837b', '#cecdc3']),
  theme('flexoki-light', 'Flexoki Light', { bg: '#fffcf0', fg: '#100f0f', cursor: '#100f0f', sel: '#e6e4d9' },
    ['#100f0f', '#af3029', '#66800b', '#ad8301', '#205ea6', '#a02f6f', '#24837b', '#6f6e69'],
    ['#b7b5ac', '#d14d41', '#879a39', '#d0a215', '#4385be', '#ce5d97', '#3aa99f', '#cecdc3'], true),
  theme('solarized-dark', 'Solarized Dark', { bg: '#002b36', fg: '#839496', cursor: '#93a1a1', sel: '#073642' }, solarized, solarizedBright),
  theme('solarized-light', 'Solarized Light', { bg: '#fdf6e3', fg: '#657b83', cursor: '#586e75', sel: '#eee8d5' }, solarized, solarizedBright, true),
  theme('phosphor-green', 'Phosphor Green', { bg: '#020c04', fg: '#39ff7a', cursor: '#39ff7a', sel: '#0f4a22' },
    ['#020c04', '#ff5f5f', '#39ff7a', '#d7ff5f', '#2fd18b', '#7dffb0', '#5fffd7', '#b8ffd0'],
    ['#1f6b3a', '#ff8787', '#7dff9e', '#e4ff8a', '#5fe0a5', '#a6ffc8', '#8affe4', '#eafff1']),
  theme('phosphor-blue', 'Phosphor Blue', { bg: '#020814', fg: '#4cc6ff', cursor: '#4cc6ff', sel: '#0f3552' },
    ['#020814', '#ff6b8a', '#4cffd2', '#ffd75f', '#4cc6ff', '#9b8cff', '#5ff0ff', '#c4e9ff'],
    ['#1f4a6b', '#ff92a8', '#85ffe2', '#ffe48a', '#85d9ff', '#bdb3ff', '#8af5ff', '#eef8ff']),
  theme('phosphor-red', 'Phosphor Red', { bg: '#120203', fg: '#ff5c5c', cursor: '#ff5c5c', sel: '#4d1215' },
    ['#120203', '#ff5c5c', '#ffa94d', '#ffd75f', '#ff7a90', '#ff8fd0', '#ffb3a8', '#ffd1d1'],
    ['#6b1f24', '#ff8787', '#ffc078', '#ffe48a', '#ffa1b2', '#ffb3df', '#ffcfc7', '#fff0f0'])
]

export function findTerminalTheme(id: string, uiLight: boolean): TerminalTheme {
  return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[uiLight ? 1 : 0]
}
