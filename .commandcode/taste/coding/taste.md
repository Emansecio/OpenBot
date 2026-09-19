# Coding

- Prefere reaproveitar os mecanismos, contratos e lógica autoritativa já existentes, com a menor extensão necessária, em vez de criar um segundo sistema concorrente ou reescrever subsistemas. Confidence: 0.7
- Evita polling agressivo, gravação por token (por fragmento) e varreduras globais do DOM a cada fragmento; prefere sinais/eventos reais e assinaturas baratas. Confidence: 0.6
- Rejeita feedback fabricado ou inferido: o estado exibido/decidido deve vir de fatos confirmados pelo backend (por identificadores reais), não do texto apresentado. Confidence: 0.65
- Prefere superfície única de UI: integra a informação nova no controle/superfície nativa já existente (etapa, tempo e última atividade dentro do indicador nativo de atividade) em vez de criar uma segunda linha ou elemento concorrente; esconder informação existente para evitar duplicação não é aceitável. Confidence: 0.7
- Localiza dados por identidade (identificadores reais informados pelo backend) e nunca por posição de linhas/elementos visíveis. Confidence: 0.65
- Não remove mecanismos existentes de forma indiscriminada para o problema sumir; corrige a causa preservando o comportamento já validado. Confidence: 0.65
- Nunca afrouxa, ajusta ou reinterpreta testes para esconder falhas — se um teste falha, quer a causa investigada ou explicitamente classificada como pré-existente. Confidence: 0.7