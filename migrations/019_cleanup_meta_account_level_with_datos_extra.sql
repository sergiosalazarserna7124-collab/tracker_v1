-- AUT-910: Remove ALL account-level Meta rows where campaign-level rows exist,
-- regardless of datos_extra. Migration 018 missed rows with datos_extra IS NOT NULL
-- (written by the sync with { source: "account_level" }), causing double counting.

DELETE FROM resumenes_diarios_ads a
WHERE a.plataforma = 'meta'
  AND (a.campana IS NULL OR a.campana = '')
  AND EXISTS (
    SELECT 1 FROM resumenes_diarios_ads b
    WHERE b.id_cuenta = a.id_cuenta
      AND b.fecha = a.fecha
      AND b.plataforma = 'meta'
      AND b.campana IS NOT NULL
      AND b.campana != ''
  );
