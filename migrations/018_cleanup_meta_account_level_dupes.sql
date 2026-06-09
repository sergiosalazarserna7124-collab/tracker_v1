-- AUT-804: Remove legacy account-level Meta rows where campaign-level rows exist.
-- Safe: only deletes rows with (campana IS NULL OR campana='') AND datos_extra IS NULL
-- when campaign-level rows (campana != '' AND campana IS NOT NULL) already exist
-- for the same (id_cuenta, fecha, plataforma='meta').

DELETE FROM resumenes_diarios_ads a
WHERE a.plataforma = 'meta'
  AND (a.campana IS NULL OR a.campana = '')
  AND a.datos_extra IS NULL
  AND EXISTS (
    SELECT 1 FROM resumenes_diarios_ads b
    WHERE b.id_cuenta = a.id_cuenta
      AND b.fecha = a.fecha
      AND b.plataforma = 'meta'
      AND b.campana IS NOT NULL
      AND b.campana != ''
  );
