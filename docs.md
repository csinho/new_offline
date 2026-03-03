# Keys dos inputs – Linha de Produção (documentação backend)

O app é **apenas** a linha de produção (frente de caixa / curral). Todo o fluxo ocorre no pipeline a partir do dashboard.

Este documento define, por **módulo**, os **atributos** (keys) usados nos formulários e, quando houver **abas com campos pré-definidos**, o **formato de envio** em `get_modulos` para o backend implementar corretamente.

---

## Convenções

- **Key:** identificador do atributo no backend e em payloads de sync.
- **ID do elemento:** id do input/select no DOM (mapeamento em `FORM_FIELD_IDS` em `app.js`).
- **OS:** Option Set — valor fixo de uma lista no front.
- **BD:** ID de entidade (lote, pasto, colaborador, fazenda, animal).

**Pré-preenchimento dinâmico:** o front aplica ao formulário qualquer campo que chegar em `get_modulos` (`modules[].abas[].campos[]`) cuja **key** exista no mapeamento `FORM_FIELD_IDS`. O backend envia as keys desejadas em cada aba; o script preenche os elementos correspondentes.

**Formato de um campo em `get_modulos` (quando a aba tiver campos pré-definidos):**

```json
{
  "key": "nome_da_key",
  "value": "valor_inicial_opcional",
  "type": "OS"
}
```

- `key`: obrigatório; deve ser uma das keys listadas no módulo/aba.
- `value`: opcional; valor inicial do campo.
- `type`: opcional; `"OS"` (option set) ou outro; usado pelo front para completar abas vazias.

Se uma aba for enviada com `campos: []` ou sem `campos`, o front exibe a aba e pode preencher com as keys padrão de `DEFAULT_ABA_CAMPOS_KEYS` (config.js).

---

# Contexto: Entrada do pipeline (dashboard)

Não é um módulo; é a tela inicial onde o usuário busca um animal ou cria um novo.

| ID do elemento        | Key (backend) | Descrição |
|-----------------------|---------------|-----------|
| `pipelineSearchBrinco` | —             | Busca de animal pelo brinco (mesma fazenda) |
| `pipelineSearchResults` | —            | Lista de resultados (clique seleciona animal e inicia pipeline) |
| `pipelineBtnCreate`    | —             | Botão "Criar animal" (abre formulário no pipeline) |

---

# Módulo: animal (Criar / editar animal)

O formulário de criar/editar animal aparece **dentro** do pipeline ao clicar em "Criar animal". Após salvar, o fluxo segue para o primeiro módulo retornado por `get_modulos`.

**Uso em get_modulos:** o formulário de animal **não** é preenchido por `get_modulos`. É preenchido por dados do animal (edição) ou rascunho. As keys abaixo servem para **payloads de sync** (`animal_create`, `animal_update`) e alinhamento com o backend.

---

## Atributos – Cadastro básico

| Key (backend)    | ID do elemento   | Tipo | Descrição |
|------------------|------------------|------|-----------|
| `proprietario`   | `animalOwnerSelect` | BD   | Proprietário (colaborador) |
| `entry_type`     | `tipoEntradaChips` (data-value) | OS | Nascimento, Compra, Doação, Empréstimo, Ajuste inventário |
| `animal_type`    | `animalTipo`     | OS   | Físico / Genealogia |
| `brinco_padrao`  | `animalBrinco`   | texto | Nº do brinco |
| `raca`           | `animalRaca`     | OS   | Raça |
| `peso_atual_kg`  | `animalPesoAtual`| número | Peso atual (kg) |
| `sexo`           | `animalSexo`     | OS   | MACHO / FEMEA |
| `categoria`      | `animalCategoria`| OS   | Categoria do animal |
| `data_nascimento`| `animalNasc`     | data | Data de nascimento |
| —                | `animalIdadeDisplay` | somente leitura | Idade (calculada; ex.: "5 meses") |
| `lote` / `list_lotes` | (lote chips) | BD | Lote(s) |

---

## Atributos – Aquisição

**Visibilidade da seção:**  
- **Nascimento:** seção oculta.  
- **Compra:** seção visível; todos os campos habilitados.  
- **Doação, Empréstimo, Ajuste inventário:** seção visível; campo Valor desabilitado; payload envia `valor_animal: 0`.

| Key (backend)      | ID do elemento        | Tipo | Descrição |
|--------------------|------------------------|------|-----------|
| `data_aquisicao`   | `animalDataAquisicao`  | data/timestamp | Data da aquisição |
| `nota_fiscal`      | `animalNotaFiscal`     | texto | NF |
| `valor` / `valor_animal` | `animalValorAquisicao` | número | Valor (R$). Desabilitado em Doação/Empréstimo/Ajuste |
| `origem_fornecedor`| `animalOrigemFornecedor` | BD/texto | Origem/Fornecedor |
| `numero_gta`       | `animalNumeroGTA`      | texto | Nº GTA |
| `uf_gta`           | `animalUfGTA`          | OS   | UF |
| `serie_gta`        | `animalSerieGTA`       | texto | Série GTA |
| `data_emissao_gta` | `animalDataEmissaoGTA` | data/timestamp | Data emissão GTA |
| `data_validade_gta`| `animalDataValidadeGTA`| data/timestamp | Data validade GTA |

---

## Atributos – Dados adicionais (Cadastro avançado)

| Key (backend)             | ID do elemento  | Tipo   | Descrição |
|---------------------------|-----------------|--------|-----------|
| `nome_completo`           | `animalNome`    | texto  | Nome completo |
| `finalidade`              | `animalFinalidade` | OS  | Finalidade |
| `peso_nascimento`         | `animalPesoNasc`| número | Peso no nascimento (kg) |
| `sisbov`                  | `animalSisbov`  | texto  | SISBOV |
| `identificacao_eletronica`| `animalEletronica` | texto | Identificação eletrônica |
| `rgd`                     | `animalRgd`    | texto  | RGD |
| `rgn`                     | `animalRgn`    | texto  | RGN |
| `pasto`                   | `animalPasto`  | BD     | Pasto |
| `lote` / `list_lotes`     | (lote chips)   | BD     | Lote |
| `observacoes`             | `animalObs`    | texto  | Observações |

---

## Atributos – Genealogia (Cadastro avançado)

Busca por animais da **mesma organização**. Ao selecionar, o front guarda o ID em `data-selected-id` e exibe "Brinco — Nome".

| Key (backend) | ID do elemento | Tipo | Descrição |
|---------------|----------------|------|-----------|
| `mae_vinculo` | `animalMae`    | BD   | Mãe (ID do animal) |
| `pai_vinculo` | `animalPai`    | BD   | Pai (ID do animal) |

---

# Módulo: movimentacao

Movimentação entre lotes, pastos ou fazendas. As **abas** exibidas vêm de `get_modulos` (campo `abas` do módulo `movimentacao`). Cada aba pode ter **campos pré-definidos** para pré-preenchimento.

---

## Atributos por aba

### Aba **lotes** (Entre lotes)

| Key (backend) | ID do elemento        | Descrição |
|---------------|------------------------|-----------|
| `lote` (origem)  | `pipelineMovLoteOrigem`  | Lote de origem (animal ou select) |
| `lote` (destino) | `pipelineMovLoteDestino` | Lote de destino |

### Aba **pastos** (Entre pastos)

| Key (backend) | ID do elemento          | Descrição |
|---------------|--------------------------|-----------|
| `pasto` (origem)  | `pipelineMovPastoOrigem`  | Pasto de origem |
| `pasto` (destino) | `pipelineMovPastoDestino` | Pasto de destino |

### Aba **fazendas** (Entre fazendas)

| Key (backend)     | ID do elemento                  | Descrição |
|-------------------|----------------------------------|-----------|
| `fazenda_destino` | `pipelineMovFazendaDestino`      | Fazenda de destino |
| `lote` (origem)   | `pipelineMovLoteOrigemFazenda`  | Lote de origem (fazenda atual) |
| `pasto` (origem)  | `pipelineMovPastoOrigemFazenda`  | Pasto de origem (fazenda atual) |
| `lote` (destino)  | `pipelineMovLoteDestinoFazenda`  | Lote de destino (fazenda destino) |
| `pasto` (destino) | `pipelineMovPastoDestinoFazenda` | Pasto de destino (fazenda destino) |

Operações enfileiradas: `movimentacao_entre_lotes`, `movimentacao_entre_pastos`, `movimentacao_entre_fazendas`.

---

## Formato de envio em get_modulos (movimentacao)

Quando a aba tiver **campos pré-definidos**, enviar no módulo `movimentacao`:

```json
{
  "modulo": "movimentacao",
  "abas": [
    {
      "titulo": "lotes",
      "campos": [
        { "key": "lote", "value": "", "type": "OS" }
      ]
    },
    {
      "titulo": "pastos",
      "campos": [
        { "key": "pasto", "value": "", "type": "OS" }
      ]
    },
    {
      "titulo": "fazendas",
      "campos": [
        { "key": "fazenda_destino", "value": "", "type": "OS" },
        { "key": "lote", "value": "", "type": "OS" },
        { "key": "pasto", "value": "", "type": "OS" }
      ]
    }
  ]
}
```

- O **titulo** da aba deve ser exatamente `lotes`, `pastos` ou `fazendas` (comparação em lowercase).
- As **keys** em `campos` devem ser as listadas acima para essa aba. O front mapeia cada key para o ID do elemento correspondente.

---

# Módulo: pesagem

Uma única aba **Pesagem**. Colaborador e tipo de pesagem no payload de sync vão como `user` e `momento_pesagem`; em get_modulos use as keys abaixo para pré-preenchimento.

---

## Atributos

| Key (get_modulos) | Key (payload sync) | ID do elemento      | Tipo   | Descrição |
|-------------------|--------------------|----------------------|--------|-----------|
| `colaborador`     | `user`             | `pesoColaboradorSelect` | BD  | Colaborador responsável |
| `tipo_pesagem`    | `momento_pesagem`  | `pesoTipoPesagem`   | OS     | Pesagem regular / Desmame |
| `peso`            | `peso_atual_kg`    | `pesoValorKg`       | número | Valor (kg) |
| `data_pesagem`    | `data_pesagem`     | `pesoDataPesagem`   | data   | Data da pesagem |

Payload `animal_create_peso`: `animal`, `data_pesagem`, `peso_atual_kg`, `tipo_equipamento`, `momento_pesagem`, `user`.

---

## Formato de envio em get_modulos (pesagem)

Quando a aba **Pesagem** tiver campos pré-definidos:

```json
{
  "modulo": "pesagem",
  "abas": [
    {
      "titulo": "Pesagem",
      "campos": [
        { "key": "colaborador", "value": "", "type": "OS" },
        { "key": "tipo_pesagem", "value": "", "type": "OS" },
        { "key": "peso", "value": "", "type": "OS" },
        { "key": "data_pesagem", "value": "", "type": "OS" }
      ]
    }
  ]
}
```

O **titulo** da aba deve ser `Pesagem` (comparação em lowercase com normalização).

---

# Módulo: saida_animais

Várias **abas**: Venda, Morte, Empréstimo, Doação, Ajuste inventário. As abas exibidas vêm de `get_modulos`. O animal já está definido pelo pipeline; na aba Venda o campo animal pode ser usado para conferência.

---

## Atributos – Aba **Venda**

| Key (backend)              | ID do elemento           | Tipo   | Descrição |
|----------------------------|---------------------------|--------|-----------|
| `animal`                   | `vendaAnimalBrinco`       | BD     | Animal (brinco → ID) |
| `proprietario_destino`     | `vendaProprietarioDestino`| BD     | Proprietário de destino |
| `fazenda_destino`          | `vendaFazendaDestino`     | BD     | Fazenda de destino |
| `valor` / `valor_saida`    | `vendaValor`              | número | Valor (R$) |
| `peso_saida`               | `vendaPeso`               | número | Peso (kg) |
| `condicao_pagamento`       | `vendaCondicaoPagamento`  | OS     | Condição de pagamento |
| `movimentacao_saida_animal`| `vendaMovimentacaoSaida`  | OS     | Tipo de saída (Venda, Morte, etc.) |
| `data_aquisicao`           | `vendaData`               | data   | Data |
| `nota_fiscal`              | `vendaNotaFiscal`         | texto  | Nota fiscal |
| `numero_gta`               | `vendaNumeroGTA`          | texto  | Número GTA |
| `data_emissao_gta`         | `vendaDataEmissaoGTA`     | data   | Data emissão GTA |
| `data_validade_gta`        | `vendaDataValidadeGTA`   | data   | Data validade GTA |
| `serie_gta`                | `vendaSerie`              | texto  | Série GTA |
| `uf_gta`                   | `vendaUF`                 | OS     | UF |

Operação: `create_saida_animais_venda`.

---

## Atributos – Aba **Empréstimo**

Mesmos IDs de elementos da Venda para os campos abaixo (layout enxuto).

| Key (backend)          | ID do elemento            |
|------------------------|---------------------------|
| `proprietario_destino` | `vendaProprietarioDestino`|
| `fazenda_destino`      | `vendaFazendaDestino`     |
| `data_aquisicao`       | `vendaData`               |
| `nota_fiscal`          | `vendaNotaFiscal`         |
| `peso_saida`           | `vendaPeso`               |

Operação: `create_saida_animais_emprestimo`.

---

## Atributos – Aba **Doação**

Mesmos keys e IDs da aba Empréstimo. Operação: `create_saida_animais_doacao`.

---

## Atributos – Aba **Ajuste inventário**

Mesmos keys e IDs da aba Empréstimo. Operação: `create_saida_animais_aju_inventario`.

---

## Atributos – Aba **Morte**

| Key (backend)              | ID do elemento             | Tipo   | Descrição |
|----------------------------|----------------------------|--------|-----------|
| `causa_morte`              | `morteCausaMorte`          | OS     | Doença Infecciosa, Problema Metabólico ou nutricional, Complicações no Parto, Outros |
| `responsavel`              | `morteResponsavel`        | BD     | Responsável (colaborador) |
| `data_morte`                | `morteDataMorte`          | timestamp | Data da morte |
| `detalhes_observacoes`     | `morteDetalhesObservacoes`| texto  | Detalhes/Observações |
| `imagem_brinco_animal`     | `morteImagemBrinco`        | base64 | Imagem do brinco ou animal |
| `movimentacao_saida_animal`| `morteMovimentacaoSaida`   | fixo "Morte" | — |

Operação: `create_saida_animais_morte`.

---

## Formato de envio em get_modulos (saida_animais)

Quando uma aba tiver **campos pré-definidos**, o **titulo** da aba deve ser exatamente: `Venda`, `Morte`, `Empréstimo`, `Doação` ou `Ajuste inventário` (comparação em lowercase com normalização). Exemplo para a aba **Venda**:

```json
{
  "modulo": "saida_animais",
  "abas": [
    {
      "titulo": "Venda",
      "campos": [
        { "key": "animal", "value": "", "type": "OS" },
        { "key": "condicao_pagamento", "value": "", "type": "OS" },
        { "key": "movimentacao_saida_animal", "value": "", "type": "OS" },
        { "key": "valor", "value": "", "type": "OS" },
        { "key": "peso_saida", "value": "", "type": "OS" },
        { "key": "data_aquisicao", "value": "", "type": "OS" },
        { "key": "nota_fiscal", "value": "", "type": "OS" },
        { "key": "numero_gta", "value": "", "type": "OS" },
        { "key": "data_emissao_gta", "value": "", "type": "OS" },
        { "key": "data_validade_gta", "value": "", "type": "OS" },
        { "key": "serie_gta", "value": "", "type": "OS" },
        { "key": "uf_gta", "value": "", "type": "OS" },
        { "key": "proprietario_destino", "value": "", "type": "OS" },
        { "key": "fazenda_destino", "value": "", "type": "OS" }
      ]
    },
    {
      "titulo": "Empréstimo",
      "campos": [
        { "key": "proprietario_destino", "value": "", "type": "OS" },
        { "key": "fazenda_destino", "value": "", "type": "OS" },
        { "key": "data_aquisicao", "value": "", "type": "OS" },
        { "key": "nota_fiscal", "value": "", "type": "OS" },
        { "key": "peso_saida", "value": "", "type": "OS" }
      ]
    },
    {
      "titulo": "Doação",
      "campos": [
        { "key": "proprietario_destino", "value": "", "type": "OS" },
        { "key": "fazenda_destino", "value": "", "type": "OS" },
        { "key": "data_aquisicao", "value": "", "type": "OS" },
        { "key": "nota_fiscal", "value": "", "type": "OS" },
        { "key": "peso_saida", "value": "", "type": "OS" }
      ]
    },
    {
      "titulo": "Ajuste inventário",
      "campos": [
        { "key": "proprietario_destino", "value": "", "type": "OS" },
        { "key": "fazenda_destino", "value": "", "type": "OS" },
        { "key": "data_aquisicao", "value": "", "type": "OS" },
        { "key": "nota_fiscal", "value": "", "type": "OS" },
        { "key": "peso_saida", "value": "", "type": "OS" }
      ]
    },
    {
      "titulo": "Morte",
      "campos": [
        { "key": "causa_morte", "value": "", "type": "OS" },
        { "key": "detalhes_observacoes", "value": "", "type": "OS" },
        { "key": "responsavel", "value": "", "type": "OS" },
        { "key": "data_morte", "value": "", "type": "OS" },
        { "key": "imagem_brinco_animal", "value": "", "type": "OS" },
        { "key": "movimentacao_saida_animal", "value": "", "type": "OS" }
      ]
    }
  ]
}
```

O backend pode enviar apenas as abas desejadas; cada aba pode ter `campos: []` (o front completa com as keys padrão) ou a lista de campos com `key`, `value` e `type` como acima.

---

# Resumo – Mapeamento key → ID (FORM_FIELD_IDS)

O front aplica o valor de `campos[].key` ao elemento cujo id está no mapa abaixo (por módulo e aba).

| Módulo          | Aba (titulo)     | Keys mapeadas |
|-----------------|------------------|----------------|
| `movimentacao`  | `lotes`          | `lote` → pipelineMovLoteDestino |
| `movimentacao`  | `pastos`         | `pasto` → pipelineMovPastoDestino |
| `movimentacao`  | `fazendas`       | `fazenda_destino`, `lote`, `pasto` → respectivos IDs |
| `pesagem`       | `pesagem`        | `colaborador`, `tipo_pesagem`, `peso`, `data_pesagem` |
| `saida_animais` | `venda`          | animal, condicao_pagamento, valor, peso_saida, data_aquisicao, nota_fiscal, numero_gta, data_emissao_gta, data_validade_gta, serie_gta, uf_gta, proprietario_destino, fazenda_destino, movimentacao_saida_animal |
| `saida_animais` | `emprestimo`     | proprietario_destino, fazenda_destino, data_aquisicao, nota_fiscal, peso_saida |
| `saida_animais` | `doacao`         | (idem Empréstimo) |
| `saida_animais` | `ajuste inventário` | (idem Empréstimo) |
| `saida_animais` | `morte`          | causa_morte, detalhes_observacoes, responsavel, data_morte, imagem_brinco_animal, movimentacao_saida_animal |

---

# Operações offline (fila de sincronização)

Nomes oficiais em `dados.operacoes` (OFFLINE_OPS em config.js):

| Operação | Descrição |
|----------|-----------|
| `animal_create` | Criação de animal |
| `animal_update` | Atualização do animal (inclui transferência entre fazendas) |
| `animal_create_peso` | Registro de pesagem |
| `create_saida_animais_venda` | Saída: Venda |
| `create_saida_animais_morte` | Saída: Morte |
| `create_saida_animais_emprestimo` | Saída: Empréstimo |
| `create_saida_animais_aju_inventario` | Saída: Ajuste inventário |
| `create_saida_animais_doacao` | Saída: Doação |
| `movimentacao_entre_lotes` | Movimentação entre lotes |
| `movimentacao_entre_pastos` | Movimentação entre pastos |
| `movimentacao_entre_fazendas` | Movimentação entre fazendas (envelope: update_fazenda_new) |

**Tipo de saída (UI) → operação:** Venda → `create_saida_animais_venda`, Morte → `create_saida_animais_morte`, Empréstimo → `create_saida_animais_emprestimo`, Ajuste inventário → `create_saida_animais_aju_inventario`, Doação → `create_saida_animais_doacao`.

---

# Option sets e listas (config.js)

| Constante | Valores |
|-----------|---------|
| `ENTRY_TYPE_LIST` | Nascimento, Compra, Doação, Empréstimo, Ajuste inventário |
| `ANIMAL_TYPE_LIST` | Físico, Genealogia |
| `CONDICAO_PAGAMENTO_LIST` | A vista, parcelado |
| `MOVIMENTACAO_SAIDA_ANIMAL_LIST` | Venda, Morte, Empréstimo, Ajuste inventário, Doação |
| `CAUSA_MORTE_LIST` | Doença Infecciosa, Problema Metabólico ou nutricional, Complicações no Parto, Outros |
| `TIPO_PESAGEM_LIST` | Pesagem regular, Desmame |
| `UF_LIST` | Lista de UFs (valor + label) para dropdowns GTA/UF |

Alinhar as opções com o backend para exibição correta.

---

# Módulos do sistema (get_modulos)

O pipeline usa apenas os módulos cujo key está em `PIPELINE_STEP_KEYS_IMPLEMENTED`: `movimentacao`, `pesagem`, `saida_animais`. A ordem dos passos segue o array retornado por `get_modulos`.

| Key do módulo   | Label            | Frontend  |
|-----------------|------------------|-----------|
| `animal`        | Animais          | pronto    |
| `movimentacao`  | Movimentações    | pronto    |
| `pesagem`       | Pesagem          | pronto    |
| `saida_animais` | Saída de Animais | pronto    |
| `vacinacao`     | Vacinação        | pendente  |
| Outros (manejo, organizacao, fazenda, etc.) | — | pendente  |
