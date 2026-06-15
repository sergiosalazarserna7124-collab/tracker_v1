-- AUT-952: Re-apply account-level Meta cleanup (020 was baseline-seeded without execution).
-- Idempotent: deletes account-level rows only where campaign-level rows exist for same cuenta+fecha.

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
