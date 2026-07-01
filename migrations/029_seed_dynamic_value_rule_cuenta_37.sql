-- AUT-1189: Sembrar regla dynamicValue de prueba en cuenta 37 (autokpiadmin)
-- Agrega una regla que resuelve tag dinámicamente desde custom field GHL "rol_lead"
-- Contacto HnVqTKxSLnX8FCcBBUQd tiene valor "Gerente de ventas" para campo jNDhBazM2O9dGrrRMMu3
-- Tag esperado resuelto: "rol_lead: exacto: Gerente de ventas"
-- Idempotente: solo agrega si no existe ya una regla con id = 'aut1189_dynamic_test'

UPDATE cuentas
SET reglas_etiquetas = COALESCE(reglas_etiquetas, '[]'::jsonb) || '[{
  "id": "aut1189_dynamic_test",
  "tag": "rol_lead",
  "fuente": "videollamadas",
  "source": "videollamadas",
  "condition": "si la persona menciona su cargo, rol o puesto en la empresa, por ejemplo gerente, director, coordinador, asistente, dueño, CEO, fundador, vendedor, o cualquier otro título profesional",
  "dynamicValue": {
    "fuente": "custom_field",
    "fieldId": "jNDhBazM2O9dGrrRMMu3",
    "mode": "exacto"
  }
}]'::jsonb
WHERE id_cuenta = 37
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(reglas_etiquetas, '[]'::jsonb)) AS elem
    WHERE elem->>'id' = 'aut1189_dynamic_test'
  );
