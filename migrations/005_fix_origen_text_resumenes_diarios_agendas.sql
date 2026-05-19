-- Migración 005: Ampliar columna origen en resumenes_diarios_agendas
-- Parte de AUT-264: error "value too long for type character varying(100)"
-- en webhooks de Serenthys (id=18) con orígenes de video GHL > 100 chars.
-- El schema Drizzle ya define origen como text() — esta migración sincroniza la BD.

ALTER TABLE resumenes_diarios_agendas
  ALTER COLUMN origen TYPE text;
