/* ============================================================================
   SHARED UI KIT — páginas avulsas do RPA Ops Monitor
   ----------------------------------------------------------------------------
   Usado por investigacao.html (Investigação & Diagnóstico, fundidas em uma
   só tela em 2026-09-29) e rpa-dashboard.html — as duas telas que abrem
   como janela "de app" a partir do dashboard principal. Cada uma dessas
   páginas acessa este arquivo através de `window.RPAUI` — por isso o
   objeto exportado no fim do arquivo precisa manter exatamente as mesmas
   chaves de sempre (D, IDX, $, esc, getRpa, lineSvg, etc.); mudar um nome
   aqui quebra as duas páginas ao mesmo tempo.

   Fontes de dados:
   - window.OBS_DATA  → gerado por server.py a partir dos logs (90 dias por
     padrão). É o "detalhe": execuções, eventos por etapa, telemetria de VM.
   - window.INDEX_DATA → o mesmo período, mas agregado (VM reliability,
     utilização, Pareto de erros). Só carregado se a página incluir também
     <script src="assets/index-data.js">; por isso todo acesso a IDX é
     defensivo (?. em cascata) — nem toda página precisa dele.
   ============================================================================ */
(function () {
    'use strict';

    /* =========================================================================
       RpaFormatter — formatação de datas, números e badges de status. Não
       depende de dado nenhum, só de valores recebidos por parâmetro.
       ========================================================================= */
    class RpaFormatter {
        static RELIABILITY_META = {
            SAUDAVEL: { label: 'Saudável', cls: 'ok' },
            ATENCAO: { label: 'Atenção', cls: 'warn' },
            PROBLEMA_ESPECIFICO: { label: 'Específico de 1 RPA', cls: 'warn' },
            PROBLEMA_GERAL: { label: 'Problema geral da VM', cls: 'bad' },
            DADOS_INSUFICIENTES: { label: 'Dados insuficientes', cls: 'neutral' },
        };

        fmtDateTime(v) { return v ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(v)) : '—'; }
        fmtDate(v) { return v ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(new Date(v + 'T12:00:00')) : '—'; }
        fmtTime(v) { return v ? new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' }).format(new Date(v)) : '—'; }

        esc(v) {
            return String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
        }

        statusBadge(s) { return `<span class="badge ${this.esc(s)}">${this.esc(s)}</span>`; }

        /** Badge de classificação de confiabilidade de VM (SAUDAVEL/ATENCAO/
         * PROBLEMA_ESPECIFICO/PROBLEMA_GERAL/DADOS_INSUFICIENTES) — mesmo
         * vocabulário usado em index.html (Infraestrutura). */
        reliabilityBadge(classification) {
            const meta = RpaFormatter.RELIABILITY_META[classification] || RpaFormatter.RELIABILITY_META.DADOS_INSUFICIENTES;
            return `<span class="badge ${meta.cls}">${meta.label}</span>`;
        }

        duration(sec) {
            return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s`;
        }

        pct(a, b) { return b ? 100 * a / b : 0; }

        median(arr) {
            const sorted = [...arr].sort((x, y) => x - y);
            if (!sorted.length) return 0;
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        }

        percentile(arr, p) {
            const sorted = [...arr].sort((x, y) => x - y);
            if (!sorted.length) return 0;
            const k = (sorted.length - 1) * p, f = Math.floor(k), c = Math.ceil(k);
            return f === c ? sorted[f] : sorted[f] * (c - k) + sorted[c] * (k - f);
        }
    }

    /* =========================================================================
       RpaDataRepository — todo acesso a OBS_DATA/INDEX_DATA passa por aqui.
       `D` continua exposto como propriedade pública crua (não um getter),
       porque as três páginas fazem acesso direto tipo `U.D.executions` e
       `U.D.rpaAggregates[rpaId]` em vários pontos — encapsular isso atrás de
       métodos exigiria reescrever as três páginas, o que foge do escopo
       (eram justamente as telas marcadas como "risco alto" para conversão).
       ========================================================================= */
    class RpaDataRepository {
        constructor(obsData, indexData) {
            this.D = obsData;
            this.IDX = indexData || null;
        }

        processName(id) { return this.D.rpas.find(r => r.rpaId === id)?.name || id; }
        getExecution(id) { return this.D.executions.find(e => e.executionId === id); }
        getRpa(id) { return this.D.rpas.find(r => r.rpaId === id); }
        getRpaByProcess(process) { return this.D.rpas.find(r => r.process === process); }
        getEvents(executionId) { return this.D.eventsByExecution[executionId] || []; }
        getVmContext(executionId) { return this.D.vmContextByExecution[executionId] || []; }

        vmReliabilityFor(machine) { return this.IDX?.vmReliability?.find(v => v.machine === machine) || null; }
        vmUtilizationFor(machine) { return this.IDX?.vmUtilization?.find(v => v.machine === machine) || null; }

        /** Posição de um rótulo dentro do Pareto de erros de todo o período
         * carregado (top 12 por dimensão) — null quando o rótulo não
         * concentra erro suficiente para aparecer entre os mais recorrentes. */
        paretoRank(dimension, label) {
            const rows = this.IDX?.errorParetos?.[dimension];
            if (!rows) return null;
            const idx = rows.findIndex(r => r.label === label);
            if (idx === -1) return null;
            return { rank: idx + 1, count: rows[idx].count, of: rows.length };
        }
    }

    /* =========================================================================
       RpaChartRenderer — os dois "mini-charts" em SVG puro usados pelas
       páginas avulsas (sem dependência de Chart.js, ao contrário do
       index.html). Depende só do RpaFormatter para escapar texto.
       ========================================================================= */
    class RpaChartRenderer {
        constructor(formatter) {
            this.fmt = formatter;
        }

        /** Gráfico de linha(s) com eixo Y e rótulos de eixo X amostrados. */
        lineSvg(rows, series, options = {}) {
            if (!rows.length) return '<div class="empty">Sem dados no período.</div>';
            const W = 900, H = 250, p = { l: 46, r: 18, t: 20, b: 38 };
            const vals = rows.flatMap(r => series.map(s => Number(r[s.key] || 0)));
            let ymin = options.min ?? Math.min(...vals);
            let ymax = options.max ?? Math.max(...vals);
            if (ymin === ymax) { ymin = Math.max(0, ymin - 1); ymax += 1; }
            const span = ymax - ymin;
            const x = i => p.l + i * (W - p.l - p.r) / Math.max(1, rows.length - 1);
            const y = v => p.t + (ymax - v) / span * (H - p.t - p.b);
            const ticks = [0, .25, .5, .75, 1].map(t => ymin + span * t);
            const grid = ticks.map(v => `<line class="gridline" x1="${p.l}" x2="${W - p.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${p.l - 7}" y="${y(v) + 3}" text-anchor="end">${options.formatY ? options.formatY(v) : Math.round(v * 10) / 10}</text>`).join('');
            const labels = rows.map((r, i) => (i === 0 || i === rows.length - 1 || i % Math.max(1, Math.floor(rows.length / 7)) === 0) ? `<text class="axis" x="${x(i)}" y="${H - 11}" text-anchor="middle">${this.fmt.esc(options.labelX ? options.labelX(r) : r.date)}</text>` : '').join('');
            const colors = ['var(--primary)', 'var(--warning)', 'var(--danger)', 'var(--info)'];
            const lines = series.map((s, si) => {
                const pts = rows.map((r, i) => `${x(i)},${y(Number(r[s.key] || 0))}`).join(' ');
                return `<polyline points="${pts}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`;
            }).join('');
            return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${lines}${labels}</svg><div class="legend">${series.map((s, i) => `<span><i style="background:${colors[i % colors.length]}"></i>${this.fmt.esc(s.label)}</span>`).join('')}</div>`;
        }

        /** Lista de barras horizontais (usa .metric-row/.progress do
         * observability.css, não de index.html). */
        barSvg(rows, key, labelKey = 'label', options = {}) {
            if (!rows.length) return '<div class="empty">Sem dados.</div>';
            const max = Math.max(...rows.map(r => Number(r[key] || 0)), 1);
            return `<div>${rows.map(r => `<div class="metric-row"><span title="${this.fmt.esc(r[labelKey])}">${this.fmt.esc(r[labelKey])}</span><div class="progress"><span style="width:${Number(r[key] || 0) / max * 100}%"></span></div><strong>${options.format ? options.format(r[key]) : r[key]}</strong></div>`).join('')}</div>`;
        }
    }

    /* =========================================================================
       RpaPageNavigator — abrir outras páginas em nova aba, montar o toolbar
       padrão (botão fechar/exportar/snapshot) e exportar PDF via impressão.
       ========================================================================= */
    class RpaPageNavigator {
        constructor(repository) {
            this.repo = repository;
        }

        /** Abre como janela "de app" (sem abas, sem barra de endereço) em vez
         * de uma aba comum — mesma técnica usada por `NavigationController`
         * em dashboard-app.js (ver `WINDOW_FEATURES` lá). `noopener` também
         * impede a página aberta de enxergar/navegar esta janela via
         * `window.opener` (nenhuma das 3 páginas avulsas usa isso hoje). */
        static WINDOW_FEATURES = 'popup=yes,noopener,noreferrer,width=1440,height=900,left=60,top=40';
        openInvestigation(executionId) { window.open(`investigacao.html?execution_id=${encodeURIComponent(executionId)}`, '_blank', RpaPageNavigator.WINDOW_FEATURES); }
        openRpa(rpaId) { window.open(`rpa-dashboard.html?rpa_id=${encodeURIComponent(rpaId)}`, '_blank', RpaPageNavigator.WINDOW_FEATURES); }
        exportPdf() { window.print(); }

        /** Delegação de clique para abrir investigação/diagnóstico a partir de
         * uma linha/célula renderizada dinamicamente a partir de dado de log
         * (execution_id não é confiável — ver README.txt, seção SEGURANÇA).
         * Em vez de `onclick="RPAUI.openInvestigation('${execution_id}')"`
         * embutido na string HTML (o valor entra dentro de uma string JS
         * dentro de um atributo HTML — escapar HTML não fecha essa segunda
         * camada, então um execution_id malicioso ainda quebraria para fora
         * da chamada), o id fica só num atributo `data-*` (que só precisa de
         * escape HTML de verdade) e é lido como string pura via `.dataset`,
         * nunca reinterpretado como código. Chamado uma vez por página —
         * sobrevive a qualquer novo innerHTML dos containers internos porque
         * o listener fica no body, não nos elementos recriados. */
        bindExecutionLinks() {
            document.body.addEventListener('click', (event) => {
                const inv = event.target.closest('[data-open-investigation]');
                if (inv) return this.openInvestigation(inv.dataset.openInvestigation);
            });
        }

        initToolbar(label, formatter) {
            const back = document.querySelector('#btnBack');
            if (back) back.addEventListener('click', () => window.close());
            const pdf = document.querySelector('#btnPdf');
            if (pdf) pdf.addEventListener('click', () => this.exportPdf());
            // Nunca rotular como "sintética"/"demo" aqui: este mesmo texto
            // aparece com o dataset de exemplo do repositório E com dados
            // reais depois do deploy (server.py lê de LOG_BASE/CONFIG_ROOT,
            // que podem apontar pro compartilhamento real da empresa) — um
            // rótulo fixo de "sintética" ficaria enganoso assim que dados de
            // verdade estiverem carregados. Mesmo texto neutro que o
            // dashboard principal (index.html) já usa.
            const snapshot = document.querySelector('#snapshot');
            if (snapshot) snapshot.textContent = `Período dos dados: ${formatter.fmtDate(this.repo.D.periodStart)} a ${formatter.fmtDate(this.repo.D.periodEnd)}`;
            document.title = label + ' · RPA Ops Monitor';
        }
    }

    /* =========================================================================
       Montagem — instancia as classes acima e publica window.RPAUI com as
       MESMAS chaves de sempre, para que investigacao.html/rpa-dashboard.html
       continuem funcionando sem nenhuma alteração.
       ========================================================================= */
    const repository = new RpaDataRepository(window.OBS_DATA, window.INDEX_DATA || null);
    const formatter = new RpaFormatter();
    const chartRenderer = new RpaChartRenderer(formatter);
    const navigator = new RpaPageNavigator(repository);

    window.RPAUI = {
        D: repository.D,
        IDX: repository.IDX,
        $: (s, root = document) => root.querySelector(s),
        $$: (s, root = document) => [...root.querySelectorAll(s)],
        q: new URLSearchParams(location.search),

        fmtDateTime: v => formatter.fmtDateTime(v),
        fmtDate: v => formatter.fmtDate(v),
        fmtTime: v => formatter.fmtTime(v),
        esc: v => formatter.esc(v),
        statusBadge: s => formatter.statusBadge(s),
        reliabilityBadge: classification => formatter.reliabilityBadge(classification),
        pct: (a, b) => formatter.pct(a, b),
        median: arr => formatter.median(arr),
        percentile: (arr, p) => formatter.percentile(arr, p),
        duration: sec => formatter.duration(sec),

        processName: id => repository.processName(id),
        getExecution: id => repository.getExecution(id),
        getRpa: id => repository.getRpa(id),
        getRpaByProcess: p => repository.getRpaByProcess(p),
        getEvents: id => repository.getEvents(id),
        getVmContext: id => repository.getVmContext(id),
        vmReliabilityFor: machine => repository.vmReliabilityFor(machine),
        vmUtilizationFor: machine => repository.vmUtilizationFor(machine),
        paretoRank: (dim, label) => repository.paretoRank(dim, label),

        openInvestigation: id => navigator.openInvestigation(id),
        openRpa: id => navigator.openRpa(id),
        exportPdf: () => navigator.exportPdf(),
        initToolbar: label => navigator.initToolbar(label, formatter),
        bindExecutionLinks: () => navigator.bindExecutionLinks(),

        lineSvg: (rows, series, options) => chartRenderer.lineSvg(rows, series, options),
        barSvg: (rows, key, labelKey, options) => chartRenderer.barSvg(rows, key, labelKey, options),
    };
})();
