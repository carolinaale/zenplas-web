/**
 * ZENPLAS — Tracking de atribución + bono (lado navegador)
 * Versión adaptada del "script hiv (4).txt" de Hivara. Cambios vs. original:
 *  - Sin dependencia de un botón único #whatsapp-btn: expone funciones que usan
 *    el formulario pre-WhatsApp y el botón flotante (ver Brief §5 y §7.2).
 *  - El contador del bono NO se resetea al vencer (deadline real, Brief §7.3).
 *  - Se agrega eventId compartido navegador/servidor para deduplicación CAPI.
 *  - El redirect va vía POST /api/wa (serverless), no wa.php.
 * Adaptaciones a este stack (HTML estático, sin bundler):
 *  - PIXEL_ID como constante (no hay process.env en el navegador).
 *  - enviarPorApiWa recibe bonoEstado como parámetro: el handler del formulario
 *    marca el bono como usado ANTES de enviar, y sin el parámetro el estado
 *    leído acá ya sería 'vencido' (se preserva la intención del original).
 */

// ============ CONFIG ============
const BONO_DURACION_MIN = 5; // ajustable
const PIXEL_ID = '1334800817206360';
const WA_ZENPLAS = '5491128529114';

// ============ ATRIBUCIÓN (idéntico al original de Hivara — no modificar) ============
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : null;
}

function setCookie(name, value, days = 90) {
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${name}=${value}; path=/; max-age=${maxAge}; SameSite=Lax`;
}

function getFBC() {
  const fbclid = getParam('fbclid');
  const existingFbc = getCookie('_fbc');
  if (existingFbc && existingFbc.startsWith('fb.1.') && !existingFbc.includes('?fbclid=')) {
    return existingFbc;
  }
  if (fbclid) {
    const fbc = 'fb.1.' + Date.now() + '.' + fbclid;
    setCookie('_fbc', fbc);
    return fbc;
  }
  return null;
}

// Código de 6 dígitos persistente — el "ticket" que une web → WhatsApp en Hivara
function generateClickId() {
  let existing = localStorage.getItem('promo_code');
  if (existing) return existing;
  const promo = Math.floor(100000 + Math.random() * 900000).toString();
  localStorage.setItem('promo_code', promo);
  return promo;
}

// ============ DATOS DEL VISITANTE ============
// formData es opcional: { nombre, telefono (normalizado 549...), email, tipo }
function getVisitorData(formData) {
  return {
    page: window.location.origin + window.location.pathname,
    referrer: document.referrer || 'direct',
    user_agent: navigator.userAgent,
    device: /mobile/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
    screen: window.screen.width + 'x' + window.screen.height,
    lang: navigator.language,
    time: new Date().toISOString(),

    fbclid: getParam('fbclid'),
    utm_source: getParam('utm_source'),
    utm_campaign: getParam('utm_campaign'),
    utm_content: getParam('utm_content'),
    utm_adset: getParam('utm_adset'),

    fbp: getCookie('_fbp'),
    fbc: getFBC(),

    promo_code: generateClickId(),

    // Bloque que espera Hivara (claves del PHP original) + datos extra del lead
    formulario: formData
      ? { telefono: formData.telefono, zona: null, nombre: formData.nombre,
          email: formData.email || null, tipo: formData.tipo }
      : null
  };
}

// ============ BONO 5% (Brief §7.3 — deadline real, sin reset) ============
const BONO_KEY = 'zp_bono_deadline';
const BONO_USADO_KEY = 'zp_bono_usado';

function zpBonoInit() {
  // Primera visita: fija el deadline. Visitas posteriores: lo respeta (no resetea).
  if (!localStorage.getItem(BONO_KEY)) {
    localStorage.setItem(BONO_KEY, String(Date.now() + BONO_DURACION_MIN * 60 * 1000));
  }
  zpBonoRender();
}

function zpBonoVigente() {
  const deadline = parseInt(localStorage.getItem(BONO_KEY), 10);
  return !!deadline && deadline > Date.now() && !localStorage.getItem(BONO_USADO_KEY);
}

function zpBonoMarcarUsado() {
  localStorage.setItem(BONO_USADO_KEY, 'true');
}

function zpBonoRender() {
  const bloque = document.getElementById('bono-bloque');     // contenedor de la oferta
  const okBloque = document.getElementById('bono-usado');    // "✓ Tu 5% quedó registrado..."
  if (!bloque) return;

  if (localStorage.getItem(BONO_USADO_KEY)) {
    bloque.style.display = 'none';
    if (okBloque) {
      okBloque.style.display = 'block';
      const cod = okBloque.querySelector('[data-codigo]');
      if (cod) cod.textContent = generateClickId();
    }
    return;
  }

  const deadline = parseInt(localStorage.getItem(BONO_KEY), 10);
  const mEl = document.getElementById('minutes');
  const sEl = document.getElementById('seconds');
  const pad = n => (n < 10 ? '0' + n : '' + n);

  function tick() {
    const diff = deadline - Date.now();
    if (diff <= 0) {                    // vencido: ocultar y NO resetear
      bloque.style.display = 'none';
      clearInterval(interval);
      return;
    }
    if (mEl) mEl.textContent = pad(Math.floor(diff / 60000));
    if (sEl) sEl.textContent = pad(Math.floor((diff % 60000) / 1000));
  }
  tick();
  const interval = setInterval(tick, 1000);
}

// ============ ENVÍO A /api/wa (Brief §7.1/§7.2) ============
async function enviarPorApiWa(mensaje, visitorData, eventName, extraParams = {}, bonoEstado) {
  const eventId = (crypto.randomUUID) ? crypto.randomUUID()
    : 'zp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  const bono = bonoEstado || (zpBonoVigente() ? '5pct' : 'vencido');

  // Pixel (navegador) — con eventID para dedup
  if (typeof fbq === 'function') {
    fbq('track', eventName, extraParams, { eventID: eventId });
  }

  try {
    const res = await fetch('/api/wa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje, visitorData, eventName, eventId, bono })
    });
    const { url } = await res.json();
    window.location.href = url;
  } catch (e) {
    // Fallback: si /api/wa falla, el lead va a WhatsApp igual (con código, sin tracking)
    const texto = encodeURIComponent(`${mensaje}\n\n🎟 Código: ${generateClickId()}`);
    window.location.href = `https://wa.me/${WA_ZENPLAS}?text=${texto}`;
  }
}
