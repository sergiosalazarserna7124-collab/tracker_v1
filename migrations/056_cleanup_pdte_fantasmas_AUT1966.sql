-- AUT-1966: limpieza de 44 registros fantasma (pdte duplicados por dedup fuera de orden).
-- Cada fantasma tiene un sibling resuelto del mismo lead; primero enriquecemos el
-- sibling con closer/id_user_ghl si le faltan, luego eliminamos el fantasma.
-- Lista determinista e idempotente por id_registro.
-- Aprobado por Juan en AUT-1960 (confirmación d23a0ddd).

-- Paso 1: enriquecer siblings resueltos con datos del closer que solo tiene el fantasma.
DO $$
DECLARE
  fantasma RECORD;
  sibling_id INTEGER;
BEGIN
  FOR fantasma IN
    SELECT id_registro, id_cuenta, mail_lead, phone_raw_format, ghl_contact_id,
           id_user_ghl, closer_mail, nombre_closer, fecha_evento
    FROM registros_de_llamada
    WHERE id_registro IN (
      106613,106615,106744,107002,107088,107158,107493,107603,107814,107936,
      107981,107992,108099,108410,108411,108414,108470,108480,108692,108703,
      108724,108735,108888,108975,109054,109070,109074,109177,109183,109407,
      109452,109492,109531,109582,109590,109606,109640,109718,109728,109931,
      110019,110066,110081,110086
    )
      AND estado = 'pdte'
  LOOP
    SELECT r.id_registro INTO sibling_id
    FROM registros_de_llamada r
    WHERE r.id_cuenta = fantasma.id_cuenta
      AND r.id_registro != fantasma.id_registro
      AND r.estado != 'pdte'
      AND (
        (fantasma.phone_raw_format IS NOT NULL AND r.phone_raw_format = fantasma.phone_raw_format)
        OR (fantasma.ghl_contact_id IS NOT NULL AND r.ghl_contact_id = fantasma.ghl_contact_id)
        OR (fantasma.mail_lead IS NOT NULL AND LOWER(r.mail_lead) = LOWER(fantasma.mail_lead))
      )
    ORDER BY ABS(EXTRACT(EPOCH FROM (r.fecha_evento - fantasma.fecha_evento)))
    LIMIT 1;

    IF sibling_id IS NOT NULL THEN
      UPDATE registros_de_llamada
      SET
        closer_mail = COALESCE(closer_mail, fantasma.closer_mail),
        nombre_closer = COALESCE(nombre_closer, fantasma.nombre_closer),
        id_user_ghl = COALESCE(id_user_ghl, fantasma.id_user_ghl)
      WHERE id_registro = sibling_id;
    END IF;
  END LOOP;
END $$;

-- Paso 2: eliminar los fantasmas (solo los que siguen en estado pdte).
DELETE FROM registros_de_llamada
WHERE id_registro IN (
  106613,106615,106744,107002,107088,107158,107493,107603,107814,107936,
  107981,107992,108099,108410,108411,108414,108470,108480,108692,108703,
  108724,108735,108888,108975,109054,109070,109074,109177,109183,109407,
  109452,109492,109531,109582,109590,109606,109640,109718,109728,109931,
  110019,110066,110081,110086
)
  AND estado = 'pdte';
