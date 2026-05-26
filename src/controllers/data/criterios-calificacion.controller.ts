/**
 * Controller: GET/PATCH /api/cuentas/:id/criterios-calificacion
 *
 * AUT-413: criterios de calificación configurables por cuenta.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  getCriteriosCalificacion,
  updateCriteriosCalificacion,
  parseCriteriosCalificacion,
} from "../../services/data/criterios-calificacion.service.js";

export interface CuentaParams {
  id: string;
}

export async function handleGetCriteriosCalificacion(
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
    const criterios = await getCriteriosCalificacion(idCuenta);
    return reply.send({ success: true, criterios_calificacion: criterios });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no encontrada")) {
      return reply.status(404).send({ success: false, error: msg });
    }
    throw err;
  }
}

export async function handlePatchCriteriosCalificacion(
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

  // null body = limpiar criterios (volver a comportamiento default)
  let criteriosNuevos = null;
  if (body !== null && body !== undefined) {
    try {
      criteriosNuevos = parseCriteriosCalificacion(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ success: false, error: msg });
    }
  }

  try {
    const criterios = await updateCriteriosCalificacion(idCuenta, criteriosNuevos);
    return reply.send({ success: true, criterios_calificacion: criterios });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no encontrada")) {
      return reply.status(404).send({ success: false, error: msg });
    }
    throw err;
  }
}
