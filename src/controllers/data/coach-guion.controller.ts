import type { FastifyRequest, FastifyReply } from "fastify";
import {
  getGuionesByCuenta,
  getGuionByCategoria,
  upsertGuion,
  deleteGuion,
  isCoachHabilitado,
} from "../../services/data/coach-guion.service.js";

export type CuentaParams = { id: number };
export type CategoriaParams = { id: number; categoriaId: string };

export async function handleGetGuiones(
  request: FastifyRequest<{ Params: CuentaParams }>,
  reply: FastifyReply,
): Promise<void> {
  const idCuenta = request.params.id;

  if (request.apiKeyAuth?.idCuenta !== idCuenta) {
    return reply.status(403).send({ error: "API key no pertenece a esta cuenta" });
  }

  const habilitado = await isCoachHabilitado(idCuenta);
  if (!habilitado) {
    return reply.status(403).send({ error: "Coach no habilitado para esta cuenta" });
  }

  const guiones = await getGuionesByCuenta(idCuenta);
  return reply.send({ guiones });
}

export async function handleGetGuionByCategoria(
  request: FastifyRequest<{ Params: CategoriaParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id: idCuenta, categoriaId } = request.params;

  if (request.apiKeyAuth?.idCuenta !== idCuenta) {
    return reply.status(403).send({ error: "API key no pertenece a esta cuenta" });
  }

  const habilitado = await isCoachHabilitado(idCuenta);
  if (!habilitado) {
    return reply.status(403).send({ error: "Coach no habilitado para esta cuenta" });
  }

  const guion = await getGuionByCategoria(idCuenta, categoriaId);
  if (!guion) {
    return reply.status(404).send({ error: "Guion no encontrado para esta categoría" });
  }

  return reply.send(guion);
}

export async function handleUpsertGuion(
  request: FastifyRequest<{ Params: CuentaParams }>,
  reply: FastifyReply,
): Promise<void> {
  const idCuenta = request.params.id;

  if (request.apiKeyAuth?.idCuenta !== idCuenta) {
    return reply.status(403).send({ error: "API key no pertenece a esta cuenta" });
  }

  const body = request.body as { categoria_llamada_id: string; secciones: unknown[]; umbral?: number };

  const habilitado = await isCoachHabilitado(idCuenta);
  if (!habilitado) {
    return reply.status(403).send({ error: "Coach no habilitado para esta cuenta" });
  }

  try {
    const guion = await upsertGuion(idCuenta, {
      categoria_llamada_id: body.categoria_llamada_id,
      secciones: body.secciones as Parameters<typeof upsertGuion>[1]["secciones"],
      umbral: body.umbral,
    });

    return reply.status(201).send(guion);
  } catch (err) {
    if (err instanceof Error) {
      return reply.status(400).send({ error: err.message });
    }
    throw err;
  }
}

export async function handleDeleteGuion(
  request: FastifyRequest<{ Params: CategoriaParams }>,
  reply: FastifyReply,
): Promise<void> {
  const { id: idCuenta, categoriaId } = request.params;

  if (request.apiKeyAuth?.idCuenta !== idCuenta) {
    return reply.status(403).send({ error: "API key no pertenece a esta cuenta" });
  }

  const habilitado = await isCoachHabilitado(idCuenta);
  if (!habilitado) {
    return reply.status(403).send({ error: "Coach no habilitado para esta cuenta" });
  }

  const deleted = await deleteGuion(idCuenta, categoriaId);
  if (!deleted) {
    return reply.status(404).send({ error: "Guion no encontrado" });
  }

  return reply.status(204).send();
}
