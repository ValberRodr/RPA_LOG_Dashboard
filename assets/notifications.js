/* ============================================================================
   RpaNotificationCenter — notificações nativas do SISTEMA OPERACIONAL quando
   o app abre ou atualiza (a cada 20 min no dashboard local; a cada 5 min na
   integração Automation Anywhere) e encontra um alerta/erro que ainda não
   tinha sido visto.

   Por que o backend dispara o toast, não a Web Notification API do
   navegador: essa API exige permissão por origem concedida por um clique
   real do usuário — e esse prompt é UI do próprio Chrome (fora da página),
   não dá pra conceder programaticamente nem verificar de fora. Decisão
   explícita do responsável do projeto (2026-09-29) depois de confirmar ao
   vivo que o prompt nunca aparecia de forma utilizável: trocar para o
   processo Python do servidor local (que já roda o tempo todo, e É "a
   máquina") disparar o toast nativo do SO via POST /api/notify — sem
   permissão de navegador nenhuma. Ver DesktopNotifier em server.py e a
   entrada correspondente em SECURITY.md.

   Por que um arquivo à parte: dashboard-app.js (alertas/incidentes locais) e
   aa-integration.js (falhas da Control Room) precisam do MESMO mecanismo —
   decidir severidade, e principalmente decidir o que já é "visto" para não
   notificar a mesma coisa de novo a cada refresh. Fica aqui, um script
   pequeno e independente que os dois só CONSOMEM (nunca o contrário).

   Trade-off assumido: um toast disparado pelo SO não tem como chamar de
   volta o JavaScript da página ao ser clicado (são processos/mecanismos
   diferentes) — diferente da Web Notification API, que permitia
   `onclick` levar direto à página relevante. Aceito pelo responsável do
   projeto em troca de notificação que realmente aparece sem depender de
   permissão de navegador.

   Primeira execução de cada "namespace" (ver `newIdsSince`) NUNCA notifica
   — só semeia a base de comparação, senão a primeira vez que alguém liga
   as notificações veria uma enxurrada de tudo que já estava aberto antes.
   ============================================================================ */
(function () {
    'use strict';

    const ENABLED_KEY = 'rpaNotificationsEnabled';
    const MAX_TRACKED_IDS = 500;
    const SEVERITY_EMOJI = { critical: '🔴', warning: '🟠', info: '🔵' };

    class RpaNotificationCenter {
        /** Flag NOSSO (localStorage) — opt-in, começa desligado. Não há
         * "permissão de navegador" nenhuma para checar aqui: quem decide se
         * o toast realmente aparece é o SO (ex.: modo "não perturbe"), fora
         * do alcance da página de qualquer forma. */
        static isEnabled() {
            try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch (exc) { return false; }
        }

        static setEnabled(value) {
            try { localStorage.setItem(ENABLED_KEY, value ? '1' : '0'); } catch (exc) { /* ignorado */ }
        }

        /** Dispara o toast nativo via backend local. Nunca lança: servidor
         * local fora do ar (ou POST recusado) só significa "sem notificação
         * nativa desta vez", nunca deveria quebrar quem chamou. */
        static push({ severity = 'info', title, body, tag }) {
            if (!RpaNotificationCenter.isEnabled()) return;
            const prefixed = `${SEVERITY_EMOJI[severity] || SEVERITY_EMOJI.info} ${title}`;
            RpaNotificationCenter._send(prefixed, body).catch(() => { /* sem servidor local, sem notificação — silencioso */ });
        }

        static async _send(title, body) {
            const csrf = await RpaNotificationCenter._csrfToken();
            await fetch('/api/notify', {
                method: 'POST', cache: 'no-store',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
                body: JSON.stringify({ title, body }),
            });
        }

        /** Mesmo padrão de CsrfTokenStore (dashboard-app.js), duplicado de
         * propósito aqui — este arquivo não pode depender de dashboard-app.js
         * carregar antes (aa-integration.js também o consome). */
        static async _csrfToken() {
            if (RpaNotificationCenter._csrfCache) return RpaNotificationCenter._csrfCache;
            if (!RpaNotificationCenter._csrfPending) {
                RpaNotificationCenter._csrfPending = fetch('/api/csrf-token', { cache: 'no-store' })
                    .then(r => r.json())
                    .then(r => { RpaNotificationCenter._csrfCache = r.token; return r.token; })
                    .finally(() => { RpaNotificationCenter._csrfPending = null; });
            }
            return RpaNotificationCenter._csrfPending;
        }

        /** Diff persistente entre `currentIds` e o que já foi visto da
         * última vez que este `namespace` foi checado. Primeira chamada de
         * sempre para um namespace (nada gravado ainda em localStorage)
         * semeia sem devolver nenhum id novo — ver docstring do arquivo.
         * `currentIds` é truncado a MAX_TRACKED_IDS antes de gravar, para
         * localStorage nunca crescer sem limite numa Control Room/log com
         * muito volume. */
        static newIdsSince(namespace, currentIds) {
            const key = 'rpaNotifySeen:' + namespace;
            let raw = null;
            try { raw = localStorage.getItem(key); } catch (exc) { /* localStorage indisponível (modo privado restrito) */ }
            const seeded = raw !== null;
            let seen = [];
            try { seen = raw ? JSON.parse(raw) : []; } catch (exc) { seen = []; }
            const seenSet = new Set(seen);
            const newIds = seeded ? currentIds.filter(id => !seenSet.has(id)) : [];
            try { localStorage.setItem(key, JSON.stringify(currentIds.slice(-MAX_TRACKED_IDS))); } catch (exc) { /* ignorado */ }
            return newIds;
        }

        /** Helper de alto nível: dado uma lista de itens já filtrada (ex.:
         * só os CRÍTICO/ALTO, ou só os RUN_FAILED), extrai o id de cada um
         * via `idOf`, descobre quais são novos, e dispara UM toast
         * resumindo até 3 nomes (nunca um por item — evita enxurrada numa
         * Control Room/log com muitas falhas simultâneas). Não-op se não
         * houver item novo. */
        static notifyNewBatch(namespace, items, idOf, nameOf, { severity, label, tag }) {
            const ids = items.map(idOf);
            const newIds = RpaNotificationCenter.newIdsSince(namespace, ids);
            if (!newIds.length) return;
            const newIdSet = new Set(newIds);
            const newItems = items.filter((item, i) => newIdSet.has(ids[i]));
            const names = newItems.slice(0, 3).map(nameOf);
            const extra = newItems.length > 3 ? ` e mais ${newItems.length - 3}` : '';
            RpaNotificationCenter.push({
                severity,
                title: `${newItems.length} ${label}`,
                body: names.join(', ') + extra,
                tag,
            });
        }
    }

    window.RpaNotificationCenter = RpaNotificationCenter;
})();
