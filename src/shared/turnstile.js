// ════════════════════════════════════════════════════════════════════
// MYTHOS — Cloudflare Turnstile (CAPTCHA nativo de Supabase Auth) para los
// paneles in-app precompilados con Vite. Compartido admin/superadmin.
// ────────────────────────────────────────────────────────────────────
// Cuando el Turnstile está ACTIVADO en el proyecto de Supabase, Auth gatea
// signInWithPassword / signUp / recover: exigen options.captchaToken. Los
// modales in-app que re-autentican (p.ej. "Cambiar contraseña" de Mi cuenta
// verifica la clave actual con signInWithPassword) necesitan renderizar el
// widget y mandar el token; si no, Supabase responde con error de captcha.
//
// Este helper carga api.js ON-DEMAND (no toca el HTML del shell; el CSP de
// vercel.json ya permite challenges.cloudflare.com en script/frame/connect) y
// expone el hook useTurnstile(active).
//
// Filosofía = login.html/registro.html: el token de un solo uso se manda
// SIEMPRE; si el captcha está apagado, Supabase lo ignora. NO se bloquea el
// submit por falta de token (adblock/red/sitekey no deben trabar un cambio de
// clave legítimo); si el server lo exige y falta, devuelve error de captcha y
// el modal resetea el widget + pide reintentar.
// ════════════════════════════════════════════════════════════════════
import React, { useEffect, useRef, useState } from "react";

// Site key PÚBLICA de Turnstile (misma que login.html/registro.html; si se
// rota, cambiar en los tres lugares).
export const TURNSTILE_SITE_KEY = "0x4AAAAAADs0-Olt_9L_CI3V";

let _loadPromise = null;

// Carga (una sola vez) el script de Turnstile en modo render explícito. Resuelve
// cuando window.turnstile está listo. NUNCA rechaza: si la red/adblock lo
// bloquea, resuelve igual para no colgar el flujo (el token queda vacío y decide
// el server).
export function loadTurnstile() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile && window.turnstile.render) return Promise.resolve();
  if (_loadPromise) return _loadPromise;
  _loadPromise = new Promise((resolve) => {
    const CB = "__mythosTurnstileOnload";
    const prev = window[CB];
    window[CB] = function () {
      if (typeof prev === "function") { try { prev(); } catch (e) {} }
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=" + CB + "&render=explicit";
    s.async = true;
    s.defer = true;
    // Si falla la carga (adblock/red/CDN), NO dejamos el singleton resuelto
    // "envenenado": lo limpiamos para que un intento posterior REINTENTE inyectar
    // el script (si no, el widget no volvería a aparecer en toda la sesión).
    s.onerror = function () { _loadPromise = null; resolve(); };
    document.head.appendChild(s);
  });
  return _loadPromise;
}

// Hook: cuando `active` es true, renderiza un widget de Turnstile en el div del
// `ref` devuelto y entrega el token en `token` (string vacío hasta resolver /
// al expirar / al fallar). Limpia el widget al desmontar. `reset()` fuerza un
// token nuevo (para reintentos: el token es de un solo uso).
export function useTurnstile(active) {
  const ref = useRef(null);
  const widgetId = useRef(null);
  const [token, setToken] = useState("");

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    loadTurnstile().then(() => {
      if (cancelled) return;
      if (!ref.current || widgetId.current !== null) return;
      if (!window.turnstile || !window.turnstile.render) return;
      try {
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: function (t) { if (!cancelled) setToken(t || ""); },
          "error-callback": function () { if (!cancelled) setToken(""); },
          "expired-callback": function () { if (!cancelled) setToken(""); }
        });
      } catch (e) { /* sin widget → token vacío; el server decide */ }
    });
    return function () {
      cancelled = true;
      try { if (widgetId.current !== null && window.turnstile) window.turnstile.remove(widgetId.current); } catch (e) {}
      widgetId.current = null;
    };
  }, [active]);

  const reset = function () {
    try { if (widgetId.current !== null && window.turnstile) window.turnstile.reset(widgetId.current); } catch (e) {}
    setToken("");
  };

  return { ref, token, reset };
}
