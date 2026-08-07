-- Speed to lead ASESOR: necesita saber CUÁNDO se le asignó el lead al asesor.
-- fecha_asignacion se setea/actualiza cuando cambia el assignedTo (ContactUpdate).
-- Si el lead se reasigna, se resetea (el reloj cuenta "desde que te dieron el lead").

ALTER TABLE registros_de_llamada
  ADD COLUMN IF NOT EXISTS fecha_asignacion TIMESTAMPTZ;
