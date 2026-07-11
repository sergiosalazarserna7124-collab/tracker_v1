-- AUT-1490: activate ghl_native_task_workflow for grupo-daxi (cuenta 49)
-- Authorized by Juan (confirmation 5ac6cce5 on AUT-1458, accepted 2026-07-10)
-- and CTO (comment 96f8b371 on AUT-1490, 2026-07-11)
UPDATE public.cuentas SET ghl_native_task_workflow = true WHERE id_cuenta = 49;
