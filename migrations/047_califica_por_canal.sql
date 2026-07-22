-- AUT-1739: Toggle "califica" por canal en criterios_calificacion
-- Preserva comportamiento existente: todos los canales mantienen califica=true.
-- Nuevos tenants (criterios NULL) obtienen el default de producto via código
-- (llamadas=false, chats/videollamadas=true).
-- Idempotente: solo actualiza filas donde califica no está seteado.

-- Tenants con canales.llamadas existente pero sin califica
UPDATE cuentas
SET criterios_calificacion = jsonb_set(
  criterios_calificacion,
  '{canales,llamadas,califica}',
  'true'::jsonb
)
WHERE criterios_calificacion IS NOT NULL
  AND criterios_calificacion -> 'canales' -> 'llamadas' IS NOT NULL
  AND NOT (criterios_calificacion #>> '{canales,llamadas,califica}' IS NOT NULL);

-- Tenants con canales.chats existente pero sin califica
UPDATE cuentas
SET criterios_calificacion = jsonb_set(
  criterios_calificacion,
  '{canales,chats,califica}',
  'true'::jsonb
)
WHERE criterios_calificacion IS NOT NULL
  AND criterios_calificacion -> 'canales' -> 'chats' IS NOT NULL
  AND NOT (criterios_calificacion #>> '{canales,chats,califica}' IS NOT NULL);

-- Tenants con canales.videollamadas existente pero sin califica
UPDATE cuentas
SET criterios_calificacion = jsonb_set(
  criterios_calificacion,
  '{canales,videollamadas,califica}',
  'true'::jsonb
)
WHERE criterios_calificacion IS NOT NULL
  AND criterios_calificacion -> 'canales' -> 'videollamadas' IS NOT NULL
  AND NOT (criterios_calificacion #>> '{canales,videollamadas,califica}' IS NOT NULL);

-- Tenants con criterios pero sin canales.llamadas: agregar canal completo con califica=true
UPDATE cuentas
SET criterios_calificacion = jsonb_set(
  CASE
    WHEN criterios_calificacion -> 'canales' IS NULL
    THEN jsonb_set(criterios_calificacion, '{canales}', '{}'::jsonb)
    ELSE criterios_calificacion
  END,
  '{canales,llamadas}',
  '{"categorias_calificadas":["calificada","cerrada","interesado","agendado","reagendado","confirmado"],"umbral_minimo":1,"califica":true}'::jsonb
)
WHERE criterios_calificacion IS NOT NULL
  AND (criterios_calificacion -> 'canales' -> 'llamadas' IS NULL);
