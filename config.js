/**
 * Configurações centralizadas da aplicação
 * URLs de API e listas fixas para dropdowns
 */

// ========================================================
// URLs DE API
// ========================================================

export const API_CONFIG = {
  // Base URL para endpoints do Bubble
  BASE_URL: "https://bovichain-g3.bubbleapps.io/version-0342o/api/1.1/wf",
  
  // Base URL para busca de dados (endpoint diferente)
  BOOTSTRAP_BASE_URL: "https://app.bovichain.com/version-0342o/api/1.1/wf",
  
  // Endpoints
  ENDPOINTS: {
    GET_DADOS: "get_dados",
    SYNC_DADOS: "sync_dados",
    STATUS_OFFLINE: "status_offline"
  },
  
  // Função auxiliar para construir URL completa
  getUrl(endpoint, useBootstrapBase = false) {
    const base = useBootstrapBase ? this.BOOTSTRAP_BASE_URL : this.BASE_URL;
    return `${base}/${endpoint}`;
  },
  
  // Função auxiliar para construir URL de busca com parâmetros
  getBootstrapUrl(fazendaId, ownerId) {
    const url = new URL(`${this.BOOTSTRAP_BASE_URL}/${this.ENDPOINTS.GET_DADOS}`);
    url.searchParams.set("fazenda", fazendaId);
    url.searchParams.set("owner", ownerId);
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

// ========================================================
// CONFIGURAÇÕES DE SINCRONIZAÇÃO
// ========================================================

export const SYNC_CONFIG = {
  // Intervalo de polling para verificar status (em milissegundos)
  POLL_INTERVAL_MS: 20000, // 20 segundos
};
