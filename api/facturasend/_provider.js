// ════════════════════════════════════════════════════════════════════
// BillingProvider — interfaz de facturación electrónica + impl FacturaSend.
// ────────────────────────────────────────────────────────────────────
// PR-FE-2: conectividad (test) + EMISIÓN sandbox. PR-FE-3: ciclo de vida completo.
// Implementados:
//   • emitir(deArray)        → POST {tenant}/lote/create (array de DE, máx 50)
//   • consultarEstado(cdcs)  → POST {tenant}/de/estado    ({ cdcList:[{cdc}] })
//   • obtenerKuDE(cdc)       → GET  {tenant}/de/xml/{cdc}
//   • obtenerPdf(cdc,{fmt})  → POST {tenant}/de/pdf        (PDF binario o base64)
//   • enviarEmail(cdc,email) → POST {tenant}/de/email      ({ email, cdcList })
//   • cancelar(cdc,motivo)   → POST {tenant}/evento/cancelacion   ({ cdc, motivo })
//   • inutilizar(rango)      → POST {tenant}/evento/inutilizacion ({ tipoDocumento,… })
//
// resolveBillingProvider(restaurantId): lee fiscal_config con service_role,
// DESCIFRA la api_key en el server, y construye la impl según fiscal_config.provider
// (facturasend hoy; sifende u otros a futuro). providerFromConfig(cfg) hace lo
// mismo cuando el caller YA leyó la config (evita doble fetch). La api_key en
// claro vive SÓLO en memoria del server; nunca se loguea ni se devuelve.
// ════════════════════════════════════════════════════════════════════
import { getFiscalConfig } from './_db.js';
import { decryptApiKey } from './_crypto.js';
import { facturaSendAuthHeader } from './_client.js';

/**
 * @typedef {Object} BillingProvider
 * @property {() => Promise<{ok:boolean,status:number,body:any}>} test              Prueba de conexión/credencial.
 * @property {(deArray:any[]) => Promise<{ok:boolean,status:number,body:any}>} emitir          Envía un lote de DE.
 * @property {(cdcList:(string|{cdc:string})[]) => Promise<{ok:boolean,status:number,body:any}>} consultarEstado  Consulta estado por CDC.
 * @property {(cdc:string) => Promise<{ok:boolean,status:number,body:any}>} obtenerKuDE        XML/KuDE por CDC.
 * @property {(cdc:string, opts?:{format?:string}) => Promise<{ok:boolean,status:number,contentType?:string,buffer?:Buffer,body?:any}>} obtenerPdf  KuDE PDF por CDC.
 * @property {(cdc:string, email:string) => Promise<{ok:boolean,status:number,body:any}>} enviarEmail  Reenvío por email.
 * @property {(cdc:string, motivo:string) => Promise<{ok:boolean,status:number,body:any}>} cancelar        Evento de cancelación.
 * @property {(rango:{tipoDocumento?:number,establecimiento:string,punto:string,desde:number,hasta:number,motivo:string,serie?:string}) => Promise<{ok:boolean,status:number,body:any}>} inutilizar  Evento de inutilización.
 */

const DEFAULT_BASE = (process.env.FACTURASEND_BASE_URL || 'https://api.facturasend.com.py').trim().replace(/\/+$/, '');

// Parseo tolerante de la respuesta de FacturaSend (JSON si se puede, si no texto crudo).
async function readResponse(r) {
  const raw = await r.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }
  return { ok: r.ok, status: r.status, body };
}

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

  _headers(json) {
    const h = { Authorization: facturaSendAuthHeader(this._apiKey), Accept: 'application/json' };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async test() {
    const r = await fetch(`${this.baseUrl}/${this.tenant}/test`, { headers: this._headers(false) });
    return readResponse(r);
  }

  // Envía un lote de DE. deArray: array de objetos `data` (o un único objeto).
  // Respuesta: { success, result: { deList:[{cdc,numero,estado,situacion,respuesta_*}], loteId } }.
  async emitir(deArray) {
    const body = Array.isArray(deArray) ? deArray : [deArray];
    const r = await fetch(`${this.baseUrl}/${this.tenant}/lote/create`, {
      method: 'POST', headers: this._headers(true), body: JSON.stringify(body),
    });
    return readResponse(r);
  }

  // Consulta estado por CDC. cdcList: array de strings o de { cdc }.
  // Respuesta: { success, deList:[{cdc,numero,estado,situacion,respuesta_codigo,respuesta_mensaje}] }.
  async consultarEstado(cdcList) {
    const list = (Array.isArray(cdcList) ? cdcList : [cdcList])
      .map((c) => (typeof c === 'string' ? { cdc: c } : c))
      .filter((c) => c && c.cdc);
    const r = await fetch(`${this.baseUrl}/${this.tenant}/de/estado`, {
      method: 'POST', headers: this._headers(true), body: JSON.stringify({ cdcList: list }),
    });
    return readResponse(r);
  }

  // XML/KuDE de un DE por su CDC.
  async obtenerKuDE(cdc) {
    const r = await fetch(`${this.baseUrl}/${this.tenant}/de/xml/${encodeURIComponent(cdc)}`, {
      headers: this._headers(false),
    });
    return readResponse(r);
  }

  // KuDE en PDF (POST {tenant}/de/pdf, body { cdcList:[{cdc}], format }). El
  // endpoint devuelve el PDF BINARIO (no JSON), así que NO usamos readResponse:
  // leemos el arrayBuffer. Si el upstream falla, devuelve JSON de error → lo
  // parseamos como texto para que el motivo quede VISIBLE.
  // format: 'ticket' | 'a4' | 'custom' (default del emisor si se omite).
  async obtenerPdf(cdc, { format } = {}) {
    const body = { cdcList: [{ cdc }] };
    if (format) body.format = format;
    const r = await fetch(`${this.baseUrl}/${this.tenant}/de/pdf`, {
      method: 'POST', headers: this._headers(true), body: JSON.stringify(body),
    });
    const contentType = r.headers.get('content-type') || '';
    if (r.ok && /pdf/i.test(contentType)) {
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, status: r.status, contentType, buffer: buf };
    }
    // No es PDF (error del upstream u otro content-type) → superficie honesta.
    const raw = await r.text();
    let body2; try { body2 = raw ? JSON.parse(raw) : null; } catch (_) { body2 = raw; }
    return { ok: false, status: r.status, contentType, body: body2 };
  }

  // Reenvío por email (POST {tenant}/de/email, body { email, cdcList:[{cdc}] }).
  async enviarEmail(cdc, email) {
    const r = await fetch(`${this.baseUrl}/${this.tenant}/de/email`, {
      method: 'POST', headers: this._headers(true),
      body: JSON.stringify({ email, cdcList: [{ cdc }] }),
    });
    return readResponse(r);
  }

  // Evento de cancelación (POST {tenant}/evento/cancelacion, body { cdc, motivo }).
  async cancelar(cdc, motivo) {
    const r = await fetch(`${this.baseUrl}/${this.tenant}/evento/cancelacion`, {
      method: 'POST', headers: this._headers(true),
      body: JSON.stringify({ cdc, motivo }),
    });
    return readResponse(r);
  }

  // Evento de inutilización de un rango de numeración (POST {tenant}/evento/inutilizacion,
  // body { tipoDocumento, establecimiento, punto, desde, hasta, motivo, serie? }).
  async inutilizar({ tipoDocumento = 1, establecimiento, punto, desde, hasta, motivo, serie = null }) {
    const body = { tipoDocumento, establecimiento, punto, desde, hasta, motivo, serie };
    const r = await fetch(`${this.baseUrl}/${this.tenant}/evento/inutilizacion`, {
      method: 'POST', headers: this._headers(true), body: JSON.stringify(body),
    });
    return readResponse(r);
  }
}

// Selección de impl por nombre de proveedor (extensible: sifende, etc.).
function buildProvider(providerName, config, apiKey) {
  switch (providerName) {
    case 'facturasend': return new FacturaSendProvider(config, apiKey);
    default: throw new Error(`Proveedor de facturación no soportado: ${providerName}`);
  }
}

// Construye el BillingProvider a partir de una fila fiscal_config YA leída
// (descifra la api_key en el server). Útil cuando el caller necesita también
// otros campos de la config (establecimiento/punto) y no quiere un doble fetch.
export function providerFromConfig(cfg) {
  if (!cfg)                    throw new Error('providerFromConfig: fiscal_config requerido');
  if (cfg.active === false)    throw new Error('fiscal_config: configuración INACTIVA para el restaurante');
  if (!cfg.api_key_ciphertext) throw new Error('fiscal_config: sin api_key cargada para el restaurante');

  // Descifrado server-only.
  const apiKey = decryptApiKey({
    ciphertext: cfg.api_key_ciphertext,
    iv: cfg.api_key_iv,
    tag: cfg.api_key_tag,
  });

  const config = { tenant: cfg.tenant, environment: cfg.environment, baseUrl: DEFAULT_BASE };
  return buildProvider(cfg.provider || 'facturasend', config, apiKey);
}

// Resuelve el BillingProvider de un restaurante desde su fiscal_config (cifrada).
export async function resolveBillingProvider(restaurantId) {
  if (!restaurantId) throw new Error('resolveBillingProvider: restaurant_id requerido');
  const cfg = await getFiscalConfig(restaurantId);
  if (!cfg) throw new Error(`fiscal_config: sin configuración para restaurant_id=${restaurantId}`);
  return providerFromConfig(cfg);
}
