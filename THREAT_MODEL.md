# Threat Model — RPA Operations Monitor

Aplicação local, mono-usuário, sem servidor remoto: um processo Python
(`server.py`) escuta em `127.0.0.1` e serve um dashboard (`index.html`) que
lê arquivos de log locais e, opcionalmente, fala com o Control Room do
Automation Anywhere. O ativo mais sensível é o token do Automation Anywhere;
o ativo mais volumoso são os dados operacionais das RPAs (podem conter dado
pessoal — CPF, e-mail, matrícula — dependendo do processo automatizado).

Ver [SECURITY.md](SECURITY.md) para os requisitos e o histórico de correções.

## Cenários de ameaça

### 1. Log malicioso
Um arquivo `.log`/`.jsonl` em `logs/` com conteúdo adversarial (payload de
HTML/JS, nome de campo malformado, tamanho anômalo) processado pelo parser
ou renderizado no dashboard.
**Risco:** XSS refletido/armazenado no front-end se o valor for jogado em
`innerHTML` sem escapar; DoS se o parser não limitar tamanho/profundidade.
**Status:** a validar na auditoria (seção 2 e 13 do SECURITY.md).

### 2. Usuário local malicioso / outro processo na mesma máquina
Qualquer processo rodando como o mesmo usuário do SO pode abrir conexão
para `127.0.0.1:8765` (o bind em loopback não isola entre processos locais).
**Risco:** ler dados do dashboard, disparar rotas que mudam estado
(`/api/reload`, CRUD de `rpa_metadata.json`) via requisição forjada.
**Mitigação existente:** CSRF em duas camadas — token de processo
(`X-CSRF-Token`, obtido só por JS same-origin) + checagem de `Origin`. Um
processo não-navegador (curl, script) ainda consegue forjar o header
manualmente, mas isso já exige capacidade de execução de código na máquina,
fora do escopo de "CSRF vindo do navegador".

### 3. Arquivo de log adulterado
Um log legítimo é editado por alguém com acesso à pasta antes de o
dashboard processar.
**Risco:** os dados exibidos refletem a adulteração (o dashboard não tem
como validar autenticidade/integridade do conteúdo original).
**Mitigação existente:** o app nunca escreve de volta no arquivo original
(seção 19 do SECURITY.md) — o pior caso é exibir dado errado, não propagar
a adulteração para o arquivo fonte.

**Variante — executável adulterado numa pasta de rede:** se o código/
executável (não só os logs) for guardado numa pasta de rede compartilhada
(ver seção 1 do SECURITY.md), quem tiver acesso de escrita a essa pasta
poderia trocar o executável por um malicioso antes de outro usuário abrir o
atalho. Sem assinatura de código (ver `packaging/README.md`), não há
verificação automática de integridade — mitigação é de processo: restringir
escrita nessa pasta de rede a quem realmente publica atualizações, nunca a
todos os usuários que só rodam o app a partir dela.

### 4. API do Automation Anywhere comprometida/maliciosa
Resposta da API do Control Room contém payload adversarial (nome de campo
com HTML, URL inesperada, estrutura profundamente aninhada).
**Risco:** XSS se a resposta for renderizada sem escapar; SSRF se algum
campo da resposta for usado para montar uma nova URL de requisição.
**Status: corrigido (parcial)** — o vetor mais concreto encontrado não era
um campo de dado da resposta virando URL, e sim o próprio Control Room
respondendo um redirecionamento HTTP (3xx/`Location`) para um destino
bloqueado, que o proxy seguia sem revalidar. Corrigido em 2026-09-27 (ver
SECURITY.md — SSRF via redirect e via DNS rebinding/TOCTOU). Nenhum campo do
*corpo* da resposta da API é hoje usado para montar uma URL de requisição
nova (fora do fluxo natural de paginação, que não é atacável dessa forma).

### 5. Dependência comprometida
N/A direto para o app em si — não usa dependências de terceiros (nem Python
nem JS além de stdlib/vanilla), então não há supply chain de pacote a
comprometer em tempo de execução. Revisar este item se isso mudar.

**Ressalva de build:** gerar o executável (`packaging/`) usa o PyInstaller
como ferramenta de build — uma dependência de build, não de runtime (não
fica embutida na lógica do app, só empacota o interpretador Python + stdlib
dentro do executável final). Instalar sempre a partir do PyPI oficial
(`pip install pyinstaller`, como os scripts em `packaging/` já fazem) — nunca
de um instalador de terceiros.

### 6. Roubo do token do Automation Anywhere
Token em memória do processo Python, ou em `config/aa_config.json`, ou
trafegando entre front-end e back-end via header customizado.
**Risco:** se persistido em texto plano em disco, qualquer leitura do
arquivo (backup, outro processo, cópia do projeto) vaza o token.
**Status:** a confirmar na auditoria — verificar `aa_config.json` e o fluxo
de "Desconectar".

### 7. XSS via mensagem de erro de uma RPA
Uma automação gera uma mensagem de erro com conteúdo controlável (por
exemplo, um valor de input que a RPA processa e ecoa na exceção), que vira
uma linha de log e é exibida no dashboard.
**Risco:** o vetor mais provável de XSS armazenado nesta aplicação, porque
mensagens de erro tendem a ser tratadas como "texto livre" e escapadas com
menos rigor que outros campos.
**Status: corrigido** — a auditoria de 2026-09-27 encontrou exatamente esse
padrão, mas no campo `executionId` (não na mensagem de erro em si, que já
passava por `U.esc()`): 5 pontos em `investigacao.html`/`diagnostico.html`/
`rpa-dashboard.html` interpolavam `executionId` cru em `innerHTML`/`onclick`.
Corrigido no mesmo dia — ver SECURITY.md, Histórico de correções.

### 8. Path Traversal
Nome de arquivo de log, parâmetro de filtro ou caminho de dependência de RPA
(`config/rpa_metadata.json`) contendo `../`, caminho absoluto, ou symlink
apontando para fora da pasta permitida.
**Mitigação existente conhecida:** há teste unitário rejeitando dependência
com caminho absoluto e com `../`; falta confirmar que a validação cobre
symlink e é feita sobre o caminho *resolvido*, não a string bruta.

### 9. Arquivo extremamente grande
Um `.log` de tamanho anômalo (GBs) ou uma pasta com dezenas de milhares de
arquivos.
**Risco:** consumo de memória/CPU, travamento da UI durante o parse.
**Status:** a confirmar limites reais no parser (seção 13 do SECURITY.md).

### 10. Exportação contendo dado sensível
Se existir exportação (CSV/Excel/PDF) dos dados do dashboard.
**Risco:** Formula Injection (`=`, `+`, `-`, `@` em CSV/Excel) e vazamento de
dado pessoal não mascarado no arquivo exportado.
**Status:** a confirmar se essa funcionalidade existe hoje; se existir,
aplicar neutralização antes da release.

### 11. Proxy corporativo da integração Automation Anywhere
A rede corporativa da empresa exige saída para a internet através de um
proxy HTTP (descoberto pelo navegador via um script PAC das Configurações de
Internet do Windows) — o firewall de perímetro derruba qualquer conexão
direta, mesmo para um IP público legítimo já validado contra SSRF.
`_forward`/`AutomationAnywhereGateway`, ao ganhar suporte a esse proxy
(`AA_PROXY`), passou a encaminhar via túnel CONNECT (`_do_one_request_via_proxy`)
em vez de conectar direto no IP pinado (`_resolve_pinned_ip`).
**Risco:** o modo com proxy não pina o IP nós mesmos (é o proxy quem resolve
o destino final), então perde a defesa específica contra DNS rebinding/TOCTOU
que o modo direto tem — mitigado por: (1) o host continua validado por texto
antes de abrir o túnel (`_blocked_host_literal` — barra loopback/link-local/
metadata por IP literal e os nomes `localhost`/`*.local`); (2) o próprio
proxy corporativo é infraestrutura de TI, não controlada pelo usuário que
digita o `baseUrl`; (3) cada salto de redirecionamento 3xx continua sendo
revalidado antes de seguir, igual ao modo direto.
**Status: corrigido** — ver SECURITY.md, Histórico de correções (2026-09-28,
"Proxy corporativo obrigatório bloqueava a integração AA").

### 12. Certificado TLS do proxy corporativo (inspeção de TLS) sem validação
O proxy corporativo (cenário 11) faz inspeção de TLS: reemite um certificado
próprio dentro do túnel CONNECT em vez de deixar passar o certificado real do
Automation Anywhere. Esse certificado reemitido tem um defeito técnico real
(falta a extensão X.509 "Authority Key Identifier", confirmado em produção
via `[AA] ... CERTIFICATE_VERIFY_FAILED ... Missing Authority Key Identifier`)
que o validador estrito do OpenSSL (usado pelo `ssl`/`urllib` do Python)
rejeita, mesmo o Windows/navegador aceitando (CryptoAPI é mais tolerante a
essa falta específica).
**Risco:** `_do_one_request_via_proxy` desliga a verificação de certificado
(`ssl.CERT_NONE`) só para essa chamada — sem isso, a chamada real ao
Automation Anywhere falha sempre nesta rede. Isso remove a proteção contra um
MITM diferente do proxy corporativo *entre o proxy e o Control Room real*
(um atacante nessa posição específica da rede da empresa, depois do proxy).
**Aceito como está** (decisão explícita do responsável do projeto,
2026-09-28) — a alternativa seria a própria empresa corrigir o certificado do
proxy de inspeção (fora do controle deste projeto). Escopo estritamente
limitado ao modo com proxy: o modo direto (`_do_one_request`/
`_PinnedHTTPSConnection`, usado sempre que `AA_PROXY` não está configurado)
continua validando certificado normalmente, sem nenhuma mudança.

## Fora de escopo (por design)

- Múltiplos usuários / múltiplas máquinas: a aplicação é explicitamente
  local e mono-usuário (seção 1 do SECURITY.md).
- Ataque de rede remoto: o bind em `127.0.0.1` não aceita conexão de fora da
  máquina; não há túnel nem exposição de porta.
