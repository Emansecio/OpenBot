# Resiliência do chat e dos provedores

Este guia explica o que o OpenBot faz quando um provedor falha e como recuperar uma conversa sem duplicar mensagens.

## Falhas antes da resposta

Falhas transitórias de rede, servidor e rate limit podem ser repetidas automaticamente até duas vezes, desde que nenhum conteúdo tenha sido recebido. O OpenBot respeita `Retry-After` por até 60 segundos. Um request que já consumiu todo o timeout do provedor não é repetido automaticamente.

Respostas de streaming que não seguem o contrato de chat-completions, terminam antes do marcador final ou contêm tool calls incompletas são tratadas como falha. Elas não aparecem como respostas vazias concluídas.

## Falhas depois de conteúdo parcial

Depois do primeiro trecho recebido, o OpenBot não repete o request automaticamente. O conteúdo parcial é preservado e a conversa recebe uma mensagem de erro curta, indicando se a falha é recuperável.

Quando a falha é recuperável, use **Tentar novamente**. A nova tentativa:

- reutiliza a mensagem original;
- não cria uma segunda mensagem do usuário;
- não envia o conteúdo parcial anterior de volta ao provedor;
- usa o mesmo provedor e modelo da tentativa que falhou;
- é idempotente se o botão for acionado mais de uma vez.

## Cancelamento

O botão **Parar** acompanha o estado real do gateway. Ele continua disponível durante espera sem tokens ou incerteza temporária de transporte. Ao cancelar, o OpenBot interrompe o stream, preserva o conteúdo já recebido e libera o bot para a próxima mensagem.

Após reinício inesperado, respostas que estavam em streaming são fechadas como parciais e operações de ferramenta abertas são marcadas como interrompidas.

## Recuperação após crash

O OpenBot mantém um journal SQLite somente enquanto cada turno está em voo. Se o backend encerrar depois de aceitar a mensagem, o próximo início transforma o turno aberto em uma falha recuperável.

- Mensagens aceitas sem resposta recebem um aviso de interrupção e podem ser tentadas novamente.
- Respostas parciais são preservadas com estado **interrompido**, mas não voltam ao provider como se fossem respostas completas.
- Tentativas interrompidas durante retry voltam a oferecer uma nova tentativa; o botão não confirma uma execução inexistente.
- Turnos concluídos, cancelados ou que já exibiram uma falha não permanecem no journal.

O ownership do banco compara identidade de processo, e não somente PID. Isso evita que um PID reutilizado por outro processo bloqueie a reconciliação de turnos antigos.

## Troca de modelo ou provedor

Cada mensagem fixa o provedor e o modelo no momento em que é aceita. Alterar as configurações enquanto ela prepara anexos ou contexto não muda o destino daquela mensagem; a nova escolha vale para mensagens aceitas depois.

O transcript registra a identidade do turno, provedor e modelo usados. Isso mantém a origem da resposta verificável sem alterar o conteúdo da conversa enviado aos próximos turnos.

Os controles de geração acompanham o bot correto. Ao trocar de conversa, **Parar** fica oculto em bots ociosos e reaparece ao voltar ao bot que continua executando. Cancelamento, retry e consulta de status possuem prazo limitado; falha de transporte não deixa o botão permanentemente desabilitado.

## Verificação local

Execute:

```powershell
npm run verify:chat-resilience
```

O gate usa providers simulados e diretórios temporários. Ele cobre resposta inválida, timeout, Retry-After, retry seguro, persistência SQLite, troca concorrente de modelo e os contratos do Electron.

O gate não comprova disponibilidade, limite ou latência de serviços comerciais externos.
