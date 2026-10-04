/* Vesta Energia — proxy de Datadis para /hogar/ (Cloudflare Worker).
 *
 * El navegador no puede llamar a Datadis directamente: hace falta la contraseña de la
 * cuenta de Vesta y la API no admite CORS. Este Worker:
 *   1. inicia sesión en Datadis con la cuenta de Vesta (secretos DATADIS_USER / DATADIS_PASSWORD),
 *   2. comprueba que el titular (NIF) ha autorizado a Vesta y que el CUPS es suyo,
 *   3. devuelve los últimos 12 meses de consumo horario, el contrato y el maxímetro.
 * No guarda nada: cada petición se responde y se olvida.
 *
 * POST /consumo  { "cups": "ES00…", "nif": "12345678Z" }
 */

const API = 'https://datadis.es';
const MAX_PER_HOUR_PER_IP = 6;

let token = null, tokenAt = 0;
const hits = new Map();

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://vestaenergia.com').split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/consumo') return reply(404, { error: 'No encontrado.' });
    if (!allowed.includes(origin)) return reply(403, { error: 'Origen no permitido.' });

    // Límite sencillo por IP (en memoria de cada instancia; para algo serio, usar Rate Limiting de Cloudflare).
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
    if (list.length >= MAX_PER_HOUR_PER_IP) return reply(429, { error: 'Demasiadas consultas. Prueba dentro de un rato.' });
    list.push(now); hits.set(ip, list);

    let body;
    try { body = await req.json(); } catch { return reply(400, { error: 'Petición no válida.' }); }
    const cups = String(body.cups || '').toUpperCase().replace(/\s/g, '');
    const nif = String(body.nif || '').toUpperCase().replace(/\s/g, '');
    if (!/^ES\d{16}[A-Z]{2}(\d[FPCRXYZ])?$/.test(cups)) return reply(400, { error: 'CUPS no válido.' });
    if (!/^[XYZ\d]\d{7}[A-Z]$/.test(nif)) return reply(400, { error: 'DNI/NIE no válido.' });

    try {
      const supplies = await get(env, '/api-private/api/get-supplies', { authorizedNif: nif });
      // Datadis puede devolver el CUPS con o sin los dos caracteres finales de frontera.
      const supply = (Array.isArray(supplies) ? supplies : []).find(s => String(s.cups || '').toUpperCase().slice(0, 20) === cups.slice(0, 20));
      if (!supply) {
        return reply(404, { error: 'No vemos ese CUPS. Comprueba que el titular ha autorizado a Vesta Energia en Datadis (Autorizaciones) y que el DNI es el del titular del contrato. La autorización puede tardar unos minutos en activarse.' });
      }
      const base = { cups: supply.cups, distributorCode: supply.distributorCode, authorizedNif: nif };
      const end = new Date();
      const start = new Date(end.getFullYear() - 1, end.getMonth(), 1);
      const ym = d => d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0');

      const [contract, consumption, maxPower] = await Promise.all([
        get(env, '/api-private/api/get-contract-detail', base).catch(() => null),
        get(env, '/api-private/api/get-consumption-data', { ...base, startDate: ym(start), endDate: ym(end), measurementType: 0, pointType: supply.pointType }),
        get(env, '/api-private/api/get-max-power', { ...base, startDate: ym(start), endDate: ym(end) }).catch(() => [])
      ]);

      return reply(200, {
        supply: { cups: supply.cups, distributor: supply.distributor, municipality: supply.municipality, province: supply.province },
        contract: Array.isArray(contract) ? contract[0] : contract,
        consumption: (consumption || []).map(c => ({ date: c.date, time: c.time, consumptionKWh: c.consumptionKWh })),
        maxPower: (maxPower || []).map(m => ({ date: m.date, time: m.time, maxPower: m.maxPower, period: m.period }))
      });
    } catch (e) {
      return reply(502, { error: 'Datadis no responde ahora mismo. Inténtalo más tarde o sube el CSV de consumos.' });
    }
  }
};

async function login(env) {
  if (token && Date.now() - tokenAt < 20 * 3600e3) return token;
  const r = await fetch(API + '/nikola-auth/tokens/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: env.DATADIS_USER, password: env.DATADIS_PASSWORD })
  });
  if (!r.ok) throw new Error('login ' + r.status);
  token = (await r.text()).trim();
  tokenAt = Date.now();
  return token;
}

async function get(env, path, params, retry = true) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  const r = await fetch(API + path + '?' + q, { headers: { Authorization: 'Bearer ' + await login(env) } });
  if (r.status === 401 && retry) { token = null; return get(env, path, params, false); }
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return r.json();
}
