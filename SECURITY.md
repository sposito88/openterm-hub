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
- Chaves de segurança FIDO2 (YubiKey etc.) são usadas pelo ssh-agent: a chave privada nunca sai do dispositivo, e cada login exige tocar nele.
- Comandos digitados sem eco (senhas pedidas por `sudo`, `read -s` etc.) não
  entram no histórico do autocomplete.
- Sincronização (opcional): o cofre na pasta sincronizada é cifrado com
  AES-256-GCM, com a chave derivada da senha do cofre por scrypt (N=2^17).
  A senha fica só no chaveiro deste computador; o arquivo não tem nada legível,
  e qualquer alteração nele é detectada pela autenticação do GCM.
- Sequências de login e senha automática do sudo rodam no processo principal:
  as senhas não passam pela interface. O sudo só é respondido logo depois de um
  comando que roda `sudo`, para que um texto parecido com o prompt (um `echo`,
  um arquivo exibido) nunca receba a senha, e para de responder se ela for recusada.
- Comandos locais antes/depois da conexão recebem os dados do host por
  variáveis de ambiente (`OPENTERM_HOST` etc.), nunca colados na linha de comando.
