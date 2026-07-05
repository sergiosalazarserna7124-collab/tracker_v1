-- AUT-1217: Normalizar embudo_personalizado name→nombre + regenerar descripcion métricas
-- Cuentas 44-52 se guardaron con llave "name" en vez de "nombre" en embudo_personalizado,
-- y sus métricas embudo_etapa quedaron con descripcion "undefined" y sin nombre.
-- Idempotente: solo toca cuentas 44-52 que tengan el problema.
-- El runner de migrate.ts envuelve cada migración en su propia transacción.

-- Paso 1: Normalizar embudo_personalizado — copiar name→nombre (si nombre no existe), luego borrar name
UPDATE cuentas
SET embudo_personalizado = (
  SELECT jsonb_agg(
    (elem - 'name')
    || jsonb_build_object('nombre', COALESCE(elem->>'nombre', elem->>'name'))
  ORDER BY ordinality)
  FROM jsonb_array_elements(embudo_personalizado) WITH ORDINALITY AS e(elem, ordinality)
)
WHERE id_cuenta BETWEEN 44 AND 52
  AND embudo_personalizado::text LIKE '%"name"%';

-- Paso 2: Regenerar nombre y descripcion en metricas_config para tipo=embudo_etapa
-- Deriva el nombre desde el embudo_personalizado ya normalizado
UPDATE cuentas
SET metricas_config = (
  SELECT jsonb_agg(
    CASE
      WHEN m.elem->>'tipo' = 'embudo_etapa'
           AND m.elem->>'id' LIKE 'embudo-%'
      THEN m.elem
           || jsonb_build_object(
                'nombre', COALESCE(
                  (SELECT e.elem->>'nombre'
                   FROM jsonb_array_elements(embudo_personalizado) AS e(elem)
                   WHERE e.elem->>'id' = substring(m.elem->>'id' FROM 8)),
                  m.elem->>'nombre'
                ),
                'descripcion', 'Leads clasificados como "' ||
                  COALESCE(
                    (SELECT e.elem->>'nombre'
                     FROM jsonb_array_elements(embudo_personalizado) AS e(elem)
                     WHERE e.elem->>'id' = substring(m.elem->>'id' FROM 8)),
                    'undefined'
                  ) || '"'
              )
      ELSE m.elem
    END
  ORDER BY m.ordinality)
  FROM jsonb_array_elements(metricas_config) WITH ORDINALITY AS m(elem, ordinality)
)
WHERE id_cuenta BETWEEN 44 AND 52
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(metricas_config) AS chk(elem)
    WHERE chk.elem->>'descripcion' LIKE '%"undefined"%'
  );
