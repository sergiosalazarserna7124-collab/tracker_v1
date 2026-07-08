import type { FastifyRequest, FastifyReply } from "fastify";
import {
  getCanalesActivos,
  updateCanalesActivos,
  parseCanalesActivos,
} from "../../services/data/canales-activos.service.js";

export interface CuentaParams {
  id: string;
}

export async function handleGetCanalesActivos(
  request: FastifyRequest<{ Params: CuentaParams }>,
  reply: FastifyReply,
): Promise<void> {
  const idCuenta = parseInt(request.params.id, 10);
  if (isNaN(idCuenta)) {
    return reply.status(400).send({ success: false, error: "id debe ser un número" });
  }

  const tenantId = request.apiKeyAuth?.idCuenta;
  if (!tenantId || tenantId !== idCuenta) {
    return reply.status(403).send({ success: false, error: "Forbidden" });
  }

  try {
    const canales = await getCanalesActivos(idCuenta);
    return reply.send({ success: true, canales_activos: canales });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no encontrada")) {
      return reply.status(404).send({ success: false, error: msg });
    }
    throw err;
  }
}

export async function handlePatchCanalesActivos(
  request: FastifyRequest<{ Params: CuentaParams }>,
  reply: FastifyReply,
): Promise<void> {
  const idCuenta = parseInt(request.params.id, 10);
  if (isNaN(idCuenta)) {
    return reply.status(400).send({ success: false, error: "id debe ser un número" });
  }

  const tenantId = request.apiKeyAuth?.idCuenta;
  if (!tenantId || tenantId !== idCuenta) {
    return reply.status(403).send({ success: false, error: "Forbidden" });
  }

  const body = request.body as unknown;

  let canalesNuevos = null;
  if (body !== null && body !== undefined) {
    try {
      canalesNuevos = parseCanalesActivos(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ success: false, error: msg });
    }
  }

  try {
    const canales = await updateCanalesActivos(idCuenta, canalesNuevos);
    return reply.send({ success: true, canales_activos: canales });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no encontrada")) {
      return reply.status(404).send({ success: false, error: msg });
    }
    throw err;
  }
}
