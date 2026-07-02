// ════════════════════════════════════════════════════════════════════
// BillingProvider — interfaz de facturación electrónica + impl FacturaSend.
// ────────────────────────────────────────────────────────────────────
// PR-FE-1: sólo conectividad (test) + carga de config por tenant. La EMISIÓN
// (emitir/consultarEstado/obtenerKuDE/cancelar/inutilizar) es PR-FE-2 → acá esos
// métodos existen en el contrato pero lanzan "no implementado" (error visible).
//
// resolveBillingProvider(restaurantId): lee fiscal_config con service_role,
// DESCIFRA la api_key en el server, y construye la impl según fiscal_config.provider
// (facturasend hoy; sifende u otros a futuro). La api_key en claro vive SÓLO en
// memoria del server; nunca se loguea ni se devuelve.
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig } from './_db.js';
import { decryptApiKey } from './_crypto.js';
import { facturaSendAuthHeader } from './_client.js';

/**
 * @typedef {Object} BillingProvider
 * @property {() => Promise<{ok:boolean,status:number,body:any}>} test  Prueba de conexión/credencial.
 * @property {(payload:any) => Promise<any>}          emitir           (PR-FE-2)
 * @property {(id:any) => Promise<any>}               consultarEstado  (PR-FE-2)
 * @property {(id:any) => Promise<any>}               obtenerKuDE      (PR-FE-2)
 * @property {(id:any, motivo:string) => Promise<any>} cancelar        (PR-FE-2)
 * @property {(rango:any) => Promise<any>}            inutilizar       (PR-FE-2)
 */

const notImpl = (m) => { throw new Error(`BillingProvider.${m}() no implementado en PR-FE-1 (emisión = PR-FE-2)`); };

const DEFAULT_BASE = (process.env.FACTURASEND_BASE_URL || 'https://api.facturasend.com.py').trim().replace(/\/+$/, '');

// Implementación FacturaSend del contrato BillingProvider.
export class FacturaSendProvider {
  // config: { tenant, environment, baseUrl }; apiKey: plaintext ya descifrada.
  constructor(config, apiKey) {
    this.provider = 'facturasend';
    this.tenant = config.tenant;
    this.environment = config.environment;
    this.baseUrl = config.baseUrl || DEFAULT_BASE;
    this._apiKey = apiKey;   // plaintext, sólo en memoria del server
  }

  async test() {
    const r = await fetch(`${this.baseUrl}/${this.tenant}/test`, {
      headers: { Authorization: facturaSendAuthHeader(this._apiKey), Accept: 'application/json' },
    });
    const raw = await r.text();
    let body;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }
    return { ok: r.ok, status: r.status, body };
  }

  emitir()          { return notImpl('emitir'); }
  consultarEstado() { return notImpl('consultarEstado'); }
  obtenerKuDE()     { return notImpl('obtenerKuDE'); }
  cancelar()        { return notImpl('cancelar'); }
  inutilizar()      { return notImpl('inutilizar'); }
}

// Selección de impl por nombre de proveedor (extensible: sifende, etc.).
function buildProvider(providerName, config, apiKey) {
  switch (providerName) {
    case 'facturasend': return new FacturaSendProvider(config, apiKey);
    default: throw new Error(`Proveedor de facturación no soportado: ${providerName}`);
  }
}

// Resuelve el BillingProvider de un restaurante desde su fiscal_config (cifrada).
export async function resolveBillingProvider(restaurantId) {
  if (!restaurantId) throw new Error('resolveBillingProvider: restaurant_id requerido');
  const cfg = await getFiscalConfig(restaurantId);
  if (!cfg)                    throw new Error(`fiscal_config: sin configuración para restaurant_id=${restaurantId}`);
  if (cfg.active === false)    throw new Error(`fiscal_config: configuración INACTIVA para restaurant_id=${restaurantId}`);
  if (!cfg.api_key_ciphertext) throw new Error(`fiscal_config: sin api_key cargada para restaurant_id=${restaurantId}`);

  // Descifrado server-only.
  const apiKey = decryptApiKey({
    ciphertext: cfg.api_key_ciphertext,
    iv: cfg.api_key_iv,
    tag: cfg.api_key_tag,
  });

  const config = { tenant: cfg.tenant, environment: cfg.environment, baseUrl: DEFAULT_BASE };
  return buildProvider(cfg.provider || 'facturasend', config, apiKey);
}
