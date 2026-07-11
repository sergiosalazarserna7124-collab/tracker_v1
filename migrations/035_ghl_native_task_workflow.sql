ALTER TABLE public.cuentas ADD COLUMN IF NOT EXISTS ghl_native_task_workflow boolean NOT NULL DEFAULT false;
