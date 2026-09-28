/* ============================================================================
   DASHBOARD APP — lógica do cockpit operacional (index.html)
   ----------------------------------------------------------------------------
   IMPORTANTE: este arquivo NÃO é envolto num IIFE de propósito. assets/
   aa-integration.js (carregado depois, como <script> irmão) lê por nome as
   variáveis/funções de nível superior definidas aqui (DATA, $, $$,
   escapeHtml, showToast, goToPage, fmtDateTime, fmtTime, chartRegistry,
   drawChart, chartPalette) — script clássicos sem type="module" compartilham
   o mesmo ambiente léxico de topo, e é assim que a integração opcional
   consegue reaproveitar tudo isso sem duplicar código. Se um dia isto virar
   um módulo ES real, essas variáveis precisam ser explicitamente exportadas
   para window primeiro.

   Organização: cada classe abaixo agrupa funções por responsabilidade (uma
   função antes solta virou um `static método` de alguma classe). Para não
   obrigar a reescrever centenas de pontos de chamada existentes, cada função
   também ganha um alias solto de mesmo nome no fim do arquivo — o
   comportamento e a assinatura são idênticos aos de antes, só a organização
   interna mudou. `DATA` continua uma variável solta reatribuível (não uma
   propriedade de classe) porque é lida e reatribuída em dezenas de pontos —
   ver comentário na seção BOOT mais abaixo.
   ============================================================================ */

/* =========================================================================
   Fmt — formatação pura (datas, badges, números). Nenhuma função aqui toca
   o DOM; são testáveis isoladamente (ver test_dashboard.js).
   ========================================================================= */
class Fmt {
    static fmtDateTime(value) {
        const d = new Date(value);
        return new Intl.DateTimeFormat('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        }).format(d);
    }

    static fmtTime(value) {
        return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    }

    static fmtHoursMinutes(totalMinutes) {
        const h = Math.floor(totalMinutes / 60);
        const m = Math.round(totalMinutes % 60);
        return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }

    static formatAuditDuration(seconds) {
        const value = Number(seconds || 0);
        if (value < 60) return `${value.toFixed(1)}s`;
        const min = Math.floor(value / 60);
        const sec = Math.round(value % 60);
        return `${min}m ${String(sec).padStart(2, '0')}s`;
    }

    static statusBadge(status) {
        const map = {
            SUCCESS: ['success', 'SUCESSO'], WARNING: ['warning', 'ATENÇÃO'], ERROR: ['danger', 'ERRO'],
            HEALTHY: ['success', 'NORMAL'], CRITICAL: ['danger', 'CRÍTICO'],
            CONNECTED: ['success', 'CONECTADO'], DISCONNECTED: ['danger', 'DESCONECTADO'], UNKNOWN: ['warning', 'DESCONHECIDO'],
            // Vocabulário de 11 estados operacionais (Seção 12 do briefing enterprise).
            AGUARDANDO: ['neutral', 'AGUARDANDO'], EXECUTANDO: ['info', 'EXECUTANDO'], SUCESSO: ['success', 'SUCESSO'],
            ATRASADA: ['warning', 'ATRASADA'], NAO_INICIOU: ['danger', 'NÃO INICIOU'], DURACAO_ANORMAL: ['warning', 'DURAÇÃO ANORMAL'],
            SLA_EM_RISCO: ['warning', 'SLA EM RISCO'], SLA_ESTOURADO: ['danger', 'SLA ESTOURADO'], VM_DEGRADADA: ['danger', 'VM DEGRADADA'],
        };
        const [cls, label] = map[status] || ['neutral', status];
        return `<span class="badge ${cls}"><span class="dot"></span>${label}</span>`;
    }

    static severityBadge(sev) {
        const map = {
            CRITICO: ['danger', 'CRÍTICO'], ALTO: ['warning', 'ALTO'], ATENCAO: ['warning', 'ATENÇÃO'], INFORMATIVO: ['info', 'INFORMATIVO'],
        };
        const [cls, label] = map[sev] || ['neutral', sev];
        return `<span class="badge ${cls}"><span class="dot"></span>${label}</span>`;
    }

    static criticalityBadge(value) {
        const cls = value === 'CRÍTICA' ? 'danger' : value === 'ALTA' ? 'warning' : 'neutral';
        return `<span class="badge ${cls}">${Fmt.escapeHtml(value)}</span>`;
    }

    static auditComplianceBadge(value) {
        if (!value) return '<span class="badge neutral">SEM REGRA</span>';
        if (value === 'NO_PRAZO' || value === 'NORMAL') return `<span class="badge success">${Fmt.escapeHtml(value.replaceAll('_', ' '))}</span>`;
        if (value === 'DEGRADADA' || value === 'ATRASADA') return `<span class="badge warning">${Fmt.escapeHtml(value.replaceAll('_', ' '))}</span>`;
        return `<span class="badge danger">${Fmt.escapeHtml(value.replaceAll('_', ' '))}</span>`;
    }

    static auditStatusIcon(status) {
        const config = {
            SUCCESS: { cls: 'success', icon: 'i-check', label: 'Sucesso' },
            WARNING: { cls: 'warning', icon: 'i-triangle', label: 'Atenção' },
            ERROR: { cls: 'error', icon: 'i-x', label: 'Erro' },
        };
        const c = config[status] || { cls: 'warning', icon: 'i-triangle', label: status };
        return `
            <div class="audit-status-icon ${c.cls}" title="${Fmt.escapeHtml(c.label)}" aria-label="${Fmt.escapeHtml(c.label)}">
                <svg class="icon"><use href="#${c.icon}"></use></svg>
            </div>
        `;
    }

    static heatClass(value, max) {
        if (!value) return 'heat-0';
        const ratio = value / Math.max(1, max);
        if (ratio <= .25) return 'heat-1';
        if (ratio <= .5) return 'heat-2';
        if (ratio <= .75) return 'heat-3';
        return 'heat-4';
    }

    static metricClass(value, warning, critical) {
        if (value >= critical) return 'danger';
        if (value >= warning) return 'warning';
        return 'success';
    }

    static escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
    }

    static clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }
}

/* =========================================================================
   DomUtils — os dois seletores usados em todo o arquivo.
   ========================================================================= */
class DomUtils {
    static $(selector, scope = document) { return scope.querySelector(selector); }
    static $$(selector, scope = document) { return [...scope.querySelectorAll(selector)]; }
}

/* =========================================================================
   UiFeedback — toast e tooltip flutuante compartilhados por todas as páginas.
   ========================================================================= */
class UiFeedback {
    static showToast(message) {
        const toast = DomUtils.$('#toast');
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(UiFeedback._timer);
        UiFeedback._timer = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    static showTooltip(event, htmlText) {
        const tooltip = DomUtils.$('#tooltip');
        tooltip.innerHTML = htmlText;
        tooltip.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 320)}px`;
        tooltip.style.top = `${Math.min(event.clientY + 14, window.innerHeight - 120)}px`;
        tooltip.classList.add('show');
    }

    static hideTooltip() {
        DomUtils.$('#tooltip').classList.remove('show');
    }
}

/* =========================================================================
   ChartService — paleta lida das variáveis CSS atuais (acompanha o tema
   claro/escuro), registro de instâncias Chart.js (evita "Canvas is already
   in use" ao rerenderizar após um refresh incremental) e os dois mini-charts
   em SVG puro usados por algumas páginas.
   ========================================================================= */
class ChartService {
    static registry = {};

    static themeColor(varName, fallback) {
        const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
        return v || fallback;
    }

    static chartPalette() {
        return {
            primary: ChartService.themeColor('--primary', '#6c68e7'),
            success: ChartService.themeColor('--success', '#35c58b'),
            warning: ChartService.themeColor('--warning', '#f2b84b'),
            danger: ChartService.themeColor('--danger', '#f06464'),
            info: ChartService.themeColor('--info', '#63a4ff'),
            text: ChartService.themeColor('--text-2', '#a8adbd'),
            textMuted: ChartService.themeColor('--text-3', '#747a8e'),
            grid: ChartService.themeColor('--border', 'rgba(255,255,255,.08)'),
            panel: ChartService.themeColor('--panel', '#1c1e25'),
        };
    }

    static drawChart(canvasId, config) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        if (ChartService.registry[canvasId]) ChartService.registry[canvasId].destroy();
        const chart = new Chart(canvas, config);
        ChartService.registry[canvasId] = chart;
        return chart;
    }

    static tooltipBase(p) {
        return {
            backgroundColor: 'rgba(15,17,23,.96)', borderColor: p.grid, borderWidth: 1,
            padding: 10, titleColor: '#fff', bodyColor: p.text, displayColors: false,
            titleFont: { weight: '700', size: 11.5 }, bodyFont: { size: 11 }, boxPadding: 4,
        };
    }

    static redrawThemedCharts() {
        if (!window.Chart) return;
        renderSuccessTrend();
        renderHourlyLoad();
        renderVmIdleTrend();
    }

    static sparkline(values, stroke = 'var(--primary)', fill = 'none', height = 38) {
        if (!values?.length) return '';
        const width = 180;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = Math.max(1, max - min);
        const points = values.map((v, i) => {
            const x = (i / Math.max(1, values.length - 1)) * width;
            const y = height - 4 - ((v - min) / range) * (height - 8);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        return `
            <svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
                <polyline points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>
            </svg>
        `;
    }

    static lineChart(rows, valueKey, options = {}) {
        const width = 760;
        const height = 240;
        const pad = { l: 34, r: 12, t: 18, b: 34 };
        const values = rows.map(r => r[valueKey]);
        const yMin = options.min ?? Math.max(0, Math.floor(Math.min(...values) - 5));
        const yMax = options.max ?? Math.min(100, Math.ceil(Math.max(...values) + 5));
        const xStep = (width - pad.l - pad.r) / Math.max(1, rows.length - 1);
        const y = (v) => pad.t + (yMax - v) / Math.max(1, yMax - yMin) * (height - pad.t - pad.b);
        const points = rows.map((r, i) => `${(pad.l + i * xStep).toFixed(1)},${y(r[valueKey]).toFixed(1)}`).join(' ');

        const gridValues = [yMin, yMin + (yMax - yMin) * .25, yMin + (yMax - yMin) * .5, yMin + (yMax - yMin) * .75, yMax];
        const grids = gridValues.map(v => `
            <line x1="${pad.l}" y1="${y(v)}" x2="${width - pad.r}" y2="${y(v)}" class="chart-grid-line"></line>
            <text x="${pad.l - 7}" y="${y(v) + 3}" text-anchor="end" class="axis-label">${Math.round(v)}%</text>
        `).join('');

        const labels = rows.map((r, i) => i % 2 === 0 || rows.length < 9 ? `
            <text x="${pad.l + i * xStep}" y="${height - 10}" text-anchor="middle" class="axis-label">${r.date}</text>
        ` : '').join('');

        const circles = rows.map((r, i) => `
            <circle cx="${pad.l + i * xStep}" cy="${y(r[valueKey])}" r="3.2" fill="var(--primary)"
                data-tip="${r.date}: ${r[valueKey]}%"></circle>
        `).join('');

        return `
            <svg class="chart-svg interactive-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${Fmt.escapeHtml(options.label || '')}">
                ${grids}
                <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
                ${circles}
                ${labels}
            </svg>
        `;
    }
}

/* =========================================================================
   NavigationController — troca de página, workspace de execução (nova aba),
   dica de rolagem horizontal, e o "cabeamento" dos controles globais do
   topbar/sidebar (tema, busca, menu mobile, filtros de cada página).
   ========================================================================= */
class NavigationController {
    static goToPage(pageName) {
        sessionStorage.setItem('rpaOpsActivePage', pageName);
        DomUtils.$$('.nav-link').forEach(link => link.classList.toggle('active', link.dataset.page === pageName));
        DomUtils.$$('.page').forEach(page => page.classList.toggle('active', page.id === `page-${pageName}`));
        document.body.classList.remove('sidebar-open');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // Larguras só ficam mensuráveis depois que a página vira visível:
        // gráficos Chart.js construídos enquanto a página estava oculta
        // (display:none) herdam um tamanho de canvas obsoleto e nunca se
        // realinham sozinhos — precisam de um resize() explícito aqui.
        NavigationController.refreshOverflowHints();
        // Um único rAF às vezes ainda cai antes do reflow terminar (a troca
        // de classe .active só é aplicada de fato no frame seguinte) — o
        // duplo rAF garante que o layout já assentou.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                Object.values(ChartService.registry).forEach(chart => chart.resize());
            });
        });
    }

    /* macOS (e outros) esconde a barra de rolagem até o hover/gesto — sem
       aviso, tabela ou heatmap mais largo que o card parece cortado, não
       "role para o lado". Mostra uma dica de texto sempre que o conteúdo
       realmente ultrapassa a largura visível. */
    static refreshOverflowHints(scope = document) {
        DomUtils.$$('.table-wrap, .heatmap-wrap', scope).forEach(el => {
            let hint = el.nextElementSibling;
            if (!hint || !hint.classList.contains('scroll-hint')) {
                hint = document.createElement('div');
                hint.className = 'scroll-hint';
                hint.textContent = '↔ role para o lado para ver mais colunas';
                el.after(hint);
            }
            hint.style.display = (el.scrollWidth - el.clientWidth > 2) ? 'block' : 'none';
        });
    }

    static openExecutionWorkspace(page, executionId = window.ACTIVE_EXECUTION_ID) {
        if (!executionId) {
            UiFeedback.showToast('Selecione uma execução antes de abrir esta visão.');
            return;
        }
        window.open(`${page}?execution_id=${encodeURIComponent(executionId)}`, '_blank');
    }

    static bindFilterListeners() {
        DomUtils.$('#overviewRpaFilter').addEventListener('change', renderRpaOpsTable);
        DomUtils.$('#overviewStatusFilter').addEventListener('change', renderRpaOpsTable);
        DomUtils.$('#alertSeverityFilter')?.addEventListener('change', renderAlerts);
        DomUtils.$('#paretoDimensionSelect')?.addEventListener('change', renderErrorPareto);
        DomUtils.$('#auditRpaSelect')?.addEventListener('change', (ev) => {
            populateAuditExecutionSelect(ev.target.value);
            const nextExecution = DomUtils.$('#auditExecutionSelect')?.value;
            if (nextExecution) openAuditExecution(nextExecution);
        });
        DomUtils.$('#auditExecutionSelect')?.addEventListener('change', (ev) => {
            if (ev.target.value) openAuditExecution(ev.target.value);
        });
    }

    /* Bindings que no arquivo original rodavam imediatamente ao carregar o
       script (não dentro de init()) — mantidos no mesmo momento do boot
       para preservar a ordem de execução original. */
    static bindGlobalControls() {
        DomUtils.$$('.nav-link').forEach(link => link.addEventListener('click', () => {
            if (link.dataset.externalPage) {
                NavigationController.openExecutionWorkspace(link.dataset.externalPage);
                return;
            }
            NavigationController.goToPage(link.dataset.page);
        }));
        DomUtils.$$('[data-go-page]').forEach(button => button.addEventListener('click', () => NavigationController.goToPage(button.dataset.goPage)));
        DomUtils.$('#mobileMenu').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));

        DomUtils.$('#themeButton').addEventListener('click', () => {
            const root = document.documentElement;
            const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
            root.dataset.theme = next;
            DomUtils.$('#themeIcon use').setAttribute('href', next === 'dark' ? '#i-sun' : '#i-moon');
            localStorage.setItem('rpa-monitor-theme', next);
            // Cores do Chart.js são fixadas na criação — sem isso os
            // gráficos ficariam com a paleta do tema anterior até o
            // próximo reload.
            ChartService.redrawThemedCharts();
        });

        const savedTheme = localStorage.getItem('rpa-monitor-theme');
        if (savedTheme) {
            document.documentElement.dataset.theme = savedTheme;
            DomUtils.$('#themeIcon use').setAttribute('href', savedTheme === 'dark' ? '#i-sun' : '#i-moon');
        }

        DomUtils.$('#refreshButton').addEventListener('click', () => {
            const icon = DomUtils.$('#refreshButton .icon');
            icon.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 480 });
            reloadData(DATA.loadStats?.mode || '30d', true);
        });

        DomUtils.$('#globalSearch').addEventListener('input', (event) => {
            const query = event.target.value.trim().toLowerCase();
            DomUtils.$$('[data-search-text]').forEach(row => {
                row.style.display = !query || row.dataset.searchText.includes(query) ? '' : 'none';
            });
        });
    }
}

/* =========================================================================
   CsrfTokenStore — busca e cacheia o token CSRF exigido pelo servidor em
   toda rota POST que muda estado (server.py, Handler._csrf_token_is_valid).
   Buscado uma vez via GET /api/csrf-token e reaproveitado; assets/
   aa-integration.js também usa esta classe (bare name, mesmo padrão de
   escopo léxico compartilhado do resto deste arquivo) para anexar o
   cabeçalho em toda chamada a /api/aa/*.
   ========================================================================= */
class CsrfTokenStore {
    static _token = null;
    static _pending = null;

    static async get() {
        if (CsrfTokenStore._token) return CsrfTokenStore._token;
        if (!CsrfTokenStore._pending) {
            CsrfTokenStore._pending = fetch('/api/csrf-token', { cache: 'no-store' })
                .then(r => r.json())
                .then(r => { CsrfTokenStore._token = r.token; return r.token; })
                .finally(() => { CsrfTokenStore._pending = null; });
        }
        return CsrfTokenStore._pending;
    }
}

/* =========================================================================
   RpaDataStore — acesso a DATA/OBS_DATA, montagem do detalhe de auditoria e
   todo o ciclo de carregamento incremental (30/90/120 dias / histórico completo).
   ========================================================================= */
class RpaDataStore {
    static PHASE_LABELS = {
        'localizando arquivos': 'Localizando arquivos',
        'filtrando período': 'Filtrando período',
        'indexando histórico no SQLite': 'Criando banco SQLite com o histórico',
        'sincronizando novos logs': 'Sincronizando arquivos novos/alterados',
        'consultando banco SQLite': 'Consultando banco SQLite',
        'consultando execuções no SQLite': 'Carregando execuções do banco',
        'consultando etapas no SQLite': 'Carregando etapas do banco',
        'consultando telemetria no SQLite': 'Carregando telemetria do banco',
        'aguardando atualização': 'Preparando atualização',
        'vinculando execuções e agenda': 'Vinculando execuções e agenda',
        'calculando indicadores': 'Calculando indicadores',
        'atualizando visualizações': 'Atualizando visualizações',
        'concluido': 'Concluído',
    };

    static _reloadInFlight = false;

    static buildAuditDetail(obs, executionId) {
        const e = obs.executions.find(item => item.executionId === executionId);
        if (!e) return null;
        const r = obs.rpas.find(item => item.rpaId === e.rpaId);
        const steps = (obs.eventsByExecution[e.executionId] || []).map(step => ({ ...step }));
        return {
            executionId: e.executionId, rpaId: e.rpaId, rpa: r?.name || e.process, process: e.process,
            robotName: e.robotName, orchestrator: e.orchestrator, environment: e.environment,
            status: e.status, start: e.start, end: e.end, durationMin: e.durationMin, machine: e.machine, version: e.version,
            totalItems: e.totalItems, processedItems: e.processedItems, successItems: e.successItems, warningItems: e.warningItems,
            errorItems: e.errorItems, retries: e.retryCount, steps, scheduledStart: e.scheduledDatetime,
            scheduleId: e.scheduleId || obs.schedules.find(s => s.rpaId === e.rpaId && s.scheduledTime === e.scheduledTime)?.scheduleId,
            expectedRunKey: e.expectedRunKey || `ER-${e.rpaId}-${e.start.slice(0, 10).replaceAll('-', '')}-${(e.scheduledTime || '00:00').replace(':', '')}`,
            startCompliance: e.startCompliance, durationCompliance: e.durationCompliance, deadlineCompliance: e.deadlineCompliance,
        };
    }

    static buildAuditExecutions(obs) {
        const result = {};
        const latestDate = DATA.periodEnd;
        obs.executions.filter(e => e.start.slice(0, 10) === latestDate).forEach(e => {
            result[e.executionId] = RpaDataStore.buildAuditDetail(obs, e.executionId);
        });
        return result;
    }

    /* Reconstrói, para cada etapa da RPA selecionada, a duração e a
       recorrência de erro nas DEMAIS execuções do período carregado —
       nunca inclui a execução em auditoria no próprio histórico. */
    static computeStepHistory(rpaId, currentExecutionId) {
        const obs = window.OBS_DATA;
        const byStep = new Map();
        obs.executions
            .filter(e => e.rpaId === rpaId && e.executionId !== currentExecutionId)
            .sort((a, b) => a.start.localeCompare(b.start))
            .forEach(e => {
                (obs.eventsByExecution[e.executionId] || []).forEach(s => {
                    if (!byStep.has(s.step)) byStep.set(s.step, { durations: [], errors: 0, total: 0, lastError: null });
                    const rec = byStep.get(s.step);
                    rec.total++;
                    rec.durations.push(Number(s.durationSec || 0));
                    if (s.status === 'ERROR') {
                        rec.errors++;
                        if (!rec.lastError || e.start > rec.lastError.date) {
                            rec.lastError = { executionId: e.executionId, date: e.start, message: s.errorMessage || s.message || '' };
                        }
                    }
                });
            });
        return byStep;
    }

    static setLoadProgress(status) {
        const bar = DomUtils.$('#loadProgress');
        const fill = DomUtils.$('#loadProgressFill');
        const label = DomUtils.$('#loadProgressLabel');
        if (!bar || !status) return;
        bar.classList.add('active');
        label.classList.add('active');
        fill.style.width = `${status.percent || 0}%`;
        const phaseText = RpaDataStore.PHASE_LABELS[status.phase] || status.phase;
        label.textContent = `Atualizando dados — ${phaseText}… ${status.percent || 0}% · ${status.filesProcessed || 0}/${status.filesFound || 0} arquivos`;
    }

    static hideLoadProgress() {
        DomUtils.$('#loadProgress')?.classList.remove('active');
        DomUtils.$('#loadProgressLabel')?.classList.remove('active');
    }

    static async pollLoadStatus() {
        const started = Date.now();
        while (Date.now() - started < 10 * 60 * 1000) {
            let status;
            try {
                status = await fetch('/api/load-status', { cache: 'no-store' }).then(r => r.json());
            } catch {
                return null; // servidor não disponível (aberto via file://, por exemplo)
            }
            RpaDataStore.setLoadProgress(status);
            if (status.phase === 'concluido' || status.phase === 'erro') return status;
            await new Promise(r => setTimeout(r, 350));
        }
        return null;
    }

    static fetchScript(src) {
        return new Promise((resolve, reject) => {
            const el = document.createElement('script');
            const separator = src.includes('?') ? '&' : '?';
            el.src = `${src}${separator}t=${Date.now()}`;
            el.onload = () => { el.remove(); resolve(); };
            el.onerror = () => { el.remove(); reject(new Error(`Falha ao carregar ${src}`)); };
            document.head.appendChild(el);
        });
    }

    /* O botão "Recarregar dados" e o refresh automático de 20 minutos usam
       este mesmo caminho: dispara /api/reload em segundo plano no servidor,
       acompanha o progresso real por fase via /api/load-status, e só então
       rebusca os dois arquivos de dados — sem jamais recarregar a página
       (preserva página ativa, filtros e scroll). */
    static async reloadData(mode, syncSource = true) {
        if (RpaDataStore._reloadInFlight) return;
        if (location.protocol !== 'http:' && location.protocol !== 'https:') {
            UiFeedback.showToast('Recarregar dados exige o servidor local (server.py). Abra via http://127.0.0.1:8765/.');
            return;
        }
        RpaDataStore._reloadInFlight = true;
        const reloadButton = DomUtils.$('#reloadButton');
        if (reloadButton) reloadButton.disabled = true;
        try {
            const response = await fetch(`/api/reload?mode=${encodeURIComponent(mode)}&sync=${syncSource ? '1' : '0'}`, {
                method: 'POST',
                cache: 'no-store',
                headers: { 'X-CSRF-Token': await CsrfTokenStore.get() },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const finalStatus = await RpaDataStore.pollLoadStatus();
            if (finalStatus && finalStatus.phase === 'erro') {
                UiFeedback.showToast(`Falha ao atualizar dados: ${finalStatus.error || 'erro desconhecido'}.`);
                return;
            }
            await RpaDataStore.fetchScript(`/assets/observability-data.js?mode=${encodeURIComponent(mode)}`);
            await RpaDataStore.fetchScript(`/assets/index-data.js?mode=${encodeURIComponent(mode)}`);
            DATA = window.INDEX_DATA;
            DATA.auditExecutions = RpaDataStore.buildAuditExecutions(window.OBS_DATA);
            window.ACTIVE_EXECUTION_ID = DATA.executionDetail?.executionId || DATA.timeline?.[0]?.executionId || window.ACTIVE_EXECUTION_ID;
            renderAll();
            const labels = { '30d': 'Últimos 30 dias', '90d': 'Últimos 90 dias', '120d': 'Últimos 120 dias', full: 'Todos os logs' };
            const sourceMsg = syncSource ? ' · banco atualizado' : '';
            UiFeedback.showToast(`${labels[mode] || 'Período atualizado'}${sourceMsg}.`);
        } catch (exc) {
            UiFeedback.showToast('Não foi possível atualizar os dados agora.');
        } finally {
            RpaDataStore._reloadInFlight = false;
            if (reloadButton) reloadButton.disabled = false;
            setTimeout(() => RpaDataStore.hideLoadProgress(), 900);
        }
    }
}

/* =========================================================================
   OverviewPage — "Visão operacional": KPIs do parque, timeline do dia,
   fila de incidentes recentes, qualidade dos dados, padrão histórico por
   horário, ociosidade/utilização de VM, confiabilidade por VM (erro
   específico de 1 RPA × erro geral da máquina) e a sugestão de consolidação.
   ========================================================================= */
class OverviewPage {
    static RELIABILITY_META = {
        SAUDAVEL: { label: 'Saudável', cls: 'success', icon: 'i-check' },
        ATENCAO: { label: 'Atenção', cls: 'warning', icon: 'i-triangle' },
        PROBLEMA_ESPECIFICO: { label: 'Específico de 1 RPA', cls: 'warning', icon: 'i-diagnostic' },
        PROBLEMA_GERAL: { label: 'Problema geral da VM', cls: 'danger', icon: 'i-alert' },
        DADOS_INSUFICIENTES: { label: 'Dados insuficientes', cls: 'neutral', icon: 'i-clock' },
    };

    static CONSOLIDATION_PALETTE = ['#6c68e7', '#43c6d9', '#f2b84b', '#35c58b', '#f06464', '#63a4ff', '#c084fc', '#fb923c'];

    static renderOverviewKpis() {
        const s = DATA.summary;
        const kpis = [
            { icon: 'i-activity', iconClass: 'info', label: 'Execuções últimas 24h', value: s.executions24h, footer: `${s.success24h} sucesso • ${s.warning24h} atenção • ${s.error24h} erro` },
            { icon: 'i-check', iconClass: 'success', label: 'Taxa de sucesso', value: `${s.successRate24h}%`, footer: 'Últimas 24h', trend: s.successRate24h >= 95 ? 'Dentro do esperado' : 'Abaixo da referência', trendClass: s.successRate24h >= 95 ? 'trend-positive' : 'trend-warning' },
            { icon: 'i-alert', iconClass: 'danger', label: 'RPAs críticas agora', value: s.criticalRpas, footer: `${s.warningRpas} com atenção`, trend: s.criticalRpas ? 'Requer sustentação' : 'Sem bloqueios', trendClass: s.criticalRpas ? 'trend-negative' : 'trend-positive' },
            { icon: 'i-triangle', iconClass: 'danger', label: 'Não iniciou / SLA em risco', value: (s.notStarted || 0) + (s.slaAtRisk || 0), footer: `${s.notStarted || 0} não iniciou • ${s.slaAtRisk || 0} SLA em risco`, trend: (s.notStarted || 0) ? 'Verifique a agenda' : 'Agenda em dia', trendClass: (s.notStarted || 0) ? 'trend-negative' : 'trend-positive' },
            { icon: 'i-server', iconClass: 'info', label: 'VMs disponíveis', value: `${DATA.vms.filter(v => v.rdp === 'CONNECTED').length}/${s.totalVms}`, footer: 'Conectividade RDP', trend: `${DATA.vms.filter(v => v.health !== 'HEALTHY').length} degradadas`, trendClass: 'trend-warning' },
            { icon: 'i-grid', iconClass: 'warning', label: 'Parque monitorado', value: s.totalRpas, footer: 'RPAs em produção', trend: `${s.totalVms} VMs`, trendClass: '' },
            { icon: 'i-clock', iconClass: s.avgVmIdlePercent24h >= 70 ? 'success' : 'warning', label: 'Ociosidade média das VMs', value: `${s.avgVmIdlePercent24h}%`, footer: 'Últimas 24h, frota inteira', trend: s.avgVmIdlePercent24h >= 70 ? 'Capacidade de sobra' : 'Frota ocupada', trendClass: s.avgVmIdlePercent24h >= 70 ? 'trend-positive' : 'trend-warning' },
            { icon: 'i-activity', iconClass: 'info', label: 'Tempo total de execução', value: Fmt.fmtHoursMinutes(s.totalExecutionMinutes24h), footer: 'Somado, todas as RPAs • 24h', trend: `${s.executions24h} execuções`, trendClass: '' },
            { icon: 'i-server', iconClass: s.maxConcurrencyVm?.value > 1 ? 'warning' : 'success', label: 'Maior concorrência de VM', value: s.maxConcurrencyVm?.value > 1 ? `${s.maxConcurrencyVm.value}×` : '—', footer: s.maxConcurrencyVm?.value > 1 ? `${s.maxConcurrencyVm.machine} · execuções simultâneas` : 'Nenhuma VM com execuções sobrepostas', trend: s.maxConcurrencyVm?.value > 1 ? 'Risco de contenção' : 'Sem contenção', trendClass: s.maxConcurrencyVm?.value > 1 ? 'trend-warning' : 'trend-positive' },
        ];

        DomUtils.$('#overviewKpis').innerHTML = kpis.map(k => `
            <article class="card kpi-card">
                <div class="kpi-top">
                    <div>
                        <div class="kpi-label">${k.label}</div>
                        <div class="kpi-value">${k.value}</div>
                    </div>
                    <div class="kpi-icon ${k.iconClass}">
                        <svg class="icon"><use href="#${k.icon}"></use></svg>
                    </div>
                </div>
                <div class="kpi-footer">
                    <span>${k.footer}</span>
                    <span class="${k.trendClass || ''}">${k.trend || ''}</span>
                </div>
            </article>
        `).join('');
    }

    static populateRpaFilterOptions() {
        const select = DomUtils.$('#overviewRpaFilter');
        const current = select.value;
        select.innerHTML = `<option value="ALL">Todas as RPAs</option>` +
            DATA.rpas.map(r => `<option value="${Fmt.escapeHtml(r.process)}">${Fmt.escapeHtml(r.name)}</option>`).join('');
        if ([...select.options].some(o => o.value === current)) select.value = current;
    }

    static renderRpaOpsTable() {
        const processFilter = DomUtils.$('#overviewRpaFilter').value;
        const statusFilter = DomUtils.$('#overviewStatusFilter').value;
        const tbody = DomUtils.$('#rpaOpsTable');

        const stateRank = {
            NAO_INICIOU: 0, SLA_ESTOURADO: 1, ERROR: 2, VM_DEGRADADA: 3, SLA_EM_RISCO: 4,
            DURACAO_ANORMAL: 5, ATRASADA: 6, WARNING: 7, AGUARDANDO: 8, EXECUTANDO: 9, SUCESSO: 10,
        };
        const rows = [...DATA.rpas]
            .filter(r => processFilter === 'ALL' || r.process === processFilter)
            .filter(r => statusFilter === 'ALL' || r.lastStatus === statusFilter)
            .sort((a, b) => (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9) || a.name.localeCompare(b.name));

        tbody.innerHTML = rows.map(r => {
            const durationRatio = r.lastDurationMin / Math.max(1, r.expectedDurationMin);
            const durationClass = durationRatio > 1.4 ? 'trend-negative' : durationRatio > 1.15 ? 'trend-warning' : '';
            return `
                <tr class="clickable-row" data-process="${Fmt.escapeHtml(r.process)}" data-search-text="${Fmt.escapeHtml((r.name + ' ' + r.process + ' ' + r.machine + ' ' + r.lastStatus + ' ' + r.state).toLowerCase())}">
                    <td>
                        <span class="cell-title">${Fmt.escapeHtml(r.name)}</span>
                        <span class="cell-subtitle">${Fmt.escapeHtml(r.process)}</span>
                    </td>
                    <td>${Fmt.statusBadge(r.state || r.lastStatus)}</td>
                    <td>${Fmt.fmtDateTime(r.lastExecution)}</td>
                    <td>${Fmt.fmtDateTime(r.lastSuccess)}</td>
                    <td class="${durationClass}"><strong>${r.lastDurationMin} min</strong><span class="cell-subtitle">esperado ~ ${r.expectedDurationMin} min</span></td>
                    <td>${r.retryCount}</td>
                    <td><span class="mono">${r.machine}</span></td>
                </tr>
            `;
        }).join('') || `<tr><td colspan="7"><div class="empty-state">Nenhuma RPA corresponde aos filtros.</div></td></tr>`;

        DomUtils.$$('.clickable-row', tbody).forEach(row => row.addEventListener('click', () => {
            const process = row.dataset.process;
            const rpa = DATA.rpas.find(x => x.process === process);
            if (rpa) window.open(`rpa-dashboard.html?rpa_id=${encodeURIComponent(rpa.id)}`, '_blank');
        }));
    }

    static renderTimeline() {
        // Agrupa por RPA e por hora do dia (0-23h). O farol de cada célula
        // mostra o pior status ocorrido naquela hora (ERROR > WARNING >
        // SUCCESS); o tamanho da caixa nunca muda — quem varia é só a cor
        // do farol e, se houver mais de uma execução na mesma hora, um
        // contador discreto no canto.
        const rank = { ERROR: 0, WARNING: 1, SUCCESS: 2 };
        const byProcess = new Map();
        DATA.timeline.forEach(run => {
            if (!byProcess.has(run.process)) byProcess.set(run.process, []);
            byProcess.get(run.process).push(run);
        });
        const hours = Array.from({ length: 24 }, (_, i) => i);
        const hourHeader = hours.map(h => `<div>${String(h).padStart(2, '0')}</div>`).join('');

        const rows = DATA.rpas.map(rpa => {
            const runs = byProcess.get(rpa.process) || [];
            const byHour = new Map();
            runs.forEach(run => {
                const h = Math.min(23, Math.floor(run.startMinute / 60));
                if (!byHour.has(h)) byHour.set(h, []);
                byHour.get(h).push(run);
            });

            const cells = hours.map(h => {
                const runsInHour = (byHour.get(h) || []).slice().sort((a, b) => rank[a.status] - rank[b.status]);
                if (!runsInHour.length) {
                    return `<div class="timeline-cell" data-tip="${Fmt.escapeHtml(rpa.name)}<br>${String(h).padStart(2, '0')}h • sem execução"><span class="timeline-farol"></span></div>`;
                }
                const worst = runsInHour[0];
                const tip = [`${Fmt.escapeHtml(rpa.name)} • ${String(h).padStart(2, '0')}h`, ...runsInHour.map(r =>
                    `${r.start} • ${Fmt.escapeHtml(r.status)} • ${r.durationMin} min • ${Fmt.escapeHtml(r.executionId)}`
                )].join('<br>');
                const count = runsInHour.length > 1 ? `<span class="timeline-cell-count">${runsInHour.length}×</span>` : '';
                return `<div class="timeline-cell has-run ${worst.status}" data-tip="${tip}" data-execution-id="${worst.executionId}"><span class="timeline-farol"></span>${count}</div>`;
            }).join('');

            return `
                <div class="timeline-grid-row">
                    <div class="timeline-row-label" title="${Fmt.escapeHtml(rpa.process)}">${Fmt.escapeHtml(rpa.name)}</div>
                    <div class="timeline-row-cells">${cells}</div>
                </div>
            `;
        }).join('');

        DomUtils.$('#timelineContainer').innerHTML = `
            <div class="timeline-grid">
                <div class="timeline-grid-row">
                    <div></div>
                    <div class="timeline-hour-row">${hourHeader}</div>
                </div>
                ${rows}
            </div>
            <div class="timeline-legend">
                <span><span class="timeline-farol" style="background:#2fac7b"></span>Sucesso</span>
                <span><span class="timeline-farol" style="background:#c89437"></span>Atenção</span>
                <span><span class="timeline-farol" style="background:#d85252"></span>Erro</span>
                <span><span class="timeline-farol"></span>Sem execução</span>
                <span>2× — mais de uma execução na mesma hora, farol mostra o pior status</span>
            </div>
        `;
        DomUtils.$('#timelineCountBadge').textContent = `${DATA.timeline.length} execuções no dia`;

        DomUtils.$$('.timeline-cell.has-run').forEach(cell => {
            cell.addEventListener('mousemove', e => UiFeedback.showTooltip(e, cell.dataset.tip));
            cell.addEventListener('mouseleave', UiFeedback.hideTooltip);
            cell.addEventListener('click', () => openAuditExecution(cell.dataset.executionId));
        });
        DomUtils.$$('.timeline-cell:not(.has-run)').forEach(cell => {
            cell.addEventListener('mousemove', e => UiFeedback.showTooltip(e, cell.dataset.tip));
            cell.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }

    static renderIncidentQueue() {
        const recent = DATA.incidents.slice(0, 5);
        DomUtils.$('#openIncidentBadge').textContent = `${DATA.incidents.filter(i => i.status === 'OPEN').length} aberta`;
        DomUtils.$('#navIncidentCount').textContent = DATA.incidents.filter(i => i.status === 'OPEN').length;
        DomUtils.$('#incidentQueue').innerHTML = recent.map(incident => `
            <div class="incident-item" data-execution-id="${incident.executionId}" data-search-text="${Fmt.escapeHtml((incident.rpa + ' ' + incident.errorCode + ' ' + incident.step + ' ' + incident.machine).toLowerCase())}">
                <div class="incident-head">
                    <div>
                        <div class="incident-title">${Fmt.escapeHtml(incident.rpa)}</div>
                        <div class="incident-meta">${Fmt.fmtDateTime(incident.timestamp)} • ${Fmt.escapeHtml(incident.step)}</div>
                    </div>
                    <span class="badge danger">${Fmt.escapeHtml(incident.errorCode)}</span>
                </div>
                <div class="incident-message">${Fmt.escapeHtml(incident.message)}</div>
            </div>
        `).join('');

        DomUtils.$$('.incident-item').forEach(item => item.addEventListener('click', () => {
            openAuditExecution(item.dataset.executionId);
        }));
    }

    static renderVmCompactList() {
        const list = [...DATA.vms].sort((a, b) => {
            const rank = { CRITICAL: 0, WARNING: 1, HEALTHY: 2 };
            return rank[a.health] - rank[b.health] || b.memory - a.memory;
        }).slice(0, 5);

        DomUtils.$('#vmCompactList').innerHTML = list.map(vm => `
            <div style="display:grid;grid-template-columns:140px 1fr 54px;gap:10px;align-items:center;margin:10px 0">
                <div>
                    <div class="cell-title mono">${vm.name}</div>
                    <div class="cell-subtitle">${vm.assignedRpas[0] || 'Contingência'}</div>
                </div>
                <div>
                    <div class="progress-track"><div class="progress-fill ${vm.memory >= 85 ? 'danger' : vm.memory >= 75 ? 'warning' : 'success'}" style="width:${vm.memory}%"></div></div>
                </div>
                <div style="text-align:right;font-size:11px">${vm.memory}% RAM</div>
            </div>
        `).join('');
    }

    /* Torna visível na UI o que antes só existia no stderr do processo
       Python: arquivos ignorados ou parcialmente inválidos na carga atual
       (Seção 25/49/50 do briefing enterprise). */
    static renderDataQuality() {
        const issues = window.OBS_DATA?.loadIssues || [];
        const badge = DomUtils.$('#qualityBadge');
        if (badge) {
            badge.textContent = issues.length ? `${issues.length} problema${issues.length === 1 ? '' : 's'}` : '0 problemas';
            badge.className = `badge ${issues.length ? 'warning' : 'neutral'}`;
        }
        const target = DomUtils.$('#dataQualityList');
        if (!target) return;

        const db = DATA.loadStats?.database || {};
        const dbStatus = `
            <div class="quality-row">
                <div class="q-file mono">${Fmt.escapeHtml(db.file || 'rpa_ops_monitor.sqlite3')}
                    <div class="q-meta">Cache persistente SQLite</div>
                </div>
                <div class="q-meta">${Number(db.sourceFiles || 0).toLocaleString('pt-BR')} arquivos-fonte indexados</div>
                <div class="q-error">${Number(db.records || 0).toLocaleString('pt-BR')} registros no banco</div>
                <div class="q-action">Última sincronização: ${db.lastSyncAt ? Fmt.fmtDateTime(db.lastSyncAt) : 'ainda não registrada'}</div>
            </div>
        `;

        if (!issues.length) {
            target.innerHTML = dbStatus + `<div class="empty-state">Nenhum arquivo inválido ou ignorado na carga atual.</div>`;
            return;
        }
        target.innerHTML = dbStatus + issues.slice(0, 20).map(i => `
            <div class="quality-row">
                <div class="q-file mono">${Fmt.escapeHtml(i.file)}<div class="q-meta">${Fmt.escapeHtml(i.path)}</div></div>
                <div class="q-meta">${Fmt.escapeHtml(i.type)} • fase: ${Fmt.escapeHtml(i.phase)}</div>
                <div class="q-error">${Fmt.escapeHtml(i.error)}</div>
                <div class="q-action">${Fmt.escapeHtml(i.action)}</div>
            </div>
        `).join('');
    }

    static renderLoadPeriodLabel() {
        const stats = DATA.loadStats;
        const label = DomUtils.$('#snapshotLabel');
        if (!label) return;
        if (!stats) { label.textContent = `Snapshot ${Fmt.fmtDateTime(DATA.snapshot)}`; return; }
        if (stats.mode === 'full') {
            label.textContent = 'Período carregado: histórico completo';
        } else {
            const start = stats.windowStart ? new Date(stats.windowStart + 'T12:00:00').toLocaleDateString('pt-BR') : '—';
            const end = stats.windowEnd ? new Date(stats.windowEnd + 'T12:00:00').toLocaleDateString('pt-BR') : '—';
            const modeLabel = { '30d': '30 dias', '90d': '90 dias', '120d': '120 dias' }[stats.mode] || 'período selecionado';
            label.textContent = `Período carregado: últimos ${modeLabel} (${start} → ${end})`;
        }
    }

    /* Heatmap RPA × hora do dia, agregado em TODO o período carregado — não
       apenas o dia do snapshot. Responde "em que horário este parque
       historicamente concentra erro", diferente da timeline (que mostra só
       hoje). */
    static renderHistoricalHeatmap() {
        const executions = window.OBS_DATA?.executions || [];
        const hours = Array.from({ length: 24 }, (_, i) => i);
        const byRpaHour = new Map();
        executions.forEach(e => {
            const hour = new Date(e.start).getHours();
            const key = `${e.rpaId}|${hour}`;
            const cell = byRpaHour.get(key) || { total: 0, error: 0 };
            cell.total++;
            if (e.status === 'ERROR') cell.error++;
            byRpaHour.set(key, cell);
        });
        const max = Math.max(1, ...[...byRpaHour.values()].map(c => c.error));
        const hourLabels = hours.map(h => `<div class="heatmap-hour">${String(h).padStart(2, '0')}</div>`).join('');
        const rows = DATA.rpas.map(rpa => `
            <div class="heatmap-label" title="${Fmt.escapeHtml(rpa.process)}">${Fmt.escapeHtml(rpa.name)}</div>
            ${hours.map(h => {
                const cell = byRpaHour.get(`${rpa.id}|${h}`) || { total: 0, error: 0 };
                const rate = cell.total ? Math.round(cell.error / cell.total * 100) : 0;
                const tip = `${Fmt.escapeHtml(rpa.name)} • ${String(h).padStart(2, '0')}h<br>${cell.total} execuções no período • ${cell.error} erro(s) (${rate}%)`;
                return `<div class="heat-cell ${Fmt.heatClass(cell.error, max)}" data-tip="${tip}">${cell.error || ''}</div>`;
            }).join('')}
        `).join('');
        DomUtils.$('#historicalHeatmap').innerHTML = `
            <div class="heatmap" style="grid-template-columns:190px repeat(24, minmax(26px, 1fr))">
                <div></div>
                ${hourLabels}
                ${rows}
            </div>
        `;
        DomUtils.$('#historicalHeatmapBadge').textContent = `${executions.length} execuções no período`;
        DomUtils.$$('#historicalHeatmap [data-tip]').forEach(el => {
            el.addEventListener('mousemove', e => UiFeedback.showTooltip(e, el.dataset.tip));
            el.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }

    static renderVmIdleTrend() {
        const p = ChartService.chartPalette();
        const rows = (DATA.vmIdleTrend || []).filter(d => d.idlePercent !== null && d.idlePercent !== undefined);
        ChartService.drawChart('vmIdleTrendChart', {
            type: 'line',
            data: {
                labels: rows.map(r => r.date),
                datasets: [{
                    label: 'Ociosidade média', data: rows.map(r => r.idlePercent),
                    borderColor: p.primary, backgroundColor: p.primary + '26',
                    fill: true, tension: .3, pointRadius: 3, pointHoverRadius: 5,
                    pointBackgroundColor: p.primary, pointBorderColor: p.panel, pointBorderWidth: 1.5,
                }],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { tooltip: { ...ChartService.tooltipBase(p), callbacks: { title: items => items[0]?.label, label: ctx => `Ociosidade: ${ctx.parsed.y}%` } } },
                scales: {
                    y: { min: 0, max: 100, ticks: { callback: v => v + '%', color: p.textMuted }, grid: { color: p.grid } },
                    x: { ticks: { color: p.textMuted, maxRotation: 0 }, grid: { display: false } },
                },
            },
        });
    }

    static renderVmUtilizationList() {
        const list = [...(DATA.vmUtilization || [])].sort((a, b) => a.idlePercent - b.idlePercent);
        DomUtils.$('#vmUtilizationList').innerHTML = list.map(vm => {
            const occupiedPct = Math.max(0, 100 - vm.idlePercent);
            const topRpa = vm.byRpa[0];
            const sharedNote = vm.byRpa.length > 1
                ? `${vm.byRpa.length} RPAs compartilham esta VM (principal: ${Fmt.escapeHtml(topRpa.rpaName)}, ${topRpa.percent}%)`
                : (topRpa ? Fmt.escapeHtml(topRpa.rpaName) : 'Sem execuções no período');
            const tip = `${Fmt.escapeHtml(vm.machine)}<br>${vm.byRpa.map(r => `${Fmt.escapeHtml(r.rpaName)}: ${r.percent}%`).join('<br>') || 'Sem execuções'}${vm.maxConcurrency > 1 ? `<br>Pico de ${vm.maxConcurrency} execuções simultâneas` : ''}`;
            return `
                <div data-tip="${tip}">
                    <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:11px">
                        <span class="mono">${Fmt.escapeHtml(vm.machine)}</span>
                        <strong>${occupiedPct.toFixed(1)}% ocupada</strong>
                    </div>
                    <div class="progress-track"><div class="progress-fill ${occupiedPct >= 30 ? 'warning' : 'success'}" style="width:${occupiedPct}%"></div></div>
                    <div class="cell-subtitle" style="margin-top:4px">${sharedNote}</div>
                </div>
            `;
        }).join('') || '<div class="empty-state">Sem dados de utilização no período.</div>';
        DomUtils.$$('#vmUtilizationList [data-tip]').forEach(el => {
            el.addEventListener('mousemove', e => UiFeedback.showTooltip(e, el.dataset.tip));
            el.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }

    /* Isola: erro concentrado numa RPA específica (a VM provavelmente não é
       a causa) × erro espalhado por todas as RPAs que rodam na mesma VM
       (sinal de problema de infraestrutura/máquina). */
    static renderVmReliability() {
        const list = DATA.vmReliability || [];
        const counts = {};
        list.forEach(v => { counts[v.classification] = (counts[v.classification] || 0) + 1; });
        const order = ['PROBLEMA_GERAL', 'PROBLEMA_ESPECIFICO', 'ATENCAO', 'SAUDAVEL', 'DADOS_INSUFICIENTES'];
        DomUtils.$('#reliabilitySummary').innerHTML = order.filter(k => counts[k]).map(k =>
            `<span class="badge ${OverviewPage.RELIABILITY_META[k].cls}"><span class="dot"></span>${counts[k]} ${OverviewPage.RELIABILITY_META[k].label.toLowerCase()}</span>`
        ).join('');

        DomUtils.$('#vmReliabilityList').innerHTML = list.map(v => {
            const m = OverviewPage.RELIABILITY_META[v.classification] || OverviewPage.RELIABILITY_META.DADOS_INSUFICIENTES;
            const breakdown = v.byRpa.slice(0, 4).map(r => `
                <div class="reliability-breakdown-row" title="${Fmt.escapeHtml(r.rpaName)}: ${r.errors}/${r.executions} execução(ões) com erro">
                    <div>
                        <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Fmt.escapeHtml(r.rpaName)}</span>
                        <div class="progress-track"><div class="progress-fill ${r.errorRate >= 15 ? 'danger' : r.errorRate > 0 ? 'warning' : 'success'}" style="width:${Math.max(2, Math.min(100, r.errorRate))}%"></div></div>
                    </div>
                    <strong>${r.errorRate}%</strong>
                </div>
            `).join('');
            const codesLine = v.topErrorCodes.length ? v.topErrorCodes.map(c => `${Fmt.escapeHtml(c.code)} (${c.count}×)`).join(' · ') : 'sem erros no período';
            const worstNote = v.worstRpa ? `<div class="cell-subtitle" style="margin-top:8px;color:var(--warning)">Concentrado em ${Fmt.escapeHtml(v.worstRpa.rpaName)} (${v.worstRpa.errorRate}%) — as demais RPAs desta VM estão bem.</div>` : '';
            return `
                <div class="reliability-card" data-tip="${Fmt.escapeHtml(v.machine)}<br>Códigos frequentes: ${Fmt.escapeHtml(codesLine)}">
                    <div class="reliability-card-top">
                        <div class="reliability-icon ${m.cls}"><svg class="icon"><use href="#${m.icon}"></use></svg></div>
                        <div>
                            <div class="reliability-card-machine mono">${Fmt.escapeHtml(v.machine)}</div>
                            <span class="badge ${m.cls}">${m.label}</span>
                        </div>
                        <div class="reliability-card-rate">${v.overallErrorRate}%</div>
                    </div>
                    ${worstNote}
                    <div class="reliability-breakdown">${breakdown || '<div class="cell-subtitle">Sem execuções no período.</div>'}</div>
                </div>
            `;
        }).join('') || '<div class="empty-state">Sem dados de confiabilidade no período.</div>';

        DomUtils.$$('#vmReliabilityList [data-tip]').forEach(el => {
            el.addEventListener('mousemove', e => UiFeedback.showTooltip(e, el.dataset.tip));
            el.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }

    /* Encaixa RPAs pelos horários reais de agenda (coloração de grafo de
       conflito no servidor) sem alterar nenhum horário agendado. */
    static renderVmConsolidation() {
        const c = DATA.vmConsolidation;
        if (!c) return;

        DomUtils.$('#consolidationKpis').innerHTML = [
            { icon: 'i-server', cls: 'info', label: 'VMs dedicadas hoje', value: c.currentVmCount, footer: '1 RPA por VM' },
            { icon: 'i-box', cls: 'success', label: 'VMs sugeridas', value: c.suggestedVmCount, footer: 'Mesmos horários de agenda' },
            { icon: 'i-check', cls: c.potentialSavings > 0 ? 'success' : 'neutral', label: 'Economia potencial', value: `${c.potentialSavings} VM${c.potentialSavings === 1 ? '' : 's'}`, footer: c.potentialSavings > 0 ? 'Poderiam ser liberadas' : 'Já no ponto ideal' },
        ].map(k => `
            <article class="card kpi-card">
                <div class="kpi-top">
                    <div><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div></div>
                    <div class="kpi-icon ${k.cls}"><svg class="icon"><use href="#${k.icon}"></use></svg></div>
                </div>
                <div class="kpi-footer"><span>${k.footer}</span><span></span></div>
            </article>
        `).join('');

        DomUtils.$('#consolidationGroups').innerHTML = c.groups.map(g => {
            const segments = [];
            g.rpas.forEach((rpa, i) => {
                const color = OverviewPage.CONSOLIDATION_PALETTE[i % OverviewPage.CONSOLIDATION_PALETTE.length];
                rpa.windows.forEach(w => {
                    const [startStr, endStr] = w.split('–');
                    const [sh, sm] = startStr.split(':').map(Number);
                    const [eh, em] = endStr.split(':').map(Number);
                    const startMin = sh * 60 + sm;
                    let endMin = eh * 60 + em;
                    if (endMin <= startMin) endMin = 24 * 60;
                    endMin = Math.min(endMin, 24 * 60);
                    const left = startMin / 1440 * 100;
                    const width = Math.max(0.5, (endMin - startMin) / 1440 * 100);
                    segments.push(`<div class="consolidation-segment" style="left:${left}%;width:${width}%;background:${color}" data-tip="${Fmt.escapeHtml(rpa.rpaName)}<br>${Fmt.escapeHtml(w)}"></div>`);
                });
            });
            const chips = g.rpas.map((rpa, i) => `
                <span class="consolidation-chip"><span class="dot" style="background:${OverviewPage.CONSOLIDATION_PALETTE[i % OverviewPage.CONSOLIDATION_PALETTE.length]}"></span>${Fmt.escapeHtml(rpa.rpaName)} <span class="mono" style="opacity:.65">(hoje: ${Fmt.escapeHtml(rpa.currentVm)})</span></span>
            `).join('');
            return `
                <div class="consolidation-group">
                    <div class="consolidation-group-head">
                        <div class="kpi-icon info"><svg class="icon"><use href="#i-server"></use></svg></div>
                        <div>
                            <div class="consolidation-group-title">${Fmt.escapeHtml(g.vmLabel)}</div>
                            <div class="consolidation-group-sub">${g.rpas.length} RPA${g.rpas.length === 1 ? '' : 's'} sem sobreposição de horário</div>
                        </div>
                    </div>
                    <div class="consolidation-track">${segments.join('')}</div>
                    <div class="consolidation-chips">${chips}</div>
                </div>
            `;
        }).join('') || '<div class="empty-state">Sem RPAs suficientes para sugerir consolidação.</div>';

        DomUtils.$('#consolidationCaveat').innerHTML = `<strong>Método:</strong> ${Fmt.escapeHtml(c.method)}<br><strong>Ressalva:</strong> ${Fmt.escapeHtml(c.caveat)}`;

        DomUtils.$$('#consolidationGroups [data-tip]').forEach(el => {
            el.addEventListener('mousemove', e => UiFeedback.showTooltip(e, el.dataset.tip));
            el.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }
}

/* =========================================================================
   AlertsPage — Central de Alertas (KPIs de severidade, contexto 7/30 dias,
   recorrência por VM/etapa e a tabela deduplicada de alertas).
   ========================================================================= */
class AlertsPage {
    static PARETO_DIMENSION_LABELS = {
        step: 'etapa', machine: 'VM', application: 'aplicação', errorCode: 'código', rpa: 'RPA', errorType: 'tipo',
    };

    static paretoListHtml(rows, dimLabel) {
        if (!rows || !rows.length) return '<div class="empty-state">Sem ocorrências no período.</div>';
        const max = Math.max(...rows.map(x => x.count), 1);
        return rows.map(item => `
            <div class="pareto-row" data-tip="${Fmt.escapeHtml(item.label)}<br>${item.count} erro${item.count === 1 ? '' : 's'} · ${Fmt.escapeHtml(dimLabel)}">
                <div class="pareto-code" title="${Fmt.escapeHtml(item.label)}">${Fmt.escapeHtml(item.label)}</div>
                <div class="pareto-bar"><span style="width:${item.count / max * 100}%"></span></div>
                <div class="pareto-count">${item.count}</div>
            </div>
        `).join('');
    }

    static renderAlertContext() {
        const s = DATA.summary;
        const kpiTarget = DomUtils.$('#alertContextKpis');
        if (kpiTarget) {
            const kpis = [
                { icon: 'i-clock', iconClass: 'info', label: 'Erros últimos 7 dias', value: s.errors7d ?? 0, footer: 'Etapas com erro' },
                { icon: 'i-activity', iconClass: 'warning', label: 'Erros últimos 30 dias', value: s.errors30d ?? 0, footer: 'Etapas com erro' },
                { icon: 'i-box', iconClass: 'danger', label: 'RPA mais afetada', value: s.topErrorRpa ? s.topErrorRpa.count : '—', footer: s.topErrorRpa ? Fmt.escapeHtml(s.topErrorRpa.label) : 'Sem dados no período' },
                { icon: 'i-server', iconClass: 'danger', label: 'VM mais afetada', value: s.topErrorMachine ? s.topErrorMachine.count : '—', footer: s.topErrorMachine ? Fmt.escapeHtml(s.topErrorMachine.label) : 'Sem dados no período' },
            ];
            kpiTarget.innerHTML = kpis.map(k => `
                <article class="card kpi-card">
                    <div class="kpi-top">
                        <div><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div></div>
                        <div class="kpi-icon ${k.iconClass}"><svg class="icon"><use href="#${k.icon}"></use></svg></div>
                    </div>
                    <div class="kpi-footer"><span>${k.footer}</span><span></span></div>
                </article>
            `).join('');
        }

        const byVm = (DATA.errorParetos || {}).machine || [];
        const byStep = (DATA.errorParetos || {}).step || [];
        DomUtils.$('#recurrenceByVm').innerHTML = AlertsPage.paretoListHtml(byVm.slice(0, 8), 'VM');
        DomUtils.$('#recurrenceByStep').innerHTML = AlertsPage.paretoListHtml(byStep.slice(0, 8), 'etapa');
        DomUtils.$$('#recurrenceByVm [data-tip], #recurrenceByStep [data-tip]').forEach(el => {
            el.addEventListener('mousemove', e => UiFeedback.showTooltip(e, el.dataset.tip));
            el.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }

    static renderAlerts() {
        const all = DATA.alerts || [];
        DomUtils.$('#navAlertCount').textContent = all.filter(a => a.severity === 'CRITICO' || a.severity === 'ALTO').length;

        const counts = { CRITICO: 0, ALTO: 0, ATENCAO: 0, INFORMATIVO: 0 };
        all.forEach(a => { counts[a.severity] = (counts[a.severity] || 0) + 1; });

        const kpiTarget = DomUtils.$('#alertKpis');
        if (kpiTarget) {
            const kpis = [
                { icon: 'i-alert', iconClass: 'danger', label: 'Crítico', value: counts.CRITICO, footer: 'Requer ação imediata' },
                { icon: 'i-triangle', iconClass: 'warning', label: 'Alto', value: counts.ALTO, footer: 'Priorizar hoje' },
                { icon: 'i-clock', iconClass: 'warning', label: 'Atenção', value: counts.ATENCAO, footer: 'Monitorar' },
                { icon: 'i-grid', iconClass: 'info', label: 'Total deduplicado', value: all.length, footer: 'Agrupado por RPA + regra' },
            ];
            kpiTarget.innerHTML = kpis.map(k => `
                <article class="card kpi-card">
                    <div class="kpi-top">
                        <div><div class="kpi-label">${k.label}</div><div class="kpi-value">${k.value}</div></div>
                        <div class="kpi-icon ${k.iconClass}"><svg class="icon"><use href="#${k.icon}"></use></svg></div>
                    </div>
                    <div class="kpi-footer"><span>${k.footer}</span><span></span></div>
                </article>
            `).join('');
        }

        const filter = DomUtils.$('#alertSeverityFilter')?.value || 'ALL';
        const rows = all.filter(a => filter === 'ALL' || a.severity === filter);
        const tbody = DomUtils.$('#alertsTable');
        if (!tbody) return;
        tbody.innerHTML = rows.map(a => `
            <tr data-search-text="${Fmt.escapeHtml((a.rpaName || a.machine || '') + ' ' + a.rule + ' ' + a.message).toLowerCase()}">
                <td>${Fmt.severityBadge(a.severity)}</td>
                <td><span class="cell-title">${Fmt.escapeHtml(a.rpaName || 'Infraestrutura')}</span><span class="cell-subtitle mono">${Fmt.escapeHtml(a.process || a.machine || '')}</span></td>
                <td><span class="mono">${Fmt.escapeHtml(a.rule)}</span></td>
                <td>${Fmt.escapeHtml(a.message)}</td>
                <td>${a.count}×</td>
                <td>${Fmt.fmtDateTime(a.lastSeen)}</td>
                <td style="white-space:nowrap">${a.executionId ? `<button class="audit-action js-alert-audit" data-execution-id="${Fmt.escapeHtml(a.executionId)}" type="button">Auditar</button>` : ''}</td>
            </tr>
        `).join('') || `<tr><td colspan="7"><div class="empty-state">Nenhum alerta nesta severidade, no período carregado.</div></td></tr>`;

        DomUtils.$$('.js-alert-audit', tbody).forEach(btn => btn.addEventListener('click', () => openAuditExecution(btn.dataset.executionId)));
    }
}

/* =========================================================================
   ExecutionsPage — "Execuções e comportamento": composição/KPIs, taxa
   diária de sucesso, duração atual × esperada e execuções por horário.
   ========================================================================= */
class ExecutionsPage {
    static renderSuccessTrend() {
        const p = ChartService.chartPalette();
        const rows = DATA.trend;
        ChartService.drawChart('successTrendChart', {
            type: 'line',
            data: {
                labels: rows.map(r => r.date),
                datasets: [
                    {
                        label: 'Taxa de sucesso', data: rows.map(r => r.successRate),
                        borderColor: p.primary, backgroundColor: p.primary + '26',
                        fill: true, tension: .3, pointRadius: 3, pointHoverRadius: 5,
                        pointBackgroundColor: p.primary, pointBorderColor: p.panel, pointBorderWidth: 1.5,
                    },
                    {
                        label: 'Meta (95%)', data: rows.map(() => 95),
                        borderColor: p.success, borderDash: [6, 4], borderWidth: 1.5,
                        pointRadius: 0, pointHoverRadius: 0, fill: false,
                    },
                ],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 10, usePointStyle: true, color: p.textMuted, font: { size: 10.5 } } },
                    tooltip: {
                        ...ChartService.tooltipBase(p), filter: item => item.datasetIndex === 0,
                        callbacks: {
                            title: items => items[0]?.label,
                            label: ctx => {
                                const row = rows[ctx.dataIndex];
                                return [`Taxa de sucesso: ${row.successRate}%`, `${row.success} sucesso · ${row.warning} atenção · ${row.error} erro`];
                            },
                        },
                    },
                },
                // 0-100 é o teto/piso real de uma taxa percentual — nunca
                // clipa um dia ruim para fora do gráfico (era o bug: min:75 fixo).
                scales: {
                    y: { min: 0, max: 100, ticks: { callback: v => v + '%', color: p.textMuted }, grid: { color: p.grid } },
                    x: { ticks: { color: p.textMuted, maxRotation: 0 }, grid: { display: false } },
                },
            },
        });
    }

    static renderExecutionKpis() {
        const trend = DATA.trend || [];
        const total = trend.reduce((a, d) => a + d.success + d.warning + d.error, 0);
        const success = trend.reduce((a, d) => a + d.success, 0);
        const warning = trend.reduce((a, d) => a + d.warning, 0);
        const error = trend.reduce((a, d) => a + d.error, 0);
        const days = trend.length || 1;
        const avgSuccessRate = trend.length ? trend.reduce((a, d) => a + d.successRate, 0) / trend.length : 0;
        const problemCount = warning + error;
        const pct = n => total ? Math.round(n / total * 100) : 0;
        const onTarget = avgSuccessRate >= 95;

        DomUtils.$('#executionKpis').innerHTML = `
            <article class="card kpi-card">
                <div class="kpi-top">
                    <div><div class="kpi-label">Composição das execuções</div><div class="kpi-value">${total}</div></div>
                    <div class="kpi-icon info"><svg class="icon"><use href="#i-box"></use></svg></div>
                </div>
                <div>
                    <div class="composition-bar">
                        <span class="success" style="width:${pct(success)}%"></span>
                        <span class="warning" style="width:${pct(warning)}%"></span>
                        <span class="danger" style="width:${pct(error)}%"></span>
                    </div>
                    <div class="kpi-footer" style="margin-top:7px">
                        <span>${success} sucesso</span><span>${warning} atenção</span><span>${error} erro</span>
                    </div>
                </div>
            </article>
            <article class="card kpi-card">
                <div class="kpi-top">
                    <div><div class="kpi-label">Total de execuções</div><div class="kpi-value">${total}</div></div>
                    <div class="kpi-icon"><svg class="icon"><use href="#i-activity"></use></svg></div>
                </div>
                <div class="kpi-footer"><span>Últimos ${days} dias</span><span>média ${(total / days).toFixed(1)}/dia</span></div>
            </article>
            <article class="card kpi-card">
                <div class="kpi-top">
                    <div><div class="kpi-label">Taxa de sucesso média</div><div class="kpi-value">${avgSuccessRate.toFixed(1)}%</div></div>
                    <div class="kpi-icon ${onTarget ? 'success' : 'warning'}"><svg class="icon"><use href="#i-check"></use></svg></div>
                </div>
                <div class="kpi-footer"><span>Meta ≥ 95%</span><span>${onTarget ? 'dentro da meta' : 'abaixo da meta'}</span></div>
            </article>
            <article class="card kpi-card">
                <div class="kpi-top">
                    <div><div class="kpi-label">Execuções com problema</div><div class="kpi-value">${problemCount}</div></div>
                    <div class="kpi-icon ${problemCount ? 'danger' : 'success'}"><svg class="icon"><use href="#i-alert"></use></svg></div>
                </div>
                <div class="kpi-footer"><span>${pct(problemCount)}% do total</span><span>${warning} warning · ${error} erro</span></div>
            </article>
        `;
    }

    static renderDurationComparison() {
        const maxRatio = Math.max(...DATA.rpas.map(r => r.lastDurationMin / r.expectedDurationMin));
        DomUtils.$('#durationComparison').innerHTML = DATA.rpas.map(r => {
            const ratio = r.lastDurationMin / r.expectedDurationMin;
            const width = Fmt.clamp(ratio / Math.max(1.8, maxRatio) * 100, 2, 100);
            const cls = ratio > 1.4 ? 'danger' : ratio > 1.15 ? 'warning' : 'success';
            return `
                <div style="display:grid;grid-template-columns:155px 1fr 92px;gap:10px;align-items:center;margin:11px 0">
                    <span style="font-size:10px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${Fmt.escapeHtml(r.name)}">${Fmt.escapeHtml(r.name)}</span>
                    <div class="progress-track"><div class="progress-fill ${cls}" style="width:${width}%"></div></div>
                    <span style="font-size:10px;text-align:right"><strong>${r.lastDurationMin}m</strong> / ${r.expectedDurationMin}m</span>
                </div>
            `;
        }).join('');
    }

    static renderHourlyLoad() {
        const p = ChartService.chartPalette();
        const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
        DATA.timeline.forEach(run => buckets[Math.floor(run.startMinute / 60)].count++);
        const max = Math.max(...buckets.map(b => b.count), 1);
        ChartService.drawChart('hourlyLoad', {
            type: 'bar',
            data: {
                labels: buckets.map(b => `${String(b.hour).padStart(2, '0')}h`),
                datasets: [{
                    label: 'Execuções', data: buckets.map(b => b.count),
                    backgroundColor: buckets.map(b => b.count >= max * .75 ? p.warning : p.primary),
                    borderRadius: 4, maxBarThickness: 22,
                }],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { tooltip: { ...ChartService.tooltipBase(p), callbacks: { title: items => `${items[0].label}00`, label: ctx => `${ctx.parsed.y} execução${ctx.parsed.y === 1 ? '' : 'ões'}` } } },
                scales: {
                    y: { beginAtZero: true, ticks: { precision: 0, color: p.textMuted }, grid: { color: p.grid } },
                    x: { ticks: { color: p.textMuted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
                },
            },
        });
    }
}

/* =========================================================================
   IncidentsPage — "Falhas e incidentes": Pareto multi-dimensão, heatmap
   RPA × etapa e a tabela completa de incidentes.
   ========================================================================= */
class IncidentsPage {
    static renderErrorPareto() {
        const select = DomUtils.$('#paretoDimensionSelect');
        const dim = select ? select.value : 'step';
        const rows = (DATA.errorParetos || {})[dim] || [];
        DomUtils.$('#paretoDimensionList').innerHTML = AlertsPage.paretoListHtml(rows, AlertsPage.PARETO_DIMENSION_LABELS[dim] || dim);
        DomUtils.$$('#paretoDimensionList [data-tip]').forEach(el => {
            el.addEventListener('mousemove', e => UiFeedback.showTooltip(e, el.dataset.tip));
            el.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }

    static renderFailureHeatmap() {
        const cols = DATA.heatmapSteps.length;
        const max = Math.max(1, ...DATA.heatmap.flatMap(row => row.values));
        DomUtils.$('#failureHeatmap').innerHTML = `
            <div class="heatmap" style="grid-template-columns:155px repeat(${cols}, minmax(56px, 1fr))">
                <div></div>
                ${DATA.heatmapSteps.map(step => `<div class="heatmap-step" title="${Fmt.escapeHtml(step)}">${Fmt.escapeHtml(step)}</div>`).join('')}
                ${DATA.heatmap.map(row => `
                    <div class="heatmap-label" title="${Fmt.escapeHtml(row.rpa)}">${Fmt.escapeHtml(row.rpa)}</div>
                    ${row.values.map((value, i) => `<div class="heat-cell ${Fmt.heatClass(value, max)}" data-tip="${Fmt.escapeHtml(row.rpa)}<br>${Fmt.escapeHtml(DATA.heatmapSteps[i])}: ${value} erro(s)">${value || ''}</div>`).join('')}
                `).join('')}
            </div>
        `;
        DomUtils.$$('#failureHeatmap [data-tip]').forEach(el => {
            el.addEventListener('mousemove', e => UiFeedback.showTooltip(e, el.dataset.tip));
            el.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }

    static renderIncidentTable() {
        DomUtils.$('#incidentTable').innerHTML = DATA.incidents.map(i => `
            <tr class="clickable-row" data-execution-id="${i.executionId}" data-search-text="${Fmt.escapeHtml((i.rpa + ' ' + i.executionId + ' ' + i.step + ' ' + i.errorCode + ' ' + i.machine).toLowerCase())}">
                <td>${Fmt.fmtDateTime(i.timestamp)}</td>
                <td><span class="cell-title">${Fmt.escapeHtml(i.rpa)}</span><span class="cell-subtitle">${Fmt.criticalityBadge(i.criticality)}</span></td>
                <td class="mono">${i.executionId}</td>
                <td>${Fmt.escapeHtml(i.step)}</td>
                <td><span class="badge danger">${Fmt.escapeHtml(i.errorCode)}</span></td>
                <td class="mono">${Fmt.escapeHtml(i.machine)}</td>
                <td>${i.durationMin} min</td>
                <td>${i.retries}</td>
                <td style="white-space:nowrap">
                    <button class="audit-action js-audit" type="button">Auditar</button>
                    <button class="audit-action js-investigate" type="button">Investigar ↗</button>
                    <button class="audit-action js-diagnose" type="button">Diagnóstico ↗</button>
                </td>
            </tr>
        `).join('');

        DomUtils.$$('#incidentTable .clickable-row').forEach(row => {
            row.addEventListener('click', () => openAuditExecution(row.dataset.executionId));
            row.querySelector('.js-audit')?.addEventListener('click', ev => { ev.stopPropagation(); openAuditExecution(row.dataset.executionId); });
            row.querySelector('.js-investigate')?.addEventListener('click', ev => { ev.stopPropagation(); NavigationController.openExecutionWorkspace('investigacao.html', row.dataset.executionId); });
            row.querySelector('.js-diagnose')?.addEventListener('click', ev => { ev.stopPropagation(); NavigationController.openExecutionWorkspace('diagnostico.html', row.dataset.executionId); });
        });
    }
}

/* =========================================================================
   InfrastructurePage — "Infraestrutura": KPIs de VM e a matriz com uso real
   (não nominal) de cada máquina.
   ========================================================================= */
class InfrastructurePage {
    static renderVmKpis() {
        const critical = DATA.vms.filter(v => v.health === 'CRITICAL').length;
        const warning = DATA.vms.filter(v => v.health === 'WARNING').length;
        const connected = DATA.vms.filter(v => v.rdp === 'CONNECTED').length;
        const avgCpu = (DATA.vms.reduce((a, v) => a + v.cpu, 0) / DATA.vms.length).toFixed(1);
        const avgMemory = (DATA.vms.reduce((a, v) => a + v.memory, 0) / DATA.vms.length).toFixed(1);
        const shared = (DATA.vmUtilization || []).filter(u => u.byRpa.length > 1).length;
        DomUtils.$('#vmKpis').innerHTML = [
            ['VMs conectadas', `${connected}/${DATA.vms.length}`, 'success', 'i-monitor'],
            ['VMs críticas', critical, 'danger', 'i-alert'],
            ['VMs em atenção', warning, 'warning', 'i-triangle'],
            ['VMs compartilhadas', shared, shared ? 'info' : 'neutral', 'i-users'],
            ['CPU média', `${avgCpu}%`, 'info', 'i-activity'],
            ['RAM média', `${avgMemory}%`, 'info', 'i-activity'],
        ].map(([label, value, cls, icon]) => `
            <article class="card kpi-card">
                <div class="kpi-top">
                    <div><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div>
                    <div class="kpi-icon ${cls}"><svg class="icon"><use href="#${icon}"></use></svg></div>
                </div>
                <div class="kpi-footer"><span>Snapshot ${Fmt.fmtTime(DATA.snapshot)}</span></div>
            </article>
        `).join('');
    }

    /* Uma VM não é dedicada a uma única RPA por natureza — o cadastro só
       define uma "primária" nominal (RPA.primaryVm). Aqui cruzamos com
       vmUtilization (quem realmente rodou ali) e vmReliability (se o
       histórico de erro daquela máquina é saudável ou não) para mostrar o
       uso real, não a intenção de cadastro. */
    static renderVmGrid() {
        const utilByMachine = new Map((DATA.vmUtilization || []).map(u => [u.machine, u]));
        const relByMachine = new Map((DATA.vmReliability || []).map(r => [r.machine, r]));
        DomUtils.$('#vmGrid').innerHTML = DATA.vms.map(vm => {
            const util = utilByMachine.get(vm.name);
            const byRpa = util ? util.byRpa : [];
            const rpaSummary = byRpa.length === 0 ? 'Sem execuções no período'
                : byRpa.length === 1 ? Fmt.escapeHtml(byRpa[0].rpaName)
                : `${byRpa.length} RPAs · principal: ${Fmt.escapeHtml(byRpa[0].rpaName)} (${byRpa[0].percent}%)`;
            const occupied = util ? Math.max(0, 100 - util.idlePercent) : null;
            const rel = relByMachine.get(vm.name);
            const relMeta = rel ? (OverviewPage.RELIABILITY_META[rel.classification] || OverviewPage.RELIABILITY_META.DADOS_INSUFICIENTES) : null;
            const tip = `${Fmt.escapeHtml(vm.name)}<br>${byRpa.map(r => `${Fmt.escapeHtml(r.rpaName)}: ${r.percent}%`).join('<br>') || 'Sem execuções no período'}`;
            return `
                <div class="vm-card" data-search-text="${Fmt.escapeHtml((vm.name + ' ' + byRpa.map(r => r.rpaName).join(' ') + ' ' + vm.rdp).toLowerCase())}" data-tip="${tip}">
                    <div class="vm-card-head">
                        <div style="display:flex;align-items:flex-start;gap:8px">
                            <div class="reliability-icon neutral" style="width:24px;height:24px;flex:none;margin-top:1px"><svg class="icon" style="width:13px;height:13px"><use href="#i-monitor"></use></svg></div>
                            <div>
                                <div class="vm-name mono">${vm.name}</div>
                                <div class="vm-rpas">${rpaSummary}</div>
                            </div>
                        </div>
                        ${Fmt.statusBadge(vm.health)}
                    </div>
                    <div class="vm-metrics">
                        <div class="vm-metric"><span>CPU</span><strong class="trend-${vm.cpu >= 90 ? 'negative' : vm.cpu >= 75 ? 'warning' : 'positive'}">${vm.cpu}%</strong></div>
                        <div class="vm-metric"><span>RAM</span><strong class="trend-${vm.memory >= 90 ? 'negative' : vm.memory >= 80 ? 'warning' : 'positive'}">${vm.memory}%</strong></div>
                        <div class="vm-metric"><span>Disco</span><strong class="trend-${vm.disk >= 90 ? 'negative' : vm.disk >= 80 ? 'warning' : 'positive'}">${vm.disk}%</strong></div>
                    </div>
                    <div style="margin-top:10px">${ChartService.sparkline(vm.history.cpu, 'var(--primary)')}</div>
                    ${occupied !== null ? `
                    <div style="margin-top:9px">
                        <div style="display:flex;justify-content:space-between;font-size:9.5px;color:var(--text-3);margin-bottom:3px"><span>Ocupação no período</span><strong style="color:var(--text-2)">${occupied.toFixed(1)}%</strong></div>
                        <div class="progress-track" style="height:5px"><div class="progress-fill ${occupied >= 30 ? 'warning' : 'success'}" style="width:${occupied}%"></div></div>
                    </div>` : ''}
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:9px">
                        ${relMeta ? `<span class="badge ${relMeta.cls}" style="font-size:9px"><span class="dot"></span>${relMeta.label}</span>` : '<span></span>'}
                        <span style="color:var(--text-3);font-size:10px">Uptime ${vm.uptime.toFixed(1)}h</span>
                    </div>
                    <div style="margin-top:8px">${Fmt.statusBadge(vm.rdp)}</div>
                </div>
            `;
        }).join('');
        DomUtils.$$('#vmGrid [data-tip]').forEach(el => {
            el.addEventListener('mousemove', e => UiFeedback.showTooltip(e, el.dataset.tip));
            el.addEventListener('mouseleave', UiFeedback.hideTooltip);
        });
    }
}

/* =========================================================================
   AuditPage — "Auditoria": seletor de RPA/execução, trilha de etapas,
   comparativo histórico e resumo/evidências da execução selecionada.
   O clique em uma execução usa execution_id para localizar o conjunto de
   eventos correspondente — nenhum status de etapa é inferido, a
   visualização usa diretamente o status registrado no log de eventos.
   ========================================================================= */
class AuditPage {
    static populateAuditRpaSelect(selectedRpaId) {
        const select = DomUtils.$('#auditRpaSelect');
        if (!select) return;
        const rpas = [...DATA.rpas].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
        select.innerHTML = rpas.map(r => `<option value="${Fmt.escapeHtml(r.id)}">${Fmt.escapeHtml(r.name)}</option>`).join('');
        if (selectedRpaId) select.value = selectedRpaId;
    }

    static populateAuditExecutionSelect(rpaId, selectedExecutionId) {
        const select = DomUtils.$('#auditExecutionSelect');
        if (!select) return;
        const execs = window.OBS_DATA.executions
            .filter(e => e.rpaId === rpaId)
            .sort((a, b) => b.start.localeCompare(a.start));
        select.innerHTML = execs.map(e => `<option value="${Fmt.escapeHtml(e.executionId)}">${Fmt.fmtDateTime(e.start)} · ${e.status}${e.status === 'ERROR' ? ' ⚠' : ''}</option>`).join('')
            || '<option value="">Sem execuções no período</option>';
        if (selectedExecutionId) select.value = selectedExecutionId;
    }

    static initAuditPicker(rpaId, executionId) {
        AuditPage.populateAuditRpaSelect(rpaId);
        AuditPage.populateAuditExecutionSelect(rpaId, executionId);
    }

    static renderAuditStepHistory(detail) {
        const container = DomUtils.$('#auditStepHistory');
        if (!container) return;
        if (!detail.rpaId) { container.innerHTML = '<div class="empty-state">Sem dados históricos disponíveis.</div>'; return; }

        const history = RpaDataStore.computeStepHistory(detail.rpaId, detail.executionId);
        const orderedNames = [];
        const seen = new Set();
        (detail.steps || []).forEach(s => { if (!seen.has(s.step)) { seen.add(s.step); orderedNames.push(s.step); } });
        history.forEach((_, name) => { if (!seen.has(name)) { seen.add(name); orderedNames.push(name); } });

        if (!orderedNames.length) {
            container.innerHTML = '<div class="empty-state">Sem etapas históricas para esta RPA no período carregado.</div>';
            return;
        }

        container.innerHTML = orderedNames.map(name => {
            const rec = history.get(name);
            if (!rec || rec.total === 0) {
                return `
                    <div class="audit-history-row">
                        <div class="audit-history-step">${Fmt.escapeHtml(name)}</div>
                        <div class="cell-subtitle">Sem histórico anterior</div>
                        <div class="cell-subtitle">—</div>
                    </div>
                `;
            }
            const avg = rec.durations.reduce((a, b) => a + b, 0) / rec.durations.length;
            const needsRework = rec.errors >= 4;
            return `
                <div class="audit-history-row">
                    <div class="audit-history-step">
                        <div>${Fmt.escapeHtml(name)}</div>
                        <div class="cell-subtitle">${rec.total} execuções históricas · média ${Fmt.formatAuditDuration(avg)}</div>
                    </div>
                    <div>${ChartService.sparkline(rec.durations.slice(-24), 'var(--primary)')}</div>
                    <div>
                        <span class="badge ${needsRework ? 'danger' : rec.errors > 0 ? 'warning' : 'success'}">
                            <span class="dot"></span>${rec.errors} erro${rec.errors === 1 ? '' : 's'}
                        </span>
                        ${needsRework ? '<div class="cell-subtitle" style="margin-top:5px;color:var(--danger)">≥4 falhas — evidência sugere refazer a etapa</div>' : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    static renderAuditExecution(detail) {
        if (!detail) return;

        const steps = detail.steps || [];
        const successSteps = steps.filter(s => s.status === 'SUCCESS').length;
        const warningSteps = steps.filter(s => s.status === 'WARNING').length;
        const errorSteps = steps.filter(s => s.status === 'ERROR').length;
        const firstTransaction = steps.find(s => s.transactionId)?.transactionId || '—';

        DomUtils.$('#auditExecutionHero').innerHTML = `
            <div class="detail-hero">
                <div class="detail-title">
                    <div>${Fmt.statusBadge(detail.status)}</div>
                    <h2>${Fmt.escapeHtml(detail.rpa)}</h2>
                    <p><span class="mono">${Fmt.escapeHtml(detail.executionId)}</span> • ${Fmt.escapeHtml(detail.process)}</p>
                </div>
                <div class="detail-stat"><span>Início real</span><strong>${Fmt.fmtDateTime(detail.start)}</strong></div>
                <div class="detail-stat"><span>Fim real</span><strong>${Fmt.fmtDateTime(detail.end)}</strong></div>
                <div class="detail-stat"><span>Duração</span><strong>${detail.durationMin.toFixed(2)} min</strong></div>
                <div class="detail-stat"><span>VM</span><strong class="mono">${Fmt.escapeHtml(detail.machine)}</strong></div>
            </div>
        `;

        DomUtils.$('#auditStepCount').textContent = `${steps.length} evento${steps.length === 1 ? '' : 's'}`;

        DomUtils.$('#auditSteps').innerHTML = steps.map((step) => {
            const attempt = Number(step.loopNumber || 1) > 1 ? ` • tentativa ${step.loopNumber}` : '';
            const note = step.errorMessage || step.message || '';
            const code = step.errorCode ? ` • ${step.errorCode}` : '';
            return `
                <div class="audit-step-row" data-search-text="${Fmt.escapeHtml((step.step + ' ' + step.status + ' ' + (step.errorCode || '') + ' ' + note).toLowerCase())}">
                    <div class="audit-step-marker">${Fmt.auditStatusIcon(step.status)}</div>
                    <div>
                        <div class="audit-step-title">${String(step.order).padStart(2, '0')}. ${Fmt.escapeHtml(step.step)}</div>
                        <div class="audit-step-meta">${Fmt.fmtTime(step.timestamp)} → ${Fmt.fmtTime(step.endTimestamp)}${attempt}</div>
                        <div class="audit-step-note ${step.status === 'ERROR' ? 'error' : ''}">${Fmt.escapeHtml(note)}</div>
                    </div>
                    <div>${Fmt.statusBadge(step.status)}${code ? `<div class="cell-subtitle mono">${Fmt.escapeHtml(code.replace(' • ', ''))}</div>` : ''}</div>
                    <div class="audit-duration">${Fmt.formatAuditDuration(step.durationSec)}</div>
                    <div>
                        <div class="cell-subtitle">Aplicação</div>
                        <div style="margin-top:3px;color:var(--text-2)">${Fmt.escapeHtml(step.application || '—')}</div>
                        ${step.errorType ? `<div class="cell-subtitle" style="margin-top:5px">${Fmt.escapeHtml(step.errorType)}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('') || '<div class="empty-state">Não há eventos detalhados para esta execução.</div>';

        DomUtils.$('#auditSummary').innerHTML = `
            <div class="audit-summary-grid">
                <div class="audit-summary-item"><span>Etapas sucesso</span><strong class="trend-positive">${successSteps}</strong></div>
                <div class="audit-summary-item"><span>Etapas atenção</span><strong class="trend-warning">${warningSteps}</strong></div>
                <div class="audit-summary-item"><span>Etapas erro</span><strong class="trend-negative">${errorSteps}</strong></div>
                <div class="audit-summary-item"><span>Retries</span><strong>${detail.retries}</strong></div>
                <div class="audit-summary-item"><span>Itens processados</span><strong>${detail.processedItems}/${detail.totalItems}</strong></div>
                <div class="audit-summary-item"><span>Itens com erro</span><strong>${detail.errorItems}</strong></div>
            </div>
            <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:grid;gap:8px">
                <div style="display:flex;justify-content:space-between;gap:10px"><span class="cell-subtitle">Início planejado</span><strong>${detail.scheduledStart ? Fmt.fmtDateTime(detail.scheduledStart) : '—'}</strong></div>
                <div style="display:flex;justify-content:space-between;gap:10px"><span class="cell-subtitle">Conformidade início</span>${Fmt.auditComplianceBadge(detail.startCompliance)}</div>
                <div style="display:flex;justify-content:space-between;gap:10px"><span class="cell-subtitle">Conformidade duração</span>${Fmt.auditComplianceBadge(detail.durationCompliance)}</div>
                <div style="display:flex;justify-content:space-between;gap:10px"><span class="cell-subtitle">Deadline</span>${Fmt.auditComplianceBadge(detail.deadlineCompliance)}</div>
            </div>
        `;

        const investigateBtn = DomUtils.$('#auditInvestigateBtn');
        const diagnoseBtn = DomUtils.$('#auditDiagnoseBtn');
        if (investigateBtn) investigateBtn.onclick = () => NavigationController.openExecutionWorkspace('investigacao.html', detail.executionId);
        if (diagnoseBtn) diagnoseBtn.onclick = () => NavigationController.openExecutionWorkspace('diagnostico.html', detail.executionId);

        DomUtils.$('#auditEvidence').innerHTML = `
            <div class="audit-evidence-list">
                <div class="audit-evidence-row"><span>execution_id</span><span class="mono">${Fmt.escapeHtml(detail.executionId)}</span></div>
                <div class="audit-evidence-row"><span>transaction_id</span><span class="mono">${Fmt.escapeHtml(firstTransaction)}</span></div>
                <div class="audit-evidence-row"><span>schedule_id</span><span class="mono">${Fmt.escapeHtml(detail.scheduleId || '—')}</span></div>
                <div class="audit-evidence-row"><span>expected_run_key</span><span class="mono">${Fmt.escapeHtml(detail.expectedRunKey || '—')}</span></div>
                <div class="audit-evidence-row"><span>robot_name</span><span class="mono">${Fmt.escapeHtml(detail.robotName || '—')}</span></div>
                <div class="audit-evidence-row"><span>orchestrator</span><span class="mono">${Fmt.escapeHtml(detail.orchestrator || '—')}</span></div>
                <div class="audit-evidence-row"><span>machine_name</span><span class="mono">${Fmt.escapeHtml(detail.machine)}</span></div>
                <div class="audit-evidence-row"><span>environment</span><span>${Fmt.escapeHtml(detail.environment || '—')}</span></div>
                <div class="audit-evidence-row"><span>version</span><span>${Fmt.escapeHtml(detail.version || '—')}</span></div>
            </div>
        `;

        AuditPage.initAuditPicker(detail.rpaId, detail.executionId);
        AuditPage.renderAuditStepHistory(detail);
    }

    static openAuditExecution(executionId) {
        window.ACTIVE_EXECUTION_ID = executionId;
        const detail = DATA.auditExecutions?.[executionId] || RpaDataStore.buildAuditDetail(window.OBS_DATA, executionId);
        if (!detail) {
            UiFeedback.showToast(`Não há log detalhado carregado para ${executionId}.`);
            return;
        }
        AuditPage.renderAuditExecution(detail);
        NavigationController.goToPage('audit');
    }

    static renderExecutionAuditTable() {
        const rows = [...DATA.timeline].sort((a, b) => b.startMinute - a.startMinute);
        DomUtils.$('#auditExecutionCount').textContent = `${rows.length} execuções`;
        DomUtils.$('#executionAuditTable').innerHTML = rows.map(run => {
            const detail = DATA.auditExecutions?.[run.executionId] || RpaDataStore.buildAuditDetail(window.OBS_DATA, run.executionId);
            const stepCount = detail?.steps?.length ?? 0;
            return `
                <tr class="clickable-row audit-execution-row" data-execution-id="${Fmt.escapeHtml(run.executionId)}"
                    data-search-text="${Fmt.escapeHtml((run.rpa + ' ' + run.process + ' ' + run.executionId + ' ' + run.machine + ' ' + run.status).toLowerCase())}">
                    <td>${Fmt.escapeHtml(run.start)}</td>
                    <td><span class="cell-title">${Fmt.escapeHtml(run.rpa)}</span><span class="cell-subtitle">${Fmt.escapeHtml(run.process)}</span></td>
                    <td class="mono">${Fmt.escapeHtml(run.executionId)}</td>
                    <td>${Fmt.statusBadge(run.status)}</td>
                    <td>${run.durationMin.toFixed(1)} min</td>
                    <td>${stepCount}</td>
                    <td class="mono">${Fmt.escapeHtml(run.machine)}</td>
                    <td>${run.retries}</td>
                    <td style="white-space:nowrap">
                        <button class="audit-action js-audit" type="button">Auditar</button>
                        <button class="audit-action js-investigate" type="button">Investigar ↗</button>
                        <button class="audit-action js-diagnose" type="button">Diagnóstico ↗</button>
                    </td>
                </tr>
            `;
        }).join('');

        DomUtils.$$('#executionAuditTable .audit-execution-row').forEach(row => {
            row.addEventListener('click', () => AuditPage.openAuditExecution(row.dataset.executionId));
            row.querySelector('.js-audit')?.addEventListener('click', event => {
                event.stopPropagation();
                AuditPage.openAuditExecution(row.dataset.executionId);
            });
            row.querySelector('.js-investigate')?.addEventListener('click', event => {
                event.stopPropagation();
                window.ACTIVE_EXECUTION_ID = row.dataset.executionId;
                NavigationController.openExecutionWorkspace('investigacao.html', row.dataset.executionId);
            });
            row.querySelector('.js-diagnose')?.addEventListener('click', event => {
                event.stopPropagation();
                window.ACTIVE_EXECUTION_ID = row.dataset.executionId;
                NavigationController.openExecutionWorkspace('diagnostico.html', row.dataset.executionId);
            });
        });
    }
}

/* =========================================================================
   DiagnosticPage — drill-down técnico embutido na própria SPA (distinto de
   diagnostico.html, que é a versão completa aberta em nova aba).
   ========================================================================= */
class DiagnosticPage {
    static renderDiagnostic(detail) {
        DomUtils.$('#executionHero').innerHTML = `
            <div class="detail-hero">
                <div class="detail-title">
                    <div>${Fmt.statusBadge(detail.status)}</div>
                    <h2>${Fmt.escapeHtml(detail.rpa)}</h2>
                    <p><span class="mono">${detail.executionId}</span> • ${Fmt.escapeHtml(detail.process)}</p>
                </div>
                <div class="detail-stat"><span>Início</span><strong>${Fmt.fmtDateTime(detail.start)}</strong></div>
                <div class="detail-stat"><span>Duração</span><strong>${detail.durationMin} min</strong></div>
                <div class="detail-stat"><span>VM</span><strong class="mono">${Fmt.escapeHtml(detail.machine)}</strong></div>
                <div class="detail-stat"><span>Itens</span><strong>${detail.processedItems}/${detail.totalItems}</strong></div>
            </div>
        `;

        DomUtils.$('#executionSteps').innerHTML = detail.steps.map(step => `
            <div class="step-row ${step.status === 'ERROR' ? 'error' : ''}">
                <div class="step-index">${step.order}</div>
                <div>
                    <div class="step-name">${Fmt.escapeHtml(step.step)}</div>
                    <div class="cell-subtitle">${Fmt.fmtTime(step.timestamp)}</div>
                </div>
                <div>${Fmt.statusBadge(step.status)}</div>
                <div><strong>${step.durationSec.toFixed(1)}s</strong></div>
                <div class="step-message" title="${Fmt.escapeHtml(step.errorMessage || step.message)}">${Fmt.escapeHtml(step.errorMessage || step.message)}</div>
            </div>
        `).join('');

        const vm = detail.vmSnapshot;
        DomUtils.$('#diagnosticVm').innerHTML = vm ? `
            <div class="grid grid-3" style="gap:8px">
                <div class="detail-stat"><span>CPU</span><strong>${vm.cpu_percent}%</strong></div>
                <div class="detail-stat"><span>RAM</span><strong>${vm.memory_percent}%</strong></div>
                <div class="detail-stat"><span>Disco</span><strong>${vm.disk_percent}%</strong></div>
            </div>
            <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center">
                <span class="mono">${Fmt.escapeHtml(vm.machine_name)}</span>
                ${Fmt.statusBadge(vm.rdp_status)}
            </div>
            <div class="cell-subtitle" style="margin-top:8px">Snapshot ${Fmt.escapeHtml(vm.data)} • uptime ${vm.uptime_hours}h</div>
        ` : `<div class="empty-state">Snapshot da VM não disponível.</div>`;

        const errorStep = detail.steps.find(s => s.status === 'ERROR');
        const infraNormal = vm && vm.cpu_percent < 75 && vm.memory_percent < 80 && vm.disk_percent < 80 && vm.rdp_status === 'CONNECTED';
        DomUtils.$('#diagnosticSummary').innerHTML = `
            <div style="display:flex;flex-direction:column;gap:11px">
                <div>
                    <span class="badge danger">CAUSA REGISTRADA</span>
                    <div style="margin-top:7px;color:var(--text);font-weight:700">${Fmt.escapeHtml(errorStep?.errorCode || 'Erro da execução')}</div>
                    <div style="margin-top:3px;color:var(--text-2);font-size:11px">${Fmt.escapeHtml(errorStep?.errorMessage || 'Consulte o evento de erro.')}</div>
                </div>
                <div style="padding-top:10px;border-top:1px solid var(--border)">
                    <span class="badge ${infraNormal ? 'success' : 'warning'}">INFRA ${infraNormal ? 'NORMAL' : 'VERIFICAR'}</span>
                    <div style="margin-top:6px;color:var(--text-2);font-size:11px">
                        ${infraNormal ? 'Não há indício de saturação de CPU, RAM, disco ou RDP no snapshot mais próximo.' : 'Há sinal de infraestrutura degradada; correlacionar com o histórico da VM.'}
                    </div>
                </div>
                <div style="padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--text-2)">
                    <strong style="color:var(--text)">Próxima ação:</strong> validar dependência indicada pelo código de erro e utilizar o runbook da RPA antes de reprocessar.
                </div>
            </div>
        `;
    }

    static renderIncidentDiagnostic(incident) {
        const rpa = DATA.rpas.find(r => r.process === incident.process);
        DomUtils.$('#executionHero').innerHTML = `
            <div class="detail-hero">
                <div class="detail-title">
                    <div><span class="badge danger"><span class="dot"></span>ERRO HISTÓRICO</span></div>
                    <h2>${Fmt.escapeHtml(incident.rpa)}</h2>
                    <p><span class="mono">${incident.executionId}</span> • ${Fmt.escapeHtml(incident.step)}</p>
                </div>
                <div class="detail-stat"><span>Horário</span><strong>${Fmt.fmtDateTime(incident.timestamp)}</strong></div>
                <div class="detail-stat"><span>Duração</span><strong>${incident.durationMin} min</strong></div>
                <div class="detail-stat"><span>VM</span><strong class="mono">${Fmt.escapeHtml(incident.machine)}</strong></div>
                <div class="detail-stat"><span>Retry</span><strong>${incident.retries}</strong></div>
            </div>
        `;
        DomUtils.$('#executionSteps').innerHTML = `
            <div class="step-row error">
                <div class="step-index">!</div>
                <div><div class="step-name">${Fmt.escapeHtml(incident.step)}</div><div class="cell-subtitle">Evento recuperado do histórico</div></div>
                <div><span class="badge danger">ERRO</span></div>
                <div><strong>${Fmt.escapeHtml(incident.errorCode)}</strong></div>
                <div class="step-message">${Fmt.escapeHtml(incident.message)}</div>
            </div>
        `;
        DomUtils.$('#diagnosticVm').innerHTML = `
            <div class="detail-stat"><span>VM registrada</span><strong class="mono">${Fmt.escapeHtml(incident.machine)}</strong></div>
            <div class="cell-subtitle" style="margin-top:8px">Use a página Infraestrutura para correlacionar a telemetria histórica.</div>
        `;
        DomUtils.$('#diagnosticSummary').innerHTML = `
            <span class="badge danger">${Fmt.escapeHtml(incident.errorCode)}</span>
            <div style="margin-top:8px;color:var(--text);font-weight:700">${Fmt.escapeHtml(incident.errorType)}</div>
            <div style="margin-top:5px;color:var(--text-2);font-size:11px">${Fmt.escapeHtml(incident.message)}</div>
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);font-size:11px;color:var(--text-2)">
                Criticidade da automação: ${Fmt.criticalityBadge(rpa?.criticality || incident.criticality)}
            </div>
        `;
    }

    static renderGenericDiagnostic(rpa) {
        DomUtils.$('#executionHero').innerHTML = `
            <div class="detail-hero">
                <div class="detail-title">
                    <div>${Fmt.statusBadge(rpa.lastStatus)}</div>
                    <h2>${Fmt.escapeHtml(rpa.name)}</h2>
                    <p>${Fmt.escapeHtml(rpa.process)}</p>
                </div>
                <div class="detail-stat"><span>Última execução</span><strong>${Fmt.fmtDateTime(rpa.lastExecution)}</strong></div>
                <div class="detail-stat"><span>Duração</span><strong>${rpa.lastDurationMin} min</strong></div>
                <div class="detail-stat"><span>VM</span><strong class="mono">${Fmt.escapeHtml(rpa.machine)}</strong></div>
                <div class="detail-stat"><span>Itens</span><strong>${rpa.processedItems}</strong></div>
            </div>
        `;
        DomUtils.$('#executionSteps').innerHTML = `<div class="empty-state">O mock mantém o detalhamento completo da execução de erro mais recente. Em produção, esta área seria preenchida pelo LOG_EVENTO filtrado pelo execution_id selecionado.</div>`;
        const vm = DATA.vms.find(v => v.name === rpa.machine);
        DomUtils.$('#diagnosticVm').innerHTML = vm ? `
            <div class="grid grid-3" style="gap:8px">
                <div class="detail-stat"><span>CPU</span><strong>${vm.cpu}%</strong></div>
                <div class="detail-stat"><span>RAM</span><strong>${vm.memory}%</strong></div>
                <div class="detail-stat"><span>Disco</span><strong>${vm.disk}%</strong></div>
            </div>
            <div style="margin-top:12px">${Fmt.statusBadge(vm.rdp)}</div>
        ` : '';
        DomUtils.$('#diagnosticSummary').innerHTML = `<div style="color:var(--text-2);font-size:11px">Última execução ${rpa.lastStatus === 'SUCCESS' ? 'concluída normalmente.' : 'com ponto de atenção.'} Duração observada de ${rpa.lastDurationMin} min contra referência de ${rpa.expectedDurationMin} min.</div>`;
    }
}

/* =========================================================================
   CatalogPage — "Catálogo": um card de linha única por RPA, com benefícios
   e responsáveis vindos do cadastro.
   ========================================================================= */
class CatalogPage {
    static renderCatalog() {
        DomUtils.$('#catalogTable').innerHTML = DATA.rpas.map(r => {
            const benefits = r.benefits || [];
            const owners = r.owners || [];
            return `
            <div class="catalog-row" data-search-text="${Fmt.escapeHtml((r.id + ' ' + r.name + ' ' + r.process + ' ' + r.application + ' ' + r.primaryVm + ' ' + (r.businessArea || '') + ' ' + owners.map(o => o.name).join(' ')).toLowerCase())}">
                <div class="catalog-row-head">
                    <div class="catalog-row-id-wrap">
                        <div class="reliability-icon neutral" style="width:34px;height:34px;flex:none"><svg class="icon" style="width:17px;height:17px"><use href="#i-box"></use></svg></div>
                        <div>
                            <div class="cell-title" style="font-size:14px">${Fmt.escapeHtml(r.name)}</div>
                            <div class="cell-subtitle mono">${Fmt.escapeHtml(r.id)} · ${Fmt.escapeHtml(r.process)}</div>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        ${Fmt.criticalityBadge(r.criticality)}
                        ${r.businessArea ? `<span class="badge neutral">${Fmt.escapeHtml(r.businessArea)}</span>` : ''}
                        <button class="action-button catalog-open-btn" data-rpa-id="${Fmt.escapeHtml(r.id)}">Dashboard ↗</button>
                    </div>
                </div>

                <div class="catalog-row-stats">
                    <div class="catalog-stat"><span>Aplicação</span><strong>${Fmt.escapeHtml(r.application)}</strong></div>
                    <div class="catalog-stat"><span>Agenda</span><strong>${Fmt.escapeHtml(r.schedule.join(' • '))}</strong></div>
                    <div class="catalog-stat"><span>Duração esperada</span><strong>${r.expectedDurationMin} min</strong></div>
                    <div class="catalog-stat"><span>VM primária</span><strong class="mono">${Fmt.escapeHtml(r.primaryVm)}</strong></div>
                    <div class="catalog-stat"><span>Contingência</span><strong class="mono">${Fmt.escapeHtml(r.backupVm)}</strong></div>
                    <div class="catalog-stat"><span>Versão</span><strong>${Fmt.escapeHtml(r.version)}</strong></div>
                </div>

                <div class="catalog-row-columns">
                    <div>
                        <div class="cell-subtitle">BENEFÍCIOS DA RPA</div>
                        <ul class="catalog-benefits">
                            ${benefits.map(b => `<li>${Fmt.escapeHtml(b)}</li>`).join('') || '<li class="cell-subtitle">Sem benefícios cadastrados.</li>'}
                        </ul>
                    </div>
                    <div>
                        <div class="cell-subtitle">RESPONSÁVEIS</div>
                        <div class="catalog-owners">
                            ${owners.map(o => `
                                <div class="catalog-owner">
                                    <div class="reliability-icon neutral" style="width:26px;height:26px;flex:none"><svg class="icon" style="width:13px;height:13px"><use href="#i-users"></use></svg></div>
                                    <div>
                                        <div class="catalog-owner-name">${Fmt.escapeHtml(o.name)}</div>
                                        <div class="catalog-owner-role">${Fmt.escapeHtml(o.role)}</div>
                                    </div>
                                </div>
                            `).join('') || '<div class="cell-subtitle">Sem responsáveis cadastrados.</div>'}
                        </div>
                    </div>
                </div>
            </div>
        `;
        }).join('');

        DomUtils.$$('#catalogTable .catalog-open-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                window.open(`rpa-dashboard.html?rpa_id=${encodeURIComponent(btn.dataset.rpaId)}`, '_blank');
            });
        });
    }
}

/* =========================================================================
   RegistryPage — "Cadastro de RPAs": CRUD completo sobre
   config/rpa_metadata.json via /api/registry/rpas/* (server.py,
   RpaRegistryStore). Cada criação/edição/exclusão dispara um refresh
   incremental completo (RpaDataStore.reloadData) para que todas as outras
   páginas (Catálogo, Visão Operacional, etc.) reflitam a mudança sem exigir
   um reload do navegador.

   FIELD_GROUPS descreve o formulário inteiro em dados (grupo → campos), em
   vez de HTML escrito à mão campo a campo — o mesmo array é usado tanto para
   montar os <input>/<select>/<textarea> quanto para serializar/parsear os
   valores ao abrir e salvar o formulário. `_serializeField`/`_parseField`
   são as únicas duas funções desta classe que não tocam o DOM — são o que
   test_dashboard.js exercita (o resto é só verificado manualmente, como
   todo o restante do frontend).
   ========================================================================= */
class RegistryPage {
    static FIELD_GROUPS = [
        { title: 'Identificação', fields: [
            { key: 'process', label: 'Processo (chave técnica, única)', type: 'text', required: true },
            { key: 'name', label: 'Nome', type: 'text', required: true },
            { key: 'businessArea', label: 'Área de negócio', type: 'text', required: true },
            { key: 'businessProcess', label: 'Processo de negócio', type: 'text', required: true },
        ] },
        { title: 'Operação', fields: [
            { key: 'criticality', label: 'Criticidade', type: 'select', options: ['BAIXA', 'MEDIA', 'ALTA', 'CRITICA'], required: true },
            { key: 'supportPriority', label: 'Prioridade de suporte', type: 'select', options: ['P1', 'P2', 'P3'], required: true },
            { key: 'application', label: 'Aplicação', type: 'text', required: true },
            { key: 'supportTeam', label: 'Time de sustentação', type: 'text', required: true },
            { key: 'businessImpact', label: 'Impacto de negócio', type: 'textarea', full: true, required: true },
        ] },
        { title: 'Infraestrutura', fields: [
            { key: 'primaryVm', label: 'VM primária', type: 'text', required: true },
            { key: 'backupVm', label: 'VM contingência', type: 'text', required: true },
            { key: 'orchestrator', label: 'Orquestrador', type: 'text', required: true },
            { key: 'robotName', label: 'Nome do robô', type: 'text', required: true },
        ] },
        { title: 'Agenda e limites', fields: [
            { key: 'schedule', label: 'Horários (HH:MM, separados por vírgula)', type: 'text', full: true, required: true, list: 'commas' },
            { key: 'calendar', label: 'Calendário', type: 'select', options: ['daily', 'weekdays'], required: true },
            { key: 'expectedDurationMin', label: 'Duração esperada (min)', type: 'number', required: true },
            { key: 'warningDurationMin', label: 'Duração de atenção (min)', type: 'number', required: true },
            { key: 'maxDurationMin', label: 'Duração máxima / deadline (min)', type: 'number', required: true },
            { key: 'startToleranceMin', label: 'Tolerância de início (min)', type: 'number', required: true },
            { key: 'maxRetries', label: 'Máximo de retries', type: 'number', required: true },
            { key: 'volumeMin', label: 'Volume mínimo esperado', type: 'number' },
            { key: 'volumeMax', label: 'Volume máximo esperado', type: 'number' },
        ] },
        { title: 'Documentação', fields: [
            { key: 'runbook', label: 'Caminho do runbook', type: 'text', full: true },
            { key: 'steps', label: 'Etapas (uma por linha)', type: 'textarea', full: true, list: 'lines' },
            { key: 'benefits', label: 'Benefícios de negócio (um por linha)', type: 'textarea', full: true, list: 'lines' },
            { key: 'owners', label: 'Responsáveis (um por linha: Nome — Papel)', type: 'textarea', full: true, list: 'pairs', pairSep: '—', pairKeys: ['name', 'role'] },
            { key: 'dependencyFiles', label: 'Arquivos de dependência (um por linha: caminho | rótulo)', type: 'textarea', full: true, list: 'pairs', pairSep: '|', pairKeys: ['path', 'label'] },
        ] },
    ];

    static _rows = [];
    static _editing = null;

    /** Busca o cadastro atual e (re)desenha a tabela. Chamado no boot e a
     * cada refresh de dados, para acompanhar mudanças feitas por qualquer
     * outra sessão do servidor local. */
    static async render() {
        let rows = [];
        try {
            const resp = await fetch('/api/registry/rpas', { cache: 'no-store' }).then(r => r.json());
            if (resp && resp.ok) rows = resp.rpas;
        } catch (exc) {
            // Servidor indisponível (ex.: painel aberto via file://) — cai no
            // cadastro já carregado em DATA, só para exibição; o CRUD real
            // exige o servidor local, como o resto do refresh incremental.
            rows = (DATA.rpas || []).map(r => ({ ...r, rpaId: r.id, schedule: r.schedule || [] }));
        }
        RegistryPage._rows = rows;
        RegistryPage.renderTable();
    }

    /** "Escanear RPAs": varre todo o histórico de logs (não só a janela
     * carregada no momento) por process_name sem entrada correspondente no
     * cadastro — RPAs que já rodam de verdade mas ninguém cadastrou ainda.
     * Nunca cria nada sozinho: só lista, e cada item abre o formulário de
     * criação normal (openForm) pré-preenchido, pra um humano revisar e
     * completar antes de salvar. */
    static async scanForNewRpas() {
        const btn = DomUtils.$('#registryScanBtn');
        const panel = DomUtils.$('#registryScanResults');
        const list = DomUtils.$('#registryScanList');
        btn.disabled = true;
        panel.style.display = '';
        list.innerHTML = `<div class="empty-state">Procurando nos logs…</div>`;
        try {
            const resp = await fetch('/api/registry/rpas/scan', { cache: 'no-store' }).then(r => r.json());
            if (!resp.ok) {
                list.innerHTML = `<div class="registry-error">${Fmt.escapeHtml(resp.error || 'Não foi possível escanear os logs.')}</div>`;
                return;
            }
            if (!resp.found.length) {
                list.innerHTML = `<div class="empty-state">Nenhuma RPA nova encontrada — todo process_name presente nos logs já está cadastrado.</div>`;
                return;
            }
            RegistryPage._scanFound = resp.found;
            list.innerHTML = resp.found.map((item, i) => `
                <div class="registry-scan-item" data-scan-index="${i}">
                    <div>
                        <span class="cell-title mono">${Fmt.escapeHtml(item.process)}</span>
                        <span class="cell-subtitle">Última execução: ${Fmt.fmtDateTime(item.lastSeen)} · VM ${Fmt.escapeHtml(item.primaryVm || '—')} · ${Fmt.escapeHtml(item.orchestrator || '—')}</span>
                    </div>
                    <button class="action-button primary js-scan-register" type="button">Cadastrar</button>
                </div>
            `).join('');
            DomUtils.$$('#registryScanList .js-scan-register').forEach(button => {
                button.addEventListener('click', () => {
                    const index = Number(button.closest('[data-scan-index]').dataset.scanIndex);
                    const found = RegistryPage._scanFound[index];
                    RegistryPage.openForm(null, { process: found.process, primaryVm: found.primaryVm, orchestrator: found.orchestrator, robotName: found.robotName });
                });
            });
        } catch (exc) {
            list.innerHTML = `<div class="registry-error">Falha de comunicação com o servidor local. O escaneamento exige o servidor local (server.py).</div>`;
        } finally {
            btn.disabled = false;
        }
    }

    static renderTable() {
        const rows = [...RegistryPage._rows].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
        DomUtils.$('#registryTable').innerHTML = rows.map(r => `
            <tr data-rpa-id="${Fmt.escapeHtml(r.rpaId)}">
                <td><span class="cell-title">${Fmt.escapeHtml(r.name)}</span><span class="cell-subtitle mono">${Fmt.escapeHtml(r.rpaId)} · ${Fmt.escapeHtml(r.process)}</span></td>
                <td>${Fmt.criticalityBadge(r.criticality)}</td>
                <td>${Fmt.escapeHtml(r.application)}</td>
                <td class="mono">${Fmt.escapeHtml(r.primaryVm)}</td>
                <td>${Fmt.escapeHtml((r.schedule || []).join(' · '))}</td>
                <td style="white-space:nowrap">
                    <button class="action-button js-registry-edit" type="button"><svg class="icon"><use href="#i-edit"></use></svg> Editar</button>
                    <button class="action-button js-registry-delete" type="button" style="color:var(--danger)"><svg class="icon"><use href="#i-trash"></use></svg> Excluir</button>
                </td>
            </tr>
        `).join('') || `<tr><td colspan="6"><div class="empty-state">Nenhuma RPA cadastrada.</div></td></tr>`;

        DomUtils.$$('#registryTable tr[data-rpa-id]').forEach(row => {
            const rpaId = row.dataset.rpaId;
            row.querySelector('.js-registry-edit').addEventListener('click', () => RegistryPage.openForm(RegistryPage._rows.find(r => r.rpaId === rpaId)));
            row.querySelector('.js-registry-delete').addEventListener('click', () => RegistryPage.confirmDelete(rpaId));
        });
    }

    /** RPA → texto de formulário. Não toca o DOM — puro por construção, para
     * ser testável isoladamente (ver test_dashboard.js). */
    static _serializeField(field, value) {
        if (field.list === 'commas') return (value || []).join(', ');
        if (field.list === 'lines') return (value || []).join('\n');
        if (field.list === 'pairs') return (value || []).map(o => `${o[field.pairKeys[0]] ?? ''} ${field.pairSep} ${o[field.pairKeys[1]] ?? ''}`).join('\n');
        return value ?? '';
    }

    /** Texto de formulário → valor pronto para o payload da API. Espelho de
     * `_serializeField` — junto, as duas garantem que abrir e salvar uma RPA
     * sem alterar nada produz o mesmo dado (round-trip). */
    static _parseField(field, raw) {
        if (field.type === 'number') return Number(raw);
        if (field.list === 'commas') return raw.split(',').map(s => s.trim()).filter(Boolean);
        if (field.list === 'lines') return raw.split('\n').map(s => s.trim()).filter(Boolean);
        if (field.list === 'pairs') {
            return raw.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
                const [a, b] = line.split(field.pairSep).map(s => s.trim());
                return { [field.pairKeys[0]]: a || '', [field.pairKeys[1]]: b || '' };
            });
        }
        return raw;
    }

    static _fieldMarkup(f, rpa) {
        const current = RegistryPage._serializeField(f, rpa ? rpa[f.key] : (f.list ? [] : ''));
        if (f.type === 'select') {
            return `<select class="select-control" id="reg_${f.key}">${f.options.map(o => `<option value="${o}" ${rpa && rpa[f.key] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
        }
        if (f.type === 'textarea') {
            return `<textarea class="select-control" id="reg_${f.key}">${Fmt.escapeHtml(current)}</textarea>`;
        }
        return `<input class="select-control" id="reg_${f.key}" type="${f.type === 'number' ? 'number' : 'text'}" value="${Fmt.escapeHtml(current)}">`;
    }

    /** Abre o formulário — sem `rpa`, cria; com `rpa`, edita (o rpaId nunca é
     * editável). `prefill` (só usado quando `rpa` é null) pré-popula os
     * campos sem virar edição — usado pelo fluxo "Escanear RPAs": o processo
     * já existe nos logs, mas ainda não tem rpaId nenhum, então continua
     * sendo uma criação (POST /api/registry/rpas), só que com alguns campos
     * já preenchidos a partir do que foi inferido do log. Modal construído
     * em JS, não em index.html, porque este arquivo não pode depender de
     * aa-integration.css (módulo opcional, removível) para nenhum estilo
     * essencial. */
    static openForm(rpa, prefill) {
        RegistryPage._editing = rpa || null;
        const values = rpa || prefill || null;
        const overlay = document.createElement('div');
        overlay.className = 'registry-modal-overlay';
        overlay.id = 'registryModalOverlay';
        const groupsHtml = RegistryPage.FIELD_GROUPS.map(group => `
            <div class="registry-form-section-title">${Fmt.escapeHtml(group.title)}</div>
            ${group.fields.map(f => `
                <div class="${f.full ? 'full' : ''}">
                    <label for="reg_${f.key}">${Fmt.escapeHtml(f.label)}${f.required ? ' *' : ''}</label>
                    ${RegistryPage._fieldMarkup(f, values)}
                </div>
            `).join('')}
        `).join('');
        overlay.innerHTML = `
            <div class="registry-modal">
                <h3>${rpa ? 'Editar RPA' : 'Nova RPA'}</h3>
                <div class="sub">${rpa ? `<span class="mono">${Fmt.escapeHtml(rpa.rpaId)}</span> — o ID não pode ser alterado.` : (prefill ? 'Processo encontrado nos logs, ainda não cadastrado — os campos abaixo vieram da execução mais recente; complete o restante. O ID é gerado automaticamente ao salvar.' : 'O ID é gerado automaticamente ao salvar.')}</div>
                <div id="registryFormError"></div>
                <div class="registry-form-grid">${groupsHtml}</div>
                <div class="registry-modal-actions">
                    <button class="action-button" id="registryCancelBtn" type="button">Cancelar</button>
                    <button class="action-button primary" id="registrySaveBtn" type="button">Salvar</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) RegistryPage.closeForm(); });
        DomUtils.$('#registryCancelBtn').addEventListener('click', RegistryPage.closeForm);
        DomUtils.$('#registrySaveBtn').addEventListener('click', RegistryPage.submitForm);
    }

    static closeForm() {
        DomUtils.$('#registryModalOverlay')?.remove();
    }

    static _collectPayload() {
        const payload = {};
        RegistryPage.FIELD_GROUPS.forEach(group => group.fields.forEach(f => {
            payload[f.key] = RegistryPage._parseField(f, DomUtils.$(`#reg_${f.key}`).value);
        }));
        return payload;
    }

    static async submitForm() {
        const payload = RegistryPage._collectPayload();
        const editing = RegistryPage._editing;
        const url = editing ? `/api/registry/rpas/${encodeURIComponent(editing.rpaId)}/update` : '/api/registry/rpas';
        const saveBtn = DomUtils.$('#registrySaveBtn');
        saveBtn.disabled = true;
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await CsrfTokenStore.get() },
                body: JSON.stringify(payload),
            }).then(r => r.json());
            if (!resp.ok) {
                DomUtils.$('#registryFormError').innerHTML = `<div class="registry-error">${Fmt.escapeHtml(resp.error || 'Não foi possível salvar.')}</div>`;
                saveBtn.disabled = false;
                return;
            }
            RegistryPage.closeForm();
            showToast(editing ? 'RPA atualizada.' : 'RPA cadastrada.');
            await reloadData(DATA.loadStats?.mode || '30d', false);
            await RegistryPage.render();
        } catch (exc) {
            DomUtils.$('#registryFormError').innerHTML = `<div class="registry-error">Falha de comunicação com o servidor local. O Cadastro de RPAs exige o servidor local (server.py).</div>`;
            saveBtn.disabled = false;
        }
    }

    /** Diálogo de confirmação próprio (não usa window.confirm — bloquearia
     * o carregamento incremental em andamento e é inconsistente com o
     * restante da UI, que sempre usa modais próprios para ações destrutivas). */
    static confirmDelete(rpaId) {
        const rpa = RegistryPage._rows.find(r => r.rpaId === rpaId);
        const overlay = document.createElement('div');
        overlay.className = 'registry-modal-overlay';
        overlay.innerHTML = `
            <div class="registry-modal" style="max-width:420px">
                <h3>Excluir RPA</h3>
                <p style="color:var(--text-2);font-size:13px">Remover <strong style="color:var(--text)">${Fmt.escapeHtml(rpa?.name || rpaId)}</strong> do cadastro? As regras de agenda associadas também serão removidas. Execuções já registradas nos logs não são apagadas.</p>
                <div class="registry-modal-actions">
                    <button class="action-button" id="registryDeleteCancel" type="button">Cancelar</button>
                    <button class="action-button primary" id="registryDeleteConfirm" type="button" style="background:var(--danger);border-color:var(--danger)">Excluir</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) overlay.remove(); });
        overlay.querySelector('#registryDeleteCancel').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#registryDeleteConfirm').addEventListener('click', () => RegistryPage._runDelete(rpaId, overlay));
    }

    static async _runDelete(rpaId, overlay) {
        overlay.remove();
        try {
            const resp = await fetch(`/api/registry/rpas/${encodeURIComponent(rpaId)}/delete`, {
                method: 'POST',
                headers: { 'X-CSRF-Token': await CsrfTokenStore.get() },
            }).then(r => r.json());
            if (!resp.ok) { showToast(resp.error || 'Não foi possível excluir.'); return; }
            showToast('RPA removida do cadastro.');
            await reloadData(DATA.loadStats?.mode || '90d');
            await RegistryPage.render();
        } catch (exc) {
            showToast('Falha de comunicação com o servidor local.');
        }
    }
}

/* =========================================================================
   RpaOpsApp — orquestrador de topo: renderiza tudo (idempotente; chamado no
   boot e a cada refresh) e faz a inicialização única.
   ========================================================================= */
class RpaOpsApp {
    static renderAll() {
        OverviewPage.renderLoadPeriodLabel();
        OverviewPage.renderDataQuality();
        OverviewPage.renderOverviewKpis();
        OverviewPage.populateRpaFilterOptions();
        OverviewPage.renderRpaOpsTable();
        OverviewPage.renderTimeline();
        OverviewPage.renderHistoricalHeatmap();
        OverviewPage.renderVmIdleTrend();
        OverviewPage.renderVmUtilizationList();
        OverviewPage.renderVmReliability();
        OverviewPage.renderVmConsolidation();
        OverviewPage.renderIncidentQueue();
        OverviewPage.renderVmCompactList();
        AlertsPage.renderAlerts();
        AlertsPage.renderAlertContext();

        ExecutionsPage.renderSuccessTrend();
        ExecutionsPage.renderExecutionKpis();
        ExecutionsPage.renderDurationComparison();
        ExecutionsPage.renderHourlyLoad();
        AuditPage.renderExecutionAuditTable();

        // Pré-carrega a execução detalhada de exemplo na página Auditoria.
        AuditPage.renderAuditExecution(DATA.auditExecutions?.[DATA.executionDetail.executionId] || DATA.executionDetail);

        IncidentsPage.renderErrorPareto();
        IncidentsPage.renderFailureHeatmap();
        IncidentsPage.renderIncidentTable();

        InfrastructurePage.renderVmKpis();
        InfrastructurePage.renderVmGrid();

        DiagnosticPage.renderDiagnostic(DATA.executionDetail);
        CatalogPage.renderCatalog();
        RegistryPage.render();

        NavigationController.refreshOverflowHints();
    }

    static init() {
        NavigationController.bindFilterListeners();
        RpaOpsApp.renderAll();

        const savedPage = sessionStorage.getItem('rpaOpsActivePage');
        if (savedPage && document.getElementById(`page-${savedPage}`)) NavigationController.goToPage(savedPage);

        const dataWindowSelect = DomUtils.$('#dataWindowSelect');
        const executionPeriod = DomUtils.$('#executionPeriod');
        const currentMode = DATA.loadStats?.mode || '30d';

        if (dataWindowSelect) {
            dataWindowSelect.value = currentMode;
            dataWindowSelect.addEventListener('change', () => {
                if (executionPeriod) executionPeriod.value = dataWindowSelect.value;
                // Troca de período consulta apenas o SQLite: não relê arquivos.
                RpaDataStore.reloadData(dataWindowSelect.value, false);
            });
        }

        if (executionPeriod) {
            executionPeriod.value = currentMode;
            executionPeriod.addEventListener('change', () => {
                if (dataWindowSelect) dataWindowSelect.value = executionPeriod.value;
                RpaDataStore.reloadData(executionPeriod.value, false);
            });
        }

        DomUtils.$('#reloadButton').addEventListener('click', () => {
            RpaDataStore.reloadData(dataWindowSelect?.value || DATA.loadStats?.mode || '30d', true);
        });

        DomUtils.$('#registryNewBtn').addEventListener('click', () => RegistryPage.openForm(null));
        DomUtils.$('#registryScanBtn').addEventListener('click', () => RegistryPage.scanForNewRpas());

        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => NavigationController.refreshOverflowHints(), 150);
        });
    }
}

/* =========================================================================
   ALIASES — mesmo nome, mesma assinatura de todas as funções que existiam
   soltas no arquivo original. Preservam cada ponto de chamada (interno e em
   assets/aa-integration.js) sem exigir nenhuma reescrita.
   ========================================================================= */
const $ = DomUtils.$;
const $$ = DomUtils.$$;
const escapeHtml = Fmt.escapeHtml;
const clamp = Fmt.clamp;
const fmtDateTime = Fmt.fmtDateTime;
const fmtTime = Fmt.fmtTime;
const fmtHoursMinutes = Fmt.fmtHoursMinutes;
const formatAuditDuration = Fmt.formatAuditDuration;
const statusBadge = Fmt.statusBadge;
const severityBadge = Fmt.severityBadge;
const criticalityBadge = Fmt.criticalityBadge;
const auditComplianceBadge = Fmt.auditComplianceBadge;
const auditStatusIcon = Fmt.auditStatusIcon;
const heatClass = Fmt.heatClass;
const metricClass = Fmt.metricClass;

const showToast = UiFeedback.showToast;
const showTooltip = UiFeedback.showTooltip;
const hideTooltip = UiFeedback.hideTooltip;

const themeColor = ChartService.themeColor;
const chartPalette = ChartService.chartPalette;
const drawChart = ChartService.drawChart;
const tooltipBase = ChartService.tooltipBase;
const redrawThemedCharts = ChartService.redrawThemedCharts;
const sparkline = ChartService.sparkline;
const lineChart = ChartService.lineChart;

const goToPage = NavigationController.goToPage;
const refreshOverflowHints = NavigationController.refreshOverflowHints;
const openExecutionWorkspace = NavigationController.openExecutionWorkspace;
const bindFilterListeners = NavigationController.bindFilterListeners;

const getCsrfToken = CsrfTokenStore.get;

const buildAuditDetail = RpaDataStore.buildAuditDetail;
const buildAuditExecutions = RpaDataStore.buildAuditExecutions;
const computeStepHistory = RpaDataStore.computeStepHistory;
const setLoadProgress = RpaDataStore.setLoadProgress;
const hideLoadProgress = RpaDataStore.hideLoadProgress;
const pollLoadStatus = RpaDataStore.pollLoadStatus;
const fetchScript = RpaDataStore.fetchScript;
const reloadData = RpaDataStore.reloadData;

const RELIABILITY_META = OverviewPage.RELIABILITY_META;
const CONSOLIDATION_PALETTE = OverviewPage.CONSOLIDATION_PALETTE;
const renderOverviewKpis = OverviewPage.renderOverviewKpis;
const populateRpaFilterOptions = OverviewPage.populateRpaFilterOptions;
const renderRpaOpsTable = OverviewPage.renderRpaOpsTable;
const renderTimeline = OverviewPage.renderTimeline;
const renderIncidentQueue = OverviewPage.renderIncidentQueue;
const renderVmCompactList = OverviewPage.renderVmCompactList;
const renderDataQuality = OverviewPage.renderDataQuality;
const renderLoadPeriodLabel = OverviewPage.renderLoadPeriodLabel;
const renderHistoricalHeatmap = OverviewPage.renderHistoricalHeatmap;
const renderVmIdleTrend = OverviewPage.renderVmIdleTrend;
const renderVmUtilizationList = OverviewPage.renderVmUtilizationList;
const renderVmReliability = OverviewPage.renderVmReliability;
const renderVmConsolidation = OverviewPage.renderVmConsolidation;

const PARETO_DIMENSION_LABELS = AlertsPage.PARETO_DIMENSION_LABELS;
const paretoListHtml = AlertsPage.paretoListHtml;
const renderAlertContext = AlertsPage.renderAlertContext;
const renderAlerts = AlertsPage.renderAlerts;

const renderSuccessTrend = ExecutionsPage.renderSuccessTrend;
const renderExecutionKpis = ExecutionsPage.renderExecutionKpis;
const renderDurationComparison = ExecutionsPage.renderDurationComparison;
const renderHourlyLoad = ExecutionsPage.renderHourlyLoad;

const renderErrorPareto = IncidentsPage.renderErrorPareto;
const renderFailureHeatmap = IncidentsPage.renderFailureHeatmap;
const renderIncidentTable = IncidentsPage.renderIncidentTable;

const renderVmKpis = InfrastructurePage.renderVmKpis;
const renderVmGrid = InfrastructurePage.renderVmGrid;

const populateAuditRpaSelect = AuditPage.populateAuditRpaSelect;
const populateAuditExecutionSelect = AuditPage.populateAuditExecutionSelect;
const initAuditPicker = AuditPage.initAuditPicker;
const renderAuditStepHistory = AuditPage.renderAuditStepHistory;
const renderAuditExecution = AuditPage.renderAuditExecution;
const openAuditExecution = AuditPage.openAuditExecution;
const renderExecutionAuditTable = AuditPage.renderExecutionAuditTable;

const renderDiagnostic = DiagnosticPage.renderDiagnostic;
const renderIncidentDiagnostic = DiagnosticPage.renderIncidentDiagnostic;
const renderGenericDiagnostic = DiagnosticPage.renderGenericDiagnostic;

const renderCatalog = CatalogPage.renderCatalog;

const renderAll = RpaOpsApp.renderAll;
const init = RpaOpsApp.init;

/* =========================================================================
   BOOT — mesma sequência e mesma ordem relativa do arquivo original: DATA é
   uma variável solta reatribuível (nunca uma propriedade de classe) porque
   RpaDataStore.reloadData() e dezenas de métodos acima leem/reatribuem o
   identificador `DATA` diretamente; movê-la para dentro de uma classe
   quebraria essa reatribuição silenciosamente.
   ========================================================================= */
// `DATA` fica declarada incondicionalmente (mesmo em Node, onde fica
// undefined) para permanecer um identificador de topo genuíno em qualquer
// ambiente — só o boot de fato (que toca window/document/Chart) roda
// apenas no navegador, guardado logo abaixo.
let DATA;
const chartRegistry = ChartService.registry;

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.INDEX_DATA && window.OBS_DATA) {
    // Sem os dois (ex.: Handler._send_data_error devolveu
    // window.OBS_DATA/INDEX_DATA = null porque o Cadastro/logs estavam
    // inacessíveis), não tem o que renderizar — a tela de carregamento
    // inicial (index.html) já mostra o erro real e fica visível; deixar o
    // boot seguir só geraria uma exceção não tratada tentando ler campos de
    // null, sem nenhum ganho.
    DATA = window.INDEX_DATA;
    DATA.auditExecutions = buildAuditExecutions(window.OBS_DATA);
    window.ACTIVE_EXECUTION_ID = DATA.executionDetail?.executionId || DATA.timeline?.[0]?.executionId || null;

    if (window.Chart) {
        Chart.defaults.font.family = "Inter, system-ui, -apple-system, sans-serif";
        Chart.defaults.font.size = 11;
        Chart.defaults.plugins.legend.display = false;
    }

    NavigationController.bindGlobalControls();

    // Ponto de integração usado pelo refresh automático de 20 minutos
    // (assets/auto-refresh.js) para evitar um location.reload() cego.
    window.RPA_INCREMENTAL_REFRESH = () => reloadData(DATA.loadStats?.mode || '30d', true);

    init();

    // Some junto com o primeiro paint pronto — nunca antes: revelar o
    // dashboard só depois de init() renderizar tudo evita um flash de UI
    // vazia entre "carregando" e "carregado" (ver tela de carregamento
    // inicial em index.html, logo no início do body).
    window.__hideInitialLoadOverlay?.();
}

/* Exporta as classes puras (sem DOM) para o test_dashboard.js via Node —
   no navegador `module` não existe, então este bloco é um no-op ali. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Fmt, ChartService, RegistryPage };
}
