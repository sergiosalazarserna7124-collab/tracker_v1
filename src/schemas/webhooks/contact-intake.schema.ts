import { Type, type Static } from "@sinclair/typebox";

export const ContactIntakeBody = Type.Object({
  nombre: Type.String({ minLength: 1 }),
  telefono: Type.Optional(Type.String({ minLength: 1 })),
  email: Type.Optional(Type.String({ format: "email" })),
  id_cliente_interno: Type.String({ minLength: 1 }),
});

export type ContactIntakeBodyType = Static<typeof ContactIntakeBody>;
