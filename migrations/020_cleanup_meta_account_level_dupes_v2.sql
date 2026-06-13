-- AUT-911: Remove account-level Meta rows where campaign-level rows exist.
-- Migration 018 only deleted rows with datos_extra IS NULL; the AUT-906 backfill
-- left datos_extra IS NOT NULL on account-level rows, so they survived.
-- This migration removes ALL account-level duplicates regardless of datos_extra.

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
