DATASET SINTETICO - MONITORAMENTO RPA / VMs

Periodo: 2026-06-25 a 2026-09-24 (92 dias)
RPAs: 10
VMs: 11
Execucoes de RPA: 2982
Eventos/etapas: 21858
Snapshots de VM: 48576

ESTRUTURA PRINCIPAL
Organizacao&Processos/Melhoria_Continua/Monitoramento/Logs/AAAA/MM/NOME_RPA/
  RPA_AAAA-MM-DD.log
      - uma linha JSON por execucao do dia.
  RPA_AAAA-MM-DD_EXECUTION_ID.log
      - uma linha JSON por etapa/evento da execucao.

Organizacao&Processos/Melhoria_Continua/Monitoramento/VMS/
  MACHINE_NAME.json
      - ultimo snapshot disponivel, no mesmo estilo do padrao mostrado.
  Historico/AAAA/MM/MACHINE_NAME/VM_AAAA-MM-DD.jsonl
      - snapshots historicos a cada 30 minutos.

ARQUIVOS DE APOIO
CONFIGURACAO_CENARIO.json
VALIDACAO_DATASET.json

REGRAS IMPORTANTES
- Todos os dados sao ficticios.
- execution_id e unico no conjunto inteiro.
- execution_id relaciona log de execucao e log de evento.
- machine_name relaciona as execucoes de RPA com a telemetria das VMs.
- processed_items = success_items + warning_items + error_items.
- Os dados incluem cenarios controlados de degradacao de infraestrutura, warnings, erros e retries.
- A VM11 e usada como contingencia em parte das execucoes.
