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
   helpers globais já existentes ($, $$, escapeHtml, showToast, goToPage,
   fmtDateTime, fmtTime, DATA, window.OBS_DATA) em vez de duplicá-los. Eles
   são lidos em tempo de chamada (nunca guardados numa constante no topo do
   arquivo), porque `DATA` é reatribuída pelo dashboard original a cada
   refresh — uma cópia guardada cedo demais ficaria com dados velhos.

   Segurança: API Key e token ficam só dentro da classe AASecretVault (nunca
   em window, localStorage, sessionStorage, log ou PDF) e são descartados ao
   desconectar ou fechar a aba.

   ----------------------------------------------------------------------------
   MAPA DAS CLASSES (para quem for mexer aqui depois)
   ----------------------------------------------------------------------------
   AASecretVault         guarda apiKey/token só em memória.
   AAConfigStore         guarda baseUrl/username (não-sensível).
   AATelemetryRecorder   contadores técnicos (Seção 34 do pedido de upgrade).
   AACacheStore          cache em memória com TTL e status LIVE/ATUALIZADO/STALE/OFFLINE.
   AAAuditTrail          log local de ações (Seção 22/34) — nunca segredo.
   AAApiClient           todas as chamadas HTTP a /api/aa/* (o proxy local).
   AACorrelationEngine   classifica Activity × log local (EXACT/HIGH_CONFIDENCE/...).
   AAConnectionManager   máquina de estados da conexão; dispara 'statechange'.
   AAModalView           modal de conexão (API Key + Configuração avançada).
   AAHeaderButtonView    botão do topbar + popover de status.
   AANavigationView      grupo "Automation Anywhere" no menu lateral.
   AAActionsController   confirmação + execução de ações (reexecutar, schedule).
   AAPagesController     injeta e renderiza as 10 páginas novas.
   AutomationAnywhereApp orquestra tudo e expõe window.AA para depuração.
   ============================================================================ */
(function () {
    'use strict';

    /** Quanto tempo esperar entre sincronizações automáticas da integração —
     * sempre menor e independente do refresh local de 20 min do dashboard. */
    const AA_REFRESH_MS = 5 * 60 * 1000;

    /** Rótulo amigável de cada capability, usado no painel técnico. */
    const CAPABILITY_LABELS = {
        activity: 'Activity', audit: 'Audit', repository: 'Repository', scheduler: 'Scheduler',
        devices: 'Devices', packages: 'Packages', policy: 'Policy', wlm: 'WLM', acc: 'ACC',
        botInsight: 'BotInsight', deploy: 'Bot Deploy',
    };

    /** Quais páginas novas dependem de qual capability (Seção 5/7 do pedido). */
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

    /* =========================================================================
       AASecretVault — o único lugar do módulo que toca API Key/token.
       ========================================================================= */
    class AASecretVault {
        constructor() {
            this._apiKey = null;
            this._token = null;
        }
        set(apiKey, token) { this._apiKey = apiKey; this._token = token; }
        getToken() { return this._token || ''; }
        hasToken() { return !!this._token; }
        clear() { this._apiKey = null; this._token = null; }
    }

    /* =========================================================================
       AAConfigStore — URL/usuário da Control Room. Nunca guarda segredo.
       ========================================================================= */
    class AAConfigStore {
        constructor() {
            this.baseUrl = '';
            this.username = '';
        }
        /** Busca o valor pré-configurado no servidor (config/aa_config.json ou
         * variáveis de ambiente AA_BASE_URL/AA_USERNAME). Falha em silêncio —
         * é um módulo opcional, o dashboard não pode depender disto. */
        async loadDefaults() {
            try {
                const r = await fetch('/api/aa/config', { cache: 'no-store' }).then(res => res.json());
                if (r && r.ok) { this.baseUrl = r.baseUrl || ''; this.username = r.username || ''; }
            } catch (exc) { /* silencioso por design */ }
        }
        update(baseUrl, username) {
            this.baseUrl = (baseUrl || this.baseUrl || '').trim();
            this.username = (username || this.username || '').trim();
        }
    }

    /* =========================================================================
       AATelemetryRecorder — observabilidade técnica da integração (Seção 34).
       Nunca guarda headers, corpo de requisição ou segredo.
       ========================================================================= */
    class AATelemetryRecorder {
        constructor() {
            this.authAt = null;
            this.lastSyncAt = null;
            this.lastLatencyMs = null;
            this.requests = 0;
            this.httpErrors = 0;
            this.version = '1.0.0-aa';
        }
        recordRequestStart() { this.requests++; return performance.now(); }
        recordRequestEnd(startedAt) { this.lastLatencyMs = Math.round(performance.now() - startedAt); }
        recordHttpError() { this.httpErrors++; }
        recordAuth() { this.authAt = new Date().toISOString(); }
        recordSync(iso) { this.lastSyncAt = iso; }
    }

    /* =========================================================================
       AACacheStore — cache em memória por chave lógica (Seção 28). Cada
       entrada carrega seu próprio TTL e calcula o status (LIVE/ATUALIZADO/
       STALE/OFFLINE) sob demanda, na leitura.
       ========================================================================= */
    class AACacheStore {
        constructor() {
            this._map = new Map();
        }
        get(key) {
            const hit = this._map.get(key);
            if (!hit) return null;
            const age = Date.now() - hit.fetchedAt;
            hit.status = age > hit.ttlMs * 3 ? 'OFFLINE' : age > hit.ttlMs ? 'STALE' : age > hit.ttlMs / 2 ? 'ATUALIZADO' : 'LIVE';
            return hit;
        }
        set(key, data, endpoint, ttlMs = 60000) {
            this._map.set(key, { data, fetchedAt: Date.now(), ttlMs, endpoint, status: 'LIVE' });
            return this._map.get(key);
        }
        deleteByPrefix(prefix) {
            [...this._map.keys()].filter(k => k.startsWith(prefix)).forEach(k => this._map.delete(k));
        }
        clear() { this._map.clear(); }
    }

    /* =========================================================================
       AAAuditTrail — registro local de tentativas de ação (Seção 22/34).
       Guarda só o que já é público (RPA, ação, resultado, horário) — nunca um
       segredo. Mantido em memória; não sobrevive a um reload de página, o que
       é aceitável porque não é um requisito de compliance, só de UX.
       ========================================================================= */
    class AAAuditTrail {
        constructor(maxEntries = 50) {
            this._entries = [];
            this._maxEntries = maxEntries;
        }
        log(entry) {
            this._entries.unshift(Object.assign({ timestamp: new Date().toISOString() }, entry));
            if (this._entries.length > this._maxEntries) this._entries.length = this._maxEntries;
        }
        list(limit = 10) { return this._entries.slice(0, limit); }
        get isEmpty() { return this._entries.length === 0; }
    }

    /* =========================================================================
       AAApiClient — única porta de saída do módulo: fala com /api/aa/* (o
       conector local em server.py), nunca diretamente com a Control Room
       (o CSP do dashboard já bloquearia connect-src fora de 'self', e um
       proxy local evita CORS e mantém o token fora de qualquer storage do
       navegador). Depende de AASecretVault + AAConfigStore + AATelemetryRecorder
       + AACacheStore, recebidos por injeção — nenhuma variável global própria.
       ========================================================================= */
    class AAApiClient {
        constructor(secrets, config, telemetry, cache) {
            this.secrets = secrets;
            this.config = config;
            this.telemetry = telemetry;
            this.cache = cache;
            /** Chamado pelo AAConnectionManager quando qualquer resposta traz
             * SESSION_EXPIRED — fica desacoplado via callback simples em vez
             * de o client conhecer a máquina de estados. */
            this.onSessionExpired = null;
        }

        /** Chamada crua a uma rota /api/aa/* — sempre same-origin. */
        async _call(path, { method = 'GET', body } = {}) {
            const headers = { 'X-AA-Base-Url': this.config.baseUrl, 'X-AA-Token': this.secrets.getToken() };
            const startedAt = this.telemetry.recordRequestStart();
            try {
                const res = await fetch(path, {
                    method,
                    headers: body !== undefined ? Object.assign(headers, { 'Content-Type': 'application/json' }) : headers,
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                    cache: 'no-store',
                });
                this.telemetry.recordRequestEnd(startedAt);
                const json = await res.json().catch(() => ({ ok: false, error: 'UNSUPPORTED' }));
                if (!json.ok) this.telemetry.recordHttpError();
                this._detectSessionExpiry(json);
                return json;
            } catch (exc) {
                this.telemetry.recordHttpError();
                return { ok: false, error: 'NETWORK_ERROR', message: 'Sem resposta do conector local.' };
            }
        }

        _detectSessionExpiry(resp) {
            if (resp && resp.error === 'SESSION_EXPIRED' && this.onSessionExpired) this.onSessionExpired();
        }

        authenticate(apiKey, baseUrl, username) {
            return this._call('/api/aa/authenticate', { method: 'POST', body: { baseUrl, username, apiKey } });
        }

        discoverCapabilities() {
            return this._call('/api/aa/discover', { method: 'POST', body: {} });
        }

        async activityList(filters, { skipCache = false } = {}) {
            const key = 'activity:' + JSON.stringify(filters || {});
            if (!skipCache) {
                const hit = this.cache.get(key);
                if (hit) return { ok: true, ...hit.data, _cache: hit };
            }
            const resp = await this._call('/api/aa/activity/list', { method: 'POST', body: { filters } });
            if (resp.ok) this.cache.set(key, resp, '/v3/activity/list', 45000);
            return resp;
        }

        async activityDetail(id) {
            const key = 'activity-detail:' + id;
            const hit = this.cache.get(key);
            if (hit) return { ok: true, ...hit.data, _cache: hit };
            const resp = await this._call('/api/aa/activity/execution/' + encodeURIComponent(id));
            if (resp.ok) this.cache.set(key, resp, '/v3/activity/execution/{id}', 120000);
            return resp;
        }

        /** Proxy genérico para capacidades além de Activity (Repository,
         * Scheduler, Devices, Audit, Packages, Policy, WLM, ACC, BotInsight).
         * `ttlMs === 0` força ignorar/pular o cache — usado por ações que
         * mutam estado (ex.: habilitar/desabilitar schedule). */
        async proxy(method, path, body, ttlMs) {
            const key = 'proxy:' + method + ':' + path + ':' + JSON.stringify(body || {});
            if (ttlMs !== 0) {
                const hit = this.cache.get(key);
                if (hit) return { ok: true, ...hit.data, _cache: hit };
            }
            const resp = await this._call('/api/aa/proxy', { method: 'POST', body: { method, path, body } });
            if (resp.ok && ttlMs !== 0) this.cache.set(key, resp, path, ttlMs || 90000);
            return resp;
        }
    }

    /* =========================================================================
       AACorrelationEngine — API × logs locais (Seção 13/36 do pedido).
       Nunca apresenta correspondência provável como fato: toda atividade
       recebe uma classificação explícita — EXACT, HIGH_CONFIDENCE, PROBABLE,
       UNMATCHED ou CONFLICT — junto com o motivo em texto.
       ========================================================================= */
    class AACorrelationEngine {
        /**
         * @param {object} activity  Um item do Activity List (formato AA).
         * @returns {{classification: string, execution: object|null, reason: string}}
         */
        correlate(activity) {
            const execs = (window.OBS_DATA && window.OBS_DATA.executions) || [];

            // 1) execution_id oficial embutido no identificador da atividade —
            //    só acontece se o bot grava o próprio execution_id local como
            //    parâmetro/nota na Control Room; não é o caso comum.
            const exact = execs.find(e => activity.id && activity.id.includes(e.executionId));
            if (exact) {
                return { classification: 'EXACT', execution: exact, reason: 'execution_id do log encontrado no identificador da atividade.' };
            }

            // 2) process_name + janela temporal + machine_name — fallback
            //    padrão quando não há chave compartilhada explícita (o caso
            //    normal neste ambiente).
            const activityStart = Date.parse(activity.started || activity.created);
            const candidates = execs
                .map(e => ({ e, deltaMin: Math.abs(Date.parse(e.start) - activityStart) / 60000 }))
                .filter(c => c.deltaMin <= 20)
                .filter(c => this._sameAutomation(activity, c.e))
                .sort((a, b) => a.deltaMin - b.deltaMin);

            if (!candidates.length) {
                return { classification: 'UNMATCHED', execution: null, reason: 'Nenhuma execução local dentro da janela de tempo esperada.' };
            }

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

        /** A comparação precisa sempre depender do execRow avaliado — nunca
         * só do nome da automação isolado, senão qualquer execução do
         * período (de qualquer RPA) passaria a "combinar" com a atividade. */
        _sameAutomation(activity, execRow) {
            const rpas = (window.DATA && window.DATA.rpas) || (typeof DATA !== 'undefined' ? DATA.rpas : []) || [];
            const rpa = rpas.find(r => r.id === activity.automationId);
            if (rpa) return rpa.process === execRow.process;
            return String(activity.automationName || '').toLowerCase() === String(execRow.process || '').toLowerCase();
        }
    }

    /* =========================================================================
       AAConnectionManager — máquina de estados da conexão. Orquestra
       AASecretVault + AAConfigStore + AAApiClient + AATelemetryRecorder e
       dispara o evento DOM 'aa:statechange' sempre que o estado muda, para
       que as views (botão, popover, navegação) se atualizem sem acoplamento
       direto a esta classe.

       Estados possíveis (Seção 6 do pedido): DISCONNECTED, CONNECTING,
       CONNECTED, CONNECTED_PARTIAL, REFRESHING, STALE, SESSION_EXPIRED,
       AUTH_ERROR, NETWORK_ERROR, OFFLINE.
       ========================================================================= */
    class AAConnectionManager extends EventTarget {
        constructor(secrets, config, apiClient, telemetry) {
            super();
            this.secrets = secrets;
            this.config = config;
            this.apiClient = apiClient;
            this.telemetry = telemetry;
            this.connection = 'DISCONNECTED';
            this.capabilities = {};
            this.session = { controlRoom: '', username: '', connectedAt: null, lastSync: null, nextSync: null, mock: false };
            this.lastError = null;
            this.checklist = [];
            this._refreshTimer = null;

            apiClient.onSessionExpired = () => {
                if (this.connection !== 'SESSION_EXPIRED') {
                    this._stopAutoRefresh();
                    this._setConnection('SESSION_EXPIRED');
                }
            };
        }

        _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

        _setConnection(next) {
            this.connection = next;
            this._emit('statechange', { connection: next });
        }

        _pushChecklist(id, status, label) {
            const row = this.checklist.find(c => c.id === id);
            if (row) row.status = status; else this.checklist.push({ id, status, label });
            this._emit('checklist', { checklist: this.checklist });
        }

        get availableCount() { return Object.values(this.capabilities).filter(v => v === 'AVAILABLE').length; }
        get totalCapabilities() { return Object.keys(this.capabilities).length; }
        get isConnected() { return ['CONNECTED', 'CONNECTED_PARTIAL', 'REFRESHING', 'STALE'].includes(this.connection); }

        async connect(apiKey, overrideBaseUrl, overrideUsername) {
            this.config.update(overrideBaseUrl, overrideUsername);
            this.checklist = [];
            this._setConnection('CONNECTING');
            this._pushChecklist('auth', 'pending', 'Autenticação');

            const authResp = await this.apiClient.authenticate(apiKey, this.config.baseUrl, this.config.username);
            if (!authResp.ok) {
                this._pushChecklist('auth', 'failed', 'Autenticação');
                this.lastError = authResp.message || 'Falha de autenticação.';
                this.secrets.clear();
                this._setConnection(authResp.error === 'NETWORK_ERROR' ? 'NETWORK_ERROR' : 'AUTH_ERROR');
                return { ok: false, message: this.lastError };
            }

            this._pushChecklist('auth', 'done', 'Autenticação');
            this.secrets.set(apiKey, authResp.token); // permanece só em memória; nunca persistido
            this.config.username = this.config.username || authResp.username || '';
            this.telemetry.recordAuth();
            this.session = {
                controlRoom: authResp.controlRoom || this.config.baseUrl || 'Control Room',
                username: this.config.username,
                connectedAt: this.telemetry.authAt,
                lastSync: null, nextSync: null,
                mock: !!authResp.mock,
            };

            this._pushChecklist('activity', 'pending', 'Activity');
            const probe = await this.apiClient.activityList({ page: 0, size: 1 }, { skipCache: true });
            this._pushChecklist('activity', probe.ok ? 'done' : 'failed', 'Activity');

            this._pushChecklist('capabilities', 'pending', 'Discovery de capacidades');
            const disc = await this.apiClient.discoverCapabilities();
            if (disc.ok) {
                this.capabilities = disc.capabilities;
                this._pushChecklist('capabilities', 'done', 'Discovery de capacidades');
            } else {
                this.capabilities = { activity: probe.ok ? 'AVAILABLE' : 'TEMPORARY_ERROR' };
                this._pushChecklist('capabilities', 'failed', 'Discovery de capacidades');
            }

            this._setConnection(this.availableCount === this.totalCapabilities ? 'CONNECTED' : 'CONNECTED_PARTIAL');
            this._scheduleSync();
            this._startAutoRefresh();
            this._emit('connected', { capabilities: this.capabilities });
            return { ok: true };
        }

        disconnect() {
            this._stopAutoRefresh();
            this.secrets.clear();
            this.capabilities = {};
            this.session = { controlRoom: '', username: '', connectedAt: null, lastSync: null, nextSync: null, mock: false };
            this._setConnection('DISCONNECTED');
            this._emit('disconnected', {});
        }

        _scheduleSync() {
            const now = new Date();
            this.session.lastSync = now.toISOString();
            this.session.nextSync = new Date(now.getTime() + AA_REFRESH_MS).toISOString();
            this.telemetry.recordSync(this.session.lastSync);
        }

        /** Refresh próprio da integração — nunca bloqueia nem depende do
         * refresh local de 20 min do dashboard (Seção 24 do pedido). */
        _startAutoRefresh() {
            this._stopAutoRefresh();
            this._refreshTimer = setInterval(async () => {
                if (!this.isConnected) return;
                const previousState = this.connection;
                this._setConnection('REFRESHING');
                this.apiClient.cache.deleteByPrefix('activity:');
                const probe = await this.apiClient.activityList({ page: 0, size: 1 }, { skipCache: true });
                this._scheduleSync();
                this._setConnection(probe.ok ? previousState : 'STALE');
                this._emit('refreshed', { ok: probe.ok });
            }, AA_REFRESH_MS);
        }

        _stopAutoRefresh() {
            if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
        }
    }

    /* =========================================================================
       AAModalView — modal de conexão: pede a API Key e, opcionalmente, URL e
       usuário da Control Room em "Configuração avançada". Só conhece o
       AAConnectionManager através da instância recebida no construtor.
       ========================================================================= */
    class AAModalView {
        constructor(connectionManager, config) {
            this.connectionManager = connectionManager;
            this.config = config;
            connectionManager.addEventListener('checklist', () => this._renderChecklist());
        }

        open() {
            if (document.getElementById('aaModalOverlay')) return;
            this.connectionManager.checklist = [];
            const overlay = document.createElement('div');
            overlay.id = 'aaModalOverlay';
            overlay.className = 'aa-modal-overlay';
            const isRetry = this.connectionManager.connection === 'SESSION_EXPIRED';
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
                            <input id="aaBaseUrlInput" type="text" placeholder="https://suaempresa.my.automationanywhere.digital (deixe vazio para simular)" value="${escapeHtml(this.config.baseUrl)}">
                        </div>
                        <div class="aa-field">
                            <label for="aaUsernameInput">Usuário</label>
                            <input id="aaUsernameInput" type="text" placeholder="svc_rpa_observability" value="${escapeHtml(this.config.username)}">
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
            overlay.addEventListener('mousedown', ev => { if (ev.target === overlay) this.close(); });
            document.getElementById('aaCancelBtn').addEventListener('click', () => this.close());
            document.getElementById('aaAdvancedToggle').addEventListener('click', ev => {
                ev.currentTarget.classList.toggle('open');
                document.getElementById('aaAdvancedBody').classList.toggle('open');
            });
            document.getElementById('aaConnectSubmitBtn').addEventListener('click', () => this._submit());
            document.getElementById('aaApiKeyInput').addEventListener('keydown', ev => { if (ev.key === 'Enter') this._submit(); });
            document.getElementById('aaApiKeyInput').focus();
        }

        close() {
            const overlay = document.getElementById('aaModalOverlay');
            if (overlay) overlay.remove();
            if (this.connectionManager.connection === 'CONNECTING') this.connectionManager._setConnection('DISCONNECTED');
        }

        _renderChecklist() {
            const slot = document.getElementById('aaChecklistSlot');
            if (!slot) return;
            const icon = { pending: '○', done: '✓', failed: '×' };
            const rows = this.connectionManager.checklist;
            slot.innerHTML = rows.length ? `<div class="aa-checklist">${rows.map(c => `
                <div class="aa-checklist-row ${c.status}"><span class="aa-checklist-mark">${icon[c.status]}</span>${escapeHtml(c.label)}</div>
            `).join('')}</div>` : '';
        }

        async _submit() {
            const apiKey = document.getElementById('aaApiKeyInput').value.trim();
            const baseUrl = document.getElementById('aaBaseUrlInput').value.trim();
            const username = document.getElementById('aaUsernameInput').value.trim();
            const errSlot = document.getElementById('aaModalErrorSlot');
            errSlot.innerHTML = '';
            if (!apiKey) { errSlot.innerHTML = '<div class="aa-modal-error">Informe a API Key.</div>'; return; }
            document.getElementById('aaConnectSubmitBtn').disabled = true;
            document.getElementById('aaCancelBtn').disabled = true;
            const result = await this.connectionManager.connect(apiKey, baseUrl, username);
            document.getElementById('aaConnectSubmitBtn').disabled = false;
            document.getElementById('aaCancelBtn').disabled = false;
            if (!result.ok) {
                errSlot.innerHTML = `<div class="aa-modal-error">${escapeHtml(result.message || 'Não foi possível conectar.')}</div>`;
                return;
            }
            this.close();
            const cm = this.connectionManager;
            showToast(cm.availableCount === cm.totalCapabilities ? 'Automation Anywhere conectado.' : `Conectado com restrições (${cm.availableCount}/${cm.totalCapabilities} recursos disponíveis).`);
            goToPage('aa-control-room');
        }
    }

    /* =========================================================================
       AAHeaderButtonView — botão fixo no topbar (a única presença permanente
       na interface principal, por design) + popover de status quando
       conectado. Nunca mostra a chave.
       ========================================================================= */
    class AAHeaderButtonView {
        constructor(connectionManager, modalView) {
            this.connectionManager = connectionManager;
            this.modalView = modalView;
            connectionManager.addEventListener('statechange', () => this._render());
        }

        mount() {
            const topbar = document.querySelector('.topbar');
            if (!topbar || document.getElementById('aaConnectBtn')) return;
            const btn = document.createElement('button');
            btn.id = 'aaConnectBtn';
            btn.className = 'aa-connect-btn';
            btn.innerHTML = '<span class="dot"></span><span class="aa-connect-label">Automation Anywhere · Conectar</span>';
            const refreshBtn = document.getElementById('refreshButton');
            topbar.insertBefore(btn, refreshBtn || topbar.lastElementChild);
            btn.addEventListener('click', () => this._onClick());
            this._render();
        }

        _render() {
            const btn = document.getElementById('aaConnectBtn');
            if (!btn) return;
            const label = btn.querySelector('.aa-connect-label');
            btn.classList.remove('connected', 'partial', 'error', 'connecting');
            const paint = {
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
            (paint[this.connectionManager.connection] || paint.DISCONNECTED)();
        }

        _onClick() {
            if (this.connectionManager.isConnected) this._togglePopover();
            else this.modalView.open();
        }

        _togglePopover() {
            const existing = document.getElementById('aaPopover');
            if (existing) { existing.remove(); return; }
            const btn = document.getElementById('aaConnectBtn');
            const rect = btn.getBoundingClientRect();
            const cm = this.connectionManager;
            const pop = document.createElement('div');
            pop.id = 'aaPopover';
            pop.className = 'aa-popover';
            pop.style.top = (rect.bottom + 8) + 'px';
            pop.style.right = (window.innerWidth - rect.right) + 'px';
            pop.innerHTML = `
                <h4>Automation Anywhere</h4>
                <div class="aa-popover-row"><span>Control Room</span><strong>${escapeHtml(cm.session.controlRoom || '—')}</strong></div>
                <div class="aa-popover-row"><span>Usuário</span><strong>${escapeHtml(cm.session.username || '—')}</strong></div>
                <div class="aa-popover-row"><span>Última sincronização</span><strong>${cm.session.lastSync ? fmtTime(cm.session.lastSync) : '—'}</strong></div>
                <div class="aa-popover-row"><span>Próxima sincronização</span><strong>${cm.session.nextSync ? fmtTime(cm.session.nextSync) : '—'}</strong></div>
                <div class="aa-popover-row"><span>Recursos disponíveis</span><strong>${cm.availableCount}/${cm.totalCapabilities}</strong></div>
                <div class="aa-popover-actions">
                    <button class="aa-btn" id="aaOpenTechBtn" style="flex:1">Detalhes técnicos</button>
                    <button class="aa-btn danger" id="aaDisconnectBtn" style="flex:1">Desconectar</button>
                </div>
            `;
            document.body.appendChild(pop);
            document.getElementById('aaDisconnectBtn').addEventListener('click', () => { pop.remove(); cm.disconnect(); });
            document.getElementById('aaOpenTechBtn').addEventListener('click', () => { pop.remove(); goToPage('aa-control-room'); });
            const dismiss = ev => {
                if (pop && !pop.contains(ev.target) && ev.target !== btn) { pop.remove(); document.removeEventListener('click', dismiss); }
            };
            setTimeout(() => document.addEventListener('click', dismiss), 0);
        }
    }

    /* =========================================================================
       AANavigationView — injeta o grupo "Automation Anywhere" no menu lateral
       e mostra/oculta cada item conforme a capability correspondente esteja
       AVAILABLE (Seção 7: "ocultar itens sem suporte ou permissão").
       ========================================================================= */
    class AANavigationView {
        constructor(connectionManager, pagesController) {
            this.connectionManager = connectionManager;
            this.pagesController = pagesController;
            connectionManager.addEventListener('connected', () => this._render());
            connectionManager.addEventListener('disconnected', () => this._render());
        }

        _ensureGroup() {
            const existing = document.getElementById('aaNavGroup');
            if (existing) return existing;
            const sidebarScroll = document.querySelector('.sidebar-scroll');
            if (!sidebarScroll) return null;
            const wrap = document.createElement('div');
            wrap.id = 'aaNavGroup';
            wrap.innerHTML = '<div class="nav-section-label">Automation Anywhere</div>';
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
            this.pagesController.ensurePages();
            return wrap;
        }

        _render() {
            const cm = this.connectionManager;
            let group = document.getElementById('aaNavGroup');
            if (!cm.isConnected) { if (group) group.style.display = 'none'; return; }
            if (!group) group = this._ensureGroup();
            group.style.display = '';
            $$('.nav-link[data-aa-capability]').forEach(btn => {
                btn.style.display = cm.capabilities[btn.dataset.aaCapability] === 'AVAILABLE' ? '' : 'none';
            });
            this.pagesController.renderControlRoom();
        }
    }

    /* =========================================================================
       AAActionsController — Fase 7 do pedido: ações que mutam estado na
       Control Room. Só existem quando a capability está disponível, sempre
       pedem confirmação (RPA/Ambiente/Ação/Consequência) e ficam registradas
       no AAAuditTrail — nunca acontecem silenciosamente.
       ========================================================================= */
    class AAActionsController {
        constructor(apiClient, auditTrail, connectionManager) {
            this.apiClient = apiClient;
            this.auditTrail = auditTrail;
            this.connectionManager = connectionManager;
        }

        /** @returns {Promise<boolean>} true se o usuário confirmou. */
        confirm({ title, rpa, environment, action, consequence, confirmLabel, dangerous }) {
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

        log(entry) {
            this.auditTrail.log(entry);
            if (document.querySelector('.page.active')?.id === 'page-aa-control-room') {
                document.dispatchEvent(new CustomEvent('aa:audittrail-changed'));
            }
        }

        async runOrRerun(activity, rpaName) {
            const cm = this.connectionManager;
            const ok = await this.confirm({
                title: 'Reexecutar automação',
                rpa: rpaName, environment: cm.session.mock ? 'Simulação (mock)' : cm.session.controlRoom,
                action: `Reexecutar ${activity.id}`,
                consequence: 'Dispara uma nova execução na Control Room. Itens já processados na tentativa original não são desfeitos.',
                confirmLabel: 'Reexecutar', dangerous: true,
            });
            if (!ok) { this.log({ action: 'RE_RUN', target: activity.id, result: 'CANCELADO_PELO_USUARIO' }); return; }
            const resp = await this.apiClient.proxy('POST', '/v4/automations/deploy', { automationId: activity.automationId, sourceActivityId: activity.id }, 0);
            this.log({ action: 'RE_RUN', target: activity.id, result: resp.ok ? 'ENVIADO' : ('FALHA: ' + resp.error) });
            showToast(resp.ok ? 'Reexecução enviada à Control Room.' : `Não foi possível reexecutar (${resp.error}).`);
        }

        async toggleSchedule(scheduleId, rpaName, enable, onDone) {
            const cm = this.connectionManager;
            const ok = await this.confirm({
                title: enable ? 'Habilitar schedule' : 'Desabilitar schedule',
                rpa: rpaName, environment: cm.session.mock ? 'Simulação (mock)' : cm.session.controlRoom,
                action: `${enable ? 'Habilitar' : 'Desabilitar'} ${scheduleId}`,
                consequence: enable ? 'A automação volta a rodar nos horários definidos na Control Room.' : 'A automação deixa de rodar nos horários definidos na Control Room até ser reabilitada.',
                confirmLabel: enable ? 'Habilitar' : 'Desabilitar', dangerous: !enable,
            });
            if (!ok) { this.log({ action: 'SCHEDULE_TOGGLE', target: scheduleId, result: 'CANCELADO_PELO_USUARIO' }); return; }
            const resp = await this.apiClient.proxy('PATCH', '/v2/schedule/rules/' + encodeURIComponent(scheduleId), { enabled: enable }, 0);
            this.log({ action: 'SCHEDULE_TOGGLE', target: scheduleId, result: resp.ok ? (enable ? 'HABILITADO' : 'DESABILITADO') : ('FALHA: ' + resp.error) });
            showToast(resp.ok ? 'Schedule atualizado.' : `Não foi possível atualizar o schedule (${resp.error}).`);
            if (onDone) onDone();
        }
    }

    /* =========================================================================
       AAPagesController — injeta as 10 páginas novas (Seção 7/9-21 do pedido)
       como <section class="page" id="page-aa-...">, exatamente no formato que
       o goToPage()/renderAll() originais do index.html já sabem exibir — eles
       não precisam saber que este módulo existe. Um MutationObserver decide
       quando buscar dados (lazy) ao detectar a troca da classe .active.
       ========================================================================= */
    class AAPagesController {
        constructor(apiClient, correlationEngine, connectionManager, actionsController, auditTrail) {
            this.apiClient = apiClient;
            this.correlationEngine = correlationEngine;
            this.connectionManager = connectionManager;
            this.actionsController = actionsController;
            this.auditTrail = auditTrail;
            this._activityCacheRows = [];
            document.addEventListener('aa:audittrail-changed', () => this.renderControlRoom());
        }

        /* ---- injeção das seções ------------------------------------------- */
        ensurePages() {
            const main = document.querySelector('main.content');
            if (!main || document.getElementById('page-aa-control-room')) return;
            const shells = [
                this._pageShell('aa-control-room', 'CONTROL ROOM', 'Visão consolidada', 'O que está executando, em fila, falhando ou fora do baseline agora — direto da Control Room.', 'aaControlRoomBody'),
                this._pageShell('aa-activity', 'AUTOMATION ANYWHERE', 'Execuções AA', 'Activity List oficial da Control Room, com nível de correlação com os logs locais.', 'aaActivityBody'),
                this._pageShell('aa-360', 'AUTOMATION ANYWHERE', 'Execução 360°', 'Consolida Control Room, logs locais e telemetria de VM para uma execução — não substitui Auditoria/Investigação/Diagnóstico.', 'aa360Body'),
                this._pageShell('aa-schedules', 'AUTOMATION ANYWHERE', 'Schedules', 'Schedule da Control Room × agenda local × execução realizada.', 'aaSchedulesBody'),
                this._pageShell('aa-devices', 'AUTOMATION ANYWHERE', 'Runners & Devices', 'Devices da Control Room combinados com a telemetria local de VM.', 'aaDevicesBody'),
                this._pageShell('aa-workload', 'AUTOMATION ANYWHERE', 'Workload', 'Filas, backlog e throughput do Workload Management, quando disponível.', 'aaWorkloadBody'),
                this._pageShell('aa-audit', 'AUTOMATION ANYWHERE', 'Mudanças & Audit', 'Linha do tempo mudança → execução → falha, separando evidência de hipótese.', 'aaAuditBody'),
                this._pageShell('aa-dependencies', 'AUTOMATION ANYWHERE', 'Dependências', 'Repository + Package Usage combinados com a criticidade local das RPAs.', 'aaDependenciesBody'),
                this._pageShell('aa-policy', 'AUTOMATION ANYWHERE', 'Qualidade / Policy', 'Violations e resultado de scans de Policy Management, quando permitido.', 'aaPolicyBody'),
                this._pageShell('aa-analytics', 'AUTOMATION ANYWHERE', 'Analytics', 'Indicadores de ACC/BotInsight, quando disponíveis nesta Control Room.', 'aaAnalyticsBody'),
            ];
            shells.forEach(html => main.insertAdjacentHTML('beforeend', html));
            document.getElementById('aaActivityStatusFilter')?.addEventListener('change', () => this._paintActivityRows());
            document.getElementById('aaActivitySearch')?.addEventListener('input', () => this._paintActivityRows());
        }

        _pageShell(id, eyebrow, title, subtitle, bodyId) {
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

        /** Roteador chamado pelo MutationObserver de AutomationAnywhereApp
         * sempre que uma página AA vira a página ativa. */
        renderActivePage(pageName) {
            const routes = {
                'aa-control-room': () => this.renderControlRoom(),
                'aa-activity': () => this.renderActivityList(),
                'aa-360': () => this.renderExecucao360(),
                'aa-schedules': () => this.renderSchedules(),
                'aa-devices': () => this.renderDevices(),
                'aa-workload': () => this.renderWorkload(),
                'aa-audit': () => this.renderAuditPage(),
                'aa-dependencies': () => this.renderDependencies(),
                'aa-policy': () => this.renderPolicy(),
                'aa-analytics': () => this.renderAnalytics(),
            };
            if (routes[pageName]) routes[pageName]();
        }

        /* ---- 1. Control Room ------------------------------------------------ */
        async renderControlRoom() {
            const body = document.getElementById('aaControlRoomBody');
            if (!body || !document.getElementById('page-aa-control-room')) return;
            const resp = await this.apiClient.activityList({ page: 0, size: 200 });
            if (!resp.ok) { body.innerHTML = this._errorState(resp); return; }
            const rows = resp.list || [];
            const running = rows.filter(r => r.status === 'RUNNING').length;
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
                    ${this._kpiCard('Executando agora', running, 'i-activity', 'info')}
                    ${this._kpiCard('Em fila', queued, 'i-clock', queued ? 'warning' : 'success')}
                    ${this._kpiCard('Falharam (amostra)', failed, 'i-alert', failed ? 'danger' : 'success')}
                    ${this._kpiCard('Acima do baseline', overBaseline, 'i-triangle', overBaseline ? 'warning' : 'success')}
                </div>
                <div class="grid grid-2" style="margin-top:14px">
                    <article class="card">
                        <div class="card-header"><div><h2>Timeline recente (Control Room)</h2><p>Últimas atividades retornadas pela Activity List.</p></div></div>
                        <div class="table-wrap"><table><thead><tr><th>Automação</th><th>Status</th><th>Início</th><th>Duração</th><th>Device</th></tr></thead>
                        <tbody>${rows.slice(0, 10).map(r => `<tr><td>${escapeHtml(r.automationName)}</td><td>${this._statusBadge(r.status)}</td><td>${fmtDateTime(r.started)}</td><td>${(r.durationMs / 60000).toFixed(1)} min</td><td class="mono">${escapeHtml(r.device || '—')}</td></tr>`).join('')}</tbody></table></div>
                    </article>
                    <article class="card">
                        <div class="card-header"><div><h2>Pareto de erros oficiais</h2><p>Código de erro reportado pela própria Control Room.</p></div></div>
                        <div class="card-body">${pareto.length ? pareto.map(([code, count]) => `
                            <div class="pareto-row"><span class="pareto-code mono">${escapeHtml(code)}</span><div class="pareto-bar"><div style="width:${count / maxCount * 100}%"></div></div><span class="pareto-count">${count}</span></div>
                        `).join('') : '<div class="empty-state">Sem erros oficiais no período retornado.</div>'}</div>
                    </article>
                </div>
                ${this._auditTrailPanel()}
                ${this._technicalPanel()}
            `;
        }

        _technicalPanel() {
            const cm = this.connectionManager;
            const telemetry = cm.telemetry;
            const caps = Object.keys(cm.capabilities);
            return `
                <article class="card" style="margin-top:14px">
                    <div class="card-header"><div><h2>Observabilidade da integração</h2><p>Estado técnico da conexão — nunca exibe segredos.</p></div></div>
                    <div class="card-body">
                        <div class="audit-evidence-list">
                            <div class="audit-evidence-row"><span>Estado da conexão</span><span>${escapeHtml(cm.connection)}</span></div>
                            <div class="audit-evidence-row"><span>Última autenticação</span><span>${telemetry.authAt ? fmtDateTime(telemetry.authAt) : '—'}</span></div>
                            <div class="audit-evidence-row"><span>Última sincronização</span><span>${cm.session.lastSync ? fmtDateTime(cm.session.lastSync) : '—'}</span></div>
                            <div class="audit-evidence-row"><span>Tempo de resposta (última chamada)</span><span>${telemetry.lastLatencyMs != null ? telemetry.lastLatencyMs + ' ms' : '—'}</span></div>
                            <div class="audit-evidence-row"><span>Requisições / erros HTTP</span><span>${telemetry.requests} / ${telemetry.httpErrors}</span></div>
                            <div class="audit-evidence-row"><span>Ambiente</span><span>${cm.session.mock ? 'Simulação local (mock)' : escapeHtml(cm.session.controlRoom)}</span></div>
                            <div class="audit-evidence-row"><span>Versão da integração</span><span>${telemetry.version}</span></div>
                        </div>
                        <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px">
                            ${caps.map(c => `<span class="badge aa-cap-${cm.capabilities[c]}"><span class="dot"></span>${CAPABILITY_LABELS[c] || c}</span>`).join('')}
                        </div>
                    </div>
                </article>
            `;
        }

        _auditTrailPanel() {
            if (this.auditTrail.isEmpty) return '';
            return `
                <article class="card" style="margin-top:14px">
                    <div class="card-header"><div><h2>Registro local de ações</h2><p>Tentativas de ação disparadas por este navegador nesta sessão — nunca inclui segredos.</p></div></div>
                    <div class="card-body">
                        ${this.auditTrail.list(10).map(a => `<div class="audit-evidence-row"><span>${fmtDateTime(a.timestamp)} · ${escapeHtml(a.action)}</span><span>${escapeHtml(a.target)} — ${escapeHtml(a.result)}</span></div>`).join('')}
                    </div>
                </article>`;
        }

        /* ---- 2. Execuções AA (Activity List) --------------------------------- */
        async renderActivityList() {
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
                document.getElementById('aaActivityStatusFilter').addEventListener('change', () => this._paintActivityRows());
                document.getElementById('aaActivitySearch').addEventListener('input', () => this._paintActivityRows());
            }
            const resp = await this.apiClient.activityList({ page: 0, size: 300 });
            if (!resp.ok) { document.getElementById('aaActivityTableBody').innerHTML = `<tr><td colspan="7">${this._errorState(resp)}</td></tr>`; return; }
            this._activityCacheRows = resp.list || [];
            this._paintActivityRows();
        }

        _paintActivityRows() {
            const tbody = document.getElementById('aaActivityTableBody');
            if (!tbody) return;
            const statusFilter = document.getElementById('aaActivityStatusFilter')?.value || '';
            const q = (document.getElementById('aaActivitySearch')?.value || '').toLowerCase();
            let rows = this._activityCacheRows;
            if (statusFilter) rows = rows.filter(r => r.status === statusFilter);
            if (q) rows = rows.filter(r => (r.automationName + ' ' + r.device).toLowerCase().includes(q));
            document.getElementById('aaActivityCount').textContent = `${rows.length} de ${this._activityCacheRows.length} atividades`;
            tbody.innerHTML = rows.slice(0, 150).map(r => {
                const corr = this.correlationEngine.correlate(r);
                return `<tr class="clickable-row" data-aa-activity-id="${escapeHtml(r.id)}">
                    <td><span class="cell-title">${escapeHtml(r.automationName)}</span><span class="cell-subtitle mono">${escapeHtml(r.id)}</span></td>
                    <td>${this._statusBadge(r.status)}</td>
                    <td>${fmtDateTime(r.started)}</td>
                    <td>${fmtDateTime(r.ended)}</td>
                    <td>${(r.durationMs / 60000).toFixed(1)} min</td>
                    <td class="mono">${escapeHtml(r.device || '—')}</td>
                    <td><span class="badge aa-corr-${corr.classification}" title="${escapeHtml(corr.reason)}">${corr.classification}</span></td>
                </tr>`;
            }).join('') || '<tr><td colspan="7" class="empty-state">Nenhuma atividade encontrada para o filtro.</td></tr>';
            $$('#aaActivityTableBody tr[data-aa-activity-id]').forEach(tr => {
                tr.addEventListener('click', () => {
                    goToPage('aa-360');
                    const select = document.getElementById('aa360Select');
                    if (select) select.value = tr.dataset.aaActivityId;
                    this.renderExecucao360(tr.dataset.aaActivityId);
                });
            });
        }

        /* ---- 3. Execução 360° ------------------------------------------------- */
        async _ensure360Options() {
            const select = document.getElementById('aa360Select');
            if (!select || select.options.length) return;
            const resp = await this.apiClient.activityList({ page: 0, size: 200 });
            if (!resp.ok) return;
            select.innerHTML = (resp.list || []).map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.automationName)} · ${fmtDateTime(r.started)}</option>`).join('');
        }

        async renderExecucao360(activityId) {
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
                document.getElementById('aa360Select').addEventListener('change', ev => this.renderExecucao360(ev.target.value));
            }
            await this._ensure360Options();
            const select = document.getElementById('aa360Select');
            if (activityId) select.value = activityId; else activityId = select.value;
            if (!activityId) { document.getElementById('aa360Content').innerHTML = '<div class="empty-state">Selecione uma atividade.</div>'; return; }

            const detailResp = await this.apiClient.activityDetail(activityId);
            if (!detailResp.ok) { document.getElementById('aa360Content').innerHTML = this._errorState(detailResp); return; }
            const activity = detailResp.activity;
            const corr = this.correlationEngine.correlate(activity);
            const execRow = corr.execution;
            const events = execRow ? (window.OBS_DATA.eventsByExecution[execRow.executionId] || []) : [];
            const vmCtx = execRow ? (window.OBS_DATA.vmContextByExecution[execRow.executionId] || []) : [];
            const rpa = (DATA.rpas || []).find(r => r.id === activity.automationId);

            document.getElementById('aa360Content').innerHTML = `
                <div class="grid grid-2">
                    <article class="card">
                        <div class="card-header"><div><h2>Control Room</h2><p>Estado oficial reportado pela Automation Anywhere.</p></div></div>
                        <div class="card-body">
                            <div class="audit-evidence-list">
                                <div class="audit-evidence-row"><span>Status</span>${this._statusBadge(activity.status)}</div>
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
                ${this.connectionManager.capabilities.deploy === 'AVAILABLE' ? `
                <article class="card" style="margin-top:14px">
                    <div class="card-header"><div><h2>Ações</h2><p>Disponível porque a capability Bot Deploy está autorizada nesta Control Room.</p></div></div>
                    <div class="card-body"><button class="aa-btn danger" id="aa360RerunBtn">Reexecutar esta automação</button></div>
                </article>` : ''}
            `;
            document.getElementById('aa360RerunBtn')?.addEventListener('click', () => this.actionsController.runOrRerun(activity, activity.automationName));
        }

        /* ---- 4. Schedules ------------------------------------------------------ */
        async renderSchedules() {
            const body = document.getElementById('aaSchedulesBody');
            if (!body) return;
            const resp = await this.apiClient.proxy('GET', '/v2/schedule/rules/list');
            if (!resp.ok) { body.innerHTML = this._errorState(resp); return; }
            const aaSchedules = resp.data?.list || [];
            const schedulerAvailable = this.connectionManager.capabilities.scheduler === 'AVAILABLE';
            const rows = (DATA.rpas || []).map(rpa => {
                const aa = aaSchedules.filter(s => s.automationId === rpa.id);
                const localTimes = rpa.schedule || [];
                let statusLabel = 'SEM REGRA LOCAL';
                if (aa.length && localTimes.length) {
                    const matches = aa.filter(a => localTimes.includes(a.scheduledTime)).length;
                    statusLabel = matches === aa.length && matches === localTimes.length ? 'ALINHADO' : 'DIVERGENTE';
                } else if (!aa.length && localTimes.length) {
                    statusLabel = 'SEM SCHEDULE AA';
                }
                const cls = { ALINHADO: 'success', DIVERGENTE: 'warning', 'SEM SCHEDULE AA': 'neutral', 'SEM REGRA LOCAL': 'neutral' }[statusLabel] || 'neutral';
                const actionCell = (schedulerAvailable && aa.length)
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
                btn.addEventListener('click', () => this.actionsController.toggleSchedule(btn.dataset.aaScheduleId, btn.dataset.aaRpaName, true, () => this.renderSchedules()));
            });
        }

        /* ---- 5. Runners & Devices ----------------------------------------------- */
        async renderDevices() {
            const body = document.getElementById('aaDevicesBody');
            if (!body) return;
            const resp = await this.apiClient.proxy('GET', '/v2/devices/list');
            if (!resp.ok) { body.innerHTML = this._errorState(resp); return; }
            const devices = resp.data?.list || [];
            const util = DATA.vmUtilization || [];
            const rel = DATA.vmReliability || [];
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

        /* ---- 6. Workload (WLM) ---------------------------------------------------- */
        async renderWorkload() {
            const body = document.getElementById('aaWorkloadBody');
            if (!body) return;
            const resp = await this.apiClient.proxy('GET', '/v2/wlm/queues');
            body.innerHTML = resp.ok ? this._wlmQueuesHtml(resp.data?.list || []) : this._errorState(resp);
        }
        _wlmQueuesHtml(rows) {
            if (!rows.length) return '<article class="card"><div class="card-body"><div class="empty-state">Sem filas retornadas pelo WLM.</div></div></article>';
            return `<article class="card"><div class="card-body">${rows.map(q => `<div class="metric-row"><span>${escapeHtml(q.name)}</span><strong>${q.backlog}</strong></div>`).join('')}</div></article>`;
        }

        /* ---- 7. Mudanças & Audit ---------------------------------------------------- */
        async renderAuditPage() {
            const body = document.getElementById('aaAuditBody');
            if (!body) return;
            const resp = await this.apiClient.proxy('GET', '/v2/audit/logs');
            if (!resp.ok) { body.innerHTML = this._errorState(resp); return; }
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

        /* ---- 8. Dependências ----------------------------------------------------- */
        async renderDependencies() {
            const body = document.getElementById('aaDependenciesBody');
            if (!body) return;
            const resp = await this.apiClient.proxy('GET', '/v2/packages/list');
            if (!resp.ok) { body.innerHTML = this._errorState(resp); return; }
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

        /* ---- 9. Qualidade / Policy -------------------------------------------------- */
        async renderPolicy() {
            const body = document.getElementById('aaPolicyBody');
            if (!body) return;
            const resp = await this.apiClient.proxy('GET', '/v3/policies');
            body.innerHTML = resp.ok ? this._jsonPreviewHtml(resp.data) : this._errorState(resp);
        }
        _jsonPreviewHtml(data) {
            return `<article class="card"><div class="card-body"><pre class="mono" style="white-space:pre-wrap">${escapeHtml(JSON.stringify(data, null, 2))}</pre></div></article>`;
        }

        /* ---- 10. Analytics (ACC/BotInsight) ------------------------------------------ */
        async renderAnalytics() {
            const body = document.getElementById('aaAnalyticsBody');
            if (!body) return;
            const resp = await this.apiClient.proxy('GET', '/v2/acc/summary');
            body.innerHTML = resp.ok ? this._jsonPreviewHtml(resp.data) : this._errorState(resp);
        }

        /* ---- helpers de apresentação compartilhados pelas páginas ------------------- */
        _kpiCard(label, value, icon, cls) {
            return `<article class="card kpi-card"><div class="kpi-top"><div><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${value}</div></div><div class="kpi-icon ${cls}"><svg class="icon"><use href="#${icon}"></use></svg></div></div></article>`;
        }
        _statusBadge(status) {
            const cls = { COMPLETED: 'success', RUN_FAILED: 'danger', FAILED: 'danger', RUNNING: 'info', QUEUED: 'warning' }[status] || 'neutral';
            return `<span class="badge ${cls}">${escapeHtml(status || '—')}</span>`;
        }
        _errorState(resp) {
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
    }

    /* =========================================================================
       AutomationAnywhereApp — ponto único de montagem. Constrói as classes
       acima na ordem certa (as que têm dependência recebem a instância já
       pronta), liga o observer de navegação e a exportação de PDF, e expõe
       uma superfície mínima em window.AA para depuração manual — nunca
       expõe o conteúdo de AASecretVault.
       ========================================================================= */
    class AutomationAnywhereApp {
        constructor() {
            this.secrets = new AASecretVault();
            this.config = new AAConfigStore();
            this.telemetry = new AATelemetryRecorder();
            this.cache = new AACacheStore();
            this.auditTrail = new AAAuditTrail();
            this.apiClient = new AAApiClient(this.secrets, this.config, this.telemetry, this.cache);
            this.connectionManager = new AAConnectionManager(this.secrets, this.config, this.apiClient, this.telemetry);
            this.correlationEngine = new AACorrelationEngine();
            this.actionsController = new AAActionsController(this.apiClient, this.auditTrail, this.connectionManager);
            this.pagesController = new AAPagesController(this.apiClient, this.correlationEngine, this.connectionManager, this.actionsController, this.auditTrail);
            this.modalView = new AAModalView(this.connectionManager, this.config);
            this.headerButtonView = new AAHeaderButtonView(this.connectionManager, this.modalView);
            this.navigationView = new AANavigationView(this.connectionManager, this.pagesController);

            // Ao desconectar de uma página do workspace AA, volta ao dashboard
            // original — nunca deixa a tela em branco.
            this.connectionManager.addEventListener('disconnected', () => {
                if (document.querySelector('.page.active')?.id.startsWith('page-aa-')) goToPage('overview');
                showToast('Automation Anywhere desconectado. Chave e token descartados.');
            });
        }

        start() {
            this.config.loadDefaults();
            this.headerButtonView.mount();
            this._hookPageObserver();
            this._hookPdfExport();
        }

        /** goToPage() do dashboard original só alterna a classe .active nas
         * <section class="page">; este observer decide quando (e o quê)
         * buscar dados para a página AA que acabou de ficar visível. */
        _hookPageObserver() {
            const target = document.querySelector('main.content');
            if (!target) return;
            const observer = new MutationObserver(() => {
                const active = document.querySelector('.page.active');
                if (!active) return;
                this.pagesController.renderActivePage(active.id.replace('page-', ''));
            });
            observer.observe(target, { attributes: true, attributeFilter: ['class'], subtree: true });
        }

        /** Exportação PDF das páginas novas — nunca inclui API Key, token ou
         * headers; reaproveita o CSS de impressão já usado pelas telas
         * avulsas do dashboard (observability.css). */
        _hookPdfExport() {
            document.addEventListener('click', ev => {
                const btn = ev.target.closest('[data-aa-export]');
                if (!btn) return;
                const page = document.getElementById('page-' + btn.dataset.aaExport);
                if (!page) return;
                const printWindow = window.open('', '_blank');
                if (!printWindow) { showToast('O navegador bloqueou a janela de exportação — permita pop-ups para este site e tente novamente.'); return; }
                printWindow.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(page.querySelector('h1')?.textContent || 'Automation Anywhere')}</title>
                    <link rel="stylesheet" href="/assets/observability.css"></head><body class="page" style="padding:24px">${page.innerHTML}</body></html>`);
                printWindow.document.close();
                setTimeout(() => printWindow.print(), 300);
            });
        }

        /** Superfície de depuração manual — nunca expõe secrets. */
        debugSurface() {
            return {
                getState: () => ({
                    connection: this.connectionManager.connection,
                    capabilities: { ...this.connectionManager.capabilities },
                    session: { ...this.connectionManager.session },
                }),
                disconnect: () => this.connectionManager.disconnect(),
                _debugForceCapability: (name, value) => {
                    this.connectionManager.capabilities[name] = value;
                    this.navigationView._render();
                },
            };
        }
    }

    const app = new AutomationAnywhereApp();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => app.start());
    else app.start();

    window.AA = app.debugSurface();
})();
