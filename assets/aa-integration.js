/* ============================================================================
   INTEGRAÇÃO OPCIONAL — AUTOMATION ANYWHERE 360 CONTROL ROOM
   ----------------------------------------------------------------------------
   Módulo estritamente aditivo e removível: basta apagar a tag <script> que
   carrega este arquivo (e a <link> do aa-integration.css) para o dashboard
   voltar a ser exatamente o que era antes — nada aqui é chamado pelo pipeline
   de dados existente (DATA/OBS_DATA, renderAll, reloadData, goToPage do
   index.html continuam intocados).

   Este script é carregado DEPOIS do <script> principal do index.html, no
   mesmo documento e sem type="module" — por isso reaproveita, por nome, os
   helpers globais já existentes ($, $$, escapeHtml, statusBadge, showToast,
   goToPage, drawChart, chartPalette, fmtDateTime, fmtTime, DATA,
   window.OBS_DATA) em vez de duplicá-los.

   Segurança: API Key e token ficam só em variáveis fechadas neste módulo
   (nunca em window, localStorage, sessionStorage, log ou PDF) e são
   descartados ao desconectar ou fechar a aba.
   ============================================================================ */
(function () {
    'use strict';

    /* =========================================================================
       1. ESTADO
       ========================================================================= */
    const secrets = { apiKey: null, token: null }; // nunca sai deste closure
    const aaConfig = { baseUrl: '', username: '' }; // não-sensível; vem de /api/aa/config
    const AA_REFRESH_MS = 5 * 60 * 1000; // independente do LOCAL REFRESH de 20 min

    const state = {
        connection: 'DISCONNECTED', // ver STATES abaixo
        capabilities: {},           // nome -> AVAILABLE|FORBIDDEN|UNAVAILABLE|UNSUPPORTED|TEMPORARY_ERROR
        session: { controlRoom: '', username: '', connectedAt: null, lastSync: null, nextSync: null, mock: false },
        lastError: null,
        checklist: [],              // progresso do popup de conexão
    };

    const STATES = ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'CONNECTED_PARTIAL', 'REFRESHING', 'STALE', 'SESSION_EXPIRED', 'AUTH_ERROR', 'NETWORK_ERROR', 'OFFLINE'];

    const CAPABILITY_LABELS = {
        activity: 'Activity', audit: 'Audit', repository: 'Repository', scheduler: 'Scheduler',
        devices: 'Devices', packages: 'Packages', policy: 'Policy', wlm: 'WLM', acc: 'ACC',
        botInsight: 'BotInsight', deploy: 'Bot Deploy',
    };

    // Quais páginas novas dependem de qual capability (Seção 5/7 do pedido).
    const AA_NAV_ITEMS = [
        { page: 'aa-control-room', label: 'Control Room', icon: 'i-server', capability: 'activity' },
        { page: 'aa-activity', label: 'Execuções AA', icon: 'i-activity', capability: 'activity' },
        { page: 'aa-360', label: 'Execução 360°', icon: 'i-diagnostic', capability: 'activity' },
        { page: 'aa-schedules', label: 'Schedules', icon: 'i-clock', capability: 'scheduler' },
        { page: 'aa-devices', label: 'Runners & Devices', icon: 'i-monitor', capability: 'devices' },
        { page: 'aa-workload', label: 'Workload', icon: 'i-box', capability: 'wlm' },
        { page: 'aa-audit', label: 'Mudanças & Audit', icon: 'i-alert', capability: 'audit' },
        { page: 'aa-dependencies', label: 'Dependências', icon: 'i-box', capability: 'repository' },
        { page: 'aa-policy', label: 'Qualidade / Policy', icon: 'i-check', capability: 'policy' },
        { page: 'aa-analytics', label: 'Analytics', icon: 'i-grid', capability: 'acc' },
    ];

    // Registro local de tentativas de ação (Seção 22/34) — não é segredo.
    const auditTrail = [];

    // Observabilidade técnica da integração (Seção 34) — nunca guarda segredo.
    const telemetry = { authAt: null, lastSyncAt: null, lastLatencyMs: null, requests: 0, httpErrors: 0, retries: 0, version: '1.0.0-aa' };

    // Cache simples em memória por chave lógica (Seção 28).
    const cache = new Map(); // key -> { data, fetchedAt, ttlMs, endpoint }

    function cacheGet(key) {
        const hit = cache.get(key);
        if (!hit) return null;
        const age = Date.now() - hit.fetchedAt;
        hit.status = age > hit.ttlMs * 3 ? 'OFFLINE' : age > hit.ttlMs ? 'STALE' : age > hit.ttlMs / 2 ? 'ATUALIZADO' : 'LIVE';
        return hit;
    }

    function cacheSet(key, data, endpoint, ttlMs = 60000) {
        cache.set(key, { data, fetchedAt: Date.now(), ttlMs, endpoint, status: 'LIVE' });
        return cache.get(key);
    }

    /* =========================================================================
       2. CLIENTE — chamadas ao proxy local /api/aa/* (nunca ao Control Room
          diretamente do navegador: CSP connect-src 'self' já impediria, e o
          proxy evita CORS e mantém o token fora de storage do browser).
       ========================================================================= */
    async function apiCall(path, { method = 'GET', body, extraHeaders } = {}) {
        const headers = Object.assign({ 'X-AA-Base-Url': aaConfig.baseUrl, 'X-AA-Token': secrets.token || '' }, extraHeaders || {});
        const started = performance.now();
        telemetry.requests++;
        try {
            const res = await fetch(path, {
                method,
                headers: body !== undefined ? Object.assign(headers, { 'Content-Type': 'application/json' }) : headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                cache: 'no-store',
            });
            telemetry.lastLatencyMs = Math.round(performance.now() - started);
            const json = await res.json().catch(() => ({ ok: false, error: 'UNSUPPORTED' }));
            if (!json.ok) telemetry.httpErrors++;
            return json;
        } catch (exc) {
            telemetry.httpErrors++;
            return { ok: false, error: 'NETWORK_ERROR', message: 'Sem resposta do conector local.' };
        }
    }

    async function loadStaticConfig() {
        try {
            const r = await fetch('/api/aa/config', { cache: 'no-store' }).then(r => r.json());
            if (r && r.ok) { aaConfig.baseUrl = r.baseUrl || ''; aaConfig.username = r.username || ''; }
        } catch (exc) { /* módulo opcional — silencioso, dashboard segue normal */ }
    }

    async function authenticate(apiKey, overrideBaseUrl, overrideUsername) {
        const baseUrl = (overrideBaseUrl || aaConfig.baseUrl || '').trim();
        const username = (overrideUsername || aaConfig.username || '').trim();
        setConnection('CONNECTING');
        pushChecklist('auth', 'pending', 'Autenticação');
        const authResp = await apiCall('/api/aa/authenticate', { method: 'POST', body: { baseUrl, username, apiKey } });
        if (!authResp.ok) {
            pushChecklist('auth', 'failed', 'Autenticação');
            state.lastError = authResp.message || 'Falha de autenticação.';
            setConnection(authResp.error === 'NETWORK_ERROR' ? 'NETWORK_ERROR' : 'AUTH_ERROR');
            secrets.apiKey = null; secrets.token = null;
            return { ok: false, message: state.lastError };
        }
        pushChecklist('auth', 'done', 'Autenticação');
        secrets.apiKey = apiKey; // permanece só em memória; nunca persistido
        secrets.token = authResp.token;
        aaConfig.baseUrl = baseUrl; aaConfig.username = username || authResp.username || '';
        telemetry.authAt = new Date().toISOString();
        state.session = {
            controlRoom: authResp.controlRoom || baseUrl || 'Control Room',
            username: aaConfig.username,
            connectedAt: telemetry.authAt,
            lastSync: null, nextSync: null,
            mock: !!authResp.mock,
        };

        pushChecklist('activity', 'pending', 'Activity');
        const probe = await activityList({ page: 0, size: 1 }, { skipCache: true });
        pushChecklist('activity', probe.ok ? 'done' : 'failed', 'Activity');

        pushChecklist('capabilities', 'pending', 'Discovery de capacidades');
        const disc = await apiCall('/api/aa/discover', { method: 'POST', body: {} });
        if (disc.ok) {
            state.capabilities = disc.capabilities;
            pushChecklist('capabilities', 'done', 'Discovery de capacidades');
        } else {
            state.capabilities = { activity: probe.ok ? 'AVAILABLE' : 'TEMPORARY_ERROR' };
            pushChecklist('capabilities', 'failed', 'Discovery de capacidades');
        }

        const available = Object.values(state.capabilities).filter(v => v === 'AVAILABLE').length;
        const total = Object.keys(state.capabilities).length;
        setConnection(available === total ? 'CONNECTED' : 'CONNECTED_PARTIAL');
        scheduleSync(true);
        startAaRefresh();
        renderNav();
        return { ok: true };
    }

    function disconnect() {
        stopAaRefresh();
        secrets.apiKey = null;
        secrets.token = null;
        state.capabilities = {};
        state.session = { controlRoom: '', username: '', connectedAt: null, lastSync: null, nextSync: null, mock: false };
        cache.clear();
        setConnection('DISCONNECTED');
        renderNav();
        // Se a página aberta era do workspace AA, volta ao dashboard original.
        if (location.hash.startsWith('#aa-') || document.querySelector('.page.active')?.id.startsWith('page-aa-')) {
            goToPage('overview');
        }
        showToast('Automation Anywhere desconectado. Chave e token descartados.');
    }

    async function activityList(filters, opts) {
        const key = 'activity:' + JSON.stringify(filters || {});
        if (!opts?.skipCache) {
            const hit = cacheGet(key);
            if (hit) return { ok: true, ...hit.data, _cache: hit };
        }
        const resp = await apiCall('/api/aa/activity/list', { method: 'POST', body: { filters } });
        if (resp.ok) cacheSet(key, resp, '/v3/activity/list', 45000);
        handleSessionErrors(resp);
        return resp;
    }

    async function activityDetail(id) {
        const key = 'activity-detail:' + id;
        const hit = cacheGet(key);
        if (hit) return { ok: true, ...hit.data, _cache: hit };
        const resp = await apiCall('/api/aa/activity/execution/' + encodeURIComponent(id));
        if (resp.ok) cacheSet(key, resp, '/v3/activity/execution/{id}', 120000);
        handleSessionErrors(resp);
        return resp;
    }

    async function proxy(method, path, body, ttlMs) {
        const key = 'proxy:' + method + ':' + path + ':' + JSON.stringify(body || {});
        if (ttlMs !== 0) {
            const hit = cacheGet(key);
            if (hit) return { ok: true, ...hit.data, _cache: hit };
        }
        const resp = await apiCall('/api/aa/proxy', { method: 'POST', body: { method, path, body } });
        if (resp.ok && ttlMs !== 0) cacheSet(key, resp, path, ttlMs || 90000);
        handleSessionErrors(resp);
        return resp;
    }

    function handleSessionErrors(resp) {
        if (resp && resp.error === 'SESSION_EXPIRED' && state.connection !== 'SESSION_EXPIRED') {
            stopAaRefresh();
            setConnection('SESSION_EXPIRED');
            renderNav();
        }
    }

    function scheduleSync(isFirst) {
        const now = new Date();
        state.session.lastSync = now.toISOString();
        state.session.nextSync = new Date(now.getTime() + AA_REFRESH_MS).toISOString();
        telemetry.lastSyncAt = state.session.lastSync;
    }

    function startAaRefresh() {
        stopAaRefresh();
        window.__aaRefreshTimer = setInterval(async () => {
            if (state.connection !== 'CONNECTED' && state.connection !== 'CONNECTED_PARTIAL') return;
            const prev = state.connection;
            setConnection('REFRESHING');
            // Incremental: só invalida o cache do Activity List; o resto é
            // buscado sob demanda (lazy) e permanece servível como STALE.
            [...cache.keys()].filter(k => k.startsWith('activity:')).forEach(k => cache.delete(k));
            const probe = await activityList({ page: 0, size: 1 }, { skipCache: true });
            scheduleSync(false);
            setConnection(probe.ok ? prev : 'STALE');
            if (document.querySelector('.page.active')?.id === 'page-aa-control-room') renderControlRoom();
        }, AA_REFRESH_MS);
    }

    function stopAaRefresh() {
        if (window.__aaRefreshTimer) { clearInterval(window.__aaRefreshTimer); window.__aaRefreshTimer = null; }
    }

    function pushChecklist(id, status, label) {
        const row = state.checklist.find(c => c.id === id);
        if (row) { row.status = status; } else { state.checklist.push({ id, status, label }); }
        renderChecklist();
    }

    function setConnection(next) {
        state.connection = next;
        renderConnectButton();
    }

    function capabilityBadge(name) {
        const value = state.capabilities[name];
        if (!value) return '<span class="badge neutral">—</span>';
        const label = { AVAILABLE: 'Disponível', FORBIDDEN: 'Sem permissão', UNAVAILABLE: 'Indisponível', UNSUPPORTED: 'Não suportado', TEMPORARY_ERROR: 'Erro temporário' }[value] || value;
        return `<span class="badge aa-cap-${value}"><span class="dot"></span>${label}</span>`;
    }

    /* =========================================================================
       3. MOTOR DE CORRELAÇÃO (API × logs locais) — Seção 13/36.
       Nunca apresenta correspondência provável como fato: toda linha carrega
       sua classificação (EXACT/HIGH_CONFIDENCE/PROBABLE/UNMATCHED/CONFLICT).
       ========================================================================= */
    function correlate(activity) {
        const execs = (window.OBS_DATA && window.OBS_DATA.executions) || [];
        // 1) execution_id oficial embutido no ID da atividade (quando o bot
        //    grava o próprio execution_id local como parâmetro/nota na AA).
        const exact = execs.find(e => activity.id && activity.id.includes(e.executionId));
        if (exact) return { classification: 'EXACT', execution: exact, reason: 'execution_id do log encontrado no identificador da atividade.' };

        // 2) process_name + janela temporal + machine_name (fallback padrão
        //    quando não há chave compartilhada explícita — é o caso normal
        //    deste ambiente de simulação).
        const activityStart = Date.parse(activity.started || activity.created);
        const candidates = execs
            .map(e => ({ e, deltaMin: Math.abs(Date.parse(e.start) - activityStart) / 60000 }))
            .filter(c => c.deltaMin <= 20)
            .filter(c => sameAutomation(activity, c.e))
            .sort((a, b) => a.deltaMin - b.deltaMin);

        if (!candidates.length) return { classification: 'UNMATCHED', execution: null, reason: 'Nenhuma execução local dentro da janela de tempo esperada.' };

        const [best, second] = candidates;
        if (second && Math.abs(second.deltaMin - best.deltaMin) < 1) {
            return { classification: 'CONFLICT', execution: best.e, reason: `${candidates.length} execuções locais igualmente próximas no tempo — ambíguo.` };
        }
        const sameMachine = String(best.e.machine).toUpperCase() === String(activity.device || activity.runner || '').toUpperCase();
        if (best.deltaMin <= 3 && sameMachine) {
            return { classification: 'HIGH_CONFIDENCE', execution: best.e, reason: `Mesma automação/VM, início a ${best.deltaMin.toFixed(1)} min de diferença.` };
        }
        return { classification: 'PROBABLE', execution: best.e, reason: `Mesma automação, início a ${best.deltaMin.toFixed(1)} min de diferença${sameMachine ? '' : ' (VM diferente)'}.` };
    }

    function sameAutomation(activity, execRow) {
        const rpas = (DATA && DATA.rpas) || [];
        const rpa = rpas.find(r => r.id === activity.automationId);
        // A comparação precisa sempre depender do execRow avaliado — nunca
        // apenas do nome da automação isolado, senão qualquer execução do
        // período (de qualquer RPA) passaria a "combinar" com a atividade.
        if (rpa) return rpa.process === execRow.process;
        return String(activity.automationName || '').toLowerCase() === String(execRow.process || '').toLowerCase();
    }

    /* =========================================================================
       4. UI — BOTÃO DO HEADER, POPOVER E MODAL DE CONEXÃO
       ========================================================================= */
    function injectHeaderButton() {
        const topbar = document.querySelector('.topbar');
        if (!topbar || document.getElementById('aaConnectBtn')) return;
        const btn = document.createElement('button');
        btn.id = 'aaConnectBtn';
        btn.className = 'aa-connect-btn';
        btn.innerHTML = '<span class="dot"></span><span class="aa-connect-label">Automation Anywhere · Conectar</span>';
        const refreshBtn = document.getElementById('refreshButton');
        topbar.insertBefore(btn, refreshBtn || topbar.lastElementChild);
        btn.addEventListener('click', onConnectButtonClick);
        renderConnectButton();
    }

    function renderConnectButton() {
        const btn = document.getElementById('aaConnectBtn');
        if (!btn) return;
        const label = btn.querySelector('.aa-connect-label');
        btn.classList.remove('connected', 'partial', 'error', 'connecting');
        const map = {
            DISCONNECTED: () => { label.textContent = 'Automation Anywhere · Conectar'; },
            CONNECTING: () => { btn.classList.add('connecting'); label.textContent = 'Conectando…'; },
            CONNECTED: () => { btn.classList.add('connected'); label.textContent = 'Automation Anywhere · Conectado'; },
            CONNECTED_PARTIAL: () => { btn.classList.add('partial'); label.textContent = 'Automation Anywhere · Restrito'; },
            REFRESHING: () => { btn.classList.add('connected'); label.textContent = 'Automation Anywhere · Sincronizando'; },
            STALE: () => { btn.classList.add('partial'); label.textContent = 'Automation Anywhere · Desatualizado'; },
            SESSION_EXPIRED: () => { btn.classList.add('error'); label.textContent = 'Sessão expirada · Reconectar'; },
            AUTH_ERROR: () => { btn.classList.add('error'); label.textContent = 'Automation Anywhere · Conectar'; },
            NETWORK_ERROR: () => { btn.classList.add('error'); label.textContent = 'Automation Anywhere · Conectar'; },
            OFFLINE: () => { btn.classList.add('error'); label.textContent = 'Automation Anywhere · Offline'; },
        };
        (map[state.connection] || map.DISCONNECTED)();
    }

    function onConnectButtonClick() {
        if (['CONNECTED', 'CONNECTED_PARTIAL', 'REFRESHING', 'STALE'].includes(state.connection)) {
            togglePopover();
        } else {
            openModal();
        }
    }

    function togglePopover() {
        const existing = document.getElementById('aaPopover');
        if (existing) { existing.remove(); return; }
        const btn = document.getElementById('aaConnectBtn');
        const rect = btn.getBoundingClientRect();
        const pop = document.createElement('div');
        pop.id = 'aaPopover';
        pop.className = 'aa-popover';
        pop.style.top = (rect.bottom + 8) + 'px';
        pop.style.right = (window.innerWidth - rect.right) + 'px';
        const available = Object.values(state.capabilities).filter(v => v === 'AVAILABLE').length;
        const total = Object.keys(state.capabilities).length;
        pop.innerHTML = `
            <h4>Automation Anywhere</h4>
            <div class="aa-popover-row"><span>Control Room</span><strong>${escapeHtml(state.session.controlRoom || '—')}</strong></div>
            <div class="aa-popover-row"><span>Usuário</span><strong>${escapeHtml(state.session.username || '—')}</strong></div>
            <div class="aa-popover-row"><span>Última sincronização</span><strong>${state.session.lastSync ? fmtTime(state.session.lastSync) : '—'}</strong></div>
            <div class="aa-popover-row"><span>Próxima sincronização</span><strong>${state.session.nextSync ? fmtTime(state.session.nextSync) : '—'}</strong></div>
            <div class="aa-popover-row"><span>Recursos disponíveis</span><strong>${available}/${total}</strong></div>
            <div class="aa-popover-actions">
                <button class="aa-btn" id="aaOpenTechBtn" style="flex:1">Detalhes técnicos</button>
                <button class="aa-btn danger" id="aaDisconnectBtn" style="flex:1">Desconectar</button>
            </div>
        `;
        document.body.appendChild(pop);
        document.getElementById('aaDisconnectBtn').addEventListener('click', () => { pop.remove(); disconnect(); });
        document.getElementById('aaOpenTechBtn').addEventListener('click', () => { pop.remove(); goToPage('aa-control-room'); });
        setTimeout(() => document.addEventListener('click', dismissPopoverOnce), 0);
    }

    function dismissPopoverOnce(ev) {
        const pop = document.getElementById('aaPopover');
        const btn = document.getElementById('aaConnectBtn');
        if (pop && !pop.contains(ev.target) && ev.target !== btn) { pop.remove(); document.removeEventListener('click', dismissPopoverOnce); }
    }

    function openModal() {
        if (document.getElementById('aaModalOverlay')) return;
        state.checklist = [];
        const overlay = document.createElement('div');
        overlay.id = 'aaModalOverlay';
        overlay.className = 'aa-modal-overlay';
        const isRetry = state.connection === 'SESSION_EXPIRED';
        overlay.innerHTML = `
            <div class="aa-modal">
                <div class="aa-modal-head">
                    <div class="aa-mark"><svg class="icon"><use href="#i-server"></use></svg></div>
                    <h3>Automation Anywhere</h3>
                </div>
                <p class="aa-sub">${isRetry ? 'Sua sessão expirou. Informe a API Key novamente para reconectar — o dashboard atual não foi afetado.' : 'Conecte a Control Room para habilitar recursos avançados. O dashboard atual continua funcionando normalmente sem esta conexão.'}</p>
                <div id="aaModalErrorSlot"></div>
                <div class="aa-field">
                    <label for="aaApiKeyInput">API Key</label>
                    <input id="aaApiKeyInput" type="password" autocomplete="off" placeholder="Cole a API Key da Control Room">
                </div>
                <button type="button" class="aa-advanced-toggle" id="aaAdvancedToggle">
                    <svg class="icon"><use href="#i-chevron"></use></svg> Configuração avançada
                </button>
                <div class="aa-advanced-body" id="aaAdvancedBody">
                    <div class="aa-field">
                        <label for="aaBaseUrlInput">Control Room URL</label>
                        <input id="aaBaseUrlInput" type="text" placeholder="https://suaempresa.my.automationanywhere.digital (deixe vazio para simular)" value="${escapeHtml(aaConfig.baseUrl)}">
                    </div>
                    <div class="aa-field">
                        <label for="aaUsernameInput">Usuário</label>
                        <input id="aaUsernameInput" type="text" placeholder="svc_rpa_observability" value="${escapeHtml(aaConfig.username)}">
                    </div>
                </div>
                <div id="aaChecklistSlot"></div>
                <div class="aa-modal-actions">
                    <button class="aa-btn" id="aaCancelBtn">Cancelar</button>
                    <button class="aa-btn primary" id="aaConnectSubmitBtn">Conectar</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) closeModal(); });
        document.getElementById('aaCancelBtn').addEventListener('click', closeModal);
        document.getElementById('aaAdvancedToggle').addEventListener('click', ev => {
            ev.currentTarget.classList.toggle('open');
            document.getElementById('aaAdvancedBody').classList.toggle('open');
        });
        document.getElementById('aaConnectSubmitBtn').addEventListener('click', submitConnect);
        document.getElementById('aaApiKeyInput').addEventListener('keydown', ev => { if (ev.key === 'Enter') submitConnect(); });
        document.getElementById('aaApiKeyInput').focus();
    }

    function closeModal() {
        const overlay = document.getElementById('aaModalOverlay');
        if (overlay) overlay.remove();
        if (state.connection === 'CONNECTING') setConnection('DISCONNECTED');
    }

    /* =========================================================================
       7. AÇÕES (Fase 7) — só aparecem com capability AVAILABLE; toda ação
          exige confirmação com RPA/Ambiente/Ação/Consequência visíveis e fica
          registrada localmente (auditTrail), nunca silenciosa.
       ========================================================================= */
    function confirmAction({ title, rpa, environment, action, consequence, confirmLabel, dangerous }) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'aa-modal-overlay';
            overlay.innerHTML = `
                <div class="aa-modal">
                    <div class="aa-modal-head"><div class="aa-mark"><svg class="icon"><use href="#i-triangle"></use></svg></div><h3>${escapeHtml(title)}</h3></div>
                    <div class="audit-evidence-list" style="margin:10px 0">
                        <div class="audit-evidence-row"><span>RPA</span><span>${escapeHtml(rpa)}</span></div>
                        <div class="audit-evidence-row"><span>Ambiente</span><span>${escapeHtml(environment)}</span></div>
                        <div class="audit-evidence-row"><span>Ação</span><span>${escapeHtml(action)}</span></div>
                        <div class="audit-evidence-row"><span>Consequência</span><span>${escapeHtml(consequence)}</span></div>
                    </div>
                    <div class="aa-modal-actions">
                        <button class="aa-btn" id="aaActionCancel">Cancelar</button>
                        <button class="aa-btn ${dangerous ? 'danger' : 'primary'}" id="aaActionConfirm">${escapeHtml(confirmLabel || 'Confirmar')}</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) { overlay.remove(); resolve(false); } });
            overlay.querySelector('#aaActionCancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
            overlay.querySelector('#aaActionConfirm').addEventListener('click', () => { overlay.remove(); resolve(true); });
        });
    }

    function logAction(entry) {
        auditTrail.unshift(Object.assign({ timestamp: new Date().toISOString() }, entry));
        if (auditTrail.length > 50) auditTrail.length = 50;
        if (document.querySelector('.page.active')?.id === 'page-aa-control-room') renderControlRoom();
    }

    async function runOrRerun(activity, rpaName) {
        const ok = await confirmAction({
            title: 'Reexecutar automação',
            rpa: rpaName, environment: state.session.mock ? 'Simulação (mock)' : state.session.controlRoom,
            action: `Reexecutar ${activity.id}`,
            consequence: 'Dispara uma nova execução na Control Room. Itens já processados na tentativa original não são desfeitos.',
            confirmLabel: 'Reexecutar', dangerous: true,
        });
        if (!ok) { logAction({ action: 'RE_RUN', target: activity.id, result: 'CANCELADO_PELO_USUARIO' }); return; }
        const resp = await proxy('POST', '/v4/automations/deploy', { automationId: activity.automationId, sourceActivityId: activity.id }, 0);
        logAction({ action: 'RE_RUN', target: activity.id, result: resp.ok ? 'ENVIADO' : ('FALHA: ' + resp.error) });
        showToast(resp.ok ? 'Reexecução enviada à Control Room.' : `Não foi possível reexecutar (${resp.error}).`);
    }

    async function toggleSchedule(scheduleId, rpaName, enable) {
        const ok = await confirmAction({
            title: enable ? 'Habilitar schedule' : 'Desabilitar schedule',
            rpa: rpaName, environment: state.session.mock ? 'Simulação (mock)' : state.session.controlRoom,
            action: `${enable ? 'Habilitar' : 'Desabilitar'} ${scheduleId}`,
            consequence: enable ? 'A automação volta a rodar nos horários definidos na Control Room.' : 'A automação deixa de rodar nos horários definidos na Control Room até ser reabilitada.',
            confirmLabel: enable ? 'Habilitar' : 'Desabilitar', dangerous: !enable,
        });
        if (!ok) { logAction({ action: 'SCHEDULE_TOGGLE', target: scheduleId, result: 'CANCELADO_PELO_USUARIO' }); return; }
        const resp = await proxy('PATCH', '/v2/schedule/rules/' + encodeURIComponent(scheduleId), { enabled: enable }, 0);
        logAction({ action: 'SCHEDULE_TOGGLE', target: scheduleId, result: resp.ok ? (enable ? 'HABILITADO' : 'DESABILITADO') : ('FALHA: ' + resp.error) });
        showToast(resp.ok ? 'Schedule atualizado.' : `Não foi possível atualizar o schedule (${resp.error}).`);
        renderSchedules();
    }

    function renderAuditTrailPanel() {
        if (!auditTrail.length) return '';
        return `
            <article class="card" style="margin-top:14px">
                <div class="card-header"><div><h2>Registro local de ações</h2><p>Tentativas de ação disparadas por este navegador nesta sessão — nunca inclui segredos.</p></div></div>
                <div class="card-body">
                    ${auditTrail.slice(0, 10).map(a => `<div class="audit-evidence-row"><span>${fmtDateTime(a.timestamp)} · ${escapeHtml(a.action)}</span><span>${escapeHtml(a.target)} — ${escapeHtml(a.result)}</span></div>`).join('')}
                </div>
            </article>`;
    }

    function renderChecklist() {
        const slot = document.getElementById('aaChecklistSlot');
        if (!slot) return;
        const icon = { pending: '○', done: '✓', failed: '×' };
        slot.innerHTML = state.checklist.length ? `<div class="aa-checklist">${state.checklist.map(c => `
            <div class="aa-checklist-row ${c.status}"><span class="aa-checklist-mark">${icon[c.status]}</span>${escapeHtml(c.label)}</div>
        `).join('')}</div>` : '';
    }

    async function submitConnect() {
        const apiKey = document.getElementById('aaApiKeyInput').value.trim();
        const baseUrl = document.getElementById('aaBaseUrlInput').value.trim();
        const username = document.getElementById('aaUsernameInput').value.trim();
        const errSlot = document.getElementById('aaModalErrorSlot');
        errSlot.innerHTML = '';
        if (!apiKey) { errSlot.innerHTML = '<div class="aa-modal-error">Informe a API Key.</div>'; return; }
        document.getElementById('aaConnectSubmitBtn').disabled = true;
        document.getElementById('aaCancelBtn').disabled = true;
        const result = await authenticate(apiKey, baseUrl, username);
        document.getElementById('aaConnectSubmitBtn').disabled = false;
        document.getElementById('aaCancelBtn').disabled = false;
        if (!result.ok) {
            errSlot.innerHTML = `<div class="aa-modal-error">${escapeHtml(result.message || 'Não foi possível conectar.')}</div>`;
            return;
        }
        closeModal();
        const available = Object.values(state.capabilities).filter(v => v === 'AVAILABLE').length;
        const total = Object.keys(state.capabilities).length;
        showToast(available === total ? 'Automation Anywhere conectado.' : `Conectado com restrições (${available}/${total} recursos disponíveis).`);
        goToPage('aa-control-room');
    }

    /* =========================================================================
       5. NAVEGAÇÃO CONDICIONAL — grupo "Automation Anywhere" no menu lateral
       ========================================================================= */
    function ensureNavGroup() {
        if (document.getElementById('aaNavGroup')) return document.getElementById('aaNavGroup');
        const sidebarScroll = document.querySelector('.sidebar-scroll');
        if (!sidebarScroll) return null;
        const wrap = document.createElement('div');
        wrap.id = 'aaNavGroup';
        wrap.innerHTML = `<div class="nav-section-label">Automation Anywhere</div>`;
        AA_NAV_ITEMS.forEach(item => {
            const btn = document.createElement('button');
            btn.className = 'nav-link';
            btn.dataset.page = item.page;
            btn.dataset.aaCapability = item.capability;
            btn.innerHTML = `<svg class="icon"><use href="#${item.icon}"></use></svg><span>${item.label}</span>`;
            btn.addEventListener('click', () => goToPage(item.page));
            wrap.appendChild(btn);
        });
        sidebarScroll.appendChild(wrap);
        ensurePages();
        return wrap;
    }

    function renderNav() {
        const connected = ['CONNECTED', 'CONNECTED_PARTIAL', 'REFRESHING', 'STALE'].includes(state.connection);
        let group = document.getElementById('aaNavGroup');
        if (!connected) { if (group) group.style.display = 'none'; return; }
        if (!group) group = ensureNavGroup();
        group.style.display = '';
        $$('.nav-link[data-aa-capability]').forEach(btn => {
            const cap = btn.dataset.aaCapability;
            btn.style.display = state.capabilities[cap] === 'AVAILABLE' ? '' : 'none';
        });
        renderControlRoom();
    }

    /* =========================================================================
       6. PÁGINAS — injeção de <section class="page" id="page-aa-...">
       goToPage()/renderAll() do dashboard original não precisam saber que
       estas seções existem: a função já existente alterna .active por id.
       ========================================================================= */
    function ensurePages() {
        const main = document.querySelector('main.content');
        if (!main || document.getElementById('page-aa-control-room')) return;
        const pages = [
            pageShell('aa-control-room', 'CONTROL ROOM', 'Visão consolidada', 'O que está executando, em fila, falhando ou fora do baseline agora — direto da Control Room.', 'aaControlRoomBody'),
            pageShell('aa-activity', 'AUTOMATION ANYWHERE', 'Execuções AA', 'Activity List oficial da Control Room, com nível de correlação com os logs locais.', 'aaActivityBody'),
            pageShell('aa-360', 'AUTOMATION ANYWHERE', 'Execução 360°', 'Consolida Control Room, logs locais e telemetria de VM para uma execução — não substitui Auditoria/Investigação/Diagnóstico.', 'aa360Body'),
            pageShell('aa-schedules', 'AUTOMATION ANYWHERE', 'Schedules', 'Schedule da Control Room × agenda local × execução realizada.', 'aaSchedulesBody'),
            pageShell('aa-devices', 'AUTOMATION ANYWHERE', 'Runners & Devices', 'Devices da Control Room combinados com a telemetria local de VM.', 'aaDevicesBody'),
            pageShell('aa-workload', 'AUTOMATION ANYWHERE', 'Workload', 'Filas, backlog e throughput do Workload Management, quando disponível.', 'aaWorkloadBody'),
            pageShell('aa-audit', 'AUTOMATION ANYWHERE', 'Mudanças & Audit', 'Linha do tempo mudança → execução → falha, separando evidência de hipótese.', 'aaAuditBody'),
            pageShell('aa-dependencies', 'AUTOMATION ANYWHERE', 'Dependências', 'Repository + Package Usage combinados com a criticidade local das RPAs.', 'aaDependenciesBody'),
            pageShell('aa-policy', 'AUTOMATION ANYWHERE', 'Qualidade / Policy', 'Violations e resultado de scans de Policy Management, quando permitido.', 'aaPolicyBody'),
            pageShell('aa-analytics', 'AUTOMATION ANYWHERE', 'Analytics', 'Indicadores de ACC/BotInsight, quando disponíveis nesta Control Room.', 'aaAnalyticsBody'),
        ];
        pages.forEach(html => main.insertAdjacentHTML('beforeend', html));
        renderCorrelateSelect();
        document.getElementById('aa360Select')?.addEventListener('change', ev => renderExecucao360(ev.target.value));
        document.getElementById('aaActivityStatusFilter')?.addEventListener('change', renderActivityList);
        document.getElementById('aaActivitySearch')?.addEventListener('input', renderActivityList);
    }

    function pageShell(id, eyebrow, title, subtitle, bodyId) {
        return `
        <section class="page" id="page-${id}">
            <div class="page-heading">
                <div>
                    <div class="eyebrow">${escapeHtml(eyebrow)}</div>
                    <h1>${escapeHtml(title)}</h1>
                    <p>${escapeHtml(subtitle)}</p>
                </div>
                <button class="action-button" data-aa-export="${id}">Exportar PDF</button>
            </div>
            <div id="${bodyId}"></div>
        </section>`;
    }

    /* ---- 6.1 Control Room ---------------------------------------------- */
    async function renderControlRoom() {
        const body = document.getElementById('aaControlRoomBody');
        if (!body || !document.getElementById('page-aa-control-room')) return;
        const resp = await activityList({ page: 0, size: 200 });
        if (!resp.ok) { body.innerHTML = aaErrorState(resp); return; }
        const rows = resp.list || [];
        const running = rows.filter(r => r.status === 'RUNNING' || r.status === 'QUEUED' && false).length;
        const queued = rows.filter(r => r.status === 'QUEUED').length;
        const failed = rows.filter(r => r.status === 'RUN_FAILED' || r.status === 'FAILED').length;
        const overBaseline = rows.filter(r => {
            const rpa = (DATA.rpas || []).find(x => x.id === r.automationId);
            return rpa && (r.durationMs / 60000) > rpa.expectedDurationMin * 1.4;
        }).length;
        const errorCounts = {};
        rows.forEach(r => { if (r.error?.code) errorCounts[r.error.code] = (errorCounts[r.error.code] || 0) + 1; });
        const pareto = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const maxCount = Math.max(1, ...pareto.map(p => p[1]));

        body.innerHTML = `
            <div class="grid grid-kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
                ${kpiCard('Executando agora', running, 'i-activity', 'info')}
                ${kpiCard('Em fila', queued, 'i-clock', queued ? 'warning' : 'success')}
                ${kpiCard('Falharam (amostra)', failed, 'i-alert', failed ? 'danger' : 'success')}
                ${kpiCard('Acima do baseline', overBaseline, 'i-triangle', overBaseline ? 'warning' : 'success')}
            </div>
            <div class="grid grid-2" style="margin-top:14px">
                <article class="card">
                    <div class="card-header"><div><h2>Timeline recente (Control Room)</h2><p>Últimas atividades retornadas pela Activity List.</p></div></div>
                    <div class="table-wrap"><table><thead><tr><th>Automação</th><th>Status</th><th>Início</th><th>Duração</th><th>Device</th></tr></thead>
                    <tbody>${rows.slice(0, 10).map(r => `<tr><td>${escapeHtml(r.automationName)}</td><td>${aaStatusBadge(r.status)}</td><td>${fmtDateTime(r.started)}</td><td>${(r.durationMs / 60000).toFixed(1)} min</td><td class="mono">${escapeHtml(r.device || '—')}</td></tr>`).join('')}</tbody></table></div>
                </article>
                <article class="card">
                    <div class="card-header"><div><h2>Pareto de erros oficiais</h2><p>Código de erro reportado pela própria Control Room.</p></div></div>
                    <div class="card-body">${pareto.length ? pareto.map(([code, count]) => `
                        <div class="pareto-row"><span class="pareto-code mono">${escapeHtml(code)}</span><div class="pareto-bar"><div style="width:${count / maxCount * 100}%"></div></div><span class="pareto-count">${count}</span></div>
                    `).join('') : '<div class="empty-state">Sem erros oficiais no período retornado.</div>'}</div>
                </article>
            </div>
            ${renderAuditTrailPanel()}
            ${renderTechnicalPanel()}
        `;
    }

    function renderTechnicalPanel() {
        const caps = Object.keys(state.capabilities);
        return `
            <article class="card" style="margin-top:14px">
                <div class="card-header"><div><h2>Observabilidade da integração</h2><p>Estado técnico da conexão — nunca exibe segredos.</p></div></div>
                <div class="card-body">
                    <div class="audit-evidence-list">
                        <div class="audit-evidence-row"><span>Estado da conexão</span><span>${escapeHtml(state.connection)}</span></div>
                        <div class="audit-evidence-row"><span>Última autenticação</span><span>${telemetry.authAt ? fmtDateTime(telemetry.authAt) : '—'}</span></div>
                        <div class="audit-evidence-row"><span>Última sincronização</span><span>${state.session.lastSync ? fmtDateTime(state.session.lastSync) : '—'}</span></div>
                        <div class="audit-evidence-row"><span>Tempo de resposta (última chamada)</span><span>${telemetry.lastLatencyMs != null ? telemetry.lastLatencyMs + ' ms' : '—'}</span></div>
                        <div class="audit-evidence-row"><span>Requisições / erros HTTP</span><span>${telemetry.requests} / ${telemetry.httpErrors}</span></div>
                        <div class="audit-evidence-row"><span>Ambiente</span><span>${state.session.mock ? 'Simulação local (mock)' : escapeHtml(state.session.controlRoom)}</span></div>
                        <div class="audit-evidence-row"><span>Versão da integração</span><span>${telemetry.version}</span></div>
                    </div>
                    <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px">
                        ${caps.map(c => `<span class="badge aa-cap-${state.capabilities[c]}"><span class="dot"></span>${CAPABILITY_LABELS[c] || c}</span>`).join('')}
                    </div>
                </div>
            </article>
        `;
    }

    /* ---- 6.2 Execuções AA (Activity List) -------------------------------- */
    let activityCacheRows = [];
    async function renderActivityList() {
        const body = document.getElementById('aaActivityBody');
        if (!body) return;
        if (!body.dataset.mounted) {
            body.dataset.mounted = '1';
            body.innerHTML = `
                <article class="card">
                    <div class="card-header">
                        <div><h2>Activity List</h2><p>Execuções oficiais reportadas pela Control Room, com correlação aos logs locais.</p></div>
                        <div style="display:flex;gap:8px">
                            <input class="select-control" id="aaActivitySearch" placeholder="Buscar automação, device..." style="width:220px">
                            <select class="select-control" id="aaActivityStatusFilter">
                                <option value="">Todos os status</option>
                                <option value="COMPLETED">COMPLETED</option>
                                <option value="RUN_FAILED">RUN_FAILED</option>
                                <option value="RUNNING">RUNNING</option>
                                <option value="QUEUED">QUEUED</option>
                            </select>
                        </div>
                    </div>
                    <div class="table-wrap"><table><thead><tr><th>Automação</th><th>Status</th><th>Início</th><th>Fim</th><th>Duração</th><th>Device</th><th>Correlação</th></tr></thead><tbody id="aaActivityTableBody"></tbody></table></div>
                    <div class="card-body" id="aaActivityCount" style="color:var(--text-3);font-size:11px"></div>
                </article>`;
            document.getElementById('aaActivityStatusFilter').addEventListener('change', paintActivityRows);
            document.getElementById('aaActivitySearch').addEventListener('input', paintActivityRows);
        }
        const resp = await activityList({ page: 0, size: 300 });
        if (!resp.ok) { document.getElementById('aaActivityTableBody').innerHTML = `<tr><td colspan="7">${aaErrorState(resp)}</td></tr>`; return; }
        activityCacheRows = resp.list || [];
        paintActivityRows();
    }

    function paintActivityRows() {
        const tbody = document.getElementById('aaActivityTableBody');
        if (!tbody) return;
        const statusFilter = document.getElementById('aaActivityStatusFilter')?.value || '';
        const q = (document.getElementById('aaActivitySearch')?.value || '').toLowerCase();
        let rows = activityCacheRows;
        if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
        if (q) rows = rows.filter(r => (r.automationName + ' ' + r.device).toLowerCase().includes(q));
        document.getElementById('aaActivityCount').textContent = `${rows.length} de ${activityCacheRows.length} atividades`;
        tbody.innerHTML = rows.slice(0, 150).map(r => {
            const corr = correlate(r);
            return `<tr class="clickable-row" data-aa-activity-id="${escapeHtml(r.id)}">
                <td><span class="cell-title">${escapeHtml(r.automationName)}</span><span class="cell-subtitle mono">${escapeHtml(r.id)}</span></td>
                <td>${aaStatusBadge(r.status)}</td>
                <td>${fmtDateTime(r.started)}</td>
                <td>${fmtDateTime(r.ended)}</td>
                <td>${(r.durationMs / 60000).toFixed(1)} min</td>
                <td class="mono">${escapeHtml(r.device || '—')}</td>
                <td><span class="badge aa-corr-${corr.classification}" title="${escapeHtml(corr.reason)}">${corr.classification}</span></td>
            </tr>`;
        }).join('') || '<tr><td colspan="7" class="empty-state">Nenhuma atividade encontrada para o filtro.</td></tr>';
        $$('#aaActivityTableBody tr[data-aa-activity-id]').forEach(tr => {
            tr.addEventListener('click', () => { goToPage('aa-360'); document.getElementById('aa360Select').value = tr.dataset.aaActivityId; renderExecucao360(tr.dataset.aaActivityId); });
        });
    }

    /* ---- 6.3 Execução 360° ------------------------------------------------ */
    async function renderCorrelateSelect() {
        // populado sob demanda quando a página é aberta (evita chamada cedo demais)
    }

    async function ensure360Options() {
        const select = document.getElementById('aa360Select');
        if (!select || select.options.length) return;
        const resp = await activityList({ page: 0, size: 200 });
        if (!resp.ok) return;
        select.innerHTML = (resp.list || []).map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.automationName)} · ${fmtDateTime(r.started)}</option>`).join('');
    }

    async function renderExecucao360(activityId) {
        const body = document.getElementById('aa360Body');
        if (!body) return;
        if (!body.dataset.mounted) {
            body.dataset.mounted = '1';
            body.innerHTML = `
                <article class="card" style="margin-bottom:14px">
                    <div class="card-body" style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap">
                        <div style="min-width:320px;flex:1"><label class="cell-subtitle" style="display:block;margin-bottom:6px">Atividade (Control Room)</label>
                        <select class="select-control" id="aa360Select" style="width:100%"></select></div>
                    </div>
                </article>
                <div id="aa360Content"></div>`;
            document.getElementById('aa360Select').addEventListener('change', ev => renderExecucao360(ev.target.value));
        }
        await ensure360Options();
        const select = document.getElementById('aa360Select');
        if (activityId) select.value = activityId; else activityId = select.value;
        if (!activityId) { document.getElementById('aa360Content').innerHTML = '<div class="empty-state">Selecione uma atividade.</div>'; return; }

        const detailResp = await activityDetail(activityId);
        if (!detailResp.ok) { document.getElementById('aa360Content').innerHTML = aaErrorState(detailResp); return; }
        const activity = detailResp.activity;
        const corr = correlate(activity);
        const execRow = corr.execution;
        const events = execRow ? (window.OBS_DATA.eventsByExecution[execRow.executionId] || []) : [];
        const vmCtx = execRow ? (window.OBS_DATA.vmContextByExecution[execRow.executionId] || []) : [];
        const rpa = (DATA.rpas || []).find(r => r.id === activity.automationId);
        const agg = execRow ? null : null;

        document.getElementById('aa360Content').innerHTML = `
            <div class="grid grid-2">
                <article class="card">
                    <div class="card-header"><div><h2>Control Room</h2><p>Estado oficial reportado pela Automation Anywhere.</p></div></div>
                    <div class="card-body">
                        <div class="audit-evidence-list">
                            <div class="audit-evidence-row"><span>Status</span>${aaStatusBadge(activity.status)}</div>
                            <div class="audit-evidence-row"><span>Deployment</span><span class="mono">${escapeHtml(activity.deploymentId || '—')}</span></div>
                            <div class="audit-evidence-row"><span>Início / Fim</span><span>${fmtDateTime(activity.started)} → ${fmtDateTime(activity.ended)}</span></div>
                            <div class="audit-evidence-row"><span>Progress</span><span>${activity.progress ?? '—'}%</span></div>
                            <div class="audit-evidence-row"><span>Current line</span><span>${escapeHtml(activity.currentLine ?? '—')}</span></div>
                            <div class="audit-evidence-row"><span>Device / Runner</span><span class="mono">${escapeHtml(activity.device || '—')}</span></div>
                            <div class="audit-evidence-row"><span>Erro AA</span><span>${activity.error ? escapeHtml(activity.error.code + ' — ' + activity.error.message) : '—'}</span></div>
                        </div>
                        <div style="margin-top:12px"><span class="badge aa-corr-${corr.classification}">${corr.classification}</span> <span class="cell-subtitle">${escapeHtml(corr.reason)}</span></div>
                    </div>
                </article>
                <article class="card">
                    <div class="card-header"><div><h2>Telemetria da VM</h2><p>Janela em torno da execução correlacionada.</p></div></div>
                    <div class="card-body">${vmCtx.length ? `
                        <div class="audit-evidence-list">
                            <div class="audit-evidence-row"><span>CPU média</span><span>${(vmCtx.reduce((a, r) => a + Number(r.cpu_percent || 0), 0) / vmCtx.length).toFixed(1)}%</span></div>
                            <div class="audit-evidence-row"><span>RAM média</span><span>${(vmCtx.reduce((a, r) => a + Number(r.memory_percent || 0), 0) / vmCtx.length).toFixed(1)}%</span></div>
                            <div class="audit-evidence-row"><span>RDP observado</span><span>${escapeHtml([...new Set(vmCtx.map(r => r.rdp_status))].join(', '))}</span></div>
                        </div>` : '<div class="empty-state">Sem execução local correlacionada com telemetria disponível.</div>'}
                    </div>
                </article>
            </div>
            <article class="card" style="margin-top:14px">
                <div class="card-header"><div><h2>Timeline de etapas (log local)</h2><p>${execRow ? `Execução correlacionada: <span class="mono">${escapeHtml(execRow.executionId)}</span>` : 'Nenhuma execução local correlacionada nesta janela.'}</p></div></div>
                <div class="card-body">${events.length ? events.map(e => `
                    <div class="metric-row"><span>${String(e.order).padStart(2, '0')}. ${escapeHtml(e.step)}</span><div class="progress-track"><div class="progress-fill ${e.status === 'ERROR' ? 'danger' : e.status === 'WARNING' ? 'warning' : 'success'}" style="width:100%"></div></div><strong>${escapeHtml(e.status)}</strong></div>
                `).join('') : '<div class="empty-state">Sem etapas locais para exibir.</div>'}</div>
            </article>
            ${rpa ? `<article class="card" style="margin-top:14px"><div class="card-header"><div><h2>Baseline histórico local</h2></div></div><div class="card-body">
                <div class="audit-evidence-row"><span>Duração esperada</span><span>${rpa.expectedDurationMin} min</span></div>
                <div class="audit-evidence-row"><span>Duração desta atividade</span><span>${(activity.durationMs / 60000).toFixed(1)} min</span></div>
            </div></article>` : ''}
            ${state.capabilities.deploy === 'AVAILABLE' ? `
            <article class="card" style="margin-top:14px">
                <div class="card-header"><div><h2>Ações</h2><p>Disponível porque a capability Bot Deploy está autorizada nesta Control Room.</p></div></div>
                <div class="card-body"><button class="aa-btn danger" id="aa360RerunBtn">Reexecutar esta automação</button></div>
            </article>` : ''}
        `;
        document.getElementById('aa360RerunBtn')?.addEventListener('click', () => runOrRerun(activity, activity.automationName));
    }

    /* ---- 6.4 Schedules ----------------------------------------------------- */
    async function renderSchedules() {
        const body = document.getElementById('aaSchedulesBody');
        if (!body) return;
        const resp = await proxy('GET', '/v2/schedule/rules/list');
        if (!resp.ok) { body.innerHTML = aaErrorState(resp); return; }
        const aaSchedules = resp.data?.list || [];
        const rows = (DATA.rpas || []).map(rpa => {
            const aa = aaSchedules.filter(s => s.automationId === rpa.id);
            const localTimes = rpa.schedule || [];
            let statusLabel = 'SEM REGRA LOCAL';
            if (aa.length && localTimes.length) {
                const matches = aa.filter(a => localTimes.includes(a.scheduledTime)).length;
                statusLabel = matches === aa.length && matches === localTimes.length ? 'ALINHADO' : 'DIVERGENTE';
            } else if (!aa.length && localTimes.length) {
                statusLabel = 'SEM SCHEDULE AA';
            } else if (!localTimes.length) {
                statusLabel = 'SEM REGRA LOCAL';
            }
            const cls = { ALINHADO: 'success', DIVERGENTE: 'warning', 'SEM SCHEDULE AA': 'neutral', 'SEM REGRA LOCAL': 'neutral' }[statusLabel] || 'neutral';
            const actionCell = (state.capabilities.scheduler === 'AVAILABLE' && aa.length)
                ? `<button class="aa-btn" style="padding:5px 10px;font-size:11px" data-aa-schedule-id="${escapeHtml(aa[0].id)}" data-aa-rpa-name="${escapeHtml(rpa.name)}">Habilitar/Desabilitar</button>`
                : '—';
            return `<tr><td>${escapeHtml(rpa.name)}</td><td>${escapeHtml(aa.map(a => a.scheduledTime).join(', ') || '—')}</td><td>${escapeHtml(localTimes.join(', ') || '—')}</td><td><span class="badge ${cls}">${statusLabel}</span></td><td>${actionCell}</td></tr>`;
        }).join('');
        body.innerHTML = `
            <article class="card">
                <div class="card-header"><div><h2>Reconciliação de agenda</h2><p>Schedule Control Room × agenda local do catálogo. A agenda local não é alterada por esta tela.</p></div></div>
                <div class="table-wrap"><table><thead><tr><th>RPA</th><th>Schedule AA</th><th>Agenda local</th><th>Estado</th><th>Ações</th></tr></thead><tbody>${rows}</tbody></table></div>
            </article>`;
        $$('[data-aa-schedule-id]', body).forEach(btn => {
            btn.addEventListener('click', () => toggleSchedule(btn.dataset.aaScheduleId, btn.dataset.aaRpaName, true));
        });
    }

    /* ---- 6.5 Runners & Devices --------------------------------------------- */
    async function renderDevices() {
        const body = document.getElementById('aaDevicesBody');
        if (!body) return;
        const resp = await proxy('GET', '/v2/devices/list');
        if (!resp.ok) { body.innerHTML = aaErrorState(resp); return; }
        const devices = resp.data?.list || [];
        const util = (DATA.vmUtilization || []);
        const rel = (DATA.vmReliability || []);
        const rows = devices.map(d => {
            const u = util.find(x => x.machine === d.hostName);
            const r = rel.find(x => x.machine === d.hostName);
            return `<tr>
                <td class="mono">${escapeHtml(d.hostName)}</td>
                <td><span class="badge ${d.status === 'CONNECTED' ? 'success' : 'danger'}">${escapeHtml(d.status)}</span></td>
                <td>${escapeHtml(d.poolName)}</td>
                <td>${d.cpuPercent}%</td><td>${d.memoryPercent}%</td><td>${d.diskPercent}%</td>
                <td>${u ? u.byRpa.length : '—'}</td>
                <td>${r ? r.classification : '—'}</td>
            </tr>`;
        }).join('');
        body.innerHTML = `
            <article class="card">
                <div class="card-header"><div><h2>Devices × telemetria local</h2><p>Combina o inventário de devices da Control Room com CPU/RAM/disco e confiabilidade já monitorados localmente.</p></div></div>
                <div class="table-wrap"><table><thead><tr><th>Device</th><th>Status AA</th><th>Pool</th><th>CPU</th><th>RAM</th><th>Disco</th><th>RPAs no período</th><th>Confiabilidade</th></tr></thead><tbody>${rows}</tbody></table></div>
            </article>`;
    }

    /* ---- 6.6 Workload (WLM) ------------------------------------------------ */
    async function renderWorkload() {
        const body = document.getElementById('aaWorkloadBody');
        if (!body) return;
        const resp = await proxy('GET', '/v2/wlm/queues');
        body.innerHTML = resp.ok ? renderWlmQueues(resp.data?.list || []) : aaErrorState(resp);
    }
    function renderWlmQueues(rows) {
        if (!rows.length) return '<article class="card"><div class="card-body"><div class="empty-state">Sem filas retornadas pelo WLM.</div></div></article>';
        return `<article class="card"><div class="card-body">${rows.map(q => `<div class="metric-row"><span>${escapeHtml(q.name)}</span><strong>${q.backlog}</strong></div>`).join('')}</div></article>`;
    }

    /* ---- 6.7 Mudanças & Audit ----------------------------------------------- */
    async function renderAuditPage() {
        const body = document.getElementById('aaAuditBody');
        if (!body) return;
        const resp = await proxy('GET', '/v2/audit/logs');
        if (!resp.ok) { body.innerHTML = aaErrorState(resp); return; }
        const rows = resp.data?.list || [];
        body.innerHTML = `
            <article class="card">
                <div class="card-header"><div><h2>Linha do tempo de mudanças</h2><p>Correlaciona alteração de pacote/arquivo com o comportamento de erro observado nos logs — nunca afirma causalidade só por proximidade temporal.</p></div></div>
                <div class="card-body">
                    ${rows.length ? rows.map(r => `
                        <div class="aa-evidence-block evidencia">
                            <span class="aa-evidence-label">Evidência</span>
                            <strong>${escapeHtml(r.action)}</strong> em ${escapeHtml(r.target)} · ${fmtDateTime(r.timestamp)} · ${escapeHtml(r.automationName)}
                        </div>
                        ${r.signal === 'AUMENTOU' ? `
                        <div class="aa-evidence-block correlacao">
                            <span class="aa-evidence-label">Correlação candidata</span>
                            ${r.errorsBefore30d} erro(s) antes · ${r.errorsAfter30d} erro(s) depois.
                            ${r.firstErrorAfter ? ` Primeiro erro ${r.firstErrorAfter.hoursAfter}h depois (execução ${escapeHtml(r.firstErrorAfter.executionId)}).` : ''}
                        </div>` : `
                        <div class="aa-evidence-block hipotese">
                            <span class="aa-evidence-label">Hipótese</span>
                            Sem sinal de aumento de erro atribuível a esta mudança até o momento.
                        </div>`}
                    `).join('') : '<div class="empty-state">Sem mudanças registradas para correlacionar.</div>'}
                </div>
            </article>`;
    }

    /* ---- 6.8 Dependências --------------------------------------------------- */
    async function renderDependencies() {
        const body = document.getElementById('aaDependenciesBody');
        if (!body) return;
        const resp = await proxy('GET', '/v2/packages/list');
        if (!resp.ok) { body.innerHTML = aaErrorState(resp); return; }
        const rows = resp.data?.list || [];
        const byPackage = {};
        rows.forEach(r => { (byPackage[r.packageName] = byPackage[r.packageName] || []).push(r); });
        const rpasById = Object.fromEntries((DATA.rpas || []).map(r => [r.id, r]));
        body.innerHTML = `
            <article class="card">
                <div class="card-header"><div><h2>Impacto de dependências</h2><p>Cada pacote/arquivo cadastrado e quantas RPAs — e quantas críticas — dependem dele.</p></div></div>
                <div class="card-body">
                    ${Object.entries(byPackage).map(([pkg, uses]) => {
                        const critical = uses.filter(u => rpasById[u.automationId]?.criticality === 'CRÍTICA').length;
                        return `<div class="metric-row"><span title="${escapeHtml(pkg)}">${escapeHtml(pkg)}</span><div class="progress-track"><div class="progress-fill ${critical ? 'danger' : 'success'}" style="width:${Math.min(100, uses.length * 20)}%"></div></div><strong>${uses.length} RPA${uses.length === 1 ? '' : 's'} · ${critical} crítica(s)</strong></div>`;
                    }).join('') || '<div class="empty-state">Sem pacotes cadastrados.</div>'}
                </div>
            </article>`;
    }

    /* ---- 6.9 Qualidade / Policy ---------------------------------------------- */
    async function renderPolicy() {
        const body = document.getElementById('aaPolicyBody');
        if (!body) return;
        const resp = await proxy('GET', '/v3/policies');
        body.innerHTML = resp.ok ? renderPolicyRows(resp.data) : aaErrorState(resp);
    }
    function renderPolicyRows(data) {
        return `<article class="card"><div class="card-body"><pre class="mono" style="white-space:pre-wrap">${escapeHtml(JSON.stringify(data, null, 2))}</pre></div></article>`;
    }

    /* ---- 6.10 Analytics (ACC/BotInsight) -------------------------------------- */
    async function renderAnalytics() {
        const body = document.getElementById('aaAnalyticsBody');
        if (!body) return;
        const resp = await proxy('GET', '/v2/acc/summary');
        body.innerHTML = resp.ok ? renderPolicyRows(resp.data) : aaErrorState(resp);
    }

    /* ---- helpers de UI compartilhados pelas páginas ------------------------- */
    function kpiCard(label, value, icon, cls) {
        return `<article class="card kpi-card"><div class="kpi-top"><div><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${value}</div></div><div class="kpi-icon ${cls}"><svg class="icon"><use href="#${icon}"></use></svg></div></div></article>`;
    }
    function aaStatusBadge(status) {
        const cls = { COMPLETED: 'success', RUN_FAILED: 'danger', FAILED: 'danger', RUNNING: 'info', QUEUED: 'warning' }[status] || 'neutral';
        return `<span class="badge ${cls}">${escapeHtml(status || '—')}</span>`;
    }
    function aaErrorState(resp) {
        const messages = {
            FORBIDDEN: 'Sem permissão para este recurso nesta Control Room.',
            UNAVAILABLE: 'Recurso não disponível nesta Control Room.',
            UNSUPPORTED: 'Formato de resposta não suportado pela integração.',
            TEMPORARY_ERROR: 'Erro temporário ao consultar a Control Room. Tente novamente em instantes.',
            NETWORK_ERROR: 'Não foi possível alcançar a Control Room.',
            SESSION_EXPIRED: 'Sessão expirada — reconecte pelo botão no topo.',
        };
        return `<div class="aa-empty-capability">${escapeHtml(messages[resp.error] || resp.message || 'Recurso indisponível.')}</div>`;
    }

    /* Dispara o render certo quando o usuário navega para uma página AA —
       goToPage() do dashboard original só alterna a classe .active; quem
       decide buscar dados sob demanda (lazy) é este observer. */
    function hookPageObserver() {
        const renderers = {
            'aa-control-room': renderControlRoom,
            'aa-activity': renderActivityList,
            'aa-360': () => renderExecucao360(),
            'aa-schedules': renderSchedules,
            'aa-devices': renderDevices,
            'aa-workload': renderWorkload,
            'aa-audit': renderAuditPage,
            'aa-dependencies': renderDependencies,
            'aa-policy': renderPolicy,
            'aa-analytics': renderAnalytics,
        };
        const target = document.querySelector('main.content');
        if (!target) return;
        const obs = new MutationObserver(() => {
            const active = document.querySelector('.page.active');
            if (!active) return;
            const name = active.id.replace('page-', '');
            if (renderers[name]) renderers[name]();
        });
        obs.observe(target, { attributes: true, attributeFilter: ['class'], subtree: true });
    }

    /* =========================================================================
       7. EXPORTAÇÃO PDF (novas páginas) — nunca inclui API Key/token/headers.
       ========================================================================= */
    document.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-aa-export]');
        if (!btn) return;
        const page = document.getElementById('page-' + btn.dataset.aaExport);
        if (!page) return;
        const w = window.open('', '_blank');
        if (!w) { showToast('O navegador bloqueou a janela de exportação — permita pop-ups para este site e tente novamente.'); return; }
        w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(page.querySelector('h1')?.textContent || 'Automation Anywhere')}</title>
            <link rel="stylesheet" href="/assets/observability.css"></head><body class="page" style="padding:24px">${page.innerHTML}</body></html>`);
        w.document.close();
        setTimeout(() => w.print(), 300);
    });

    /* =========================================================================
       8. INICIALIZAÇÃO
       ========================================================================= */
    function init() {
        loadStaticConfig();
        injectHeaderButton();
        hookPageObserver();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Superfície mínima para depuração manual — nunca expõe secrets.apiKey/token.
    window.AA = {
        getState: () => ({ connection: state.connection, capabilities: { ...state.capabilities }, session: { ...state.session } }),
        disconnect,
        _debugForceCapability(name, value) { state.capabilities[name] = value; renderNav(); },
    };
})();
