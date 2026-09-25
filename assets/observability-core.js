/* ==========================================================================\n   Shared utilities for the local RPA observability pages.\n   No external library is required.\n   ========================================================================== */
(function(){
    const D = window.OBS_DATA;
    const $ = (s,root=document)=>root.querySelector(s);
    const $$ = (s,root=document)=>[...root.querySelectorAll(s)];
    const q = new URLSearchParams(location.search);
    const fmtDateTime = v => v ? new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'medium'}).format(new Date(v)) : '—';
    const fmtDate = v => v ? new Intl.DateTimeFormat('pt-BR',{dateStyle:'short'}).format(new Date(v+'T12:00:00')) : '—';
    const fmtTime = v => v ? new Intl.DateTimeFormat('pt-BR',{timeStyle:'medium'}).format(new Date(v)) : '—';
    const esc = v => String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    const statusBadge = s => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
    const pct = (a,b)=>b?100*a/b:0;
    const median = arr => {const a=[...arr].sort((x,y)=>x-y); if(!a.length)return 0; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2};
    const percentile = (arr,p)=>{const a=[...arr].sort((x,y)=>x-y);if(!a.length)return 0;const k=(a.length-1)*p,f=Math.floor(k),c=Math.ceil(k);return f===c?a[f]:a[f]*(c-k)+a[c]*(k-f)};
    const processName = id => D.rpas.find(r=>r.rpaId===id)?.name || id;
    const getExecution = id => D.executions.find(e=>e.executionId===id);
    const getRpa = id => D.rpas.find(r=>r.rpaId===id);
    const getRpaByProcess = p => D.rpas.find(r=>r.process===p);
    const getEvents = id => D.eventsByExecution[id] || [];
    const getVmContext = id => D.vmContextByExecution[id] || [];
    const duration = sec => sec<60?`${sec.toFixed(1)}s`:`${Math.floor(sec/60)}m ${String(Math.round(sec%60)).padStart(2,'0')}s`;
    const openInvestigation = id => window.open(`investigacao.html?execution_id=${encodeURIComponent(id)}`,'_blank');
    const openDiagnostic = id => window.open(`diagnostico.html?execution_id=${encodeURIComponent(id)}`,'_blank');
    const openRpa = id => window.open(`rpa-dashboard.html?rpa_id=${encodeURIComponent(id)}`,'_blank');
    const exportPdf = () => window.print();
    function initToolbar(label){
        const back=$('#btnBack'); if(back) back.addEventListener('click',()=>window.close());
        const pdf=$('#btnPdf'); if(pdf) pdf.addEventListener('click',exportPdf);
        const snapshot=$('#snapshot'); if(snapshot) snapshot.textContent=`Base sintética: ${fmtDate(D.periodStart)} a ${fmtDate(D.periodEnd)}`;
        document.title = label + ' · RPA Ops Monitor';
    }
    function lineSvg(rows, series, options={}){
        if(!rows.length) return '<div class="empty">Sem dados no período.</div>';
        const W=900,H=250,p={l:46,r:18,t:20,b:38};
        const vals=rows.flatMap(r=>series.map(s=>Number(r[s.key]||0)));
        let ymin=options.min ?? Math.min(...vals), ymax=options.max ?? Math.max(...vals);
        if(ymin===ymax){ymin=Math.max(0,ymin-1);ymax+=1} const span=ymax-ymin;
        const x=i=>p.l+i*(W-p.l-p.r)/Math.max(1,rows.length-1);
        const y=v=>p.t+(ymax-v)/span*(H-p.t-p.b);
        const ticks=[0,.25,.5,.75,1].map(t=>ymin+span*t);
        const grid=ticks.map(v=>`<line class="gridline" x1="${p.l}" x2="${W-p.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${p.l-7}" y="${y(v)+3}" text-anchor="end">${options.formatY?options.formatY(v):Math.round(v*10)/10}</text>`).join('');
        const labels=rows.map((r,i)=> (i===0||i===rows.length-1||i%Math.max(1,Math.floor(rows.length/7))===0)?`<text class="axis" x="${x(i)}" y="${H-11}" text-anchor="middle">${esc(options.labelX?options.labelX(r):r.date)}</text>`:'').join('');
        const colors=['var(--primary)','var(--warning)','var(--danger)','var(--info)'];
        const lines=series.map((s,si)=>{const pts=rows.map((r,i)=>`${x(i)},${y(Number(r[s.key]||0))}`).join(' ');return `<polyline points="${pts}" fill="none" stroke="${colors[si%colors.length]}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`}).join('');
        return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${lines}${labels}</svg><div class="legend">${series.map((s,i)=>`<span><i style="background:${colors[i%colors.length]}"></i>${esc(s.label)}</span>`).join('')}</div>`;
    }
    function barSvg(rows,key,labelKey='label',options={}){
        if(!rows.length) return '<div class="empty">Sem dados.</div>';
        const max=Math.max(...rows.map(r=>Number(r[key]||0)),1);
        return `<div>${rows.map(r=>`<div class="metric-row"><span title="${esc(r[labelKey])}">${esc(r[labelKey])}</span><div class="progress"><span style="width:${Number(r[key]||0)/max*100}%"></span></div><strong>${options.format?options.format(r[key]):r[key]}</strong></div>`).join('')}</div>`;
    }
    window.RPAUI={D,$,$$,q,fmtDateTime,fmtDate,fmtTime,esc,statusBadge,pct,median,percentile,processName,getExecution,getRpa,getRpaByProcess,getEvents,getVmContext,duration,openInvestigation,openDiagnostic,openRpa,exportPdf,initToolbar,lineSvg,barSvg};
})();
