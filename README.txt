RPA OBSERVABILITY MONITOR — VERSÃO DINÂMICA

INÍCIO RÁPIDO
- macOS: dê duplo clique em Iniciar_Monitoramento.command
- Windows: dê duplo clique em Iniciar_Monitoramento.bat
- Alternativa: execute `python3 server.py` e abra http://127.0.0.1:8765/index.html

POR QUE EXISTE UM SERVIDOR LOCAL?
Navegadores bloqueiam a leitura automática de arquivos .log locais quando um HTML é aberto por file://. O servidor usa apenas a biblioteca padrão do Python, escuta somente em 127.0.0.1 e permite que o painel leia os logs sem upload, internet ou dependências externas.

CARREGAMENTO E ATUALIZAÇÃO
- Os dados exibidos são montados diretamente dos arquivos em ./logs.
- A cada requisição o servidor verifica se houve mudança em quantidade, tamanho ou data de modificação dos logs.
- Se algo mudou, o dataset é reconstruído.
- As páginas recarregam automaticamente a cada 20 minutos e portanto passam a refletir os novos logs.
- O pequeno selo no canto inferior direito mostra o tempo até a próxima atualização.

NAVEGAÇÃO
- Investigação e Diagnóstico não ficam mais no menu lateral.
- Em Execuções e Falhas/Incidentes, use os botões Auditar / Investigar / Diagnóstico da execução.
- Na página Auditoria, os atalhos Investigação e Diagnóstico ficam no cabeçalho da própria execução.
- No Catálogo, clicar em uma RPA abre seu dashboard histórico dedicado em nova janela.
- Investigação, Diagnóstico e Dashboard da RPA permitem exportar para PDF pelo botão Exportar PDF.

ARQUIVOS
- index.html: cockpit operacional.
- investigacao.html: investigação forense detalhada por execution_id.
- diagnostico.html: diagnóstico técnico-operacional por execution_id.
- rpa-dashboard.html: dashboard histórico individual da RPA.
- server.py: parser/servidor local.
- config/rpa_metadata.json: cadastro e regras esperadas das RPAs.
- logs/: logs fictícios de execução, eventos e telemetria das VMs (92 dias).
- assets/observability-data.js e assets/index-data.js: fallback estático; quando servido via server.py, são substituídos dinamicamente pela versão recomposta dos logs.

DADOS FICTÍCIOS
Período original: 25/06/2026 a 24/09/2026.
10 RPAs e 11 VMs.
