// ════════════════════════════════════════════════════════════════════
// Helper compartido de FacturaSend (SIFEN) — formato de autenticación.
// ────────────────────────────────────────────────────────────────────
// FacturaSend NO recibe el token pelado: espera el header
//   Authorization: Bearer api_key_<API_KEY>
// (el prefijo literal "api_key_" delante del GUID). El env FACTURASEND_API_KEY
// guarda el GUID PELADO (sin prefijo); el prefijo se agrega SOLO acá, para que
// TODAS las llamadas (este smoke test y el FacturaSendProvider de PR-FE-1+)
// compartan un único lugar con el formato correcto.
//
// La API key nunca se loguea ni se devuelve: sólo viaja dentro de este header.
// ════════════════════════════════════════════════════════════════════

// Prefijo literal que FacturaSend exige delante de la API key.
export const FACTURASEND_TOKEN_PREFIX = 'api_key_';

// Construye el header Authorization a partir de la API key PELADA (GUID sin prefijo).
export function facturaSendAuthHeader(apiKey) {
  return `Bearer ${FACTURASEND_TOKEN_PREFIX}${apiKey}`;
}
