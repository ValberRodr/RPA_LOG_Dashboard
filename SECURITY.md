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
  pela rede (isso violaria o primeiro item desta seção). Risco à parte:
  `config/rpa_metadata.json` compartilhado entre várias máquinas não tem
  lock/controle de concorrência — edições simultâneas por usuários
  diferentes podem se sobrescrever silenciosamente (perda de dado, não uma
  vulnerabilidade de segurança).

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
- preferencialmente só em memória durante a sessão;
- se persistido, usar armazenamento seguro do SO ou mecanismo criptográfico;
- "Desconectar" deve remover a credencial imediatamente de memória/persistência;
- nunca enviado para domínio diferente do endpoint configurado.

**Status: a confirmar** — auditoria em andamento sobre `aa_config.json`,
headers `X-AA-Base-Url`/`X-AA-Token` e o fluxo de desconexão.

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
