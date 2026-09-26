/* ============================================================================
   Testes locais das partes puras de assets/dashboard-app.js — sem navegador,
   sem dependências externas. Usa o test runner embutido do Node (>=18).

   Como rodar:
       node --test test_dashboard.js

   Cobre só Fmt e ChartService.sparkline/lineChart: são as únicas classes do
   dashboard que não tocam o DOM (document/window) — todo o resto (as
   *Page, NavigationController, RpaDataStore) manipula elementos da página
   diretamente e por isso só é verificado manualmente no navegador, como
   sempre foi neste projeto (ver README.txt, seção TESTES).
   ============================================================================ */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { Fmt, ChartService, RegistryPage } = require(path.join(__dirname, 'assets', 'dashboard-app.js'));

test('Fmt.escapeHtml escapa os cinco caracteres perigosos', () => {
    assert.equal(Fmt.escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#039;&amp;&#039;&lt;/a&gt;');
});

test('Fmt.escapeHtml trata null/undefined como string vazia', () => {
    assert.equal(Fmt.escapeHtml(null), '');
    assert.equal(Fmt.escapeHtml(undefined), '');
});

test('Fmt.clamp limita nos dois sentidos', () => {
    assert.equal(Fmt.clamp(5, 0, 10), 5);
    assert.equal(Fmt.clamp(-5, 0, 10), 0);
    assert.equal(Fmt.clamp(50, 0, 10), 10);
});

test('Fmt.fmtHoursMinutes formata só minutos quando <1h', () => {
    assert.equal(Fmt.fmtHoursMinutes(45), '45m');
});

test('Fmt.fmtHoursMinutes formata horas e minutos quando >=1h', () => {
    assert.equal(Fmt.fmtHoursMinutes(125), '2h 05m');
});

test('Fmt.formatAuditDuration usa segundos com casa decimal abaixo de 1 min', () => {
    assert.equal(Fmt.formatAuditDuration(45.2), '45.2s');
});

test('Fmt.formatAuditDuration usa minutos e segundos a partir de 60s', () => {
    assert.equal(Fmt.formatAuditDuration(125), '2m 05s');
});

test('Fmt.statusBadge conhece os 11 estados operacionais + os básicos', () => {
    for (const status of ['SUCCESS', 'WARNING', 'ERROR', 'AGUARDANDO', 'EXECUTANDO', 'SUCESSO', 'ATRASADA', 'NAO_INICIOU', 'DURACAO_ANORMAL', 'SLA_EM_RISCO', 'SLA_ESTOURADO', 'VM_DEGRADADA']) {
        const html = Fmt.statusBadge(status);
        assert.match(html, /<span class="badge/, `status ${status} deveria gerar um badge`);
        assert.doesNotMatch(html, new RegExp(`neutral">${status}<`), `status ${status} não deveria cair no fallback "neutral"`);
    }
});

test('Fmt.statusBadge cai em "neutral" para um status desconhecido, sem lançar erro', () => {
    const html = Fmt.statusBadge('ALGO_INEXISTENTE');
    assert.match(html, /badge neutral/);
    assert.match(html, /ALGO_INEXISTENTE/);
});

test('Fmt.criticalityBadge classifica CRÍTICA como danger e ALTA como warning', () => {
    assert.match(Fmt.criticalityBadge('CRÍTICA'), /badge danger/);
    assert.match(Fmt.criticalityBadge('ALTA'), /badge warning/);
    assert.match(Fmt.criticalityBadge('MÉDIA'), /badge neutral/);
});

test('Fmt.auditComplianceBadge trata ausência de regra sem lançar erro', () => {
    assert.match(Fmt.auditComplianceBadge(null), /SEM REGRA/);
    assert.match(Fmt.auditComplianceBadge(undefined), /SEM REGRA/);
});

test('Fmt.auditComplianceBadge classifica NO_PRAZO/NORMAL como sucesso e ATRASADA como aviso', () => {
    assert.match(Fmt.auditComplianceBadge('NO_PRAZO'), /badge success/);
    assert.match(Fmt.auditComplianceBadge('NORMAL'), /badge success/);
    assert.match(Fmt.auditComplianceBadge('ATRASADA'), /badge warning/);
});

test('Fmt.heatClass distribui em 5 faixas (0 a 4) proporcionalmente ao máximo', () => {
    assert.equal(Fmt.heatClass(0, 10), 'heat-0');
    assert.equal(Fmt.heatClass(2, 10), 'heat-1');  // ratio .2 <= .25
    assert.equal(Fmt.heatClass(5, 10), 'heat-2');  // ratio .5 <= .5
    assert.equal(Fmt.heatClass(7, 10), 'heat-3');  // ratio .7 <= .75
    assert.equal(Fmt.heatClass(10, 10), 'heat-4'); // ratio 1 > .75
});

test('Fmt.metricClass usa os limiares de warning/critical na ordem certa', () => {
    assert.equal(Fmt.metricClass(50, 75, 90), 'success');
    assert.equal(Fmt.metricClass(80, 75, 90), 'warning');
    assert.equal(Fmt.metricClass(95, 75, 90), 'danger');
});

test('ChartService.sparkline retorna string vazia para lista vazia (sem lançar erro de Math.min de array vazio)', () => {
    assert.equal(ChartService.sparkline([]), '');
    assert.equal(ChartService.sparkline(null), '');
});

test('ChartService.sparkline gera um <polyline> com um ponto por valor', () => {
    const svg = ChartService.sparkline([1, 5, 3, 8]);
    const points = svg.match(/points="([^"]+)"/)[1].trim().split(' ');
    assert.equal(points.length, 4);
});

test('ChartService.sparkline não quebra quando todos os valores são iguais (range zero)', () => {
    const svg = ChartService.sparkline([7, 7, 7]);
    assert.match(svg, /<polyline/);
    assert.doesNotMatch(svg, /NaN/);
});

test('ChartService.lineChart gera um círculo por linha e nenhum NaN nas coordenadas', () => {
    const rows = [{ date: '01/01', rate: 90 }, { date: '02/01', rate: 95 }, { date: '03/01', rate: 88 }];
    const svg = ChartService.lineChart(rows, 'rate', { label: 'Teste' });
    const circles = svg.match(/<circle/g) || [];
    assert.equal(circles.length, 3);
    assert.doesNotMatch(svg, /NaN/);
});

/* ----------------------------------------------------------------------
   RegistryPage — só _serializeField/_parseField não tocam o DOM; o resto
   (render, openForm, submitForm) manipula elementos da página diretamente
   e é verificado manualmente no navegador, como as demais classes *Page.
   ---------------------------------------------------------------------- */

test('RegistryPage._parseField converte lista separada por vírgula (schedule)', () => {
    const field = { list: 'commas' };
    assert.deepEqual(RegistryPage._parseField(field, '08:00, 09:00 ,10:00'), ['08:00', '09:00', '10:00']);
});

test('RegistryPage._parseField converte lista separada por vírgula vazia em array vazio', () => {
    assert.deepEqual(RegistryPage._parseField({ list: 'commas' }, ''), []);
});

test('RegistryPage._parseField converte textarea em lista de linhas (steps/benefits)', () => {
    const field = { list: 'lines' };
    assert.deepEqual(RegistryPage._parseField(field, 'Etapa 1\n\nEtapa 2\n  Etapa 3  '), ['Etapa 1', 'Etapa 2', 'Etapa 3']);
});

test('RegistryPage._parseField converte textarea de pares (owners: "Nome — Papel")', () => {
    const field = { list: 'pairs', pairSep: '—', pairKeys: ['name', 'role'] };
    const parsed = RegistryPage._parseField(field, 'Fernanda Duarte — Business Owner\nLucas Prado — Process Owner');
    assert.deepEqual(parsed, [
        { name: 'Fernanda Duarte', role: 'Business Owner' },
        { name: 'Lucas Prado', role: 'Process Owner' },
    ]);
});

test('RegistryPage._parseField converte campo numérico', () => {
    assert.equal(RegistryPage._parseField({ type: 'number' }, '25'), 25);
});

test('RegistryPage._serializeField/_parseField fazem round-trip sem alterar o valor', () => {
    const scheduleField = { list: 'commas' };
    const original = ['08:00', '14:30'];
    assert.deepEqual(RegistryPage._parseField(scheduleField, RegistryPage._serializeField(scheduleField, original)), original);

    const ownersField = { list: 'pairs', pairSep: '—', pairKeys: ['name', 'role'] };
    const owners = [{ name: 'Ana', role: 'Owner' }, { name: 'Bruno', role: 'Suporte' }];
    assert.deepEqual(RegistryPage._parseField(ownersField, RegistryPage._serializeField(ownersField, owners)), owners);
});
