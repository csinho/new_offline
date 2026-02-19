# Bovichain Offline PWA - Project Documentation

> **Status**: Em Desenvolvimento (Beta)
> **Tipo**: Progressive Web App (PWA) Offline-First
> **Stack**: HTML5, Vanilla CSS, Vanilla JS, IndexedDB

---

## 1. Visão Geral
O **Bovichain Offline** é uma aplicação PWA focada em gestão de fazendas de gado, projetada para funcionar 100% offline no campo. A aplicação sincroniza dados com o servidor principal (Bubble) quando há conexão.

### Principais Funcionalidades
- **Plataforma Modular Offline**: O sistema é uma base para diversos módulos (Animais, Vacina, Lote, Fazenda, etc.), permitindo criar e editar registros offline.
- **Módulo de Animais** (Implementado): Cadastro e edição completa de animais.
- **Dashboard Gerencial** com gráficos (Categorias, Peso por Lote, Sexo).
- **Sincronização Bidirecional**: Baixa dados ao iniciar (bootstrap) e envia alterações via fila de sincronização.
- **Feedback Visual**: Indicadores de "pendente" (🕒, ☁️) e botão de sincronização ativo.

---

## 2. Design System & Identidade Visual

### Cores (CSS Variables)
| Variável | Cor HEX | Uso |
| :--- | :--- | :--- |
| `--bg` | `#f8f8f8` | Fundo geral da aplicação (Cinza muito claro) |
| `--sidebar` | `#fbffe3` | Fundo da Sidebar e Header Mobile (Lime muito claro) |
| `--card` | `#ffffff` | Fundo de cartões e áreas de conteúdo |
| `--text` | `#111827` | Texto principal (Cinza escuro/Preto) |
| `--muted` | `#6b7280` | Texto secundário/legendas |
| `--btn` | `#edff77` | **Cor Primária** (Botões, Destaques, Barras de progresso) |
| `--btnText`| `#121826` | Texto dentro de botões primários |
| `--green` | `#16a34a` | Status Validados / Sucesso |
| `--danger` | `#ef4444` | Erros / Exclusão |
| `--border` | `#e5e7eb` | Bordas sutis |
| `-` | `#9cb3e4` | Gráficos (Base do Donut / Outros elementos azuis) |
| `-` | `#111827` | Borda do FAB (Azul muito escuro) |

### Tipografia
- **Família Fontes**: `'Inter'`, `'Rethink Sans'`, sans-serif.
- **Títulos**: Font-weight 800 (Extrabold).
- **Corpo**: Font-weight 400 (Regular).
- **Botões/Nav**: Font-weight 600 (Semi-bold).

### Layout e UI
- **Border Radius**: `16px` (geral), `20px` (Page Head), `999px` (Pills/Botões redondos).
- **Sombra**: `0 10px 28px rgba(17, 24, 39, .06)` (Suave e elevada).
- **Mobile First**:
    - Sidebar oculta em mobile (`< 980px`).
    - Navegação via **Módulos no Dashboard**.
    - Botão de Sync Flutuante (FAB) no canto inferior direito.

---

## 3. Ícones e Assets

### Ícones de Módulos (Emojis)
Usados para identificar visualmente os módulos no Dashboard e Listas.
- 🐮 **Animais** (`animal_create`)
- 📦 **Lotes** (`lotes`)
- 🛠️ **Manejo** (`manejo`)
- 🏢 **Organização** (`organizacao`)
- 🏡 **Fazenda** (`fazenda`)
- 💉 **Vacinas/Vacinação** (`vaccine`, `vacinacao`)
- ⚕️ **Sanidade** (`sanidade`)
- 🧬 **Reprodução** (`reproducao`)
- 🌽 **Nutrição** (`nutricao`)
- 💰 **Financeiro** (`financeiro`)

### Ícones de Status
- 🕒 **Relógio**: Indica que um item (animal) foi criado/editado offline e aguarda sincronização.
- ☁️ **Nuvem**: No cabeçalho do Dashboard, indica que existem dados pendentes na fila geral.
- 🔄 **Sync (FAB)**: Botão de ação para iniciar o upload.
- ⏳ **Ampulheta**: Botão de Sync em processamento (girando).

### SVG Personalizado (Sync FAB)
SVG "Dashed Document" usado no botão flutuante:
```html
<svg width="30px" height="30px" viewBox="-0.1 -0.1 1.8 1.8" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Caminhos vetoriais definidos no index.html -->
    <path ... fill="#2F88FF" ... />
</svg>
```
*Nota: Borda do botão é `5px solid #111827`.*

---

## 4. Arquitetura de Dados (IndexedDB)

### Stores Principais
| Store | Key | Descrição |
| :--- | :--- | :--- |
| `fazenda` | `current` | Objeto da fazenda atual (configurações, listas auxiliares). |
| `owner` | `current` | Dados do usuário logado (Nome, Foto). |
| `animais` | `list` | Array de objetos `Animal`. Fonte principal das listas e gráficos. |
| `lotes` | `list` | Array de objetos `Lote`. Usado p/ lookup de nomes e peso médio. |
| `records` | `queue:...` | **Fila de Sincronização**. Armazena operações pendentes (`create`, `update`). |
| `meta` | `session_config` | Configuração da sessão (IDs, módulos ativos). |

### Modelo de Dados: Animal
Exemplo de objeto salvo em `animais.list`:
```json
{
  "_id": "local:uuid-v4...",      // ID local (temp) ou do servidor
  "_local": true,                 // Flag: criado localmente
  "_sync": "pending",             // Flag: pendente de envio
  "brinco_padrao": "123",
  "nome_completo": "Mimoso",
  "sexo": "MACHO",
  "raca": "Nelore",
  "peso_atual_kg": 450.5,
  "data_nascimento": "2023-01-01",
  "ativo": true,
  "morto": false,
  "deleted": false
}
```

---

## 5. Lógica de Sincronização

### 1. Bootstrap (Download)
Ao abrir o app com internet:
1. `bootstrapData()` busca JSON no endpoint Bubble.
2. Salva tudo no IndexedDB (`fazenda`, `owner`, `animais`, etc.).
3. Habilita o uso offline.

### 2. Queue (Upload)
Ao salvar um animal offline:
1. O objeto é salvo em `animais.list` (com `_sync: "pending"`).
2. Uma entrada é adicionada em `records` (chave `queue:{fazenda}:{owner}:animal`).
3. Payload da fila: `{ op: "animal_create", at: timestamp, payload: data }`.

### 3. Sync Button (Processamento)
Lógica `checkSyncStatus()` e `processQueue()`:
- **Condição Visibilidade**: `navigator.onLine === true` **E** `records` contém itens na fila.
- **Ação**:
    1. Lê a fila.
    2. Envia para API (simulado por enquanto com `timeout` de 1.5s).
    3. Se sucesso: remove da fila.
    4. Atualiza UI (remove alertas 🕒/☁️).

---

## 6. Componentes & Layout

### Dashboard
- **Header**: Logo, Boas-vindas (Nome Usuário).
- **Módulos Grid**: Lista horizontal/grid de atalhos para os módulos.
- **Gráficos**:
    - **Sexo (Donut CSS)**: SVG circular com `stroke-dasharray`.
    - **Categorias (Barras)**: Divs com largura `%` baseada no valor.
    - **Peso por Lote (Barras)**: Agrupado por `id_lote`, exibe `nome_lote`.

### Listas (Ex: Animais)
- **Header**: Busca, Botão "Novo".
- **Tabela**: Colunas (Brinco, Sexo, Raça, Peso, Status).
- **Cards (Mobile)**: (Planejado/Opcional, atualmente usa tabela scrollável).

### Forms
- **Edição/Criação**: Inputs padronizados, validação básica.
- **Botão Voltar**: Retorna para a lista ou Dashboard.

---

> **Desenvolvedor:** Documentação gerada por Antigravity.
