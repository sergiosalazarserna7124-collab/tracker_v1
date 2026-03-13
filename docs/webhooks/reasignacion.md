# Webhook Reasignación

**POST** `/webhooks/reasignacion`

Recibe desde GHL los datos de una reasignación de closer. Si faltan nombre o correo del closer, el evento se guarda como huérfano para revisión.

---

## Ejemplo de payload (cómo configurarlo en GHL)

Envía un JSON con `customData` conteniendo los siguientes campos. Puede llegar en formato **directo** o envuelto en array (n8n).

### Formato directo (recomendado para GHL)

```json
{
  "customData": {
    "idusuario": "abc123xyz",
    "locationid": "tuLocationIdDeGhl",
    "correocloser": "closer@empresa.com",
    "nombrecloser": "María García",
    "nombre": "Juan Pérez",
    "telefono": "+57 300 123 4567"
  }
}
```

### Campos

| Campo           | Requerido | Descripción |
|----------------|-----------|-------------|
| `idusuario`    | Sí        | ID del contacto/lead en GHL (se guarda como `id_user_ghl` en llamadas). |
| `locationid`   | Sí        | ID de la location en GHL (para resolver la cuenta). |
| `correocloser` | Sí*       | Email del closer asignado. Si falta → se guarda como evento huérfano. |
| `nombrecloser` | Sí*       | Nombre del closer. Si falta → se guarda como evento huérfano. |
| `nombre`       | No        | Nombre del lead/customer. Se guarda en `nombre_lead`. Si no se envía, en registros nuevos se usa "sin nombre". |
| `telefono`     | No        | Teléfono del lead. Se guarda en `phone_raw_format`. |

\* Si falta **correocloser** o **nombrecloser**, el webhook responde 200 pero no actualiza/crea registro de llamada; guarda el payload en `eventos_huerfanos` con `origen: "reasignacion"` y `motivo` indicando qué faltó.

---

## Cómo mostrar en el front (eventos huérfanos de reasignación)

Los huérfanos de reasignación están en la tabla `eventos_huerfanos` con:

- `origen`: `"reasignacion"`
- `motivo`: p. ej. `"Reasignación incompleta: falta correo del closer"` o `"Reasignación incompleta: falta nombre del closer"` o ambos
- `payload_original`: el JSON completo que envió GHL

### Estructura sugerida para listar y corregir

1. **Filtrar** por `origen === 'reasignacion'` y `estado === 'pendiente'`.

2. **Por cada fila**, leer `payload_original.customData` y mostrar:

   - **Lead:** `payload_original.customData.nombre` (o "Sin nombre" si no viene) + `payload_original.customData.telefono` (o "Sin teléfono").
   - **ID usuario (GHL):** `payload_original.customData.idusuario`.
   - **Location:** `payload_original.customData.locationid`.
   - **Motivo:** `motivo` (qué faltaba: correo y/o nombre del closer).
   - **Closer (si llegó algo):** `payload_original.customData.nombrecloser` / `payload_original.customData.correocloser`.

3. **Acción de corrección:** formulario o modal donde la persona complete **nombre del closer** y **correo del closer**, y luego:
   - o bien reenvíe un POST a `/webhooks/reasignacion` con el mismo payload corregido (añadiendo `nombrecloser` y `correocloser`),  
   - o bien tu backend tenga un “reintento” que tome el huérfano, merge los datos corregidos y vuelva a ejecutar la lógica de reasignación (y marque el huérfano como resuelto).

### Ejemplo de objeto para una fila en la UI

```ts
interface ReasignacionOrphanRow {
  id_huerfano: number;
  id_cuenta: number | null;
  origen: "reasignacion";
  motivo: string;
  estado: string;
  created_at: string;
  // Del payload:
  idusuario: string;
  locationid: string;
  nombreLead: string;      // customData.nombre ?? "Sin nombre"
  telefonoLead: string;    // customData.telefono ?? "—"
  nombrecloser: string;    // customData.nombrecloser ?? "—"
  correocloser: string;    // customData.correocloser ?? "—"
}
```

Al parsear `payload_original` en el front:

```ts
const cd = evento.payload_original?.customData ?? {};
const row: ReasignacionOrphanRow = {
  id_huerfano: evento.id_huerfano,
  id_cuenta: evento.id_cuenta,
  origen: evento.origen,
  motivo: evento.motivo,
  estado: evento.estado,
  created_at: evento.created_at,
  idusuario: cd.idusuario ?? "—",
  locationid: cd.locationid ?? "—",
  nombreLead: cd.nombre?.trim() || "Sin nombre",
  telefonoLead: cd.telefono?.trim() || "—",
  nombrecloser: cd.nombrecloser?.trim() || "—",
  correocloser: cd.correocloser?.trim() || "—",
};
```

Con esto puedes mostrar una tabla por evento huérfano de reasignación y dar la opción de completar closer y reenviar.
