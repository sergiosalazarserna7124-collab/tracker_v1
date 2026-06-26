import { eq, and } from "drizzle-orm";
import { drizzleDb } from "../../config/drizzle.js";
import { cuentas, mapeoIdExterno } from "../../db/schema.js";
import type { ContactIntakeBodyType } from "../../schemas/webhooks/contact-intake.schema.js";
import {
  getAccountById,
  searchContactByPhone,
  searchContactByEmail,
  createContact,
  type CreateContactPayload,
} from "../ghl-api.service.js";

export interface ContactIntakeResult {
  created: boolean;
  ghl_contact_id: string;
  id_cliente_interno: string;
  action: "created" | "existing";
}

export async function processContactIntake(
  idCuenta: number,
  body: ContactIntakeBodyType,
): Promise<ContactIntakeResult> {
  const { nombre, telefono, email, id_cliente_interno } = body;

  // 1. Check idempotency — if this id_cliente_interno already mapped, return existing
  const [existing] = await drizzleDb
    .select({
      ghl_contact_id: mapeoIdExterno.ghl_contact_id,
      id_cliente_interno: mapeoIdExterno.id_cliente_interno,
    })
    .from(mapeoIdExterno)
    .where(
      and(
        eq(mapeoIdExterno.id_cuenta, idCuenta),
        eq(mapeoIdExterno.id_cliente_interno, id_cliente_interno),
      ),
    )
    .limit(1);

  if (existing) {
    return {
      created: false,
      ghl_contact_id: existing.ghl_contact_id,
      id_cliente_interno: existing.id_cliente_interno,
      action: "existing",
    };
  }

  // 2. Get account data (token + locationId)
  const account = await getAccountById(idCuenta);
  if (!account) {
    throw new Error(`Account ${idCuenta} not found`);
  }
  if (!account.token_ghl) {
    throw new Error(`Account ${idCuenta} has no GHL token configured`);
  }
  if (!account.locationid) {
    throw new Error(`Account ${idCuenta} has no GHL locationId configured`);
  }

  const token = account.token_ghl;
  const locationId = account.locationid;

  // 3. Dedup: search GHL by phone or email to avoid creating duplicate contacts
  let existingGhlId: string | null = null;

  if (telefono) {
    const byPhone = await searchContactByPhone(locationId, telefono, token);
    if (byPhone) existingGhlId = byPhone.id;
  }

  if (!existingGhlId && email) {
    const byEmail = await searchContactByEmail(locationId, email, token);
    if (byEmail) existingGhlId = byEmail.id;
  }

  let ghlContactId: string;
  let created = false;

  if (existingGhlId) {
    ghlContactId = existingGhlId;
  } else {
    // 4. Create contact in GHL
    const nameParts = nombre.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : undefined;

    const payload: CreateContactPayload = {
      firstName,
      lastName,
      phone: telefono,
      email,
    };

    const result = await createContact(locationId, token, payload);
    ghlContactId = result.id;
    created = true;
  }

  // 5. Persist mapping in BD
  await drizzleDb.insert(mapeoIdExterno).values({
    id_cuenta: idCuenta,
    id_cliente_interno,
    ghl_contact_id: ghlContactId,
    telefono: telefono ?? null,
    email: email ?? null,
    nombre,
  });

  console.info(
    `[contact-intake] ${created ? "Created" : "Linked"} contact for account=${idCuenta} ` +
    `id_cliente_interno=${id_cliente_interno} ghl_contact_id=${ghlContactId}`,
  );

  return {
    created,
    ghl_contact_id: ghlContactId,
    id_cliente_interno,
    action: created ? "created" : "existing",
  };
}
