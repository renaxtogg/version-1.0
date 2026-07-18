// v2: el SW ahora SOLO media requests de nuestro propio origen y cachea solo
// respuestas sanas. Antes interceptaba TODO GET que no fuera a supabase.co —incluido
// el bundle del CDN de supabase-js (cdn.jsdelivr.net) que carga login.html—: si ese
// request se rompía o se cacheaba opaco/roto, login.html quedaba sin window.supabase
// y el login recargaba a un formulario en blanco. El bump de versión purga la caché
// vieja (posiblemente envenenada) en el activate de abajo.
const CACHE = 'mythos-caja-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Solo mediamos requests de NUESTRO mismo origen. Los cross-origin (CDN de
  // supabase-js, Turnstile, etc.) pasan de largo → nunca se cachean opacos ni se
  // pueden servir rotos, y el login jamás depende del estado del SW.
  let sameOrigin = false;
  try { sameOrigin = new URL(e.request.url).origin === self.location.origin; } catch (_) {}
  if (!sameOrigin) return;

  // Doble seguro: no interceptar llamadas a Supabase (Auth/Realtime/REST).
  if (e.request.url.includes('supabase.co')) return;

  e.respondWith(
    fetch(e.request)
      .then(resp => {
        // Cachear SOLO respuestas sanas de nuestro origen (evita guardar errores,
        // redirects u opacas que luego se sirvan rotas offline).
        if (resp && resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return resp;
      })
      .catch(() =>
        caches.match(e.request).then(cached => {
          if (cached) return cached;
          if (e.request.mode === 'navigate') return caches.match('caja.html');
        })
      )
  );
});
