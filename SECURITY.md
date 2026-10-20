# Segurança / Security

Encontrou uma vulnerabilidade? **Não abra uma issue pública.** Use o recurso
"Report a vulnerability" (GitHub Security Advisories) deste repositório.

Found a vulnerability? **Do not open a public issue.** Please use this
repository's "Report a vulnerability" (GitHub Security Advisories) instead.

## Como o OpenTerm Hub protege seus dados

- Senhas e chaves privadas ficam em `secrets.json`, cifradas com o `safeStorage`
  do Electron (libsecret/gnome-keyring no Linux, Keychain no macOS, DPAPI no
  Windows). Se não houver chaveiro seguro, o app avisa na tela de hosts.
- Segredos nunca são enviados para a interface (renderer). O renderer roda com
  `sandbox`, `contextIsolation` e sem `nodeIntegration`, e só fala com o
  processo principal por uma lista fechada de chamadas IPC.
- Toda chave de servidor é confirmada pelo usuário na primeira conexão, e uma
  chave alterada gera um alerta de possível ataque man-in-the-middle.
- O backup exportado não contém senhas nem chaves privadas.
- Comandos digitados sem eco (senhas pedidas por `sudo`, `read -s` etc.) não
  entram no histórico do autocomplete.
