# Política de Segurança — RPA Operations Monitor

Este documento define os requisitos de segurança obrigatórios do projeto e
registra o histórico de vulnerabilidades encontradas e corrigidas.

Princípios: OWASP, secure-by-default, least privilege. Segurança prevalece
sobre conveniência de implementação. Nenhuma feature é considerada concluída
se introduzir uma vulnerabilidade CRITICAL ou HIGH sem correção.

Ver também [THREAT_MODEL.md](THREAT_MODEL.md).

---

## 1. Arquitetura local

- A aplicação roda exclusivamente na máquina do usuário.
- O servidor HTTP local (`server.py`) faz bind fixo em `127.0.0.1` (constante
  `HOST`, não configurável para `0.0.0.0` nem outro endereço) — **status:
  implementado**.
- Não abre portas externas, não inicia túnel/compartilhamento automático.
- Qualquer comunicação externa deve estar documentada aqui: hoje a única é a
  chamada explícita e opcional ao Control Room do Automation Anywhere,
  configurada manualmente pelo usuário (seção 4).
- **Distribuição como executável (PyInstaller, ver `packaging/`):** os
  executáveis gerados (Windows/macOS) não são assinados (sem certificado
  Apple Developer ID / Microsoft Authenticode) — na primeira execução o SO
  mostra um aviso ("desenvolvedor não identificado"/SmartScreen). Isso é
  esperado, mas **treinar usuários a sempre clicar em "abrir/executar mesmo
  assim" é, em geral, um vetor de engenharia social**: só distribua o
  executável por um canal em que o usuário confia na origem (nunca por
  e-mail/link externo não solicitado), e valide o hash/procedência antes de
  rodar num ambiente sensível. `config/`/`logs/` ficam sempre fora do bundle
  do executável (nunca dentro da pasta temporária de extração) — ver
  `packaging/README.md` para o porquê.
- **Armazenamento em pasta de rede:** é seguro guardar o código (ou o
  executável) numa pasta compartilhada, desde que cada usuário rode seu
  próprio processo local (continua ouvindo só em `127.0.0.1` na própria
  máquina) — nunca um único servidor central acessado por vários usuários
  pela rede (isso violaria o primeiro item desta seção). Desde 2026-09-28,
  `config/rpa_metadata.json` também pode ficar numa pasta de rede
  compartilhada (`CONFIG_ROOT`, ver comentário em `server.py`) — as
  gravações (`RpaRegistryStore._locked`) são serializadas por um arquivo de
  trava (`.lock`, criação atômica via `O_CREAT|O_EXCL`) com timeout de 10s e
  reclamação automática de trava abandonada (>30s) se o processo que a
  segurava morreu sem limpar; duas máquinas editando ao mesmo tempo não
  corrompem mais o arquivo nem perdem a gravação uma da outra (a segunda
  espera a primeira terminar e parte do estado já atualizado). Isso NÃO é
  um lock distribuído genérico (é um arquivo comum, não um mecanismo de SO)
  — funciona bem para a escala esperada (algumas pessoas, ações
  esporádicas), não para alta concorrência.
- **⚠️ Divulgação de informação — caminho UNC corporativo hardcoded (flagged
  2026-09-28, decisão pendente do responsável pelo projeto):** `server.py`
  tem, como padrão no Windows, o hostname e o nome do compartilhamento de
  rede internos da empresa (`DEFAULT_DATA_ROOT`) escritos literalmente no
  código-fonte — e este repositório é **público** no GitHub, então esse
  caminho também fica embutido no `.exe` publicado na Release pública.
  Isso expõe topologia de rede interna (nome de servidor, nome de
  compartilhamento) para qualquer pessoa na internet. Foi mantido a pedido
  explícito do responsável pelo projeto (ver commit `05e9b32`); a mitigação
  recomendada — não aplicada — seria remover o literal do código e passar
  esse valor só via `RPA_MONITOR_DATA_ROOT` (variável de ambiente, nunca
  commitada) ou tornar o repositório privado.

## 2. Dados de logs — sempre não confiáveis

Conteúdo de logs nunca deve ser executado nem interpretado como HTML/JS/SQL/
comando de shell. Deve ser exibido como texto (`textContent`, nunca
`innerHTML` bruto). Proteções obrigatórias: XSS, HTML/JS/Template/Command/SQL
Injection, CSV/Excel Formula Injection, Path Traversal, Prototype Pollution,
JSON Injection.

**Status: corrigido** — `executionId` (vindo direto do log, não sanitizado)
escapava da sanitização em 5 pontos de `investigacao.html`, `diagnostico.html`
e `rpa-dashboard.html`; corrigido em 2026-09-27, ver Histórico de correções
abaixo. Todo outro campo de log exibido já passava por `U.esc()` desde antes
desta revisão.

## 3. Leitura de arquivos

Acesso restrito às pastas configuradas (`logs/`, `config/`). Path Traversal
(`../`, `..\`, `file://`, UNC paths, symlinks) deve ser bloqueado resolvendo
o caminho real antes de qualquer leitura. Nomes/valores vindos de dentro de
um log nunca devem determinar qual arquivo é acessado. Limites obrigatórios:
extensão permitida, tamanho máximo de arquivo/pasta, quantidade máxima de
arquivos, validação de encoding, tratamento de arquivo corrompido, timeout
de processamento.

**Status: a confirmar** — validar a lógica real de resolução de caminho no
parser de logs e no CRUD de `rpa_metadata.json` (dependências), não só os
testes que exercitam esse comportamento.

## 4. Automation Anywhere — token/credenciais

O token do Automation Anywhere:

- nunca hardcoded, nunca em arquivo JS, nunca no Git, nunca em logs, erros,
  relatórios PDF, console do navegador ou query string;
- a API Key (o segredo de vida mais longa, digitado pelo usuário) nunca é
  persistida — só existe em memória (`AASecretVault._apiKey`) durante a
  chamada de autenticação, nunca gravada em lugar nenhum;
- o TOKEN derivado dela (mais curto, específico da sessão) fica em
  `sessionStorage` — decisão de risco aceita (2026-09-29, a pedido explícito
  do responsável do projeto: manter a sessão logada entre recarregamentos da
  mesma aba, sem digitar a API Key de novo a cada F5) — ver linha
  correspondente no Histórico de correções e THREAT_MODEL.md cenário 6.
  `sessionStorage` nunca é escrito em disco pelo navegador e é limpo ao
  fechar a aba/janela — não é persistência entre sessões do app, só entre
  navegações/recargas da mesma aba aberta;
- "Desconectar" (ou uma resposta `SESSION_EXPIRED` da Control Room) remove o
  token de memória E de `sessionStorage` imediatamente;
- nunca enviado para domínio diferente do endpoint configurado.

**Status:** auditado (2026-09-29). `aa_config.json` guarda só `aaBaseUrl`/
`aaUsername` (não-sensível, ver seu próprio `_readme`); headers
`X-AA-Base-Url`/`X-AA-Token` trafegam só entre navegador e este servidor
local (nunca logados — ver `_forward`/`_log_upstream_error`); o fluxo de
desconexão (`AAConnectionManager.disconnect`) limpa `AASecretVault` e
`sessionStorage` juntos, sempre.

## 5. Proteção contra exfiltração

Nenhum envio automático de logs, usuários, máquinas, caminhos, erros,
métricas, dados de RPA, credenciais ou arquivos para serviços externos.
Sem Google Analytics, trackers, telemetry, pixels, error-reporting SaaS ou
APIs externas não autorizadas. Toda chamada externa precisa de justificativa
funcional registrada aqui (hoje: só o Automation Anywhere, ver seção 1).

## 6. Front-end

Proibido `eval()`, `new Function()`, `document.write()`,
`setTimeout`/`setInterval` com string. CSP restritiva sempre que possível
(alvo: `default-src 'self'; script-src 'self'; object-src 'none';
base-uri 'none'; frame-ancestors 'none'`, `connect-src` limitado a `'self'`
+ endpoint do AA). Sem dependência de CDN pública para funcionalidade básica.

**Status: a confirmar** — validar CSP efetivamente enviada pelo servidor
(nonce, diretivas) contra este alvo.

## 7. Dependências

Este projeto **não usa bibliotecas externas** (nem Python nem JS além da
stdlib/vanilla) — `server.py` roda só com a biblioteca padrão do Python, o
front-end é vanilla JS. Não há `requirements.txt`/`package.json` a auditar
com `pip-audit`/`npm audit`. Revisar novamente se isso mudar.

## 8. Backend Python

Proibido `eval`, `exec`, `os.system`, `subprocess(..., shell=True)`,
`pickle.loads`, `yaml.load` sem `SafeLoader`. Nunca concatenar entrada do
usuário em comando de SO.

**Status: implementado no código revisado até agora** — o único uso de
`subprocess` no projeto (`_open_as_app_window`, abertura do navegador em
modo app) usa lista de argumentos sem `shell=True` e caminhos absolutos
fixos, não construídos a partir de entrada externa.

## 9–10. Upload/importação e exportação

Sem fluxo de upload manual de arquivo no momento. Exportações (se houver
CSV/Excel) devem neutralizar valores iniciados por `=`, `+`, `-`, `@`
vindos de dado não confiável; PDF não deve carregar URL/script remoto
automaticamente.

**Status: a confirmar na auditoria** — verificar se existe algum caminho de
exportação hoje e se aplica essa neutralização.

## 11. Logs da própria aplicação

Nunca registrar senha, token, API key, cookie, header de autorização ou
dado pessoal desnecessário. Mascarar automaticamente
(`Authorization: Bearer [REDACTED]`, etc.).

**Status: a confirmar** — checar `log_message` e prints de erro do gateway
AA quanto a vazamento de token.

## 12. Tratamento de erros

Usuário recebe mensagem genérica; detalhe técnico só em log interno. Nunca
expor stack trace, estrutura interna, variáveis de ambiente, diretórios ou
credenciais diretamente na resposta.

## 13. DoS local e estabilidade

Limites contra RAM ilimitada, loop infinito, regex catastrófica, arquivo
gigante, JSON excessivamente profundo, zip bomb (se ZIP for aceito).

## 14. Dados pessoais

Minimização: só carregar campos necessários. Mascarar CPF, e-mail, telefone,
matrícula, apólice, identificadores pessoais e credenciais quando possível.
Não duplicar dado sensível em cache/relatório/arquivo temporário sem
necessidade.

## 15. Arquivos temporários

Diretório controlado, nome imprevisível, sem colisão, sem Path Traversal,
remoção após uso, nunca guardar secret sem necessidade.

## 16. Git

`.gitignore` deve cobrir `.env`, `*.log`, `logs/`, `data/`, `temp/`, `tmp/`,
`secrets/`, `credentials/`, `config.local.*`. Verificar ausência de secret no
histórico antes de cada release.

**Status: a confirmar** — conferir `.gitignore` atual contra esta lista.

## 17. Segurança do navegador

CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`frame-ancestors 'none'`, `Permissions-Policy` restritiva. CORS fechado por
padrão — nunca `Access-Control-Allow-Origin: *` sem necessidade comprovada.

## 18. Privilégio mínimo

Não exigir admin/root, não alterar registro do Windows, não instalar
serviço, não executar PowerShell arbitrário nem script encontrado em log.
Logs são somente leitura.

**Status: implementado** — nenhum passo de instalação/execução do projeto
(`Iniciar_Monitoramento.command`/`.bat`) requer elevação; o app roda como
processo comum do usuário.

## 19. Integridade dos logs

Fluxo obrigatório: `arquivo original → leitura → processamento em
memória/cópia → dashboard`. Nunca o inverso (dashboard não pode alterar log
original).

## 20. Validação de entrada

Camada centralizada validando filtros, datas, nomes de RPA, IDs, nomes de
arquivo, parâmetros de API, caminhos, parâmetros de exportação — allowlist
sempre que possível.

## 21. Automation Anywhere — resposta da API

Tratar resposta do AA como dado não confiável: validar schema antes de usar;
nunca usar valor retornado para executar comando, construir caminho/SQL/HTML
ou determinar URL arbitrária. Timeout e tratamento seguro de falha de
conexão.

**Status: corrigido (SSRF via redirect)** — o proxy (`_forward`) seguia
redirecionamento 3xx do Control Room sem revalidar o novo destino, e havia
uma janela de TOCTOU/DNS rebinding entre a validação do host e a conexão de
verdade. Corrigido em 2026-09-27, ver Histórico de correções abaixo.

## 22. Segurança offline

Dashboard deve funcionar sem internet para análise de logs, exceto
funcionalidades explicitamente dependentes da API do Automation Anywhere.
Nenhuma funcionalidade básica depende de CDN externa.

## 23. Security review obrigatório

Antes de considerar qualquer feature concluída, revisar pelo menos: XSS, DOM
XSS, injection, command injection, path traversal, insecure file handling,
secret exposure, credential leakage, dependency vulnerabilities, permissive
CORS, insecure HTTP endpoints, unsafe deserialization, insecure temp files,
broken access boundaries, client-side secret storage, information
disclosure, formula injection. Classificar achados em CRITICAL/HIGH/MEDIUM/
LOW/INFO. CRITICAL e HIGH bloqueiam a conclusão da feature.

## 25. Processo de correção (regra para desenvolvimento com IA)

Nenhuma vulnerabilidade deve ser corrigida apenas ocultando o erro. Para
cada dado externo, verificar o fluxo completo: Entrada → Validação →
Processamento → Armazenamento → Exibição → Exportação — todo dado externo é
não confiável durante todo esse fluxo. Ao encontrar uma vulnerabilidade:

1. explicar a causa técnica;
2. indicar o impacto;
3. indicar o vetor de ataque;
4. corrigir;
5. criar teste de regressão;
6. registrar a correção abaixo.

---

## Histórico de correções

| Data | Vulnerabilidade | Causa | Impacto | Vetor | Correção | Teste de regressão |
|------|------------------|-------|---------|-------|----------|---------------------|
| 2026-09-27 | SSRF — redirecionamento não revalidado (MEDIUM) | `_forward` (`server.py`) chamava `urllib.request.urlopen` puro, que segue 3xx automaticamente sem reaplicar `_is_blocked_target` ao destino do `Location`. | Um Control Room malicioso/comprometido (ou um MITM na rede) podia responder `302 Location: http://169.254.169.254/...` ou `http://127.0.0.1:8765/...` e o servidor buscava sem filtrar, quebrando a proteção de SSRF que o código já dizia oferecer. | Resposta HTTP do endpoint AA configurado pelo usuário, controlada por quem controla/compromete esse endpoint. | Substituído por `_forward`/`_do_one_request` com `_NoFollowRedirectHandler` (desliga redirect automático) + laço que revalida cada `Location` via `_resolve_pinned_ip` antes de seguir, até `MAX_REDIRECTS=5`. | `test_redirect_to_blocked_target_is_not_followed`, `test_redirect_to_allowed_target_is_followed`, `test_forward_gives_up_after_too_many_redirects` (`test_server.py`), mais verificação manual end-to-end contra um redirect real (`httpbin.org/redirect-to`). |
| 2026-09-27 | SSRF — TOCTOU / DNS rebinding (MEDIUM) | `_is_blocked_target` resolvia o host uma vez para validar o IP, mas `urlopen` resolvia de novo (independentemente) ao conectar de verdade. | Um domínio com TTL curto sob controle do atacante podia responder um IP público na checagem e `127.0.0.1`/`169.254.169.254` na conexão real, sem invalidar a resposta. | Hostname do `baseUrl`/Control Room controlado por DNS malicioso ou comprometido. | `_resolve_pinned_ip` resolve uma única vez e devolve o IP; `_PinnedHTTPConnection`/`_PinnedHTTPSConnection` conectam exatamente nesse IP literal (nunca deixam a stdlib resolver de novo), preservando `server_hostname` correto para a verificação de certificado TLS. | Cobertura indireta pelos testes de `_is_blocked_target`/`_forward` acima (agora compartilham a mesma resolução única); validado manualmente contra HTTPS real (`api.github.com`) e HTTP real com redirect (`httpbin.org`) confirmando que a conexão de fato usa o IP pinado. |
| 2026-09-27 | XSS armazenado — `executionId` sem escape (MEDIUM) | `executionId` vem direto do arquivo de log (`server.py:405`, não sanitizado) e era interpolado cru em `innerHTML`/`onclick="...('${x.executionId}')"` em 5 pontos de `investigacao.html`, `diagnostico.html`, `rpa-dashboard.html` — enquanto todo outro campo já passava por `U.esc()`. Escapar HTML sozinho também não bastaria para o caso `onclick`: o valor ficava dentro de uma string JS dentro de um atributo HTML, e o navegador decodifica entidades HTML *antes* de compilar o handler inline, então `U.esc()` ali não fecharia a injeção de JS, só a de HTML. | Um `execution_id` malicioso num arquivo de log (gerado por uma automação comprometida, ou por qualquer processo com escrita na pasta compartilhada de logs) virava HTML/JS ao vivo na tela de quem abrisse aquela execução — confirmado ao vivo: `<img src=x onerror=...>` num `executionId` gerava um elemento real no DOM. | Arquivo `.log`/`.jsonl` em `logs/...` com um `execution_id` adversarial. | Removidos os 5 `onclick="RPAUI.open...('${...}')"` inline; substituídos por atributos `data-open-investigation`/`data-open-diagnostic` (sempre via `U.esc()`) lidos por um único listener delegado (`RPAUI.bindExecutionLinks()`, `assets/observability-core.js`) — o id nunca mais é reinterpretado como código, só lido como string via `.dataset`. Texto visível também passou a usar `U.esc()`. Efeito colateral positivo: elimina o achado informativo de que a própria CSP (`script-src` sem `unsafe-inline`) bloqueava esses `onclick` e impedia os botões "Investigar"/"Diagnóstico" de funcionar. | Verificado manualmente: `U.esc()` neutraliza um payload com `<`/`>` (renderiza como texto literal, sem criar elemento DOM), atributo `data-*` recebe o valor escapado corretamente, clique nos botões não gera mais `securitypolicyviolation` no console (Chrome, via `bs-rpa-monitor` rodando localmente). Não há teste automatizado de front-end no projeto (`test_server.py` cobre só o backend) — considerar adicionar se um harness de front-end for introduzido. |
| 2026-09-28 | Regressão — caminho de log corporativo (UNC) quebrava macOS/CI (LOW, não-segurança) | Um commit externo a esta sessão (`05e9b32`) trocou o `LOG_BASE` padrão para um caminho UNC do Windows (`\\servidor\...`) sem checagem de plataforma. Barra invertida não é separador de caminho no macOS/Linux, então o literal virava um nome de arquivo sem sentido ali. | 23 dos 75 testes (`TestDatasetBuilds`, `TestHttpServerRoutes`) passaram a ser pulados silenciosamente em qualquer máquina não-Windows (inclusive o runner `macos-latest` do CI) — sem erro visível, só "logs não encontrado". | Nenhum — bug de portabilidade, não de segurança. | `DEFAULT_DATA_ROOT` agora é condicional a `sys.platform.startswith('win')`: no Windows usa o caminho UNC corporativo (mantido exatamente como solicitado); em qualquer outro SO cai no padrão local de sempre (`ROOT/logs/...`), preservando o fluxo de dev/teste/CI. `RPA_MONITOR_DATA_ROOT` continua disponível para sobrescrever em qualquer SO. | Suíte completa (75/75) voltou a passar no macOS após a correção. |
| 2026-09-28 | Concorrência — Cadastro de RPAs sem lock numa pasta de rede compartilhada (mitigação proativa, não um incidente) | `META_FILE`/`AA_CONFIG_FILE` passaram a viver em `CONFIG_ROOT` (pasta de rede `Cadastro_RPA`, irmã de `Logs`/`VMS`, a pedido do responsável pelo projeto) — múltiplas máquinas passam a ler/escrever o MESMO `rpa_metadata.json`, mas `RpaRegistryStore` fazia só leitura→modificação→escrita sem qualquer exclusão mútua entre processos. | Duas máquinas chamando `create_rpa`/`update_rpa`/`delete_rpa` ao mesmo tempo podiam corromper o JSON (escritas intercaladas) ou perder silenciosamente a mudança uma da outra (last-write-wins sobre uma leitura já desatualizada). | Dois usuários usando o Cadastro de RPAs ao mesmo tempo, a partir de máquinas diferentes, contra o mesmo arquivo de rede. | `RpaRegistryStore._locked()`: trava por arquivo (`.lock`) criada atomicamente via `os.open(O_CREAT\|O_EXCL)`, segurada por todo o ciclo leitura→validação→escrita (não só a escrita final) de `create_rpa`/`update_rpa`/`delete_rpa`; espera com retry até 10s (`LOCK_TIMEOUT_SECONDS`) antes de desistir com erro claro (`RpaRegistryValidationError`); trava mais velha que 30s (`LOCK_STALE_SECONDS`) é tratada como abandonada (processo morto) e retomada, para um crash não travar todo mundo pra sempre. | `test_create_rpa_waits_for_lock_then_succeeds`, `test_create_rpa_raises_clear_error_when_lock_held_too_long`, `test_stale_lock_is_reclaimed_instead_of_blocking`, `test_concurrent_create_from_two_threads_does_not_lose_either_write` (este último com threads de verdade, confirmando que as duas gravações concorrentes sobrevivem) — `test_server.py`. |
| 2026-09-28 | Integridade de dado — rótulo "Base sintética" fixo nas páginas avulsas (LOW, não-segurança) | Verificação pedida pelo responsável do projeto ("confirmar que só dado real do caminho configurado é exibido") antes do deploy corporativo. `RpaPageNavigator.initToolbar` (`observability-core.js`) tinha o texto `Base sintética: ...` hardcoded, sem relação com a origem real do dado — mostraria isso mesmo com dados reais da empresa carregados via `LOG_BASE`/`CONFIG_ROOT`. Achado relacionado: o filtro de período da página "Execuções" (`#executionPeriod`) nunca funcionou; seu único efeito era um aviso dizendo "em produção isso deveria recarregar" — enganoso rodando de verdade em produção. | Nenhum dado falso era exibido (a checagem confirmou que `/assets/observability-data.js`/`index-data.js` sempre regeneram ao vivo do backend, nunca do fallback estático) — mas o rótulo podia levar o usuário a desconfiar erroneamente de dado real, ou a mensagem do filtro prometia um comportamento inexistente em produção. | N/A — texto estático, não influenciado por entrada externa. | Rótulo trocado para "Período dos dados: ..." (neutro, mesmo texto usado pelo dashboard principal); mensagem do filtro de período trocada para descrever a limitação real (filtro ainda não implementado) em vez de mencionar mock/produção. | Suíte completa (79/79 backend, 25/25 frontend) sem alteração de comportamento — mudança é só de texto exibido. |
| 2026-09-28 | Robustez — falha ao montar o dataset derrubava a conexão sem nenhuma informação (LOW, não-segurança — incidente real durante o deploy corporativo) | `do_GET` chamava `get_data()` sem tratamento de exceção em `/assets/observability-data.js`, `/assets/index-data.js` e `/api/status` — quando `META_FILE`/`RPA_LOG_ROOT` estão inacessíveis (ex.: `Cadastro_RPA/rpa_metadata.json` ainda não criado na pasta de rede), `FileNotFoundError` propagava sem tratamento até o `socketserver`, que resetava a conexão sem enviar nenhuma resposta. | Painel carregava em branco, sem nenhum erro visível na tela nem no Network tab (conexão resetada) — reproduzido ao vivo durante o deploy: exatamente esse cenário aconteceu na máquina do usuário. Diagnosticável só reproduzindo localmente com acesso ao código-fonte. | Caminho de dados (`CONFIG_ROOT`/`LOG_BASE`) mal configurado, inacessível ou ainda não populado — não é entrada externa/ataque. | `Handler._send_data_error`: as 3 rotas agora capturam a exceção, sempre logam o traceback completo (`traceback.print_exc()`) e devolvem HTTP 500 com a mensagem real no corpo (JS `console.error(...)` + `window.OBS_DATA/INDEX_DATA = null` para as duas primeiras, JSON `{ok:false, message:...}` para `/api/status`) — visível no Network tab do DevTools em vez de uma conexão resetada sem informação nenhuma. | `test_observability_data_route_surfaces_data_error_instead_of_dropping_connection`, `test_api_status_route_surfaces_data_error_instead_of_dropping_connection` (`test_server.py`, mockando `server.get_data` para simular a falha sem depender de um caminho de rede real). |
| 2026-09-28 | Robustez — mesmo bug do item acima, faltando nas rotas do Cadastro de RPAs (LOW, não-segurança — encontrado ao investigar uma pergunta do usuário sobre o comportamento do scan) | `GET /api/registry/rpas` (`list_rpas`) e `_handle_registry_post` (`create_rpa`/`update_rpa`/`delete_rpa`) não tinham a mesma proteção aplicada à rota de scan (`/api/registry/rpas/scan`, já corrigida ao ser criada) — `Cadastro_RPA` inacessível ainda derrubava a conexão ao listar ou salvar uma RPA. | Confirmado ao vivo: `POST /api/registry/rpas` com `Cadastro_RPA` inexistente resetava a conexão sem resposta nenhuma — o formulário só mostrava "Falha de comunicação com o servidor local", sem a causa real. | Mesmo de sempre: caminho de dados mal configurado/inacessível, não é ataque. | `Handler._send_registry_error(exc)`: nova rotina compartilhada por `list_rpas`, `scan_unregistered_processes` e o handler de POST — sempre loga o traceback completo e devolve `{'ok': false, 'error': <mensagem real>}` com HTTP 500, no mesmo formato que `RpaRegistryValidationError` já usava (campo `error` = texto pronto pra UI, não um código separado — evita a UI ter que saber dois formatos de erro diferentes). | `test_registry_rpas_route_surfaces_error_instead_of_dropping_connection`, `test_registry_scan_route_surfaces_error_instead_of_dropping_connection`, `test_registry_create_route_surfaces_error_instead_of_dropping_connection` (`test_server.py`, mockando o método do `rpa_registry` real). |
| 2026-09-28 | Empacotamento — remove a janela de terminal (`console=False`) sem perder diagnóstico | Pedido do responsável do projeto ("fica feio" ter uma janela de terminal atrás do painel). No Windows, `console=False` deixa `sys.stdout`/`sys.stderr` como `None` — sem tratamento, o primeiro `print()` (o próprio banner de inicialização) derrubaria o processo inteiro com `AttributeError`, e o traceback usado minutos antes para diagnosticar o item acima deixaria de existir em qualquer lugar. | N/A — mudança preventiva antes de aplicar `console=False`, não uma vulnerabilidade encontrada em produção. | Ambiente sem console (Windows nativamente; macOS também, por consistência). | `server.py` redireciona `stdout`/`stderr` para `RPA_Ops_Monitor.log` (criado ao lado do executável) sempre que `sys.frozen` é verdadeiro, antes de qualquer `print()` — preserva 100% do conteúdo que apareceria no console, só que em arquivo. `packaging/RPA_Ops_Monitor.spec`: `console=True` → `console=False`. | Build local (macOS) com `console=False`: confirmado que o processo inicia normalmente, `RPA_Ops_Monitor.log` recebe o banner de inicialização e o traceback completo do cenário de erro acima, e o painel serve dados reais — sem crash. |
| 2026-09-28 | Robustez — motivo real de falha de rede na integração AA nunca chegava a lugar nenhum (LOW, não-segurança — incidente real durante uso corporativo) | `authenticate`/`discover`/`activity`/proxy sempre devolviam ao usuário a mesma mensagem genérica ("Não foi possível alcançar a Control Room") quando `_forward` retornava um erro de rede — o motivo real (`net_err`: SSRF_BLOCKED, timeout, DNS, etc.) era calculado e depois descartado, nunca logado nem exposto. | Erro de autenticação em produção era indiagnosticável a distância — precisou de reprodução manual passo a passo (capturas de tela, `Test-NetConnection`, checagem de proxy) para descobrir a causa real. | N/A — lacuna de observabilidade, não um vetor de ataque. | `_forward` agora loga (stdout/`RPA_Ops_Monitor.log`) `[AA] {método} {url} -> {motivo}` em todo ponto de retorno de erro — nunca inclui headers/corpo (evita vazar token/API key), só o motivo já calculado. | Suíte completa (92/92 antes desta linha) sem alteração de comportamento — mudança é só logging. |
| 2026-09-28 | Robustez — proxy HTTP corporativo obrigatório bloqueava a integração Automation Anywhere (LOW, não-segurança — incidente real durante uso corporativo) | A rede da empresa só libera saída para a internet através de um proxy HTTP (descoberto pelo navegador via PAC — `netsh winhttp show proxy` não mostra nada porque é config de WinINet, não de WinHTTP); `_forward` sempre conectava direto no IP pinado (`_resolve_pinned_ip`/`_PinnedHTTPSConnection`), que o firewall de perímetro derruba com timeout mesmo para um IP público legítimo. | Conectar ao Automation Anywhere de uma máquina corporativa falhava sempre com "Não foi possível alcançar a Control Room", mesmo com API Key/URL corretos — confirmado ao vivo (`Test-NetConnection` com `TcpTestSucceeded: False`/timeout nos 3 IPs do domínio, enquanto o navegador abria o mesmo endereço normalmente via proxy). | N/A — bug de conectividade em rede específica, não um vetor de ataque externo. | Nova env var `RPA_MONITOR_AA_PROXY` (padrão `proxy.bradseg.com.br:80` só no Windows — mesmo padrão do `DEFAULT_DATA_ROOT`, valor obtido do `else` do PAC corporativo real, já que o projeto não embute um interpretador de PAC para evitar dependência externa). Quando configurado, `_forward` usa `_do_one_request_via_proxy` (túnel CONNECT via `urllib.request.ProxyHandler`, SNI correto) em vez do modo direto; a validação de destino passa a ser `_blocked_host_literal` (checagem textual, sem DNS, já que quem resolve o destino final é o proxy) em vez de `_resolve_pinned_ip` — ver THREAT_MODEL.md, cenário 11, para a análise de risco dessa mudança de postura. | `TestAutomationAnywhereProxyMode` (`test_server.py`): `_resolve_proxy` com/sem `AA_PROXY`; `_blocked_host_literal` barra loopback/link-local/`localhost` sem resolver DNS e permite domínio real sem resolver; `_forward` usa o transporte via proxy quando configurado (nunca tenta o modo direto); short-circuit em alvo bloqueado sem chamada de rede; redirecionamento para alvo bloqueado não é seguido — mesma cobertura de regressão de `TestAutomationAnywhereSsrfGuard`, agora também no modo proxy. Suíte completa: 99/99. |
| 2026-09-28 | Redução deliberada de postura — certificado TLS do proxy corporativo não é validado (decisão de risco aceito, não uma vulnerabilidade encontrada) | Confirmado em produção (log `[AA]`, após a correção de proxy acima destravar a conexão até a Control Room): o proxy corporativo faz inspeção de TLS e reemite um certificado próprio dentro do túnel CONNECT; esse certificado tem um defeito técnico real (falta a extensão X.509 "Authority Key Identifier") que o validador estrito do OpenSSL rejeita — `[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: Missing Authority Key Identifier`. O Windows/navegador aceita o mesmo certificado (CryptoAPI mais tolerante a essa falta específica), por isso a conexão via navegador funcionava normalmente enquanto a integração falhava sempre. | Sem essa mudança, a integração AA é inutilizável nesta rede corporativa — não existe workaround que preserve a validação de certificado sem o time de TI corrigir o certificado do proxy de inspeção (fora do controle deste projeto). Com a mudança: perde-se a proteção contra um MITM diferente do proxy corporativo entre o proxy e o Control Room real (um atacante nessa posição específica, depois do proxy, dentro da rede da empresa). | N/A — decisão de arquitetura diante de uma limitação de infraestrutura de rede, não uma entrada externa maliciosa. | `AutomationAnywhereGateway._proxy_tls_context()`: `ssl.create_default_context()` com `check_hostname=False`/`verify_mode=ssl.CERT_NONE`, usado só em `_do_one_request_via_proxy` (via `urllib.request.HTTPSHandler(context=...)`). Escopo estritamente limitado ao modo com proxy — `_do_one_request`/`_PinnedHTTPSConnection` (modo direto, usado sempre que `AA_PROXY` não está configurado) continuam validando certificado normalmente, sem nenhuma mudança. Decisão explícita do responsável do projeto, ciente do trade-off, preferindo destravar o uso imediato a esperar TI corrigir o certificado — ver THREAT_MODEL.md, cenário 12. | `test_proxy_tls_context_skips_certificate_verification` (`test_server.py`) confirma `check_hostname=False`/`verify_mode=ssl.CERT_NONE` no contexto usado pelo modo proxy; toda a suíte de `TestAutomationAnywhereSsrfGuard` (modo direto) roda sem alteração, confirmando que o modo sem proxy continua com a validação de certificado padrão do Python intacta. Suíte completa: 100/100. |
| 2026-09-29 | Ampliação de superfície — allowlist do proxy AA passou a aceitar `/v1/` (mitigação proativa, não uma vulnerabilidade encontrada) | Expansão da integração Automation Anywhere (capacidade "Usuários & Sessões", Search Users) exige `POST /v1/usermanagement/users/list` — o único módulo da API real que nunca migrou para v2+. `AutomationAnywhereGateway.PROXY_ALLOWED_PREFIXES` só aceitava `/v2/`, `/v3/`, `/v4/`. | Nenhum aumento de risco de SSRF (o allowlist de prefixo só limita QUAIS capacidades da Control Room o proxy alcança — quem bloqueia QUAL host é `_forward`/`_resolve_pinned_ip`, inalterado). O risco real é de escopo: uma API Key legítima mas mal-escopada, usada nesta integração, agora também consegue listar usuários/papéis da Control Room (metadados — usuário/e-mail/papel — nunca senha/token) através do dashboard, não só via UI oficial do AA. | N/A — mudança de configuração deliberada, não uma entrada externa maliciosa. | `PROXY_ALLOWED_PREFIXES` passou a `('/v1/', '/v2/', '/v3/', '/v4/')`; nova capability `users` (discovery via `CAPABILITY_PROBE`, mock em `_mock_generic`) exposta só quando a API Key conectada já tem permissão de "view users" na Control Room real (a própria API nega 403/`FORBIDDEN` caso contrário, como qualquer outra capability). Explicitamente **não** incluído: Credential Vault (nomes/lockers de credencial) — decisão do responsável do projeto de manter fora do escopo por ampliar demais a superfície de reconhecimento de um API Key vazado. | `test_generic_proxy_v1_usermanagement_users_mock`, `test_generic_proxy_v1_allowed_by_prefix_allowlist`, `test_discover_includes_users_capability`, `test_discover_sends_json_body_for_users_probe` (`test_server.py`). Suíte completa: 111/111. |
| 2026-09-29 | Redução deliberada de postura — token da integração AA passou a viver também em `sessionStorage` (decisão de risco aceita, a pedido explícito do responsável do projeto) | Até aqui o token só existia numa variável de módulo (`AASecretVault`, nunca exposta em `window`) — perdida a cada F5/navegação, forçando digitar a API Key de novo. Pedido explícito: "permitir que a sessão logada no Automation Anywhere persista até que o app seja fechado". `sessionStorage` é o único mecanismo do navegador com exatamente essa semântica (sobrevive a reload/navegação na mesma aba, some ao fechar a aba/janela, nunca vai a disco) — documentado até então como proibido na seção 4 deste arquivo. | Um XSS na mesma origem que hoje já teria diversas formas de abusar da sessão (chamar `/api/aa/proxy` via `fetch` usando os headers que o próprio `AAApiClient` monta) ganha, adicionalmente, uma forma trivial e padronizada de ler o token direto (`sessionStorage.getItem('aa_session_v1')`) em vez de precisar conhecer a estrutura interna do módulo — mitigado por: (1) a API Key em si (segredo de vida mais longa) nunca é persistida, só o token derivado; (2) `sessionStorage` é isolado por aba/origem, nunca compartilhado via `localStorage` entre abas; (3) `SESSION_EXPIRED` (401/403 da Control Room real) já limpa o storage imediatamente. Este projeto não tem XSS conhecido nesta superfície (ver histórico de correções 2026-09-27, já corrigido); o risco aceito é sobre uma classe de vulnerabilidade futura/hipotética, não uma encontrada agora. | Um XSS refletido/armazenado na mesma origem (nenhum conhecido hoje). | `AAConnectionManager._persistSession`/`_clearPersistedSession` (chave `sessionStorage['aa_session_v1']` = `{baseUrl, username, token, mock}`, nunca a API Key); `tryRestoreSession()` chamado uma vez no boot (`AutomationAnywhereApp.start`), reaproveita o probe de Activity + discovery já existentes (`_afterAuthenticated`, extraído de `connect()`) para validar o token salvo — um token expirado/inválido cai no fluxo `SESSION_EXPIRED` já existente (`apiClient.onSessionExpired`), que já limpa o storage. `disconnect()` limpa memória e `sessionStorage` juntos. | Verificado manualmente (Chrome, `claude-in-chrome`): conectar em modo mock, navegar entre páginas AA, recarregar a página (F5) e confirmar que a sessão volta a `CONNECTED_PARTIAL` sem reabrir o modal de login; `sessionStorage.getItem('aa_session_v1')` confirmado vazio após "Desconectar". Sem teste automatizado (não há harness de front-end no projeto — mesma lacuna já registrada na linha de XSS de 2026-09-27). |
| 2026-09-29 | Refatoração — Investigação e Diagnóstico fundidas em uma só tela (LOW, não-segurança, a pedido explícito do responsável do projeto: "não vejo necessidade em duas telas separadas") | `investigacao.html`/`diagnostico.html` eram duas páginas quase sempre abertas em sequência para a mesma execução, com 2 seções genuinamente duplicadas (telemetria de VM, lista de ocorrências relacionadas) e o resto complementar. | N/A — mudança de UX, nenhum dado novo exposto (mesmo `execution_id`, mesma guarda contra acesso sem parâmetro válido, mesmo `U.esc()` em tudo). | `diagnostico.html` removido; `investigacao.html` ganhou a classe `ExecutionDetailPage` (fusão de `InvestigacaoPage`+`DiagnosticoPage`, um método por seção, sem duplicar as 2 seções idênticas). Todo ponto que abria as duas páginas lado a lado (3 pares de botões em `dashboard-app.js`/`index.html`, mais `data-open-diagnostic` em `rpa-dashboard.html`) colapsado para um único botão/atributo. `RpaPageNavigator.openDiagnostic` e o suporte a `data-open-diagnostic` removidos de `observability-core.js` (não half-finished: nada mais os chama). | Suíte Python inalterada (111/111 — mudança é só front-end); verificado manualmente (Chrome): página mesclada renderiza todas as seções das duas antigas sem erro de console, e os locais que tinham 2 botões agora têm 1. |
| 2026-09-29 | Adição — histórico e gráficos de tendência no Control Room da integração AA (não-segurança), a pedido explícito do responsável do projeto ("carregar mais dados históricos com mais gráficos") | A Activity List de uma página só (200 itens) raramente cobre mais que algumas horas numa Control Room ativa — pouco para uma tendência diária. | N/A — usa só a capacidade `activity` já autorizada; nenhum endpoint/allowlist novo (ver linha "Ampliação de superfície" acima, que é sobre `users`, não esta). Único cuidado de robustez: paginar demais uma Control Room real gera mais chamadas HTTP — por isso o carregamento além de 1 página (200 itens) é sempre uma escolha explícita do usuário no seletor da tela, nunca automático. | `AAApiClient.fetchActivityHistory(maxPages, pageSize, onProgress)` pagina a Activity List com teto explícito (até 2.000 itens); `AARegistryScanExtension` refatorado para reusar o mesmo helper (evita duplicar a paginação). Novo painel "Histórico consolidado" no Control Room com 3 gráficos Chart.js (execuções/dia por status, duração média/dia, top automações por volume), cores de status reaproveitando o mesmo mapeamento de `_statusBadge`. Mock (`_mock_activities`) ampliado de 180 para 600 execuções de amostra para o histórico ter dias suficientes para exercitar a tendência em modo local. | Suíte Python inalterada (111/111 — mudança é só front-end + mock); verificado manualmente (Chrome, modo mock): troca de "200"→"2.000 atividades" carrega mais dias, barra de progresso aparece/some corretamente, gráficos redesenham sem erro de console. |
| 2026-09-29 | Adição — badge de erros em "Execuções AA" + botão "Ver detalhes" por linha (não-segurança), a pedido explícito do responsável do projeto | Nada sinalizava falha da AA no menu (só os badges locais de "Alertas"/"Falhas e incidentes" existiam); visualizar o detalhe de uma execução da AA dependia de saber que a linha inteira era clicável (sem affordance explícita). | N/A — mudança de UX, mesmo dado já autorizado pela capability `activity`. | Badge vermelho reaproveitando a mesma classe CSS `.nav-link .count` já usada pelos badges locais (`AA_NAV_ITEMS[…].badgeId`); contagem de `RUN_FAILED`/`FAILED` atualizada sempre que Control Room ou Execuções AA buscam a Activity List (`_updateActivityErrorBadge`, sem chamada de rede extra). Nova coluna "Detalhes" com botão explícito por linha, reaproveitando a mesma navegação para "Execução 360°" que o clique na linha já usava (`openDetail` compartilhado). | Suíte Python inalterada (111/111); verificado manualmente (Chrome, modo mock): badge mostrou a contagem correta e "Ver detalhes" abriu a Execução 360° da atividade certa. |
| 2026-09-29 | Adição — notificações nativas do sistema operacional para erro novo (local ou Automation Anywhere), a pedido explícito do responsável do projeto | Erros novos só apareciam se alguém estivesse olhando o dashboard aberto — nada avisava fora da aba. | N/A — usa a Web Notification API padrão do navegador, opt-in (exige clique do usuário + permissão concedida pelo próprio navegador, nunca solicitada/aceita programaticamente); nenhum dado sensível na notificação (só nome de RPA/automação e contagem, os mesmos já visíveis no dashboard); ícone é um SVG gerado na hora (`data:image/svg+xml`), permitido pela CSP já existente (`img-src 'self' data:`), nenhuma mudança de CSP necessária. | Novo `assets/notifications.js` (`RpaNotificationCenter`): permissão + flag de ligar/desligar (`localStorage`, separado da permissão do navegador), diff persistente "o que já foi visto" por namespace (semeia sem notificar na primeira checagem de cada namespace — evita enxurrada no primeiro uso), agrupa em UMA notificação por lote (nunca uma por item). Consumido por `NotificationBridge` (dashboard-app.js, alertas/incidentes locais, checado a cada `renderAll()` — cobre abertura do app e o refresh de 20 min) e por `AAPagesController._checkForNewFailures` (aa-integration.js, falhas da Control Room, checado ao conectar e a cada auto-refresh de 5 min da integração, independente de qual página está visível). Botão de sino novo no topbar (`#notificationsButton`). | Suíte Python inalterada (111/111 — mudança é só front-end); verificado manualmente (Chrome): lógica de diff/lote testada via console (semeia sem notificar na 1ª chamada, notifica só o item novo na 2ª, não repete na 3ª sem mudança); badge da AA populado em segundo plano via `_checkForNewFailures` sem nenhuma página AA visível; sem erro de console em todo o fluxo. O disparo real da notificação nativa (após permissão concedida por um humano) não pôde ser verificado por automação — pedir/conceder permissão de notificação é uma interação de UI do próprio navegador, fora do DOM da página, que a automação de browser não pode (nem deve) aceitar em nome do usuário. |
| 2026-09-29 | Pivô — notificação nativa passou do navegador (Web Notification API) para o backend Python (decisão de arquitetura, superando a linha anterior) | Confirmado ao vivo, a pedido do responsável do projeto ("ativa as notificações aí e testa de verdade"): o prompt de permissão do Chrome nunca ficou em estado utilizável via automação nem, no relato do usuário, era o formato desejado — ele queria explicitamente notificação "a nível de máquina", não amarrada a uma permissão por aba/origem do navegador. | N/A até aqui — mas a correção introduz uma SUPERFÍCIE NOVA que precisa de análise própria: um endpoint (`POST /api/notify`) que aciona um comando do SO (AppleScript/PowerShell/`notify-send`) com texto que, transitivamente, pode se originar de dado de log ou de nome de automação da Control Room — ambos classificados como NÃO CONFIÁVEIS (SECURITY.md seção 2/21). Sem cuidado, isso seria um injeção de comando: um `execution_id`/nome de RPA malicioso poderia fechar a string do script e executar comando arbitrário na máquina do usuário — categoria de vulnerabilidade muito mais grave que XSS (execução fora do navegador). | Um valor de log/nome-de-automação adversarial chegando a `DesktopNotifier.notify(title, body)`. | `DesktopNotifier` (server.py): título/corpo NUNCA interpolados dentro da string do script — sempre trafegam por variável de ambiente do subprocesso (`RPA_NOTIF_TITLE`/`RPA_NOTIF_BODY`), lida de DENTRO do AppleScript (`system attribute`) ou do PowerShell (`$env:`), nunca reanalisada como sintaxe; no Linux, vão como argv separado do `notify-send`, sem `shell=True` em nenhum ponto. `POST /api/notify` adicionado à mesma allowlist de CSRF+Origin de toda rota que muda estado (`protected` em `do_POST`) — nunca acessível sem o token CSRF da própria sessão. Título/corpo clipados (120/300 chars) e um rate-limit mínimo (2s) contra chamada repetida/em loop. `assets/notifications.js` reescrito: sem Web Notification API/permissão de navegador — `RpaNotificationCenter.push` agora faz `POST /api/notify`; `isEnabled()` vira só um flag nosso de ligar/desligar (localStorage), sem estado de permissão para verificar. Trade-off aceito: um toast do SO não tem como chamar de volta o JS da página ao ser clicado (`onClick` removido de `notifyNewBatch`) — diferente da Web Notification API. | `TestDesktopNotifier` (`test_server.py`, 6 casos): `_clip` trunca/remove quebra de linha; rate-limit bloqueia chamada repetida imediata; **regressão de injeção** — um payload adversarial (`" & do shell script "..." & "` no macOS, `'; Remove-Item ... '` no Windows) nunca aparece dentro da string do script montado, só na env var; Linux recebe título/corpo como argv separado, nunca `shell=True`; falha de subprocess nunca lança, só devolve `False`. `TestHttpServerRoutes`: `/api/notify` exige CSRF (403 sem token) e chama `DesktopNotifier.notify` com o payload esperado (mockado — rodar de verdade dispararia um toast real na máquina que roda a suíte). Suíte completa: 119/119. |
| 2026-09-29 | Robustez — VMs paravam de aparecer no ambiente corporativo (LOW, não-segurança — incidente real relatado pelo responsável do projeto: "não notei aparecerem no ambiente corporativo") | `VM_ROOT` decidia entre `VMS/Historico` e `VMS` (a estrutura oficial do compartilhamento pode usar qualquer uma) checando `.is_dir()` — mas essa checagem só rodava UMA VEZ, na importação do módulo (boot do processo), contra um caminho de REDE (UNC). Se o compartilhamento ainda não estivesse totalmente montado naquele instante exato (comum logo após login do Windows, ou se o processo é iniciado por tarefa agendada antes da rede terminar de montar), `.is_dir()` respondia `False` mesmo a pasta existindo segundos depois — e essa resposta errada ficava CONGELADA (`VM_ROOT` é constante de módulo) pelo resto da vida do processo, sem nenhum log explicando o motivo. | Telemetria de VM inteira ausente do dashboard (todas as VMs, todo o período) enquanto o processo estivesse de pé — só um restart completo do app "corrigia", e só por acaso (se a rede já estivesse pronta na próxima vez). Nenhum log indicava que o caminho escolhido estava errado; parecia "não tem dado" quando na real era "olhou no lugar errado". | N/A — bug de timing contra infraestrutura de rede própria, não uma entrada externa. | `_resolve_vm_root()` extraída como função (não mais uma constante calculada uma vez) e chamada de novo a cada `DatasetBuilder.build_dataset()` (não só no import) — se a resposta mudar desde a última vez, `log_store.vm_root` é atualizado em memória e o motivo é logado (`[BOOT] VM_ROOT recalculado: ... -> ...`); autocorrige no próximo refresh (manual ou automático a cada 20 min), sem precisar reiniciar o processo. Override explícito (`RPA_MONITOR_VM_ROOT`) continua tendo prioridade absoluta, nunca revalidado (quem define já sabe o caminho certo). Novo log de boot (`[BOOT] LOG_BASE=.../RPA_LOG_ROOT=.../VM_ROOT=... (existe: True/False)`) e um aviso quando um build fecha com 0 snapshots de VM, mostrando o caminho efetivamente escaneado — antes não havia NENHUM registro desses caminhos em `RPA_Ops_Monitor.log`, tornando o diagnóstico a distância impossível sem acesso direto à máquina. | `TestResolveVmRoot` (`test_server.py`, 5 casos): prefere `Historico` quando existe; cai para a base quando não existe; **recalcula dinamicamente** (simula "pasta não existe no boot" seguido de "pasta aparece depois" e confirma que a PRÓXIMA chamada já reflete a mudança, sem cache); override de env var sempre vence a autodetecção; `build_dataset()` de verdade propaga a nova resolução para `log_store.vm_root`. Suíte completa: 124/124. |

## Auditorias realizadas

- **2026-09-27** — Revisão de segurança do diff que introduziu o hostname
  amigável `bs.rpa-monitor.localhost` e a abertura automática em "modo app"
  do Chrome/Edge (`_open_as_app_window`, `subprocess.Popen`). Resultado:
  nenhum achado HIGH/MEDIUM. Detalhes: uso de lista de argumentos (sem
  `shell=True`), caminhos absolutos fixos (sem PATH hijacking), origem
  validada por igualdade exata em `set`, `.localhost` resolvido pelo próprio
  navegador (resistente a DNS rebinding).
- **2026-09-27** — Auditoria completa estilo pentest de toda a aplicação
  (servidor, front-end, integração Automation Anywhere, armazenamento de
  config). Nenhum CRITICAL/HIGH. Três MEDIUM (SSRF via redirect, SSRF via
  DNS rebinding/TOCTOU, XSS em `executionId`) — todos corrigidos no mesmo
  dia, ver Histórico de correções acima. Um achado informativo (CSP
  bloqueando os próprios botões da UI) resolvido como efeito colateral da
  correção de XSS. Um achado LOW (sem allowlist de rota estática — `GET
  /server.py`/`/config/aa_config.json` são baixáveis; sem segredo real
  neles, aceito como está). Path traversal no CRUD de `rpa_metadata.json`,
  CSRF (token + Origin), credenciais do AA em memória (nunca em disco/log) e
  mass-assignment do CRUD foram revisados e confirmados corretos.
- **2026-09-28** — Revisão da nova função "Escanear RPAs"
  (`scan_unregistered_processes`, `GET /api/registry/rpas/scan`) contra o
  checklist da seção 23. Nenhum achado. Pontos verificados: a rota é
  leitura pura (sem CSRF necessário, mesmo padrão das demais rotas GET);
  reaproveita a descoberta de arquivo já auditada (`_collect_exec_files`/
  `_read_cached`), nenhum caminho novo derivado de entrada externa; todo
  campo vindo do log (dado não confiável, ver `THREAT_MODEL.md` cenário 1)
  passa por `Fmt.escapeHtml`/`Fmt.fmtDateTime` (que nunca ecoa a string
  crua) antes de renderizar — inclusive no formulário pré-preenchido
  (`_fieldMarkup`, mesmo escape de sempre); a escrita real ainda passa
  inteira por `create_rpa`/`validate_payload`/`_extract_editable_fields` —
  o scan só sugere valores num formulário, nunca grava nada sozinho.
