RPA OBSERVABILITY MONITOR — GUIA DO PROJETO E DA ARQUITETURA
================================================================================

Este arquivo existe para que qualquer dev consiga entender a arquitetura e
fazer uma alteração com segurança sem precisar ler o projeto inteiro antes.

--------------------------------------------------------------------------------
INÍCIO RÁPIDO
--------------------------------------------------------------------------------
- macOS: dê duplo clique em Iniciar_Monitoramento.command
- Windows: dê duplo clique em Iniciar_Monitoramento.bat
- Alternativa: execute `python3 server.py` e abra http://127.0.0.1:8765/index.html
- Testes locais: `python3 test_server.py` (sem dependências, usa unittest da
  biblioteca padrão — ver seção TESTES mais abaixo).

POR QUE EXISTE UM SERVIDOR LOCAL?
Navegadores bloqueiam a leitura automática de arquivos .log locais quando um
HTML é aberto por file://. O servidor usa apenas a biblioteca padrão do
Python, escuta somente em 127.0.0.1 e permite que o painel leia os logs sem
upload, internet ou dependências externas.

--------------------------------------------------------------------------------
MAPA DE ARQUIVOS
--------------------------------------------------------------------------------
server.py                      parser dos logs + servidor HTTP local + a
                                integração opcional com Automation Anywhere.
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
                                DiagnosticPage, CatalogPage, RpaOpsApp).
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
                                responsáveis, arquivos de dependência.
config/aa_config.json          config NÃO-SENSÍVEL da integração AA
                                (URL/usuário) — nunca contém API Key/token.
config/dependencies/           arquivos de dependência fictícios usados pela
                                correlação "mudança × erro" da Investigação.
logs/                          logs fictícios de execução, eventos e
                                telemetria das VMs (92 dias).

--------------------------------------------------------------------------------
ARQUITETURA — VISÃO GERAL
--------------------------------------------------------------------------------

    logs/*.log, logs/*.jsonl
             │
             ▼
    server.py: DatasetBuilder.build_dataset(mode)  ← parseia e filtra por
             │                         janela de datas antes de abrir cada
             │                         arquivo (barato)
             ▼
    obs (dict "de detalhe": execuções, eventos por etapa, telemetria de VM)
             │
             ▼
    server.py: IndexBuilder.build_index(obs, ...)  ← agrega: KPIs, tendências,
             │                         Pareto de erros, confiabilidade/
             │                         utilização de VM, sugestão de
             │                         consolidação
             ▼
    idx (dict "agregado", consumido principalmente por index.html)
             │
             ├── GET /assets/observability-data.js → window.OBS_DATA = obs
             └── GET /assets/index-data.js          → window.INDEX_DATA = idx

`DataCache.get_data(mode)` cacheia (obs, idx) em memória por modo ('90d' ou
'full') e só reconstrói quando o fingerprint dos arquivos (contagem/
tamanho/mtime) muda — por isso um GET repetido não reprocessa os logs à toa.

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
  que comecem com /v2, /v3 ou /v4 — nunca uma URL arbitrária.

--------------------------------------------------------------------------------
TESTES
--------------------------------------------------------------------------------
`python3 test_server.py` roda uma suíte local (unittest da biblioteca
padrão, sem dependências) cobrindo: os regex de nome de arquivo de log, a
integração Automation Anywhere em modo mock (sem tocar em ./logs), um smoke
test de `build_dataset()` contra os logs reais do projeto, e as rotas HTTP
principais contra um servidor de verdade numa porta livre. Rodar uma classe
específica: `python3 -m unittest test_server.TestAutomationAnywhereGatewayMock -v`

`node --test test_dashboard.js` roda os testes das partes puras (sem DOM)
de assets/dashboard-app.js: `Fmt` inteira (formatação de datas, badges,
classificação de faixas de heatmap/métrica) e os dois mini-charts SVG de
`ChartService` (sparkline/lineChart). O resto do front-end (as classes
*Page, NavigationController, RpaDataStore, e as páginas avulsas) manipula
o DOM diretamente e continua verificado manualmente no navegador a cada
mudança, como sempre foi neste projeto.

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
