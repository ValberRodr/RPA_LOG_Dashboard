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
test_server.py                 suíte de testes local (unittest, sem deps).
index.html                     cockpit operacional — SPA de página única,
                                todo o JS inline num único <script>.
investigacao.html              investigação forense por execution_id.
diagnostico.html               diagnóstico técnico-operacional por execution_id.
rpa-dashboard.html             dashboard histórico individual da RPA.
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
    server.py: build_dataset(mode)   ← parseia e filtra por janela de datas
             │                         antes de abrir cada arquivo (barato)
             ▼
    obs (dict "de detalhe": execuções, eventos por etapa, telemetria de VM)
             │
             ▼
    server.py: build_index(obs, ...) ← agrega: KPIs, tendências, Pareto de
             │                         erros, confiabilidade/utilização de
             │                         VM, sugestão de consolidação
             ▼
    idx (dict "agregado", consumido principalmente por index.html)
             │
             ├── GET /assets/observability-data.js → window.OBS_DATA = obs
             └── GET /assets/index-data.js          → window.INDEX_DATA = idx

`get_data(mode)` cacheia (obs, idx) em memória por modo ('90d' ou 'full') e
só reconstrói quando o fingerprint dos arquivos (contagem/tamanho/mtime)
muda — por isso um GET repetido não reprocessa os logs à toa.

FRONT-END — index.html (o cockpit)
É uma SPA de arquivo único: um <script> só, sem módulos, sem bundler. Todas
as `function`/`const` de nível superior desse script viram globais
acessíveis por qualquer <script> carregado depois no mesmo documento — é
assim que assets/aa-integration.js consegue reaproveitar `$`, `$$`,
`escapeHtml`, `showToast`, `goToPage`, `DATA`, `window.OBS_DATA` sem
duplicá-los.

Convenções que você precisa conhecer para mexer em index.html:
- `DATA` é reatribuída a cada refresh (`DATA = window.INDEX_DATA`) — nunca
  guarde uma cópia de `DATA` ou de um campo dela numa constante fora de uma
  função; leia sempre em tempo de chamada.
- Cada página é uma `<section class="page" id="page-NOME">`; `goToPage(nome)`
  só alterna a classe `.active` entre elas. Adicionar uma página nova =
  criar a `<section>` + um botão `.nav-link` com `data-page="nome"` + uma
  função `renderNome()` chamada a partir de `renderAll()`.
- `renderAll()` roda uma vez no load e de novo a cada `reloadData()`
  (refresh de 20 min ou botão "Recarregar dados") — qualquer função de
  render nova precisa ser chamada a partir dali para se manter atualizada.
- Gráficos usam Chart.js (`chartRegistry`, `drawChart()`, `chartPalette()`).
  Charts construídos numa página ainda oculta (`display:none`) herdam um
  canvas com tamanho errado; por isso `goToPage()` força um `resize()` de
  todos os charts registrados, com duplo `requestAnimationFrame`, depois de
  trocar a página ativa — não remova isso.

FRONT-END — páginas avulsas (investigacao.html, diagnostico.html,
rpa-dashboard.html)
Cada uma é um HTML pequeno com um `<script>` que só lê `window.RPAUI`
(exportado por assets/observability-core.js) e monta a página. Não têm
sidebar/roteamento — abrem numa aba nova a partir de index.html, sempre com
um parâmetro na URL (`execution_id` ou `rpa_id`). Por segurança, nenhuma
delas cai num "exemplo" quando o parâmetro está ausente/inválido — mostram
uma mensagem de acesso inválido (ver seção SEGURANÇA).

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

Não há teste automatizado de front-end (index.html e as páginas avulsas) —
a verificação delas até hoje foi manual, no navegador, a cada mudança.

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
