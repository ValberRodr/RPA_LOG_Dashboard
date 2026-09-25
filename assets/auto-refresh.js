/* ==========================================================================\n   Auto refresh - recarrega a página a cada 20 minutos.\n   O servidor local recompõe os datasets lendo os arquivos .log antes de\n   entregar observability-data.js e index-data.js.\n   ========================================================================== */
(function(){
    const REFRESH_MS = 20 * 60 * 1000;
    const loadedAt = new Date();
    window.RPA_REFRESH = { intervalMs: REFRESH_MS, loadedAt };

    function ensureBadge(){
        if(document.getElementById('autoRefreshBadge')) return;
        const badge = document.createElement('div');
        badge.id = 'autoRefreshBadge';
        badge.className = 'no-print';
        badge.style.cssText = [
            'position:fixed','right:16px','bottom:14px','z-index:9999',
            'padding:7px 10px','border-radius:999px','font:600 11px/1.2 Inter,system-ui,sans-serif',
            'background:rgba(24,27,35,.92)','color:#a8adbd','border:1px solid rgba(255,255,255,.09)',
            'box-shadow:0 8px 24px rgba(0,0,0,.18)','backdrop-filter:blur(8px)'
        ].join(';');
        document.body.appendChild(badge);
    }

    function tick(){
        ensureBadge();
        const elapsed = Date.now() - loadedAt.getTime();
        const remain = Math.max(0, REFRESH_MS - elapsed);
        const min = Math.floor(remain / 60000);
        const sec = Math.floor((remain % 60000) / 1000);
        const badge = document.getElementById('autoRefreshBadge');
        if(badge) badge.textContent = `Dados dos logs • atualização em ${min}:${String(sec).padStart(2,'0')}`;
    }

    document.addEventListener('DOMContentLoaded', ()=>{
        tick();
        setInterval(tick, 1000);
        setTimeout(()=>location.reload(), REFRESH_MS);
    });
})();
