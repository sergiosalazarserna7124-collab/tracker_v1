// ─── Tipos para MetricaConfig ────────────────────────────────────────────────
// El campo metricas_config en la tabla cuentas es JSONB con estructura MetricaConfig[].

export type ChatCampo =
  | "ia_categoria"
  | "estado"
  | "origen"
  | "asesor_asignado"
  | "tags_internos"
  | "ia_objeciones"
  | "primer_msg_lead_at";

export type ChatAgregacion =
  | "count"           // total de chats
  | "count_distinct"  // valores únicos del campo
  | "count_by_value"  // conteo agrupado por valor del campo (devuelve Record<string,number>)
  | "avg_response_time" // tiempo promedio de respuesta (primer_msg_lead_at)
  | "speed_post_bot";   // promedio minutos entre bot_delegacion_at y primer contacto del asesor (AUT-1762)

export interface MetricaConfigBase {
  id: string;
  nombre: string;
  descripcion?: string;
}

export interface MetricaConfigManual extends MetricaConfigBase {
  tipo: "manual";
}

export interface MetricaConfigAutomatica extends MetricaConfigBase {
  tipo: "automatica";
  campo: string;
}

export interface MetricaConfigWebhook extends MetricaConfigBase {
  tipo: "webhook";
  webhook_key: string;
}

export interface MetricaConfigAds extends MetricaConfigBase {
  tipo: "ads";
  adsCampo: string;
  adsAgregacion?: string;
}

export interface MetricaConfigEmbudoEtapa extends MetricaConfigBase {
  tipo: "embudo_etapa";
  etapaId: string;
}

export interface MetricaConfigChat extends MetricaConfigBase {
  tipo: "chat";
  /** Campo de chats_logs a agregar */
  chatCampo: ChatCampo;
  /** Tipo de agregación a aplicar */
  chatAgregacion: ChatAgregacion;
  /** Filtro opcional: solo incluir chats donde chatCampo == este valor */
  chatFiltroValor?: string;
}

export type KeywordMatchScope = "mensajes_lead" | "todo_el_chat";
export type KeywordCountMode = "chats" | "ocurrencias";

export interface MetricaConfigChatKeyword extends MetricaConfigBase {
  tipo: "chat";
  chatSubtipo: "conteo_keyword";
  keywords: string[];
  matchScope?: KeywordMatchScope;
  countMode?: KeywordCountMode;
  normalizeAccents?: boolean;
  paneles?: string[];
}

export type MetricaConfig =
  | MetricaConfigManual
  | MetricaConfigAutomatica
  | MetricaConfigWebhook
  | MetricaConfigAds
  | MetricaConfigEmbudoEtapa
  | MetricaConfigChat
  | MetricaConfigChatKeyword;

// ─── Resultado de métrica custom de chat ─────────────────────────────────────

export interface ChatMetricaResultado {
  id: string;
  nombre: string;
  tipo: "chat";
  valor: number | Record<string, number>;
}
