/**
 * ZENPLAS — /api/wa (función serverless Vercel, Node 18+)
 * Port del "wa (5) (4).php" de Hivara. Cambios vs. original:
 *  - PHP → JS serverless (el PHP no corre en Vercel).
 *  - Rotación de 14 números eliminada → único WhatsApp de Zenplas.
 *  - Sin SSL_VERIFYPEER false, sin logs a archivos (hit.log/debug.log/visitas.json):
 *    filesystem efímero + PII en texto plano. Se loguea acotado por console.
 *  - AGREGADO: envío del mismo evento a Meta CAPI con event_id compartido (Brief §6.4).
 *  - Devuelve JSON { url } en vez de redirect 302 (el cliente hace window.location).
 * El payload a Hivara conserva EXACTAMENTE los campos del PHP original.
 * Formato del código en el mensaje (ancla de atribución de Hivara — no cambiar):
 *   "\n\n🎟 Código: XXXXXX"   ← emoji 🎟 (ticket), tal cual el PHP original.
 */
import { createHash } from 'crypto';

const WA_ZENPLAS = '5491128529114';                 // único número (decisión 22/07/2026)
const HIVARA_ENDPOINT = 'https://app-api.hivara.ai/api/v1/pixel/tracking/';
const HIVARA_ORG_ID = 24;                            // organización Zenplas en Hivara
const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID || '1334800817206360';
const CAPI_TOKEN = process.env.META_CAPI_TOKEN;           // secreto, solo servidor
const TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE; // solo en desarrollo

// --- helpers ---
const sha256 = (v) =>
  v ? createHash('sha256').update(String(v)).digest('hex') : undefined;

const normEmail = (e) => (e ? String(e).trim().toLowerCase() : null);
const normNombre = (n) =>
  n ? String(n).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s/g, '') : null;
function normTel(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('15')) d = d.slice(2);
  if (!d.startsWith('54')) d = '549' + d;
  else if (!d.startsWith('549')) d = '549' + d.slice(2);
  return d;
}

async function postJson(url, body, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    mensaje = 'Quiero presupuestar mi proyecto',
    visitorData = {},
    eventName = 'Contact',          // 'Lead' (formulario) o 'Contact' (botón directo)
    eventId,                        // UUID generado en el navegador (deduplicación)
    bono = 'none',
  } = req.body || {};

  const clickId =
    visitorData.promo_code || String(Math.floor(100000 + Math.random() * 900000));
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || '';
  const userAgent = req.headers['user-agent'] || '';
  const form = visitorData.formulario || {};
  const telefono = normTel(form.telefono);

  // ---- 1) Payload a Hivara (campos idénticos al PHP original) ----
  const hivaraPayload = {
    organization_id: HIVARA_ORG_ID,
    external_id: clickId,
    fbp: visitorData.fbp ?? null,
    fbc: visitorData.fbc ?? null,
    fbclid: visitorData.fbclid ?? null,
    utm_source: visitorData.utm_source ?? null,
    utm_campaign: visitorData.utm_campaign ?? null,
    utm_content: visitorData.utm_content ?? null,
    utm_adset: visitorData.utm_adset ?? null,
    phone: telefono,
    ip,
    user_agent: userAgent,
  };

  // ---- 2) Evento a Meta CAPI (Brief §6.4) — solo si hay token configurado ----
  const tareas = [
    postJson(HIVARA_ENDPOINT, hivaraPayload).catch((e) => ({ ok: false, error: e.message })),
  ];

  if (CAPI_TOKEN && PIXEL_ID) {
    const capiBody = {
      data: [{
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId || clickId,
        action_source: 'website',
        event_source_url: visitorData.page || 'https://zenplasmaderaplastica.com',
        user_data: {
          ...(telefono && { ph: [sha256(telefono)] }),
          ...(normEmail(form.email) && { em: [sha256(normEmail(form.email))] }),
          ...(normNombre(form.nombre) && { fn: [sha256(normNombre(form.nombre))] }),
          external_id: [sha256(clickId)],
          client_ip_address: ip,
          client_user_agent: userAgent,
          ...(visitorData.fbc && { fbc: visitorData.fbc }),  // fbc/fbp SIN hashear
          ...(visitorData.fbp && { fbp: visitorData.fbp }),
        },
        custom_data: {
          ...(form.tipo && { content_category: form.tipo }),
          content_name: eventName === 'Lead' ? 'form_prewhatsapp' : 'whatsapp_directo',
          bono,
        },
      }],
      ...(TEST_EVENT_CODE && { test_event_code: TEST_EVENT_CODE }),
    };
    tareas.push(
      postJson(
        `https://graph.facebook.com/v23.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`,
        capiBody
      ).catch((e) => ({ ok: false, error: e.message }))
    );
  }

  // Tracking en paralelo; si algo falla, el lead sigue su camino igual
  const resultados = await Promise.allSettled(tareas);
  resultados.forEach((r, i) => {
    const nombre = i === 0 ? 'hivara' : 'meta-capi';
    if (r.status === 'rejected' || !r.value?.ok) {
      console.error(`[api/wa] ${nombre} fallo:`, r.status === 'rejected' ? r.reason : r.value?.status, r.value?.text?.slice(0, 300));
    }
  });

  // ---- 3) URL de WhatsApp con el código (formato EXACTO del PHP original) ----
  const texto = `${mensaje}\n\n🎟 Código: ${clickId}`;
  return res.status(200).json({
    url: `https://wa.me/${WA_ZENPLAS}?text=${encodeURIComponent(texto)}`,
  });
}
