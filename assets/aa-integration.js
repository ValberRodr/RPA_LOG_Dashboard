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
        botInsight: 'BotInsight', deploy: 'Bot Deploy', users: 'Users',
    };

    /** Quais páginas novas dependem de qual capability (Seção 5/7 do pedido). */
    const AA_NAV_ITEMS = [
        { page: 'aa-control-room', label: 'Control Room', icon: 'i-server', capability: 'activity' },
        { page: 'aa-fleet', label: 'Parque de RPAs 360°', icon: 'i-grid', capability: 'activity' },
        { page: 'aa-activity', label: 'Execuções AA', icon: 'i-activity', capability: 'activity', badgeId: 'aaExecErrorCount' },
        { page: 'aa-360', label: 'Execução 360°', icon: 'i-diagnostic', capability: 'activity' },
        { page: 'aa-schedules', label: 'Schedules', icon: 'i-clock', capability: 'scheduler' },
        { page: 'aa-devices', label: 'Runners & Devices', icon: 'i-monitor', capability: 'devices' },
        { page: 'aa-workload', label: 'Workload', icon: 'i-box', capability: 'wlm' },
        { page: 'aa-users', label: 'Usuários & Sessões', icon: 'i-users', capability: 'users' },
        { page: 'aa-audit', label: 'Mudanças & Audit', icon: 'i-alert', capability: 'audit' },
        { page: 'aa-dependencies', label: 'Dependências', icon: 'i-box', capability: 'repository' },
        { page: 'aa-policy', label: 'Qualidade / Policy', icon: 'i-check', capability: 'policy' },
        { page: 'aa-analytics', label: 'Analytics', icon: 'i-grid', capability: 'acc' },
    ];

    /* =========================================================================
       AASecretVault — o único lugar do módulo que toca API Key/token.

       O TOKEN (nunca a API Key) fica também em sessionStorage — decisão de
       risco aceita (2026-09-29, a pedido explícito do responsável do
       projeto: "manter a sessão logada até o app ser fechado") — ver
       SECURITY.md/THREAT_MODEL.md para o registro completo. sessionStorage
       é isolado por aba e some ao fechar a aba/navegador (nunca sobrevive
       num arquivo em disco), então continua não sendo "persistência" no
       sentido de sobreviver ao fechamento do app — só ao F5/navegação
       dentro da mesma aba, que antes desconectava. A API Key em si (o
       segredo de vida mais longa) nunca é persistida, só o token derivado
       dela — quem só tiver acesso ao sessionStorage não consegue emitir um
       novo token depois que este expirar. Ver AAConnectionManager.
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
            // X-CSRF-Token: exigido pelo servidor em toda rota POST que muda
            // estado (server.py, Handler._csrf_token_is_valid) — sem isso,
            // um site malicioso aberto noutra aba conseguiria acionar
            // qualquer ação da integração AA (reexecutar bot, mexer em
            // schedule) só fazendo o navegador da vítima mandar a
            // requisição. getCsrfToken() é definida em dashboard-app.js e
            // lida por nome aqui (mesmo padrão de escopo compartilhado do
            // resto deste arquivo).
            const headers = {
                'X-AA-Base-Url': this.config.baseUrl, 'X-AA-Token': this.secrets.getToken(),
                'X-CSRF-Token': await getCsrfToken(),
            };
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

        /** Pagina a Activity List além da primeira página (200 itens), até
         * `maxPages`, ignorando cache (sempre dado fresco — é usado tanto
         * pelo scan de cadastro quanto pelos gráficos históricos, os dois
         * casos em que "página 1 de 200" não é histórico suficiente).
         * Nunca busca ilimitado: uma Control Room real pode ter meses de
         * atividade, então o teto (`maxPages * pageSize`) é sempre explícito
         * — best effort, não o histórico completo. `onProgress(pct, fetched,
         * total)` é opcional, chamado a cada página. */
        async fetchActivityHistory(maxPages, pageSize, onProgress) {
            const rows = [];
            let total = Infinity;
            for (let page = 0; page < maxPages; page++) {
                const resp = await this.activityList({ page, size: pageSize }, { skipCache: true });
                if (!resp.ok) break;
                const cap = maxPages * pageSize;
                total = Math.min(resp.total ?? cap, cap);
                rows.push(...(resp.list || []));
                const fetched = Math.min((page + 1) * pageSize, total);
                if (onProgress) onProgress(total ? Math.min(100, Math.round(fetched / total * 100)) : 100, fetched, total);
                if (!resp.list || resp.list.length < pageSize || fetched >= total) break;
            }
            return rows;
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
        /** Chave de sessionStorage onde {baseUrl, username, token, mock} fica
         * guardado enquanto conectado — ver docstring de AASecretVault. */
        static SESSION_STORAGE_KEY = 'aa_session_v1';

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
                    this._clearPersistedSession();
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
            this.secrets.set(apiKey, authResp.token); // a API Key não é persistida, só o token (ver AASecretVault)
            this.config.username = this.config.username || authResp.username || '';
            this.telemetry.recordAuth();
            this.session = {
                controlRoom: authResp.controlRoom || this.config.baseUrl || 'Control Room',
                username: this.config.username,
                connectedAt: this.telemetry.authAt,
                lastSync: null, nextSync: null,
                mock: !!authResp.mock,
            };
            this._persistSession(authResp.token, authResp.mock);

            await this._afterAuthenticated();
            return { ok: true };
        }

        /** Tenta retomar uma sessão salva em sessionStorage (mesma aba, F5 ou
         * navegação) sem pedir a API Key de novo — chamado uma vez no boot do
         * app. Nunca falha "alto": se não houver sessão salva ou o token não
         * for mais válido, a chamada de Activity dentro de
         * `_afterAuthenticated` volta SESSION_EXPIRED (tratado pelo callback
         * `onSessionExpired` do construtor, que já limpa o storage e ajusta o
         * estado) — o usuário só vê o botão de reconectar, nunca um erro. */
        async tryRestoreSession() {
            let saved = null;
            try { saved = JSON.parse(sessionStorage.getItem(AAConnectionManager.SESSION_STORAGE_KEY) || 'null'); }
            catch (exc) { saved = null; }
            if (!saved || !saved.token) return;

            this.config.update(saved.baseUrl, saved.username);
            this.secrets.set(null, saved.token);
            this.checklist = [];
            this._setConnection('CONNECTING');
            this.session = {
                controlRoom: saved.mock ? 'MOCK · ambiente de simulação local' : (saved.baseUrl || 'Control Room'),
                username: saved.username || '', connectedAt: null, lastSync: null, nextSync: null,
                mock: !!saved.mock,
            };
            await this._afterAuthenticated();
        }

        /** Parte comum entre `connect()` (API Key nova) e `tryRestoreSession()`
         * (token já em sessionStorage): probe de Activity + discovery de
         * capacidades + entrar em CONNECTED/CONNECTED_PARTIAL. Não sobrescreve
         * SESSION_EXPIRED — se o token salvo já não vale mais, o próprio probe
         * de Activity dispara `onSessionExpired` (ver `apiClient.onSessionExpired`
         * no construtor) antes deste método terminar. */
        async _afterAuthenticated() {
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

            if (this.connection === 'SESSION_EXPIRED') return;
            this._setConnection(this.availableCount === this.totalCapabilities ? 'CONNECTED' : 'CONNECTED_PARTIAL');
            this._scheduleSync();
            this._startAutoRefresh();
            this._emit('connected', { capabilities: this.capabilities });
        }

        _persistSession(token, mock) {
            try {
                sessionStorage.setItem(AAConnectionManager.SESSION_STORAGE_KEY, JSON.stringify({
                    baseUrl: this.config.baseUrl, username: this.config.username, token, mock: !!mock,
                }));
            } catch (exc) { /* sessionStorage indisponível (ex.: modo privado restrito) — sessão cai de novo ao recarregar, como antes desta mudança */ }
        }

        _clearPersistedSession() {
            try { sessionStorage.removeItem(AAConnectionManager.SESSION_STORAGE_KEY); } catch (exc) { /* ignorado */ }
        }

        disconnect() {
            this._stopAutoRefresh();
            this.secrets.clear();
            this._clearPersistedSession();
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
                // Mesmo padrão visual do badge vermelho de "Alertas"/"Falhas
                // e incidentes" do dashboard original (.nav-link .count, CSS
                // já global em index.html) — reaproveitado aqui, não duplicado.
                const badge = item.badgeId ? `<span class="count" id="${item.badgeId}">0</span>` : '';
                btn.innerHTML = `<svg class="icon"><use href="#${item.icon}"></use></svg><span>${item.label}</span>${badge}`;
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
            // Notificação nativa de novas falhas (RUN_FAILED/FAILED) da
            // Control Room — checada tanto ao conectar (cobre "app acabou de
            // abrir" quando a sessão é restaurada via sessionStorage) quanto
            // a cada ciclo do auto-refresh próprio da integração (5 min,
            // AA_REFRESH_MS), nunca só quando o usuário está olhando uma
            // página específica da AA.
            connectionManager.addEventListener('connected', () => this._checkForNewFailures());
            connectionManager.addEventListener('refreshed', () => this._checkForNewFailures());
        }

        /** Busca uma janela de atividades independente de qual página AA
         * está visível (o próprio badge do menu "Execuções AA" e a
         * notificação de novas falhas precisam funcionar em segundo plano),
         * atualiza o badge do menu e notifica só as falhas realmente novas
         * desde a última checagem (`RpaNotificationCenter.notifyNewBatch`
         * cuida do "não notificar a mesma falha de novo"). */
        async _checkForNewFailures() {
            const resp = await this.apiClient.activityList({ page: 0, size: 100 }, { skipCache: true });
            if (!resp.ok) return;
            const rows = resp.list || [];
            this._updateActivityErrorBadge(rows);
            if (!window.RpaNotificationCenter || !RpaNotificationCenter.isEnabled()) return;
            const failed = rows.filter(r => r.status === 'RUN_FAILED' || r.status === 'FAILED');
            RpaNotificationCenter.notifyNewBatch(
                'aa-failures', failed, r => r.id, r => r.automationName,
                { severity: 'critical', label: 'nova(s) falha(s) na Automation Anywhere', tag: 'rpa-aa-failures' },
            );
        }

        /* ---- injeção das seções ------------------------------------------- */
        ensurePages() {
            const main = document.querySelector('main.content');
            if (!main || document.getElementById('page-aa-control-room')) return;
            const shells = [
                this._pageShell('aa-control-room', 'CONTROL ROOM', 'Visão consolidada', 'O que está executando, em fila, falhando ou fora do baseline agora — direto da Control Room.', 'aaControlRoomBody'),
                this._pageShell('aa-fleet', 'AUTOMATION ANYWHERE', 'Parque de RPAs 360°', 'Cada RPA cadastrada × histórico local × Activity List da Control Room — VMs usadas, agenda e RPAs sem log num só lugar.', 'aaFleetBody'),
                this._pageShell('aa-activity', 'AUTOMATION ANYWHERE', 'Execuções AA', 'Activity List oficial da Control Room, com nível de correlação com os logs locais.', 'aaActivityBody'),
                this._pageShell('aa-360', 'AUTOMATION ANYWHERE', 'Execução 360°', 'Consolida Control Room, logs locais e telemetria de VM para uma execução — não substitui Auditoria/Investigação/Diagnóstico.', 'aa360Body'),
                this._pageShell('aa-schedules', 'AUTOMATION ANYWHERE', 'Schedules', 'Schedule da Control Room × agenda local × execução realizada.', 'aaSchedulesBody'),
                this._pageShell('aa-devices', 'AUTOMATION ANYWHERE', 'Runners & Devices', 'Devices da Control Room combinados com a telemetria local de VM.', 'aaDevicesBody'),
                this._pageShell('aa-workload', 'AUTOMATION ANYWHERE', 'Workload', 'Filas, backlog e itens de trabalho do Workload Management, quando disponível.', 'aaWorkloadBody'),
                this._pageShell('aa-users', 'AUTOMATION ANYWHERE', 'Usuários & Sessões', 'Usuários cadastrados na Control Room e o que está rodando agora, por device/automação.', 'aaUsersBody'),
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
                'aa-fleet': () => this.renderFleet(),
                'aa-activity': () => this.renderActivityList(),
                'aa-360': () => this.renderExecucao360(),
                'aa-schedules': () => this.renderSchedules(),
                'aa-devices': () => this.renderDevices(),
                'aa-workload': () => this.renderWorkload(),
                'aa-users': () => this.renderUsers(),
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
            this._updateActivityErrorBadge(rows);
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
                ${this._historyPanel()}
                ${this._auditTrailPanel()}
                ${this._technicalPanel()}
            `;
            document.getElementById('aaHistoryDepth').addEventListener('change', ev => this._loadHistoryCharts(Number(ev.target.value)));
            this._loadHistoryCharts(this._historyPages || 1);
        }

        /* ---- Histórico consolidado (gráficos, Seção pedida em 2026-09-29:
           "enriquecer o monitoramento via Automation Anywhere, carregando mais
           dados históricos com mais gráficos") -------------------------------
           A Activity List de uma página só (200 itens) raramente cobre mais
           que algumas horas numa Control Room ativa — pouco para um gráfico
           de TENDÊNCIA por dia. `AAApiClient.fetchActivityHistory` pagina de
           verdade (até o teto escolhido aqui) para dar uma janela honesta.
           Nunca automático além de 200 (1 página): mais que isso é uma
           decisão explícita do usuário via `#aaHistoryDepth`, para não
           martelar uma Control Room real com várias páginas a cada visita a
           esta tela. */
        _historyPanel() {
            return `
                <article class="card" style="margin-top:14px">
                    <div class="card-header">
                        <div><h2>Histórico consolidado da Control Room</h2><p>Tendência diária e automações mais executadas — quanto mais atividades carregadas, mais confiável a leitura.</p></div>
                        <select class="select-control" id="aaHistoryDepth" aria-label="Quantidade de histórico a carregar">
                            <option value="1">Últimas 200 atividades</option>
                            <option value="5">Últimas 1.000 atividades</option>
                            <option value="10">Últimas 2.000 atividades</option>
                        </select>
                    </div>
                    <div class="card-body">
                        <div id="aaHistoryProgress" style="display:none; margin-bottom:14px">
                            <div class="progress-track"><div class="progress-fill" id="aaHistoryProgressFill" style="width:0%"></div></div>
                            <div class="cell-subtitle" style="margin-top:6px" id="aaHistoryProgressLabel"></div>
                        </div>
                        <div class="grid grid-2">
                            <div>
                                <div class="cell-subtitle" style="margin-bottom:8px">Execuções por dia, por status</div>
                                <div class="chart-canvas-wrap" style="height:220px"><canvas id="aaExecPerDayChart"></canvas></div>
                            </div>
                            <div>
                                <div class="cell-subtitle" style="margin-bottom:8px">Duração média por dia</div>
                                <div class="chart-canvas-wrap" style="height:220px"><canvas id="aaAvgDurationChart"></canvas></div>
                            </div>
                        </div>
                        <div style="margin-top:20px">
                            <div class="cell-subtitle" style="margin-bottom:8px">Top automações por volume no período carregado</div>
                            <div class="chart-canvas-wrap" style="height:280px"><canvas id="aaTopAutomationsChart"></canvas></div>
                        </div>
                        <div class="cell-subtitle" id="aaHistoryMeta" style="margin-top:10px"></div>
                    </div>
                </article>`;
        }

        /** Chart.js fixa cores na criação (mesma observação já feita para os
         * gráficos do dashboard original, ver `ChartService.redrawThemedCharts`
         * em dashboard-app.js) — redesenha com a paleta atual sem refazer a
         * chamada de rede, usando as linhas já carregadas. Não-op se o
         * usuário nunca visitou o Control Room nesta sessão (nada em cache). */
        redrawHistoryChartsForTheme() {
            if (!this._historyRows || !document.getElementById('aaExecPerDayChart')) return;
            this._renderExecPerDayChart(this._historyRows);
            this._renderAvgDurationChart(this._historyRows);
            this._renderTopAutomationsChart(this._historyRows);
        }

        async _loadHistoryCharts(pages) {
            this._historyPages = pages;
            const progress = document.getElementById('aaHistoryProgress');
            const fill = document.getElementById('aaHistoryProgressFill');
            const label = document.getElementById('aaHistoryProgressLabel');
            if (!progress) return;
            progress.style.display = pages > 1 ? '' : 'none';
            const rows = await this.apiClient.fetchActivityHistory(pages, 200, (pct, fetched, total) => {
                if (fill) fill.style.width = pct + '%';
                if (label) label.textContent = `Carregando histórico… ${pct}% (${fetched}${Number.isFinite(total) ? '/' + total : ''} atividades)`;
            });
            progress.style.display = 'none';
            this._historyRows = rows;
            this._renderExecPerDayChart(rows);
            this._renderAvgDurationChart(rows);
            this._renderTopAutomationsChart(rows);
            const meta = document.getElementById('aaHistoryMeta');
            if (meta) {
                const days = new Set(rows.filter(r => r.started).map(r => r.started.slice(0, 10))).size;
                meta.textContent = `${rows.length} atividade(s) carregada(s), cobrindo ${days} dia(s) distinto(s).`;
            }
        }

        /** Status ↔ cor reservada — mesmo mapeamento de `_statusBadge`, nunca
         * cores diferentes para o mesmo estado em lugares diferentes da UI. */
        static STATUS_CHART_COLORS(p) {
            return { COMPLETED: p.success, RUN_FAILED: p.danger, FAILED: p.danger, RUNNING: p.info, QUEUED: p.warning, DEPLOYED: p.info };
        }

        _bucketByDay(rows) {
            const byDay = new Map();
            rows.forEach(r => {
                if (!r.started) return;
                const day = r.started.slice(0, 10);
                if (!byDay.has(day)) byDay.set(day, []);
                byDay.get(day).push(r);
            });
            return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        }

        _renderExecPerDayChart(rows) {
            const p = ChartService.chartPalette();
            const colors = AAPagesController.STATUS_CHART_COLORS(p);
            const days = this._bucketByDay(rows);
            const statuses = ['COMPLETED', 'RUNNING', 'QUEUED', 'RUN_FAILED', 'FAILED'].filter(s => days.some(([, items]) => items.some(r => r.status === s)));
            ChartService.drawChart('aaExecPerDayChart', {
                type: 'bar',
                data: {
                    labels: days.map(([day]) => day.slice(5)),
                    datasets: statuses.map(status => ({
                        label: status, data: days.map(([, items]) => items.filter(r => r.status === status).length),
                        backgroundColor: colors[status] || p.textMuted, borderRadius: 3, maxBarThickness: 22, stack: 'total',
                    })),
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: statuses.length > 1, position: 'top', align: 'end', labels: { boxWidth: 10, usePointStyle: true, color: p.textMuted, font: { size: 10.5 } } },
                        tooltip: ChartService.tooltipBase(p),
                    },
                    scales: {
                        y: { beginAtZero: true, ticks: { color: p.textMuted, precision: 0 }, grid: { color: p.grid }, stacked: true },
                        x: { ticks: { color: p.textMuted, maxRotation: 0 }, grid: { display: false }, stacked: true },
                    },
                },
            });
        }

        _renderAvgDurationChart(rows) {
            const p = ChartService.chartPalette();
            const days = this._bucketByDay(rows);
            const avgMin = items => items.reduce((a, r) => a + (r.durationMs || 0), 0) / items.length / 60000;
            ChartService.drawChart('aaAvgDurationChart', {
                type: 'line',
                data: {
                    labels: days.map(([day]) => day.slice(5)),
                    datasets: [{
                        label: 'Duração média', data: days.map(([, items]) => Number(avgMin(items).toFixed(1))),
                        borderColor: p.primary, backgroundColor: p.primary + '26', fill: true, tension: .3,
                        pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: p.primary, pointBorderColor: p.panel, pointBorderWidth: 1.5,
                    }],
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: { ...ChartService.tooltipBase(p), callbacks: { label: ctx => `${ctx.parsed.y} min` } } },
                    scales: {
                        y: { beginAtZero: true, ticks: { color: p.textMuted, callback: v => v + ' min' }, grid: { color: p.grid } },
                        x: { ticks: { color: p.textMuted, maxRotation: 0 }, grid: { display: false } },
                    },
                },
            });
        }

        _renderTopAutomationsChart(rows) {
            const p = ChartService.chartPalette();
            const counts = new Map();
            rows.forEach(r => { const name = r.automationName || '—'; counts.set(name, (counts.get(name) || 0) + 1); });
            const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
            ChartService.drawChart('aaTopAutomationsChart', {
                type: 'bar',
                data: {
                    labels: top.map(([name]) => name),
                    datasets: [{ label: 'Execuções', data: top.map(([, count]) => count), backgroundColor: p.primary, borderRadius: 3, maxBarThickness: 18 }],
                },
                options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: ChartService.tooltipBase(p) },
                    scales: {
                        x: { beginAtZero: true, ticks: { color: p.textMuted, precision: 0 }, grid: { color: p.grid } },
                        y: { ticks: { color: p.textMuted, font: { size: 10.5 } }, grid: { display: false } },
                    },
                },
            });
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
                        <div class="table-wrap"><table><thead><tr><th>Automação</th><th>Status</th><th>Início</th><th>Fim</th><th>Duração</th><th>Device</th><th>Correlação</th><th>Detalhes</th></tr></thead><tbody id="aaActivityTableBody"></tbody></table></div>
                        <div class="card-body" id="aaActivityCount" style="color:var(--text-3);font-size:11px"></div>
                    </article>`;
                document.getElementById('aaActivityStatusFilter').addEventListener('change', () => this._paintActivityRows());
                document.getElementById('aaActivitySearch').addEventListener('input', () => this._paintActivityRows());
            }
            const resp = await this.apiClient.activityList({ page: 0, size: 300 });
            if (!resp.ok) { document.getElementById('aaActivityTableBody').innerHTML = `<tr><td colspan="8">${this._errorState(resp)}</td></tr>`; return; }
            this._activityCacheRows = resp.list || [];
            this._updateActivityErrorBadge(this._activityCacheRows);
            this._paintActivityRows();
        }

        /** Badge vermelho no item de menu "Execuções AA" (mesmo estilo de
         * "Alertas"/"Falhas e incidentes" do dashboard original) — contagem
         * de RUN_FAILED/FAILED na janela de atividades já carregada por
         * quem chamou (Control Room ou a própria Execuções AA), nunca uma
         * chamada de rede extra só para o badge. */
        _updateActivityErrorBadge(rows) {
            const badge = document.getElementById('aaExecErrorCount');
            if (badge) badge.textContent = rows.filter(r => r.status === 'RUN_FAILED' || r.status === 'FAILED').length;
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
                    <td><button class="btn" type="button" data-aa-open-detail="${escapeHtml(r.id)}">Ver detalhes</button></td>
                </tr>`;
            }).join('') || '<tr><td colspan="8" class="empty-state">Nenhuma atividade encontrada para o filtro.</td></tr>';
            const openDetail = activityId => {
                goToPage('aa-360');
                const select = document.getElementById('aa360Select');
                if (select) select.value = activityId;
                this.renderExecucao360(activityId);
            };
            $$('#aaActivityTableBody tr[data-aa-activity-id]').forEach(tr => {
                tr.addEventListener('click', () => openDetail(tr.dataset.aaActivityId));
            });
            $$('#aaActivityTableBody [data-aa-open-detail]').forEach(btn => {
                btn.addEventListener('click', ev => { ev.stopPropagation(); openDetail(btn.dataset.aaOpenDetail); });
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
            if (!resp.ok) { body.innerHTML = this._errorState(resp); return; }
            this._wlmQueues = resp.data?.list || [];
            body.innerHTML = this._wlmQueuesHtml(this._wlmQueues);
            $$('[data-aa-queue-id]', body).forEach(row => {
                row.addEventListener('click', () => this._renderQueueItems(row.dataset.aaQueueId, row.dataset.aaQueueName));
            });
        }
        _wlmQueuesHtml(rows) {
            if (!rows.length) return '<article class="card"><div class="card-body"><div class="empty-state">Sem filas retornadas pelo WLM.</div></div></article>';
            return `
                <article class="card">
                    <div class="card-header"><div><h2>Filas</h2><p>Clique numa fila para ver os itens de trabalho (workitems).</p></div></div>
                    <div class="card-body">${rows.map(q => `
                        <div class="metric-row aa-clickable-row" data-aa-queue-id="${escapeHtml(q.id ?? q.queueId ?? q.name)}" data-aa-queue-name="${escapeHtml(q.name)}">
                            <span>${escapeHtml(q.name)}</span><strong>${q.backlog ?? '—'}</strong>
                        </div>`).join('')}
                    </div>
                </article>
                <article class="card" id="aaQueueItemsPanel" style="margin-top:14px"><div class="card-body"><div class="empty-state">Selecione uma fila acima para ver os itens.</div></div></article>`;
        }
        /** Itens de trabalho (workitems) de uma fila específica — POST
         * /v2/wlm/queues/{id}/workitems/list é a única "List API" do WLM que
         * exige o ID no caminho, por isso não passa pelo cache genérico do
         * mesmo jeito que uma rota fixa (a chave de cache já inclui o path
         * inteiro, então cada fila tem sua própria entrada — nenhuma
         * mudança extra necessária). */
        async _renderQueueItems(queueId, queueName) {
            const panel = document.getElementById('aaQueueItemsPanel');
            if (!panel) return;
            panel.innerHTML = '<div class="card-body"><div class="empty-state">Carregando itens…</div></div>';
            const resp = await this.apiClient.proxy('POST', `/v2/wlm/queues/${encodeURIComponent(queueId)}/workitems/list`, {
                sort: [{ field: 'createdDate', direction: 'desc' }], page: { offset: 0, length: 50 },
            });
            if (!resp.ok) { panel.innerHTML = `<div class="card-body">${this._errorState(resp)}</div>`; return; }
            const items = resp.data?.list || [];
            panel.innerHTML = `
                <div class="card-header"><div><h2>Itens de "${escapeHtml(queueName)}"</h2><p>${items.length} item(ns) mais recente(s) retornado(s) pelo WLM.</p></div></div>
                <div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Prioridade</th><th>Tentativas</th><th>Criado em</th></tr></thead>
                <tbody>${items.length ? items.map(it => `<tr>
                    <td class="mono">${escapeHtml(String(it.id ?? it.workItemId ?? '—'))}</td>
                    <td>${this._statusBadge(it.status)}</td>
                    <td>${escapeHtml(String(it.priority ?? '—'))}</td>
                    <td>${escapeHtml(String(it.retryCount ?? it.attempts ?? 0))}</td>
                    <td>${fmtDateTime(it.createdDate || it.created)}</td>
                </tr>`).join('') : '<tr><td colspan="5"><div class="empty-state">Sem itens nesta fila.</div></td></tr>'}</tbody></table></div>`;
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
            if (!resp.ok) { body.innerHTML = this._errorState(resp); return; }
            const rows = resp.data?.list || resp.data?.violations || (Array.isArray(resp.data) ? resp.data : null);
            if (!rows) { body.innerHTML = this._jsonPreviewHtml(resp.data); return; }
            const bySeverity = {};
            rows.forEach(r => { const sev = (r.severity || r.level || 'DESCONHECIDA').toUpperCase(); bySeverity[sev] = (bySeverity[sev] || 0) + 1; });
            const sevClass = { HIGH: 'danger', CRITICAL: 'danger', MEDIUM: 'warning', LOW: 'neutral' };
            body.innerHTML = `
                <div class="grid grid-kpis" style="grid-template-columns:repeat(${Math.max(2, Object.keys(bySeverity).length)},minmax(0,1fr))">
                    ${this._kpiCard('Total de violações', rows.length, 'i-check', rows.length ? 'warning' : 'success')}
                    ${Object.entries(bySeverity).map(([sev, count]) => this._kpiCard(sev, count, 'i-alert', sevClass[sev] || 'neutral')).join('')}
                </div>
                <article class="card" style="margin-top:14px">
                    <div class="card-header"><div><h2>Violações de Policy</h2><p>Resultado do último scan de Policy Management retornado pela Control Room.</p></div></div>
                    <div class="table-wrap"><table><thead><tr><th>Regra</th><th>Severidade</th><th>Automação</th><th>Detalhe</th></tr></thead>
                    <tbody>${rows.length ? rows.map(r => `<tr>
                        <td>${escapeHtml(r.policyName || r.ruleName || r.name || '—')}</td>
                        <td><span class="badge ${sevClass[(r.severity || r.level || '').toUpperCase()] || 'neutral'}">${escapeHtml(r.severity || r.level || '—')}</span></td>
                        <td>${escapeHtml(r.automationName || r.botName || '—')}</td>
                        <td>${escapeHtml(r.message || r.description || '—')}</td>
                    </tr>`).join('') : '<tr><td colspan="4"><div class="empty-state">Nenhuma violação retornada.</div></td></tr>'}</tbody></table></div>
                </article>`;
        }
        _jsonPreviewHtml(data) {
            return `<article class="card"><div class="card-header"><div><h2>Resposta bruta</h2><p>Formato não reconhecido pela integração — exibindo o JSON retornado pela Control Room para diagnóstico.</p></div></div><div class="card-body"><pre class="mono" style="white-space:pre-wrap">${escapeHtml(JSON.stringify(data, null, 2))}</pre></div></article>`;
        }

        /* ---- 10. Analytics (ACC/BotInsight) ------------------------------------------ */
        async renderAnalytics() {
            const body = document.getElementById('aaAnalyticsBody');
            if (!body) return;
            const resp = await this.apiClient.proxy('GET', '/v2/acc/summary');
            if (!resp.ok) { body.innerHTML = this._errorState(resp); return; }
            const data = resp.data && typeof resp.data === 'object' ? resp.data : {};
            const numericEntries = Object.entries(data).filter(([, v]) => typeof v === 'number');
            const listEntries = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object');
            if (!numericEntries.length && !listEntries.length) { body.innerHTML = this._jsonPreviewHtml(data); return; }
            const kpiIcons = ['i-activity', 'i-clock', 'i-box', 'i-check', 'i-alert', 'i-monitor'];
            body.innerHTML = `
                ${numericEntries.length ? `<div class="grid grid-kpis" style="grid-template-columns:repeat(${Math.min(4, numericEntries.length)},minmax(0,1fr))">
                    ${numericEntries.map(([label, value], i) => this._kpiCard(this._humanizeKey(label), value, kpiIcons[i % kpiIcons.length], 'info')).join('')}
                </div>` : ''}
                ${listEntries.map(([label, rows]) => {
                    const cols = Object.keys(rows[0]).slice(0, 6);
                    return `<article class="card" style="margin-top:14px">
                        <div class="card-header"><div><h2>${escapeHtml(this._humanizeKey(label))}</h2></div></div>
                        <div class="table-wrap"><table><thead><tr>${cols.map(c => `<th>${escapeHtml(this._humanizeKey(c))}</th>`).join('')}</tr></thead>
                        <tbody>${rows.slice(0, 30).map(r => `<tr>${cols.map(c => `<td>${escapeHtml(String(r[c] ?? '—'))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
                    </article>`;
                }).join('')}
            `;
        }
        _humanizeKey(key) {
            return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, c => c.toUpperCase());
        }

        /* ---- 11. Usuários & Sessões ---------------------------------------------- */
        async renderUsers() {
            const body = document.getElementById('aaUsersBody');
            if (!body) return;
            const [usersResp, activityResp, devicesResp] = await Promise.all([
                this.apiClient.proxy('POST', '/v1/usermanagement/users/list', { page: { offset: 0, length: 200 } }),
                this.apiClient.activityList({ page: 0, size: 200 }),
                this.apiClient.proxy('GET', '/v2/devices/list'),
            ]);
            if (!usersResp.ok) { body.innerHTML = this._errorState(usersResp); return; }
            const users = usersResp.data?.list || [];
            const runningActivities = (activityResp.ok ? activityResp.list || [] : []).filter(a => a.status === 'RUNNING' || a.status === 'DEPLOYED');
            const devicesById = Object.fromEntries((devicesResp.ok ? devicesResp.data?.list || [] : []).map(d => [String(d.id ?? d.hostName), d]));
            body.innerHTML = `
                <div class="grid grid-kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
                    ${this._kpiCard('Usuários na Control Room', users.length, 'i-users', 'info')}
                    ${this._kpiCard('Usuários desabilitados', users.filter(u => u.disabled).length, 'i-x', 'neutral')}
                    ${this._kpiCard('Sessões em execução agora', runningActivities.length, 'i-activity', runningActivities.length ? 'warning' : 'success')}
                </div>
                <article class="card" style="margin-top:14px">
                    <div class="card-header"><div><h2>Sessões ativas agora</h2><p>Derivado da Activity List (status RUNNING/DEPLOYED) cruzado com o inventário de devices — a Control Room não expõe uma API dedicada de "sessão ativa" por usuário.</p></div></div>
                    <div class="table-wrap"><table><thead><tr><th>Device</th><th>Pool</th><th>Automação</th><th>Início</th></tr></thead>
                    <tbody>${runningActivities.length ? runningActivities.map(a => {
                        const dev = devicesById[String(a.device)] || devicesById[String(a.runner)];
                        return `<tr><td class="mono">${escapeHtml(a.device || a.runner || '—')}</td><td>${escapeHtml(dev?.poolName || '—')}</td><td>${escapeHtml(a.automationName)}</td><td>${fmtDateTime(a.started)}</td></tr>`;
                    }).join('') : '<tr><td colspan="4"><div class="empty-state">Nenhuma execução em andamento agora.</div></td></tr>'}</tbody></table></div>
                </article>
                <article class="card" style="margin-top:14px">
                    <div class="card-header"><div><h2>Usuários cadastrados</h2><p>Search Users da Control Room — nunca exibe senha/token, só identidade e papel.</p></div></div>
                    <div class="table-wrap"><table><thead><tr><th>Usuário</th><th>Nome</th><th>E-mail</th><th>Papéis</th><th>Status</th></tr></thead>
                    <tbody>${users.length ? users.map(u => `<tr>
                        <td class="mono">${escapeHtml(u.username || '—')}</td>
                        <td>${escapeHtml([u.firstName, u.lastName].filter(Boolean).join(' ') || '—')}</td>
                        <td>${escapeHtml(u.email || '—')}</td>
                        <td>${escapeHtml((u.roles || []).join(', ') || '—')}</td>
                        <td><span class="badge ${u.disabled ? 'neutral' : 'success'}">${u.disabled ? 'DESABILITADO' : 'ATIVO'}</span></td>
                    </tr>`).join('') : '<tr><td colspan="5"><div class="empty-state">Nenhum usuário retornado.</div></td></tr>'}</tbody></table></div>
                </article>`;
        }

        /* ---- 12. Parque de RPAs 360° ----------------------------------------------- */
        async renderFleet() {
            const body = document.getElementById('aaFleetBody');
            if (!body) return;
            if (!body.dataset.mounted) {
                body.dataset.mounted = '1';
                body.innerHTML = `
                    <div class="grid" id="aaFleetKpis" style="grid-template-columns:repeat(4,minmax(0,1fr))"></div>
                    <div style="display:flex; gap:10px; align-items:center; margin:14px 0">
                        <input type="text" id="aaFleetSearch" placeholder="Buscar RPA…" style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--surface); color:var(--text)">
                        <label style="display:flex; align-items:center; gap:6px; white-space:nowrap; font-size:13px; color:var(--text-2)">
                            <input type="checkbox" id="aaFleetOnlyNoLogs"> Só RPAs sem logs
                        </label>
                    </div>
                    <div class="grid grid-2" id="aaFleetGrid"></div>`;
                document.getElementById('aaFleetSearch').addEventListener('input', () => this._paintFleet());
                document.getElementById('aaFleetOnlyNoLogs').addEventListener('change', () => this._paintFleet());
            }
            const [activityResp, schedResp] = await Promise.all([
                this.apiClient.activityList({ page: 0, size: 200 }),
                this.apiClient.proxy('GET', '/v2/schedule/rules/list'),
            ]);
            this._fleetActivities = activityResp.ok ? activityResp.list || [] : [];
            this._fleetAaSchedules = schedResp.ok ? schedResp.data?.list || [] : [];
            this._paintFleet();
        }
        _paintFleet() {
            const kpisEl = document.getElementById('aaFleetKpis');
            const gridEl = document.getElementById('aaFleetGrid');
            if (!kpisEl || !gridEl) return;
            const search = (document.getElementById('aaFleetSearch')?.value || '').toLowerCase();
            const onlyNoLogs = document.getElementById('aaFleetOnlyNoLogs')?.checked;
            const execs = (window.OBS_DATA && window.OBS_DATA.executions) || [];
            const rpas = DATA.rpas || [];
            const dependencyStatus = (window.OBS_DATA && window.OBS_DATA.dependencyStatus) || {};

            const entries = rpas.map(rpa => {
                const localExecs = execs.filter(e => e.rpaId === rpa.id);
                const aaMatches = this._fleetActivities.filter(a =>
                    a.automationId === rpa.id || String(a.automationName || '').toLowerCase() === String(rpa.name || '').toLowerCase());
                const vmsUsed = new Set([rpa.primaryVm, rpa.backupVm, ...localExecs.map(e => e.machine), ...aaMatches.map(a => a.device)].filter(Boolean));
                const aaSchedule = this._fleetAaSchedules.filter(s => s.automationId === rpa.id).map(s => s.scheduledTime);
                const failCount = localExecs.filter(e => e.status === 'ERROR').length;
                const deps = dependencyStatus[rpa.id] || [];
                const depsWithIssue = deps.filter(d => d.exists && d.signal === 'AUMENTOU').length;
                const lastRun = [...localExecs].sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
                return {
                    rpa, localCount: localExecs.length, aaCount: aaMatches.length, failCount,
                    vmsUsed: [...vmsUsed], schedule: rpa.schedule || [], aaSchedule, depsWithIssue,
                    lastRun, noLogs: localExecs.length === 0, foundInAA: aaMatches.length > 0,
                };
            });

            const totalNoLogs = entries.filter(e => e.noLogs).length;
            const totalNotInAA = entries.filter(e => !e.foundInAA).length;
            kpisEl.innerHTML = `
                ${this._kpiCard('RPAs cadastradas', rpas.length, 'i-grid', 'info')}
                ${this._kpiCard('Sem logs no período', totalNoLogs, 'i-alert', totalNoLogs ? 'warning' : 'success')}
                ${this._kpiCard('Não vistas na Control Room', totalNotInAA, 'i-x', totalNotInAA ? 'warning' : 'success')}
                ${this._kpiCard('Com falha recente', entries.filter(e => e.failCount > 0).length, 'i-triangle', 'neutral')}
            `;

            const filtered = entries.filter(e => {
                if (onlyNoLogs && !e.noLogs) return false;
                if (search && !e.rpa.name.toLowerCase().includes(search) && !e.rpa.process.toLowerCase().includes(search)) return false;
                return true;
            });

            gridEl.innerHTML = filtered.length ? filtered.map(e => `
                <article class="card aa-fleet-card">
                    <div class="card-header">
                        <div><h2>${escapeHtml(e.rpa.name)}</h2><p class="mono">${escapeHtml(e.rpa.process)}</p></div>
                        <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end">
                            ${e.noLogs ? '<span class="badge warning">SEM LOGS</span>' : ''}
                            ${e.foundInAA ? '<span class="badge success">NA CONTROL ROOM</span>' : '<span class="badge neutral">NÃO VISTA NA AA</span>'}
                        </div>
                    </div>
                    <div class="card-body">
                        <div class="audit-evidence-list">
                            <div class="audit-evidence-row"><span>Execuções locais (período)</span><span>${e.localCount} (${e.failCount} falha(s))</span></div>
                            <div class="audit-evidence-row"><span>Atividades na Control Room</span><span>${e.aaCount}</span></div>
                            <div class="audit-evidence-row"><span>Última execução local</span><span>${e.lastRun ? fmtDateTime(e.lastRun.start) : '—'}</span></div>
                            <div class="audit-evidence-row"><span>VMs usadas</span><span class="mono">${escapeHtml(e.vmsUsed.join(', ') || '—')}</span></div>
                            <div class="audit-evidence-row"><span>Agenda local</span><span>${escapeHtml(e.schedule.join(', ') || '—')}</span></div>
                            <div class="audit-evidence-row"><span>Agenda Control Room</span><span>${escapeHtml(e.aaSchedule.join(', ') || '—')}</span></div>
                            <div class="audit-evidence-row"><span>Dependências com sinal de piora</span><span>${e.depsWithIssue}</span></div>
                        </div>
                    </div>
                </article>`).join('') : '<article class="card"><div class="card-body"><div class="empty-state">Nenhuma RPA corresponde ao filtro atual.</div></div></article>';
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
       AARegistryScanExtension — injeta, na página "Cadastro de RPAs" (do
       dashboard ORIGINAL, não uma página AA), um botão extra para escanear
       automações conhecidas pela Automation Anywhere (via Activity List)
       sem entrada correspondente no cadastro local — complementa o scan já
       existente (#registryScanBtn), que só olha os logs locais.

       Paginação com barra de progresso (%): a Activity List de uma Control
       Room real pode ter um histórico grande, então o scan é limitado a
       MAX_PAGES*PAGE_SIZE atividades (best effort, não o histórico
       completo) — suficiente para achar automações que rodam com alguma
       frequência sem travar a UI numa varredura sem fim. ========================================================================= */
    class AARegistryScanExtension {
        static MAX_PAGES = 10;
        static PAGE_SIZE = 200;

        constructor(apiClient, connectionManager) {
            this.apiClient = apiClient;
            this.connectionManager = connectionManager;
            connectionManager.addEventListener('connected', () => this._mount());
            connectionManager.addEventListener('disconnected', () => this._unmount());
        }

        _mount() {
            const heading = document.querySelector('#page-registry .page-heading > div:last-child');
            if (!heading) return;
            if (!document.getElementById('aaRegistryScanBtn')) {
                const btn = document.createElement('button');
                btn.className = 'action-button';
                btn.id = 'aaRegistryScanBtn';
                btn.type = 'button';
                btn.title = 'Procurar, na Activity List da Automation Anywhere, automações sem processo correspondente no cadastro local';
                btn.innerHTML = '<svg class="icon"><use href="#i-server"></use></svg> Escanear no Automation Anywhere';
                heading.insertBefore(btn, heading.firstChild);
                btn.addEventListener('click', () => this._scan());
            }
            const anchor = document.getElementById('registryScanResults');
            if (anchor && !document.getElementById('aaRegistryScanPanel')) {
                const panel = document.createElement('article');
                panel.className = 'card';
                panel.id = 'aaRegistryScanPanel';
                panel.style.cssText = 'display:none; margin-bottom:14px';
                panel.innerHTML = `
                    <div class="card-header"><div><h2>RPAs encontradas na Automation Anywhere, ainda não cadastradas</h2><p>Automação com atividade recente na Control Room sem processo correspondente no cadastro local (busca por nome).</p></div></div>
                    <div class="card-body">
                        <div id="aaRegistryScanProgress" style="display:none; margin-bottom:12px">
                            <div class="progress-track"><div class="progress-fill" id="aaRegistryScanProgressFill" style="width:0%"></div></div>
                            <div style="font-size:11.5px; color:var(--text-2); margin-top:6px" id="aaRegistryScanProgressLabel"></div>
                        </div>
                        <div id="aaRegistryScanList"></div>
                    </div>`;
                anchor.insertAdjacentElement('afterend', panel);
            }
        }

        _unmount() {
            document.getElementById('aaRegistryScanBtn')?.remove();
            document.getElementById('aaRegistryScanPanel')?.remove();
        }

        async _scan() {
            const btn = document.getElementById('aaRegistryScanBtn');
            const panel = document.getElementById('aaRegistryScanPanel');
            const progress = document.getElementById('aaRegistryScanProgress');
            const fill = document.getElementById('aaRegistryScanProgressFill');
            const label = document.getElementById('aaRegistryScanProgressLabel');
            const list = document.getElementById('aaRegistryScanList');
            if (!panel || !btn) return;
            btn.disabled = true;
            panel.style.display = '';
            progress.style.display = '';
            fill.style.width = '0%';
            list.innerHTML = '';
            try {
                const found = await this._collectAaAutomations((pct, fetched, total) => {
                    fill.style.width = pct + '%';
                    label.textContent = `Consultando Activity List… ${pct}% (${fetched}${Number.isFinite(total) ? '/' + total : ''} atividade(s))`;
                });
                label.textContent = 'Cruzando com o cadastro local…';
                const known = new Set();
                (DATA.rpas || []).forEach(r => { known.add((r.name || '').toLowerCase()); known.add((r.process || '').toLowerCase()); });
                const candidates = [...found.values()].filter(c => !known.has(c.automationName.toLowerCase()));
                progress.style.display = 'none';
                this._renderCandidates(list, candidates);
            } catch (exc) {
                progress.style.display = 'none';
                list.innerHTML = '<div class="registry-error">Falha ao consultar a Activity List da Automation Anywhere.</div>';
            } finally {
                btn.disabled = false;
            }
        }

        /** Pagina a Activity List (via `AAApiClient.fetchActivityHistory`,
         * compartilhado com os gráficos históricos do Control Room) e guarda
         * só a atividade mais recente de cada automationName. */
        async _collectAaAutomations(onProgress) {
            const rows = await this.apiClient.fetchActivityHistory(AARegistryScanExtension.MAX_PAGES, AARegistryScanExtension.PAGE_SIZE, onProgress);
            const found = new Map();
            rows.forEach(a => {
                if (!a.automationName) return;
                const key = a.automationName.toLowerCase();
                const prev = found.get(key);
                if (!prev || Date.parse(a.started || 0) > Date.parse(prev.started || 0)) {
                    found.set(key, { automationName: a.automationName, automationId: a.automationId, device: a.device, started: a.started });
                }
            });
            return found;
        }

        _renderCandidates(list, candidates) {
            if (!candidates.length) {
                list.innerHTML = '<div class="empty-state">Nenhuma automação nova encontrada — toda automação vista na Activity List já está cadastrada.</div>';
                return;
            }
            list.innerHTML = candidates.map((c, i) => `
                <div class="registry-scan-item" data-aa-scan-index="${i}">
                    <div>
                        <span class="cell-title mono">${escapeHtml(c.automationName)}</span>
                        <span class="cell-subtitle">Vista pela última vez: ${fmtDateTime(c.started)} · Device ${escapeHtml(c.device || '—')}</span>
                    </div>
                    <button class="action-button primary" type="button" data-aa-scan-register="${i}">Cadastrar</button>
                </div>
            `).join('');
            list.querySelectorAll('[data-aa-scan-register]').forEach(button => {
                button.addEventListener('click', () => {
                    const c = candidates[Number(button.dataset.aaScanRegister)];
                    if (typeof RegistryPage !== 'undefined') {
                        RegistryPage.openForm(null, { process: c.automationName, primaryVm: c.device || '', orchestrator: 'Automation Anywhere 360', robotName: '' });
                    }
                });
            });
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
            this.registryScanExtension = new AARegistryScanExtension(this.apiClient, this.connectionManager);

            // Ao desconectar de uma página do workspace AA, volta ao dashboard
            // original — nunca deixa a tela em branco.
            this.connectionManager.addEventListener('disconnected', () => {
                if (document.querySelector('.page.active')?.id.startsWith('page-aa-')) goToPage('overview');
                showToast('Automation Anywhere desconectado. Chave e token descartados.');
            });
        }

        /** `await` em sequência (não em paralelo) de propósito:
         * `tryRestoreSession()` só deve rodar DEPOIS que `loadDefaults()`
         * terminar de popular `config.baseUrl`/`username` a partir do
         * servidor — senão, numa sessão restaurada, a resposta tardia de
         * `loadDefaults()` sobrescreveria o baseUrl da sessão já conectada
         * (usado em todo header `X-AA-Base-Url` daí em diante) por baixo. */
        async start() {
            await this.config.loadDefaults();
            await this.connectionManager.tryRestoreSession();
            this.headerButtonView.mount();
            this._hookPageObserver();
            this._hookPdfExport();
            // Listener PRÓPRIO no mesmo #themeButton do dashboard original —
            // nunca edita dashboard-app.js para isso (módulo aditivo, ver
            // comentário no topo do arquivo): os gráficos do histórico da AA
            // fixam cor na criação (Chart.js), então precisam de um redesenho
            // próprio ao trocar de tema, senão ficam com a paleta antiga até
            // a próxima visita à página.
            document.getElementById('themeButton')?.addEventListener('click', () => this.pagesController.redrawHistoryChartsForTheme());
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
