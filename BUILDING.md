# Gerando os instaladores

| Sistema | Arquivos | Onde gerar |
|---|---|---|
| Linux | `.deb` e `.AppImage` | Linux (`npm run dist`) |
| Windows | instalador `setup-x64.exe` e `portable-x64.exe` | Windows (`npm run dist:win`). No Linux só o portátil sai sem Wine: `npx electron-builder --win portable` |
| macOS | `.dmg` e `.zip` (Intel e Apple Silicon) | **somente macOS** (`npm run dist:mac`) |

Os arquivos ficam em `dist/linux`, `dist/windows` e `dist/mac`.

## O jeito mais simples: GitHub Actions

O workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) compila em máquinas Linux, Windows e macOS de verdade, roda os testes e publica tudo num GitHub Release. Basta criar uma tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Também dá para rodar manualmente em **Actions → Release → Run workflow**. Sem uma tag, os instaladores ficam disponíveis como *artifacts* da execução.

## Windows a partir do Linux

O `.exe` portátil é gerado no Linux sem nenhuma dependência extra. O instalador (`setup-x64.exe`, NSIS) precisa do [Wine](https://www.winehq.org/) para criar o desinstalador; sem ele o build falha com `wine process failed ENOENT` e deixa um `setup.exe` de poucos KB, sem o app dentro. O workflow de Release gera o instalador numa máquina Windows.

## Por que o macOS precisa de um Mac

- O `.dmg` é criado com o `hdiutil`, que só existe no macOS.
- No Apple Silicon, o sistema não executa apps sem assinatura. Usamos uma assinatura *ad hoc* (`identity: "-"`), feita com o `codesign` do macOS.

## Patches em dependências

`patches/` contém ajustes pequenos aplicados pelo [patch-package](https://github.com/ds300/patch-package) a cada `npm install` (via `scripts/postinstall.mjs`):

- **`ssh2+1.17.0.patch`**: suporte a chaves de segurança FIDO2 (`sk-ssh-ed25519@openssh.com` e `sk-ecdsa-sha2-nistp256@openssh.com`) por meio do ssh-agent. A biblioteca descartava essas chaves e removia os campos *flags* e *counter* da assinatura (formato `PROTOCOL.u2f` do OpenSSH). O teste `test/fido.test.ts` faz login num `sshd` real do OpenSSH com uma assinatura nesse formato.

## Módulos nativos

O `node-pty` (terminal local) e o `serialport` (porta serial) têm partes nativas:

- **Linux:** o `npm install` compila os dois para o Electron (`scripts/postinstall.mjs`).
- **Windows e macOS:** os pacotes já trazem binários N-API prontos (`prebuilds/`), que funcionam com qualquer versão do Electron. Por isso o Windows pode ser empacotado a partir do Linux, e não é preciso Visual Studio nem Xcode.

O `electron-builder.yml` inclui em cada pacote só os binários do sistema de destino.

## Assinatura de código (opcional, recomendado para distribuir)

Sem assinatura o app funciona, mas os sistemas avisam:

- **Windows (SmartScreen):** "O Windows protegeu o computador". Clique em *Mais informações → Executar assim mesmo*. Para remover o aviso é preciso um certificado de assinatura de código (OV/EV). Configure `CSC_LINK` e `CSC_KEY_PASSWORD` nos *secrets* do repositório.
- **macOS (Gatekeeper):** "não pode ser aberto porque o desenvolvedor não pode ser verificado". Clique com o botão direito no app → *Abrir*. Se o macOS disser que o app está "danificado", rode `xattr -dr com.apple.quarantine "/Applications/OpenTerm Hub.app"`. Para remover o aviso é preciso uma conta Apple Developer (US$ 99/ano):
  1. troque `identity: "-"` pelo seu Developer ID;
  2. configure `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID`;
  3. ative `notarize: true` na seção `mac` do `electron-builder.yml`.

## Diferenças entre sistemas

- **Shell local:** PowerShell no Windows; o seu `$SHELL` como *login shell* no macOS; `$SHELL` no Linux. Para trocar, use a variável `OPENTERM_SHELL`.
- **ssh-agent:** no Windows é usado o agente do OpenSSH (`\\.\pipe\openssh-ssh-agent`), quando `SSH_AUTH_SOCK` não está definido.
- **Atalhos no macOS:** usam ⌘ (por exemplo ⌘C / ⌘V para copiar e colar no terminal, ⌘1…9 para trocar de aba).
- **Mosh e Telnet:** dependem dos binários do sistema (`brew install mosh` no macOS; no Windows o Mosh não está disponível).
