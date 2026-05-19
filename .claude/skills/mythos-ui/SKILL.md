# Mythos UI — Design System Skill

Cuando esta skill se activa, aplicás el design system Mythos a cualquier panel o módulo nuevo o existente del proyecto.
El sistema es **minimalista, blanco y negro, estilo Apple**. Esto aplica a los 7 paneles y a todo módulo futuro.

---

## Branding — regla global e innegociable

**El sistema se llama Mythos. No "Mesa App". No "Sistema". No nada más.**

Esto aplica a absolutamente todo: titles HTML, headers, sidebars, footers, modales, emails, PDFs, placeholders, mensajes de error. Si un archivo dice "Mesa App" en cualquier forma, es un bug de branding que hay que corregir.

| Elemento | Correcto | Incorrecto |
|---|---|---|
| `<title>` del HTML | `Mythos · Cocina` | `Mesa App · Cocina` |
| Logo en sidebar | `Mythos` | `Mesa App` |
| Footer / hint | `Mythos · Sistema gastronómico` | `Mesa App v1.0 · La Huaca` |
| Mensajes de error | `Error en Mythos` | `Error en Mesa App` |
| Loading states | `Cargando Mythos…` | cualquier otra cosa |

El logo **es solo texto** por ahora — el diseño del isotipo está en proceso. Usar el nombre en tipografía del sistema, peso bold, letter-spacing negativo (`-1px`). No inventar íconos ni placeholders visuales para el logo.

---

## Principios de diseño

1. **Blanco y negro real.** Sin colores de acento a menos que sea un estado semántico crítico (rojo error, verde éxito) y solo en texto o íconos, nunca como fondo de área.
2. **Tipografía es jerarquía.** Tamaño + peso reemplazan al color para comunicar importancia.
3. **Espacio es intención.** Nunca llenar. El vacío guía la atención.
4. **Sin decoración superflua.** Cero gradientes, cero sombras vistosas, cero borders radius excesivos.
5. **Funcional primero.** Cada elemento existe porque tiene una función, no porque se ve bien.

---

## Tokens de diseño — CSS Variables

Reemplazá el contenido de `public/design-system.css` con esto como base:

```css
:root {
  /* Color */
  --bg:          #FFFFFF;
  --bg-subtle:   #F5F5F7;
  --bg-hover:    #E8E8ED;
  --surface:     #FFFFFF;
  --border:      #D2D2D7;
  --border-strong: #86868B;

  --text-primary:   #1D1D1F;
  --text-secondary: #6E6E73;
  --text-tertiary:  #86868B;
  --text-disabled:  #AEAEB2;
  --text-inverse:   #FFFFFF;

  --black: #000000;
  --white: #FFFFFF;

  /* Semánticos — solo texto/íconos, nunca fondo de área grande */
  --error:   #FF3B30;
  --success: #34C759;
  --warning: #FF9500;
  --info:    #007AFF;

  /* Tipografía */
  --font: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'SF Mono', ui-monospace, monospace;

  --text-xs:   11px;
  --text-sm:   13px;
  --text-base: 15px;
  --text-md:   17px;
  --text-lg:   20px;
  --text-xl:   24px;
  --text-2xl:  28px;
  --text-3xl:  34px;

  --weight-regular: 400;
  --weight-medium:  500;
  --weight-semibold: 600;
  --weight-bold:    700;

  /* Espaciado — grid de 8px */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;

  /* Border radius */
  --radius-sm:  6px;
  --radius-md:  10px;
  --radius-lg:  14px;
  --radius-xl:  20px;
  --radius-full: 999px;

  /* Sombras — monocromáticas y sutiles */
  --shadow-xs: 0 1px 2px rgba(0,0,0,0.06);
  --shadow-sm: 0 1px 4px rgba(0,0,0,0.08), 0 0 1px rgba(0,0,0,0.04);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.10), 0 0 1px rgba(0,0,0,0.06);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.12), 0 0 1px rgba(0,0,0,0.04);

  /* Transiciones */
  --transition: 150ms ease;
  --transition-slow: 250ms ease;
}

/* Dark mode — solo para cocina.html (KDS) */
[data-theme="dark"] {
  --bg:          #000000;
  --bg-subtle:   #1C1C1E;
  --bg-hover:    #2C2C2E;
  --surface:     #1C1C1E;
  --border:      #38383A;
  --border-strong: #636366;

  --text-primary:   #F5F5F7;
  --text-secondary: #AEAEB2;
  --text-tertiary:  #636366;
  --text-disabled:  #3A3A3C;
  --text-inverse:   #000000;
}
```

---

## Componentes — patrones de código

### Reset base (en cada HTML, antes de cualquier estilo)
```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--font);
  font-size: var(--text-base);
  color: var(--text-primary);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  line-height: 1.5;
}
```

### Botones
```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-md);
  font-family: var(--font);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  cursor: pointer;
  border: none;
  transition: opacity var(--transition), transform var(--transition);
  white-space: nowrap;
}
.btn:active { transform: scale(0.98); }

.btn-primary   { background: var(--black); color: var(--white); }
.btn-secondary { background: var(--bg-subtle); color: var(--text-primary); border: 1px solid var(--border); }
.btn-ghost     { background: transparent; color: var(--text-primary); }
.btn-danger    { background: var(--error); color: var(--white); }

.btn:hover { opacity: 0.84; }
.btn:disabled { opacity: 0.38; cursor: not-allowed; }

.btn-sm { padding: var(--space-2) var(--space-3); font-size: var(--text-sm); border-radius: var(--radius-sm); }
.btn-lg { padding: var(--space-4) var(--space-6); font-size: var(--text-md); }
```

### Cards
```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
}
.card-sm { padding: var(--space-4); border-radius: var(--radius-md); }
.card-interactive {
  cursor: pointer;
  transition: background var(--transition), box-shadow var(--transition);
}
.card-interactive:hover {
  background: var(--bg-subtle);
  box-shadow: var(--shadow-sm);
}
```

### Inputs
```css
.input {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-family: var(--font);
  font-size: var(--text-base);
  color: var(--text-primary);
  background: var(--bg);
  transition: border-color var(--transition);
  outline: none;
}
.input:focus { border-color: var(--black); }
.input::placeholder { color: var(--text-tertiary); }

label {
  display: block;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
}
```

### Badges / Estado
```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.badge-default  { background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border); }
.badge-success  { background: #E8F9ED; color: #1A7E37; }
.badge-warning  { background: #FFF4E0; color: #8A4B00; }
.badge-error    { background: #FFEDEC; color: #C0190F; }
.badge-neutral  { background: var(--bg-subtle); color: var(--text-primary); }
```

### Tabla de datos
```css
.data-table { width: 100%; border-collapse: collapse; }
.data-table th {
  padding: var(--space-3) var(--space-4);
  text-align: left;
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  border-bottom: 1px solid var(--border);
}
.data-table td {
  padding: var(--space-4);
  border-bottom: 1px solid var(--bg-subtle);
  font-size: var(--text-sm);
  color: var(--text-primary);
}
.data-table tr:hover td { background: var(--bg-subtle); }
.data-table tr:last-child td { border-bottom: none; }
```

### Modal
```css
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.4);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
  padding: var(--space-4);
}
.modal {
  background: var(--surface);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 480px;
  max-height: 90vh;
  overflow-y: auto;
  padding: var(--space-8);
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-6);
}
.modal-title {
  font-size: var(--text-xl);
  font-weight: var(--weight-semibold);
}
```

### Sidebar nav (paneles desktop)
```css
.sidebar {
  width: 240px;
  min-height: 100vh;
  border-right: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  padding: var(--space-6) var(--space-4);
}
.sidebar-logo {
  font-size: var(--text-xl);
  font-weight: var(--weight-bold);
  letter-spacing: -1px;
  padding: 0 var(--space-2) var(--space-6);
  color: var(--black);
}
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  transition: background var(--transition), color var(--transition);
}
.nav-item:hover { background: var(--bg-subtle); color: var(--text-primary); }
.nav-item.active { background: var(--black); color: var(--white); }
```

### Stat / KPI card
```css
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-5) var(--space-6);
}
.stat-label {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  font-weight: var(--weight-medium);
  margin-bottom: var(--space-2);
}
.stat-value {
  font-size: var(--text-3xl);
  font-weight: var(--weight-bold);
  letter-spacing: -1px;
  color: var(--text-primary);
}
.stat-delta {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  margin-top: var(--space-1);
}
```

---

## Patrones por panel

### `login.html` — referencia de diseño aprobada

Este es el diseño de referencia validado. Todo panel nuevo debe mantener este nivel de limpieza.

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Mythos · Acceso</title>
  <!-- scripts de Supabase y config aquí -->
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#F5F5F7;color:#1D1D1F;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
    .card{background:#fff;border:1px solid #D2D2D7;border-radius:20px;padding:48px 40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,0.08),0 0 1px rgba(0,0,0,0.04)}
    .logo{text-align:center;margin-bottom:36px}
    .logo-title{font-size:32px;font-weight:800;color:#000;letter-spacing:-1.2px}
    .logo-sub{font-size:13px;font-weight:500;color:#6E6E73;margin-top:4px}
    label{display:block;font-size:13px;font-weight:500;color:#6E6E73;margin-bottom:6px}
    input{width:100%;background:#fff;border:1px solid #D2D2D7;color:#1D1D1F;padding:11px 14px;border-radius:10px;font-size:15px;outline:none;transition:border-color .15s;font-family:inherit}
    input:focus{border-color:#000}
    input::placeholder{color:#AEAEB2}
    .field{margin-bottom:20px}
    .btn{width:100%;background:#000;color:#fff;border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .15s;margin-top:4px;font-family:inherit}
    .btn:hover{opacity:0.84}
    .btn:active{opacity:0.72}
    .btn:disabled{opacity:.38;cursor:not-allowed}
    .error{background:#fff;border:1px solid #FFCDD0;color:#C0190F;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:20px;display:none}
    .error.show{display:block}
    .hint{font-size:12px;color:#AEAEB2;text-align:center;margin-top:24px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .spinner{width:15px;height:15px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;display:inline-block;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-title">Mythos</div>
    <div class="logo-sub">Iniciá sesión para continuar</div>
  </div>
  <div id="err" class="error"></div>
  <form id="loginForm">
    <div class="field">
      <label for="username">Usuario</label>
      <input id="username" type="text" autocomplete="username" placeholder="Tu usuario" required/>
    </div>
    <div class="field">
      <label for="password">Contraseña</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="••••••••" required/>
    </div>
    <button class="btn" type="submit" id="submitBtn">Ingresar</button>
  </form>
  <div class="hint">Mythos · Sistema gastronómico</div>
</div>
<!-- JS sin cambios -->
</body>
</html>
```

Claves visuales de esta referencia:
- Fondo: `#F5F5F7` (gris Apple muy suave), no blanco puro
- Card: blanco, borde `#D2D2D7`, `border-radius: 20px`, sombra negra con opacidad baja
- Logo: `font-size: 32px`, `font-weight: 800`, `letter-spacing: -1.2px` — impacto sin color
- Inputs: borde fino, focus negro (no azul, no violeta)
- Botón: negro sólido, hover con opacity (no cambio de color)
- Error: borde rosado + texto rojo oscuro — solo semántico, no alarma visual

### `index.html` — Cliente móvil
- Fondo `var(--bg)`, pantalla completa, sin sidebar
- Header fijo: "Mythos" a la izquierda + nombre del restaurante más pequeño
- Cards de producto: imagen cuadrada con `border-radius: var(--radius-lg)`, nombre bold, precio en `--text-secondary`
- Botón "Agregar al carrito": full-width, `btn-primary`
- Cart badge: número en negro, fondo `--bg-subtle`
- Bottom sheet para modales (slide up desde abajo, `border-radius` arriba)
- Tamaños táctiles mínimos: 44px de altura en todo elemento interactivo

### `cocina.html` — KDS
- `data-theme="dark"` en `<body>` — fondo negro total, texto blanco
- Header: "Mythos · Cocina" en blanco
- Kanban: 3 columnas, cards compactas con número de orden y mesa grande
- Timer por ticket en `--font-mono`, cambia de color solo cuando es crítico: `--warning` → `--error`
- Sin imágenes, solo texto e íconos
- Botón avanzar estado: borde blanco, hover fondo blanco / texto negro

### `mozo.html` — Panel mozo
- Sidebar: logo "Mythos" arriba, nav items
- Grilla de mesas: libre en `--bg-subtle`, ocupada en `--black`/blanco, lista con borde negro grueso
- Sin colores de fondo de área grandes — el estado va en borde o texto

### `caja.html` — Panel caja
- Sidebar: logo "Mythos" + badge turno activo
- Cobro: modal con totales en `--text-3xl bold`, métodos de pago como botones secundarios
- Movimientos: tabla `data-table` con timestamp, tipo, monto

### `admin.html` — Admin local
- Sidebar: "Mythos" + nombre del restaurante debajo en `--text-secondary`
- Tabs horizontales para sub-módulos
- CRUD en modals estándar, tablas con acciones inline al hover

### `superadmin.html` — Superadmin SaaS
- Sidebar más amplio: "Mythos" + badge "Superadmin"
- Lista de restaurantes en sidebar
- Tabla de ecosistemas con badge de plan y estado

---

## Reglas absolutas del design system

- **NUNCA** usar `background: linear-gradient(...)` como decoración
- **NUNCA** usar colores de acento (azul, verde, violeta) como fondo de sección o card
- **NUNCA** usar box-shadow con color (solo rgba negro con opacidad baja)
- **NUNCA** mezclar fuentes — solo `var(--font)` o `var(--font-mono)`
- **NUNCA** escribir "Mesa App" en ningún lugar visible ni en comentarios de código nuevo
- **SIEMPRE** usar los tokens CSS (`var(--...)`) en lugar de valores hardcodeados
- **SIEMPRE** mantener alineación al grid de 8px
- **SIEMPRE** usar "Mythos" como nombre del sistema en todo texto visible
- **SIEMPRE** que exista un estado vacío, mostrar mensaje de texto secundario simple
- Los íconos van como texto Unicode o SVG inline simple — no importar icon libraries pesadas

---

## Cómo aplicar a un panel existente

1. Cambiar `<title>` a `Mythos · [Nombre del panel]`
2. Reemplazar toda aparición de "Mesa App" por "Mythos" en texto visible
3. Agregar `<link rel="stylesheet" href="design-system.css">` si no está
4. Reemplazar el bloque `<style>` completo usando los tokens y componentes de esta skill
5. Verificar que cada elemento interactivo tenga mínimo 44px de altura
6. Verificar viewport 375px (móvil) y 1280px (desktop)
7. **NO cambiar nada de JS** — solo HTML y estilos

---

## Stack recordatorio (no cambiar)
- HTML + React 18 CDN + Babel Standalone. Sin bundler.
- Estilos: CSS custom properties + inline styles en JSX. Sin Tailwind, sin CSS modules.
- `window.*` globals. Sin `import`/`export`.
