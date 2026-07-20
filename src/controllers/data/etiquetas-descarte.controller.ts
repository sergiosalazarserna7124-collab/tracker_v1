import type { FastifyRequest, FastifyReply } from "fastify";
import {
  getEtiquetasDescarte,
  updateEtiquetasDescarte,
  parseEtiquetasDescarte,
} from "../../services/data/etiquetas-descarte.service.js";

interface CuentaParams {
  id: string;
}

export async function handleGetEtiquetasDescarte(
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
    const etiquetas = await getEtiquetasDescarte(idCuenta);
    return reply.send({ success: true, etiquetas_descarte: etiquetas });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no encontrada")) {
      return reply.status(404).send({ success: false, error: msg });
    }
    throw err;
  }
}

export async function handlePutEtiquetasDescarte(
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

  let etiquetasNuevas: string[] | null = null;
  if (body !== null && body !== undefined) {
    try {
      etiquetasNuevas = parseEtiquetasDescarte(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ success: false, error: msg });
    }
  }

  try {
    const etiquetas = await updateEtiquetasDescarte(idCuenta, etiquetasNuevas);
    return reply.send({ success: true, etiquetas_descarte: etiquetas });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("no encontrada")) {
      return reply.status(404).send({ success: false, error: msg });
    }
    throw err;
  }
}
