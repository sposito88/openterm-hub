# Importar de outro cliente SSH

Em **Configurações → Backup → Importar backup**, o OpenTerm Hub aceita dois tipos de arquivo JSON:

1. **Backup do OpenTerm Hub** (`"format": "openterm-hub-backup"`), gerado pelo próprio app. Não traz senhas nem chaves privadas.
2. **Arquivo de migração** (`"format": "openterm-hub-import"`), descrito abaixo. Traz senhas e chaves privadas, para migrar de outro cliente sem redigitar nada.

> ⚠️ O arquivo de migração tem senhas e chaves **em texto puro**. Gere-o com permissão restrita (`chmod 600`), importe, e **apague-o** em seguida. Dentro do app, os segredos passam a ser cifrados pelo chaveiro do sistema.

## Formato `openterm-hub-import` (versão 1)

```json
{
  "format": "openterm-hub-import",
  "version": 1,
  "keys": [
    { "ref": "k1", "label": "deploy", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n…", "passphrase": "opcional" }
  ],
  "identities": [
    { "ref": "i1", "label": "deploy (produção)", "username": "deploy", "password": "opcional", "keyRef": "k1" }
  ],
  "snippets": [
    { "ref": "s1", "label": "Uptime", "script": "uptime" }
  ],
  "hosts": [
    {
      "ref": "h1",
      "label": "Bastion",
      "group": "Produção",
      "hostname": "10.0.0.1",
      "port": 22,
      "username": "ops",
      "password": "opcional",
      "keyRef": "k1",
      "identityRef": "i1",
      "protocol": "ssh",
      "agentForward": false,
      "jumpHostRef": "h0",
      "snippetRef": "s1",
      "tags": ["linux"]
    }
  ],
  "knownHosts": [
    { "host": "10.0.0.1", "port": 22, "publicKey": "ssh-ed25519 AAAAC3Nza…" }
  ]
}
```

| Campo | Observações |
|---|---|
| `ref` | Identificador livre, usado só para ligar itens dentro do arquivo (`keyRef`, `identityRef`, `jumpHostRef`, `snippetRef`). |
| `identityRef` | Login reaproveitável (usuário, senha e chave). Quando presente, `username`, `password` e `keyRef` do host são ignorados. |
| `privateKey` | Formatos OpenSSH, PEM (RSA/ECDSA) ou PuTTY `.ppk` v2. |
| `group` | Texto livre. Para grupos aninhados, use `"Pai / Filho"`. |
| `protocol` | `ssh` (padrão), `mosh` ou `telnet`. |
| `port` | Padrão 22. |

## Itens repetidos

Importar o mesmo arquivo duas vezes não duplica nada:

- **Chaves:** iguais pela fingerprint são reaproveitadas.
- **Snippets:** iguais pelo texto do comando são reaproveitados.
- **Identidades:** iguais em usuário, senha e chave são reaproveitadas.
- **Hosts:** só uma cópia **idêntica** (endereço, porta, nome, grupo e o login efetivo, usuário e senha) é ignorada. Entradas do mesmo servidor com outro nome, grupo ou senha são mantidas. Se o host já existe com o mesmo login e o arquivo traz uma identidade para ele, o host é **vinculado** à identidade em vez de duplicado.
- **Known hosts:** se o host já tem uma fingerprint confiável, ela é mantida.

No fim, o app mostra quantos itens foram importados e lista os que falharam, citando apenas o nome, nunca o conteúdo secreto.
