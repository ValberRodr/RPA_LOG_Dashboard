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
N/A direto — o projeto não usa dependências de terceiros (nem Python nem
JS além de stdlib/vanilla), então não há supply chain de pacote a
comprometer. Revisar este item se isso mudar.

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

## Fora de escopo (por design)

- Múltiplos usuários / múltiplas máquinas: a aplicação é explicitamente
  local e mono-usuário (seção 1 do SECURITY.md).
- Ataque de rede remoto: o bind em `127.0.0.1` não aceita conexão de fora da
  máquina; não há túnel nem exposição de porta.
