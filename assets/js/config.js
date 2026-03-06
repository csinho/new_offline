/**
 * Configurações centralizadas da aplicação
 * URLs de API e listas fixas para dropdowns
 */

// ========================================================
// URLs DE API
// ========================================================

export const API_CONFIG = {

  VERSION_BUBBLE: "735lp",

  // Base URL para endpoints do Bubble
  BASE_URL: `https://bovichain-g3.bubbleapps.io/version-${API_CONFIG.VERSION_BUBBLE}/api/1.1/wf`,
  
  // Base URL para busca de dados (endpoint diferente)
  BOOTSTRAP_BASE_URL: `https://app.bovichain.com/version-${API_CONFIG.VERSION_BUBBLE}/api/1.1/wf`,
  
  // Endpoints
  ENDPOINTS: {
    GET_DADOS: "get_dados",
    GET_MODULOS: "get_modulos",
    SYNC_DADOS: "sync_dados",
    STATUS_OFFLINE: "status_offline"
  },
  
  // Função auxiliar para construir URL completa
  getUrl(endpoint, useBootstrapBase = false) {
    const base = useBootstrapBase ? this.BOOTSTRAP_BASE_URL : this.BASE_URL;
    return `${base}/${endpoint}`;
  },
  
  // Função auxiliar para construir URL de busca com parâmetros
  getBootstrapUrl(fazendaId, colaboradorId) {
    const url = new URL(`${this.BOOTSTRAP_BASE_URL}/${this.ENDPOINTS.GET_DADOS}`);
    url.searchParams.set("fazenda", fazendaId);
    url.searchParams.set("colaborador", colaboradorId);
    return url.toString();
  },
  
  // Função auxiliar para construir URL de busca de módulos com parâmetro id
  getModulosUrl(id) {
    const url = new URL(`${this.BOOTSTRAP_BASE_URL}/${this.ENDPOINTS.GET_MODULOS}`);
    url.searchParams.set("id", id);
    return url.toString();
  }
};

// ========================================================
// LISTAS FIXAS PARA DROPDOWNS
// ========================================================

/**
 * Mapeamento de siglas UF para nomes completos
 */
export const UF_MAP = {
  "AC": "Acre",
  "AL": "Alagoas",
  "AP": "Amapá",
  "AM": "Amazonas",
  "BA": "Bahia",
  "CE": "Ceará",
  "DF": "Distrito Federal",
  "ES": "Espírito Santo",
  "GO": "Goiás",
  "MA": "Maranhão",
  "MT": "Mato Grosso",
  "MS": "Mato Grosso do Sul",
  "MG": "Minas Gerais",
  "PA": "Pará",
  "PB": "Paraíba",
  "PR": "Paraná",
  "PE": "Pernambuco",
  "PI": "Piauí",
  "RJ": "Rio de Janeiro",
  "RN": "Rio Grande do Norte",
  "RS": "Rio Grande do Sul",
  "RO": "Rondônia",
  "RR": "Roraima",
  "SC": "Santa Catarina",
  "SP": "São Paulo",
  "SE": "Sergipe",
  "TO": "Tocantins"
};

/**
 * Lista de estados (UF) para dropdown
 * Array de objetos { value: "AC", label: "Acre" }
 */
export const UF_LIST = Object.entries(UF_MAP).map(([value, label]) => ({
  value,
  label
}));

/**
 * Lista de raças de gado
 */
export const RACAS_LIST = [
  "Aberdeen Angus",
  "Africander",
  "Anatolian",
  "Assam",
  "Azeri",
  "Badhawari",
  "Bangladesh",
  "Banni",
  "Barzona",
  "Beefalo",
  "Beefmaster",
  "Belgian Blue",
  "Bonsmara",
  "Braford",
  "Brahman",
  "Brangus",
  "Campino Red Pied",
  "Canchim",
  "Cangaian",
  "Carabao",
  "Charolês",
  "Chianina",
  "Chilika",
  "Devon",
  "Egyptian",
  "Gir",
  "Gir Leiteiro",
  "Girolando",
  "Grauvieh",
  "Groninger",
  "Guzerá",
  "Hereford",
  "Híbrido",
  "Holandesa",
  "Jafarabadi",
  "Jersey",
  "Limousin",
  "Kobe (Wagyu)",
  "Kundi",
  "Manda",
  "Marchigiana",
  "Mediterrâneo",
  "Meshana",
  "Murrah",
  "Murray Gray",
  "Nagpuri",
  "Nelore",
  "Nelore Mocho",
  "Nili-Ravi",
  "Norwegian Red",
  "Pandharpuri",
  "Pardo Suiço",
  "Ranger",
  "Red Angus",
  "Red Brangus",
  "Red Poll",
  "Romagnola",
  "Senepol",
  "Simental",
  "Sindi",
  "South Kanara",
  "Surti",
  "Tabapuã",
  "Toda",
  "Tucura",
  "Wagyu"
];

/**
 * Lista de finalidades
 */
export const FINALIDADE_LIST = [
  "Cria",
  "Recria",
  "Engorda"
];

/**
 * Lista de categorias
 */
export const CATEGORIA_LIST = [
  "Bezerro",
  "Garrote",
  "Touro",
  "Bezerra",
  "Novilha",
  "Vaca"
];

/**
 * Lista de sexo
 */
export const SEXO_LIST = [
  { value: "M", label: "Macho" },
  { value: "F", label: "Fêmea" }
];

/**
 * Lista de tipo de animal
 */
export const TIPO_ANIMAL_LIST = [
  "Físico",
  "Genealogia"
];

/**
 * Lista de tipo de entrada (entry_type)
 */
export const ENTRY_TYPE_LIST = [
  "Nascimento",
  "Compra",
  "Doação",
  "Empréstimo",
  "Ajuste inventário"
];

/**
 * Lista de condições de pagamento (venda / saída de animais)
 */
export const CONDICAO_PAGAMENTO_LIST = [
  "A vista",
  "parcelado"
];

/**
 * Lista de tipos de movimentação saída de animal (create_saida_animais)
 * Valor enviado no payload como "movimentacao_saida_animal"
 */
export const MOVIMENTACAO_SAIDA_ANIMAL_LIST = [
  "Venda",
  "Morte",
  "Empréstimo",
  "Ajuste inventário",
  "Doação"
];

/**
 * Mapeamento saída → entrada (ENTRY_TYPE_LIST) para movimentacao_entrada_animal.
 * Quando há saída (ex.: Venda), o destino registra entrada (ex.: Compra).
 * "Morte" não tem entrada correspondente (retorna "").
 */
export const MOVIMENTACAO_SAIDA_TO_ENTRADA = {
  "Venda": "Compra",
  "Doação": "Doação",
  "Empréstimo": "Empréstimo",
  "Ajuste inventário": "Ajuste inventário",
  "Morte": ""
};

/**
 * Opções do dropdown "Causa da morte" (aba Morte em saida_animais)
 */
export const CAUSA_MORTE_LIST = [
  "Doença Infecciosa",
  "Problema Metabólico ou nutricional",
  "Complicações no Parto",
  "Outros"
];

/**
 * Opções do dropdown "Tipo de pesagem" (módulo Pesagem)
 */
export const TIPO_PESAGEM_LIST = [
  "Pesagem regular",
  "Desmame"
];

// ========================================================
// OPERAÇÕES OFFLINE (fila / dados.operacoes)
// ========================================================
/**
 * Nomes oficiais das operações enviadas em dados.operacoes (offline).
 * Toda a aplicação deve usar APENAS estas constantes (nunca strings diretas).
 */
export const OFFLINE_OPS = {
  ANIMAL_CREATE: "animal_create",
  ANIMAL_CREATE_PESO: "animal_create_peso",

  CREATE_SAIDA_ANIMAIS_VENDA: "create_saida_animais_venda",
  CREATE_SAIDA_ANIMAIS_MORTE: "create_saida_animais_morte",
  CREATE_SAIDA_ANIMAIS_EMPRESTIMO: "create_saida_animais_emprestimo",
  CREATE_SAIDA_ANIMAIS_AJU_INVENTARIO: "create_saida_animais_aju_inventario",
  CREATE_SAIDA_ANIMAIS_DOACAO: "create_saida_animais_doacao",

  MOVIMENTACAO_ENTRE_LOTES: "movimentacao_entre_lotes",
  MOVIMENTACAO_ENTRE_PASTOS: "movimentacao_entre_pastos",

  // Caso especial: entre fazendas (envelope dados.op permanece update_fazenda_new)
  MOVIMENTACAO_ENTRE_FAZENDAS: "movimentacao_entre_fazendas",

  // Atualização genérica de atributos do animal (nome, valor, raça, etc.)
  ANIMAL_UPDATE: "animal_update",
};

/**
 * Mapeia o tipo de saída (movimentacao_saida_animal) para a operação offline correspondente.
 * Ex.: "Venda" → "create_saida_animais_venda".
 */
export const SAIDA_TIPO_TO_OFFLINE_OP = {
  "Venda": OFFLINE_OPS.CREATE_SAIDA_ANIMAIS_VENDA,
  "Morte": OFFLINE_OPS.CREATE_SAIDA_ANIMAIS_MORTE,
  "Empréstimo": OFFLINE_OPS.CREATE_SAIDA_ANIMAIS_EMPRESTIMO,
  "Ajuste inventário": OFFLINE_OPS.CREATE_SAIDA_ANIMAIS_AJU_INVENTARIO,
  "Doação": OFFLINE_OPS.CREATE_SAIDA_ANIMAIS_DOACAO,
};

// ========================================================
// MÓDULOS DO APP (nomes para usar no Bubble ao criar módulos)
// ========================================================
/**
 * Lista de módulos do sistema. Usar estes mesmos nomes no Bubble ao configurar
 * módulos acessíveis (ex.: get_modulos deve retornar estes keys).
 * frontend: "pronto" = tela implementada no PWA; "pendente" = ainda não.
 */
export const MODULES = [
  { key: "animal", label: "Animais", frontend: "pronto" },
  { key: "movimentacao", label: "Movimentações", frontend: "pronto" },
  { key: "pesagem", label: "Pesagem", frontend: "pronto" },
  { key: "saida_animais", label: "Saída de Animais", frontend: "pronto" },
  { key: "vacinacao", label: "Vacinação", frontend: "pendente" },
  { key: "manejo", label: "Manejo", frontend: "pendente" },
  { key: "organizacao", label: "Organização", frontend: "pendente" },
  { key: "fazenda", label: "Fazenda", frontend: "pendente" },
  { key: "colaboradores", label: "Colaboradores", frontend: "pendente" },
  { key: "sanidade", label: "Sanidade", frontend: "pendente" },
  { key: "reproducao", label: "Reprodução", frontend: "pendente" },
  { key: "nutricao", label: "Nutrição", frontend: "pendente" },
  { key: "financeiro", label: "Financeiro", frontend: "pendente" },
];

// ========================================================
// CAMPOS PADRÃO POR MÓDULO/ABA (get_modulos)
// ========================================================
/**
 * Lista de keys conhecidas por (módulo, aba). Quando o backend envia uma aba com
 * "campos" vazio ou ausente, o script preenche automaticamente com todos estes
 * atributos (value: "", type: "OS"). Quando "campos" traz alguns itens, esses
 * definem o pré-preenchimento (key, value, type); o script completa com as keys
 * que faltam para o formulário ter todos os atributos.
 * Ver KEYS_LINHA_DE_PRODUCAO.md.
 */
export const DEFAULT_ABA_CAMPOS_KEYS = {
  movimentacao: {
    lotes: ["lote"],
    pastos: ["pasto"],
    fazendas: ["fazenda_destino", "lote", "pasto"],
  },
  pesagem: {
    // Módulo Pesagem: uma única aba "Pesagem" com estes campos principais.
    pesagem: ["colaborador", "tipo_pesagem", "peso", "data_pesagem"],
  },
  saida_animais: {
    venda: [
      "condicao_pagamento",
      "movimentacao_saida_animal",
      "valor",
      "peso_saida",
      "data_aquisicao",
      "nota_fiscal",
      "numero_gta",
      "data_emissao_gta",
      "data_validade_gta",
      "serie_gta",
      "uf_gta",
      "proprietario_destino",
      "fazenda_destino",
      "animal",
    ],
    doacao: [
      // Doação reutiliza o mesmo layout enxuto de Empréstimo/Ajuste:
      // proprietário, fazenda, data, número da nota e peso.
      "proprietario_destino",
      "fazenda_destino",
      "data_aquisicao",
      "nota_fiscal",
      "peso_saida",
    ],
    morte: [
      "causa_morte",
      "detalhes_observacoes",
      "responsavel",
      "data_morte",
      "imagem_brinco_animal",
      "movimentacao_saida_animal",
    ],
    emprestimo: [
      // Empréstimo usa menos campos na tela; estes são os oficiais:
      // proprietário, fazenda, data, número da nota e peso.
      "proprietario_destino",
      "fazenda_destino",
      "data_aquisicao",
      "nota_fiscal",
      "peso_saida",
    ],
    "ajuste inventário": [
      // Ajuste inventário segue o mesmo layout de Empréstimo:
      // proprietário, fazenda, data, número da nota e peso.
      "proprietario_destino",
      "fazenda_destino",
      "data_aquisicao",
      "nota_fiscal",
      "peso_saida",
    ],
  },
};

// ========================================================
// LINHA DE PRODUÇÃO (PIPELINE)
// ========================================================
/**
 * Ordem dos passos após escolher/criar o animal.
 * Cada passo é um key de módulo: movimentacao (entre lotes), pesagem, saida_animais.
 * Default do fluxo "frente de caixa" no curral.
 */
export const PIPELINE_STEPS = [
  "movimentacao",
  "pesagem",
  "saida_animais"
];

// ========================================================
// CONFIGURAÇÕES DE SINCRONIZAÇÃO
// ========================================================

export const SYNC_CONFIG = {
  // Intervalo de polling para verificar status (em milissegundos)
  POLL_INTERVAL_MS: 20000, // 20 segundos
};
