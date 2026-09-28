RPA OBSERVABILITY MONITOR — GUIA DO PROJETO E DA ARQUITETURA
================================================================================

Este arquivo existe para que qualquer dev consiga entender a arquitetura e
fazer uma alteração com segurança sem precisar ler o projeto inteiro antes.

--------------------------------------------------------------------------------
INÍCIO RÁPIDO
--------------------------------------------------------------------------------
- macOS: dê duplo clique em Iniciar_Monitoramento.command
- Windows: dê duplo clique em Iniciar_Monitoramento.bat
- Alternativa: execute `python3 server.py` — abre sozinho uma janela do
  Chrome/Edge em "modo app" (sem barra de endereço, abas ou menus, com cara
  de aplicativo próprio) em http://bs.rpa-monitor.localhost:8765/index.html
  (nome amigável em vez de "127.0.0.1"; funciona sem configuração extra no
  Windows e no macOS — Chrome/Edge/Firefox resolvem qualquer nome
  ".localhost" para 127.0.0.1 nativamente). Sem Chrome/Edge instalado, cai
  para o navegador padrão numa aba normal. Para mudar o nome ou a porta, use
  as variáveis de ambiente RPA_MONITOR_HOSTNAME e RPA_MONITOR_PORT.
- Testes locais: `python -m unittest -v test_server.py test_sqlite_log_store.py`
  e `node test_dashboard.js`. Não há workflow automático de testes.
- Executável sem precisar de Python instalado: `packaging/build_macos.sh`
  (macOS) ou `packaging/build_windows.bat` (Windows) geram uma pasta com o
  binário dentro (`dist/RPA_Ops_Monitor/`) — ou baixe pronto em Actions →
  "Build executáveis (Windows/macOS)" → Run workflow, no GitHub. Ver
  packaging/README.md. O executável abre sem janela de terminal
  (`console=False`, 2026-09-28) — stdout/stderr vão para
  `RPA_Ops_Monitor.log`, criado ao lado do executável; é o primeiro lugar a
  olhar se o painel abrir vazio ou algo parecer errado.
- Tela de carregamento inicial (2026-09-28): index.html mostra um overlay
  com % e fase enquanto o SQLite é criado/sincronizado e o dataset é montado
  (sonda /api/load-status, mesmo endpoint usado pela barra de atualização) — evita a aba parecer travada
  quando há muito mais arquivos que no dataset sintético local (ex.: log
  numa pasta de rede corporativa). Se a montagem falhar, o overlay mostra a
  mensagem real e não desaparece sozinho.

POR QUE EXISTE UM SERVIDOR LOCAL?
Navegadores bloqueiam a leitura automática de arquivos .log locais quando um
HTML é aberto por file://. O servidor usa apenas a biblioteca padrão do
Python, escuta somente em 127.0.0.1 e permite que o painel leia os logs sem
upload, internet ou dependências externas.

--------------------------------------------------------------------------------
MAPA DE ARQUIVOS
--------------------------------------------------------------------------------
server.py                      servidor HTTP local + montagem dos datasets sobre
                                SQLite + integração opcional com Automation Anywhere.
sqlite_log_store.py             cache persistente incremental dos logs; controla
                                offset por byte, manifesto e retries de leitura.
                                Pipeline de dataset organizado em classes
                                (TimeMath, IntervalMath,
                                VmReliabilityClassifier,
                                VmConsolidationPlanner, LogFileDiscovery,
                                LogFileReader, ScheduleMatcher,
                                DependencyAnalyzer, DatasetBuilder,
                                IndexBuilder, DataCache) — ver ARQUITETURA
                                abaixo.
test_server.py                 suíte de testes local do back-end (unittest, sem deps).
test_dashboard.js              suíte de testes local das partes puras do
                                front-end (node --test, sem deps).
index.html                     cockpit operacional — SPA de página única; o
                                HTML só tem markup + <style>, a lógica está
                                em assets/dashboard-app.js (ver abaixo).
assets/dashboard-app.js        todo o JavaScript de index.html, organizado em
                                classes (Fmt, ChartService, NavigationController,
                                RpaDataStore, e uma classe *Page por página:
                                OverviewPage, AlertsPage, ExecutionsPage,
                                IncidentsPage, InfrastructurePage, AuditPage,
                                DiagnosticPage, CatalogPage, RegistryPage,
                                RpaOpsApp).
investigacao.html              investigação forense por execution_id —
                                lógica na classe InvestigacaoPage (um método
                                por seção renderizada).
diagnostico.html                diagnóstico técnico-operacional por execution_id
                                — classe DiagnosticoPage.
rpa-dashboard.html             dashboard histórico individual da RPA —
                                classe RpaDashboardPage (filtros de
                                período/status/busca como propriedades da
                                instância).
assets/observability-core.js   kit de UI compartilhado pelas 3 páginas acima
                                (window.RPAUI) — formatação, acesso a dados,
                                mini-charts SVG, navegação entre páginas.
assets/observability.css       CSS compartilhado pelas 3 páginas acima
                                (index.html tem seu próprio <style> interno,
                                não usa este arquivo).
assets/aa-integration.js       módulo OPCIONAL de integração com a
                                Automation Anywhere 360 Control Room —
                                aditivo e removível (ver seção INTEGRAÇÃO
                                AUTOMATION ANYWHERE mais abaixo).
assets/aa-integration.css      estilos do módulo acima.
assets/chart.umd.min.js        Chart.js vendorizado (sem CDN) — usado só
                                por index.html.
assets/auto-refresh.js         badge + timer de atualização automática a
                                cada 20 min, compartilhado por todas as
                                páginas HTML.
assets/observability-data.js   fallback estático (window.OBS_DATA) usado só
                                se o HTML for aberto via file://; quando
                                servido por server.py, é substituído por uma
                                versão gerada em tempo real a partir dos logs.
assets/index-data.js           idem, mas a versão agregada (window.INDEX_DATA).
config/rpa_metadata.json       cadastro das RPAs: agenda, criticidade,
                                VM primária/contingência, benefícios,
                                responsáveis, arquivos de dependência. Editável
                                pelo próprio dashboard (menu "Cadastro de
                                RPAs" → RegistryPage no frontend,
                                RpaRegistryStore em server.py) — ver seção
                                CADASTRO DE RPAS mais abaixo.
config/aa_config.json          config NÃO-SENSÍVEL da integração AA
                                (URL/usuário) — nunca contém API Key/token.
config/dependencies/           arquivos de dependência fictícios usados pela
                                correlação "mudança × erro" da Investigação.
logs/                          logs fictícios de execução, eventos e
                                telemetria das VMs (92 dias).

--------------------------------------------------------------------------------
ARQUITETURA — VISÃO GERAL
--------------------------------------------------------------------------------

    Logs/*.log + VMS/*.jsonl
             │
             │ primeira execução: importa o histórico
             │ atualizações: somente arquivos novos/alterados
             ▼
    sqlite_log_store.py → rpa_ops_monitor.sqlite3
             │
             ├── manifesto por arquivo
             ├── processed_bytes / line_count / guard_hash
             ├── append-only: lê somente bytes novos
             └── retry de leitura: 8s → 30s → 90s quando o banco está ocupado
             │
             ▼
    server.py: DatasetBuilder.build_dataset(mode)
             │
             ├── 30 dias (padrão)
             ├── 90 dias
             ├── 120 dias
             └── todos os logs
             ▼
    obs → IndexBuilder.build_index(obs, ...) → idx
             │
             ├── /assets/observability-data.js
             └── /assets/index-data.js

Trocar o período consulta apenas o SQLite. O botão Atualizar sincroniza a
origem. Arquivos inalterados não são reabertos; arquivos que só cresceram são
lidos a partir do último byte confirmado. Truncamento/reescrita causa
reindexação daquele arquivo.

BACK-END — server.py (organização em classes)
O pipeline de dataset é organizado em classes por responsabilidade, cada
método mantendo o nome original (com underscore quando aplicável) como
`@staticmethod`: TimeMath (datas/percentil/mediana), IntervalMath (merge de
intervalos, minutos ocupados, concorrência máxima — usado por
VmConsolidationPlanner), VmReliabilityClassifier (classifica uma VM como
confiável/instável cruzando todas as RPAs que passam por ela),
VmConsolidationPlanner (sugestão de consolidação via coloração de grafo
gulosa Welsh-Powell), LogFileDiscovery (localizar/filtrar arquivos de log
por janela de datas), LogFileReader (leitura com cache incremental por
mtime+tamanho), ScheduleMatcher (cruza agenda esperada × execuções reais,
gera alertas de atraso/não-execução), DependencyAnalyzer (correlação
"mudança de dependência × erro" usada pela Investigação), DatasetBuilder
(`build_dataset`, um único método sequencial — deliberadamente não
fragmentado: o fluxo é de passagem única com muitas variáveis locais
interdependentes, e decompor mais aumentaria o risco de regressão sem
ganho real de clareza) e IndexBuilder (`build_index`, mesma lógica de não
fragmentar). Assim como em dashboard-app.js, cada método também tem um
alias solto de mesmo nome logo após as classes (`build_dataset =
DatasetBuilder.build_dataset` etc.) — nenhum ponto de chamada interno ou
externo (test_server.py, AutomationAnywhereGateway) precisou mudar.

FRONT-END — index.html + assets/dashboard-app.js (o cockpit)
index.html carrega assets/dashboard-app.js como um <script src> clássico —
SEM type="module" e SEM um IIFE envolvendo o arquivo inteiro, de propósito:
assets/aa-integration.js (carregado depois, como <script> irmão) lê por
nome `$`, `$$`, `escapeHtml`, `showToast`, `goToPage`, `DATA`,
`window.OBS_DATA`, `chartRegistry`, `drawChart`, `chartPalette` — scripts
clássicos sem módulo compartilham o mesmo ambiente léxico de topo, e é
assim que a integração opcional reaproveita tudo isso sem duplicar código.
Se envolver dashboard-app.js num IIFE ou convertê-lo para type="module",
esses identificadores somem do escopo global e a integração AA quebra.

dashboard-app.js organiza as antigas ~63 funções soltas em classes por
responsabilidade (Fmt, ChartService, UiFeedback, NavigationController,
RpaDataStore, e uma classe *Page por página do menu). Para não exigir
reescrever centenas de pontos de chamada, CADA função também tem um alias
solto de mesmo nome (`const renderTimeline = OverviewPage.renderTimeline;`
etc.) — o comportamento é idêntico a antes, só a organização mudou. `DATA`
continua uma variável solta reatribuível (nunca uma propriedade de classe)
porque é lida e reatribuída em dezenas de pontos.

Convenções que você precisa conhecer para mexer em dashboard-app.js:
- `DATA` é reatribuída a cada refresh (`DATA = window.INDEX_DATA`) — nunca
  guarde uma cópia de `DATA` ou de um campo dela numa constante fora de uma
  função; leia sempre em tempo de chamada.
- Cada página é uma `<section class="page" id="page-NOME">` em index.html;
  `NavigationController.goToPage(nome)` só alterna a classe `.active` entre
  elas. Adicionar uma página nova = criar a `<section>` em index.html + um
  botão `.nav-link` com `data-page="nome"` + um método `renderNome()` na
  classe *Page correspondente, chamado a partir de `RpaOpsApp.renderAll()`.
- `RpaOpsApp.renderAll()` roda uma vez no load e de novo a cada
  `RpaDataStore.reloadData()` (refresh de 20 min ou botão "Recarregar
  dados") — qualquer método de render novo precisa ser chamado a partir
  dali para se manter atualizado.
- Gráficos usam Chart.js (`ChartService.registry`, `.drawChart()`,
  `.chartPalette()`). Charts construídos numa página ainda oculta
  (`display:none`) herdam um canvas com tamanho errado; por isso
  `NavigationController.goToPage()` força um `resize()` de todos os charts
  registrados, com duplo `requestAnimationFrame`, depois de trocar a página
  ativa — não remova isso.
- `Fmt` e os métodos SVG-puros de `ChartService` (`sparkline`, `lineChart`)
  não tocam o DOM — são as únicas partes de dashboard-app.js testadas fora
  do navegador (test_dashboard.js, via `node --test`). O resto (as *Page,
  NavigationController, RpaDataStore) manipula elementos da página
  diretamente e continua verificado manualmente no navegador, como sempre
  foi neste projeto.

FRONT-END — páginas avulsas (investigacao.html, diagnostico.html,
rpa-dashboard.html)
Cada uma é um HTML pequeno com um `<script>` que só lê `window.RPAUI`
(exportado por assets/observability-core.js) e monta a página. Não têm
sidebar/roteamento — abrem numa aba nova a partir de index.html, sempre com
um parâmetro na URL (`execution_id` ou `rpa_id`). Por segurança, nenhuma
delas cai num "exemplo" quando o parâmetro está ausente/inválido — mostram
uma mensagem de acesso inválido (ver seção SEGURANÇA).

Cada página encapsula sua lógica numa única classe (InvestigacaoPage,
DiagnosticoPage, RpaDashboardPage): construtor recebe `window.RPAUI`,
`render()` faz a validação do parâmetro da URL + monta o estado
compartilhado (execução, RPA, eventos, telemetria de VM) como propriedades
da instância, e cada seção da página (hero, KPIs, evidências, gráficos,
tabela etc.) é um método próprio que lê esse estado via `this`. Diferente
de dashboard-app.js, aqui não há reuso entre páginas — a classe existe só
para nomear/isolar cada seção, não para compartilhar código. Em
RpaDashboardPage, os campos de filtro (período/status/busca) também viram
propriedades da instância (`bindFilters()`) para que os handlers de evento
consigam chamar `this.renderCharts()`/`this.renderTable()` sem variáveis
globais soltas.

--------------------------------------------------------------------------------
CADASTRO DE RPAS (CRUD do config/rpa_metadata.json)
--------------------------------------------------------------------------------
Menu "Cadastro de RPAs" (item novo em Contexto, ao lado de Catálogo): cria,
edita e remove RPAs sem editar o JSON manualmente. Ao contrário do Catálogo
(read-only, decorativo), esta tela grava de volta em
config/rpa_metadata.json.

Frontend: classe RegistryPage em assets/dashboard-app.js. `FIELD_GROUPS`
descreve o formulário inteiro em dados (grupo → campos → tipo) — o mesmo
array monta os inputs/selects/textareas e serializa/parseia os valores ao
abrir e salvar (`_serializeField`/`_parseField`, as únicas duas funções da
classe sem DOM, cobertas por test_dashboard.js). O modal é construído em
JS (não em index.html) e usa suas próprias classes CSS
(.registry-modal-overlay etc.) — nunca depende de aa-integration.css, que é
opcional e removível. Exclusão pede confirmação num modal próprio, nunca
`window.confirm()` (bloquearia o refresh incremental em andamento).

Backend: classe RpaRegistryStore em server.py, recebendo o caminho do
arquivo por injeção (mesmo padrão de AutomationAnywhereGateway) para os
testes usarem um arquivo temporário. `validate_payload` levanta
RpaRegistryValidationError com uma mensagem já pronta para a UI na primeira
violação (campo obrigatório ausente, processo duplicado, horário fora do
formato HH:MM, duração esperada > atenção > máxima, etc.). Toda mutação usa
escrita atômica (grava em .tmp e substitui o arquivo original) e
regenera automaticamente as regras de `schedules` daquela RPA a partir de
`schedule`/`calendar`/`startToleranceMin`/`warningDurationMin`/
`maxDurationMin` — ninguém precisa calcular latestStartTime/
warningFinishTime/deadlineTime à mão.

Rotas (sempre POST, mesmo para editar/remover — mesma convenção do proxy da
integração AA, verbo lógico no caminho em vez de PUT/DELETE reais):
GET /api/registry/rpas, POST /api/registry/rpas (criar),
POST /api/registry/rpas/{id}/update, POST /api/registry/rpas/{id}/delete.

"Escanear RPAs" (2026-09-28): botão na mesma página. GET
/api/registry/rpas/scan (RpaRegistryStore.scan_unregistered_processes)
varre TODO o histórico de logs por process_name sem entrada correspondente
no cadastro — necessário porque DatasetBuilder.build_dataset descarta
silenciosamente qualquer execução cujo processo não esteja cadastrado, então
uma automação nova rodando em produção nunca aparece em lugar nenhum até
alguém lembrar de cadastrar manualmente. Devolve, por processo, só o que dá
pra inferir com segurança da execução mais recente (VM, orquestrador, robô)
— nunca cria nada sozinho; cada resultado abre o formulário de criação
normal (RegistryPage.openForm(null, prefill)) já preenchido, pra um humano
revisar e completar antes de salvar.

Toda mutação bem-sucedida dispara `RpaDataStore.reloadData()` no frontend —
o dataset inteiro é recarregado e todas as páginas (KPIs, Catálogo,
Auditoria etc.) refletem a mudança na hora, sem reload do navegador.

--------------------------------------------------------------------------------
INTEGRAÇÃO AUTOMATION ANYWHERE (módulo opcional)
--------------------------------------------------------------------------------
assets/aa-integration.js/.css implementam uma camada OPCIONAL de conexão com
a Automation Anywhere 360 Control Room. É estritamente aditiva: apagar as
duas tags (<link>/<script>) em index.html desliga o módulo inteiro sem
afetar nada mais — nenhum dado, cálculo, página ou fluxo do dashboard
original depende dele.

Sem conectar, a única mudança visível é o botão "Automation Anywhere ·
Conectar" no topbar. Depois de conectar (API Key + Control Room, ou "mock"
para simular), um grupo de navegação novo aparece com até 10 páginas —
cada uma só fica visível se a capability correspondente estiver disponível
(discovery de capability roda uma vez, na conexão).

Arquitetura do módulo (todas as classes vivem dentro do IIFE de
aa-integration.js — ver o comentário no topo do arquivo para o mapa
completo): AASecretVault guarda API Key/token só em memória; AAApiClient
fala com /api/aa/* (nunca direto com a Control Room); AACorrelationEngine
classifica Activity × log local; AAConnectionManager é a máquina de
estados; as classes *View cuidam do DOM; AAPagesController renderiza as
10 páginas.

No backend, `AutomationAnywhereGateway` (em server.py) concentra config,
autenticação, discovery e o proxy para a Control Room — com um modo mock
(baseUrl vazio) que deriva respostas plausíveis dos próprios dados locais,
o suficiente para testar a integração inteira sem um Control Room real.
Quando houver um Control Room de verdade, basta preencher `aaBaseUrl` em
config/aa_config.json (ou nas variáveis de ambiente AA_BASE_URL/AA_USERNAME)
— nunca coloque API Key nesse arquivo, ela só existe em memória durante a
sessão conectada do navegador.

--------------------------------------------------------------------------------
SEGURANÇA
--------------------------------------------------------------------------------
- Nenhuma página de detalhe (investigacao/diagnostico/rpa-dashboard) aceita
  navegação direta sem um parâmetro válido na URL — não há fallback para
  "última execução"/"primeira RPA".
- A integração Automation Anywhere nunca grava API Key/token em disco,
  localStorage, sessionStorage, log ou PDF — só em variáveis de memória,
  descartadas ao desconectar ou fechar a aba.
- O proxy genérico da integração (`/api/aa/proxy`) só encaminha caminhos
  que comecem com /v2, /v3 ou /v4 — nunca uma URL arbitrária. `_forward`
  também recusa qualquer destino cujo host resolva para loopback, link-local
  ou o endpoint de metadata de nuvem (169.254.169.254) — defesa contra SSRF
  a partir de um `X-AA-Base-Url` malicioso, mantendo redes privadas (10/8,
  172.16/12, 192.168/16) liberadas de propósito (caso de uso legítimo:
  Control Room on-premises).
- O Cadastro de RPAs valida todo payload antes de gravar (campos
  obrigatórios, formato de horário, unicidade de processo, ordenação de
  duração, e que nenhum caminho de `dependencyFiles` escape da pasta do
  projeto — bloqueado tanto na entrada quanto de novo no ponto de uso, em
  DependencyAnalyzer) e escreve via arquivo temporário + substituição
  atômica — uma falha no meio da escrita nunca deixa
  config/rpa_metadata.json corrompido. `create_rpa`/`update_rpa` só copiam
  chaves conhecidas do payload (allow-list) para o arquivo — uma chamada
  direta à API não consegue gravar um campo arbitrário (mass assignment).
- CSRF: toda rota POST que muda estado (`/api/registry/rpas/*`,
  `/api/aa/*`, `/api/reload`) exige o cabeçalho `X-CSRF-Token`, obtido via
  `GET /api/csrf-token` — um token gerado uma vez por processo (reiniciar o
  servidor invalida qualquer token capturado antes) e comparado em tempo
  constante (`hmac.compare_digest`). Sem cookies/sessão, é essa a defesa
  contra um site malicioso aberto noutra aba do navegador forçar uma ação
  (ex.: apagar uma RPA) só com um `<form>`/`fetch(no-cors)` escondido — o
  servidor também rejeita qualquer requisição cujo header `Origin`, quando
  presente, não seja a própria origem do app. `/api/reload` deixou de ser
  GET por causa disso: uma GET com efeito colateral é disparável só com uma
  tag `<img>`, sem nenhum JavaScript.
- CSP sem `'unsafe-inline'` em `script-src`: cada resposta `.html` recebe um
  nonce novo por requisição, injetado em cada `<script>` inline daquela
  página — só esse nonce exato (ou um `<script src>` de `'self'`) executa.
  `style-src` mantém `'unsafe-inline'` de propósito (trade-off documentado
  em `Handler.end_headers` — remover exigiria reescrever toda a geração de
  `style="..."` dinâmico do frontend; CSS injetado não executa JavaScript
  arbitrário, o risco real de XSS).
- `Handler` bloqueia qualquer segmento de caminho começando com "." (nunca
  mais serve `.git/`, `.DS_Store` etc. — antes, o histórico completo do
  repositório era acessível via HTTP) e nunca lista o conteúdo de uma pasta
  (`/config/`, `/logs/` deixaram de expor um índice de arquivos).
- `do_POST` limita o corpo da requisição a 2 MB (`MAX_POST_BODY_BYTES`) e
  rejeita um `Content-Length` malformado — sem isso, um corpo arbitrariamente
  grande era lido inteiro em memória de uma vez.
- O mock de token da integração AA usa `hashlib` em vez do `hash()` nativo
  do Python (aleatorizado por processo via `PYTHONHASHSEED`, sem nenhuma
  garantia de estabilidade) — cosmético (nunca é um segredo real), mas
  correto por princípio.

--------------------------------------------------------------------------------
TESTES
--------------------------------------------------------------------------------
`python3 test_server.py` roda uma suíte local (unittest da biblioteca
padrão, sem dependências) cobrindo: os regex de nome de arquivo de log, a
integração Automation Anywhere em modo mock (sem tocar em ./logs), o guard
de SSRF de `_forward` (TestAutomationAnywhereSsrfGuard, sempre com IPs
literais — nunca depende de DNS/rede), o CRUD completo do Cadastro de RPAs
(RpaRegistryStore, sempre contra um arquivo JSON temporário — nunca
config/rpa_metadata.json real — incluindo path traversal e mass assignment),
um smoke test de `build_dataset()` contra os logs reais do projeto, e as
rotas HTTP principais contra um servidor de verdade numa porta livre —
inclusive CSRF/Origin, bloqueio de dotfiles/directory listing e o nonce de
CSP por requisição. Rodar uma classe específica:
`python3 -m unittest test_server.TestRpaRegistryStore -v`

`node --test test_dashboard.js` roda os testes das partes puras (sem DOM)
de assets/dashboard-app.js: `Fmt` inteira (formatação de datas, badges,
classificação de faixas de heatmap/métrica), os dois mini-charts SVG de
`ChartService` (sparkline/lineChart) e a serialização/parsing de campos do
formulário de `RegistryPage`. O resto do front-end (as classes *Page,
NavigationController, RpaDataStore, e as páginas avulsas) manipula o DOM
diretamente e continua verificado manualmente no navegador a cada mudança,
como sempre foi neste projeto.

--------------------------------------------------------------------------------
CARREGAMENTO E ATUALIZAÇÃO DOS DADOS
--------------------------------------------------------------------------------
- Os dados exibidos são montados diretamente dos arquivos em ./logs.
- A cada requisição o servidor verifica se houve mudança em quantidade,
  tamanho ou data de modificação dos logs; se algo mudou, o dataset é
  reconstruído (ver `get_data()` em server.py).
- Por padrão, a janela considerada é de 90 dias; o checkbox "Histórico
  completo" + "Recarregar dados" pede o período inteiro (`/api/reload?mode=full`).
- As páginas recarregam automaticamente a cada 20 minutos (assets/auto-refresh.js)
  e portanto passam a refletir os novos logs. O selo no canto inferior
  direito mostra o tempo até a próxima atualização.
- O refresh da integração Automation Anywhere é independente: a cada 5 min,
  só quando conectado, e nunca bloqueia o refresh de 20 min acima.

--------------------------------------------------------------------------------
NAVEGAÇÃO
--------------------------------------------------------------------------------
- Investigação e Diagnóstico não ficam no menu lateral — acesse pelos
  botões Auditar / Investigar / Diagnóstico em Execuções, Falhas/Incidentes
  ou na própria página Auditoria.
- No Catálogo, clicar em "Dashboard" numa RPA abre seu histórico dedicado
  em nova janela.
- Investigação, Diagnóstico e Dashboard da RPA exportam PDF pelo botão
  Exportar PDF (via impressão do navegador). As páginas novas da integração
  Automation Anywhere também exportam PDF, do mesmo jeito.

--------------------------------------------------------------------------------
DADOS FICTÍCIOS
--------------------------------------------------------------------------------
Período original: 25/06/2026 a 24/09/2026. 10 RPAs e 11 VMs.
