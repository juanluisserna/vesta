/* Vesta Energia — analizador de la factura para hogares.
   Todo el cálculo ocurre en el navegador: ni la factura ni el CSV salen del equipo.
   La única ruta que envía algo es la del CUPS (al proxy de Datadis o al formulario). */
(function(){
'use strict';

var CONFIG = {
  // URL del Worker de /_datadis-worker. Vacía = la ruta del CUPS envía una solicitud por correo.
  datadisProxy: '',
  // NIF de Vesta Energia que el titular debe autorizar en Datadis. Vacío = se lo enviamos por correo.
  vestaNif: '',
  formEndpoint: 'https://formsubmit.co/ajax/dad40a5fbaa11649a5fbac54c66413a1',
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
};

/* Precios orientativos sin impuestos (2026). El usuario puede cambiarlos. */
var DEFAULT_PRICES = { p1: 0.21, p2: 0.14, p3: 0.09, flat: 0.14, power: 35, type: 'unknown' };
/* Impuesto eléctrico (5,11 %) + IVA (21 %), aproximado. */
var TAX = 1.0511 * 1.21;
/* Referencia de consumo de un hogar medio en España, kWh/año (orientativa). */
var AVG_HOME_KWH = 3300;
/* Festivos nacionales de fecha fija: valle todo el día en la 2.0TD. */
var HOLIDAYS = ['01-01','01-06','05-01','08-15','10-12','11-01','12-06','12-08','12-25'];
var PNAME = { 1: 'punta', 2: 'llano', 3: 'valle' };
var MONTHS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

var prices = Object.assign({}, DEFAULT_PRICES);
var current = null;   // último modelo analizado

/* ================= utilidades ================= */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function fmt(n, d){
  if(n == null || !isFinite(n)) return '—';
  return n.toLocaleString('es-ES', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
}
function eur(n){ return fmt(Math.round(n)) + ' €'; }
function pct(x){ return fmt(x * 100) + ' %'; }
/* Número en formato español o inglés. decimalDot: un punto solo se lee como decimal ("3.450" kW = 3,45). */
function num(s, decimalDot){
  if(s == null) return NaN;
  s = String(s).trim().replace(/\s|€/g, '');
  if(!s) return NaN;
  if(s.indexOf(',') >= 0){ s = s.replace(/\./g, '').replace(',', '.'); }
  else if(!decimalDot && /^\d{1,3}(\.\d{3})+$/.test(s)){ s = s.replace(/\./g, ''); }
  return parseFloat(s);
}
function pad(n){ return n < 10 ? '0' + n : '' + n; }
function isoDate(y, m, d){ return y + '-' + pad(m) + '-' + pad(d); }

/* Periodo 2.0TD (península, Baleares y Canarias) para la hora que empieza a las h. */
function periodOf(iso, h){
  var dt = new Date(iso + 'T12:00:00');
  var dow = dt.getDay();
  if(dow === 0 || dow === 6 || HOLIDAYS.indexOf(iso.slice(5)) >= 0) return 3;
  if(h < 8) return 3;
  if((h >= 10 && h < 14) || (h >= 18 && h < 22)) return 1;
  return 2;
}

/* ================= CUPS ================= */
function cleanCups(s){ return String(s || '').toUpperCase().replace(/[\s.-]/g, ''); }
function cupsValid(s){
  var m = cleanCups(s).match(/^ES(\d{16})([A-Z]{2})(\d[FPCRXYZ])?$/);
  if(!m) return false;
  var L = 'TRWAGMYFPDXBNJZSQVHLCKE';
  var r = 0;
  for(var i = 0; i < 16; i++) r = (r * 10 + (+m[1][i])) % 529;
  return m[2] === L[Math.floor(r / 23)] + L[r % 23];
}

/* ================= CSV de Datadis / distribuidora ================= */
function parseCsv(text){
  var lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(function(l){ return l.trim(); });
  if(lines.length < 2) throw new Error('El archivo está vacío.');
  var sep = (lines[0].split(';').length >= lines[0].split(',').length) ? ';' : ',';
  var head = lines[0].split(sep).map(function(c){ return c.replace(/"/g, '').trim().toLowerCase(); });
  function find(re, not){ for(var i = 0; i < head.length; i++){ if(re.test(head[i]) && !(not && not.test(head[i]))) return i; } return -1; }
  var iDate = find(/fecha|date/);
  var iHour = find(/hora|time|^h$/);
  var iKwh = find(/consumo|kwh|^ae|energ/, /vertid|export|generad|excedent|autocons|metodo|método|obten/);
  if(iDate < 0 || iHour < 0 || iKwh < 0) throw new Error('No encontramos columnas de fecha, hora y consumo en kWh.');

  var raw = [], sawZero = false, sawTwentyFour = false;
  for(var n = 1; n < lines.length; n++){
    var c = lines[n].split(sep).map(function(x){ return x.replace(/"/g, '').trim(); });
    var dm = (c[iDate] || '').match(/^(\d{1,4})[\/-](\d{1,2})[\/-](\d{1,4})/);
    if(!dm) continue;
    var y, mo, d;
    if(dm[1].length === 4){ y = +dm[1]; mo = +dm[2]; d = +dm[3]; } else { d = +dm[1]; mo = +dm[2]; y = +dm[3]; }
    if(y < 100) y += 2000;
    var hm = (c[iHour] || '').match(/^(\d{1,2})/);
    var kwh = num(c[iKwh], true);
    if(!hm || !isFinite(kwh)) continue;
    var H = +hm[1];
    if(H === 0) sawZero = true;
    if(H === 24) sawTwentyFour = true;
    raw.push({ d: isoDate(y, mo, d), H: H, kwh: kwh });
  }
  // Datadis numera las horas de 1 a 24 (la hora que termina); otras fuentes, de 0 a 23.
  var hourEnding = sawTwentyFour || !sawZero;
  return raw.map(function(r){
    var h = hourEnding ? r.H - 1 : r.H;
    return { d: r.d, h: Math.max(0, Math.min(23, h)), kwh: r.kwh };   // la hora 25 del cambio de hora cae en la 23
  });
}

/* ================= análisis de datos horarios ================= */
function analyzeHourly(records, extra){
  extra = extra || {};
  var map = {};
  records.forEach(function(r){
    if(!(r.kwh >= 0)) return;
    var k = r.d + '|' + r.h;
    map[k] = (map[k] || 0) + r.kwh;
  });
  var keys = Object.keys(map);
  if(keys.length < 24 * 7) throw new Error('Hacen falta al menos 7 días de datos horarios.');

  var days = {}, per = { 1: 0, 2: 0, 3: 0 }, total = 0, maxH = 0, maxAt = null;
  var wdSum = new Array(24).fill(0), weSum = new Array(24).fill(0), months = {};
  keys.forEach(function(k){
    var parts = k.split('|'), d = parts[0], h = +parts[1], v = map[k];
    var p = periodOf(d, h);
    var dow = new Date(d + 'T12:00:00').getDay();
    var we = (dow === 0 || dow === 6);
    (days[d] = days[d] || { min: Infinity, sum: 0, we: we, n: 0 });
    days[d].min = Math.min(days[d].min, v); days[d].sum += v; days[d].n++;
    per[p] += v; total += v;
    (we ? weSum : wdSum)[h] += v;
    if(v > maxH){ maxH = v; maxAt = d + ' ' + pad(h) + ':00'; }
    var mk = d.slice(0, 7); months[mk] = (months[mk] || 0) + v;
  });
  var dayList = Object.keys(days).sort();
  var nDays = dayList.length;
  var nWe = dayList.filter(function(d){ return days[d].we; }).length, nWd = nDays - nWe;
  // Consumo de fondo: mediana del mínimo horario de cada día completo.
  var mins = dayList.filter(function(d){ return days[d].n >= 20; }).map(function(d){ return days[d].min; }).sort(function(a, b){ return a - b; });
  var baseKwh = mins.length ? mins[Math.floor(mins.length / 2)] : null;
  var monthly = Object.keys(months).sort().map(function(mk){
    var full = dayList.filter(function(d){ return d.slice(0, 7) === mk; }).length;
    return { m: mk, kwh: months[mk], days: full };
  });

  return finalize({
    kind: 'hourly',
    from: dayList[0], to: dayList[nDays - 1],
    days: nDays,
    totalKWh: total,
    period: per,
    periodEstimated: false,
    profileWd: nWd ? wdSum.map(function(v){ return v / nWd; }) : null,
    profileWe: nWe ? weSum.map(function(v){ return v / nWe; }) : null,
    wdDaily: nWd ? dayList.filter(function(d){ return !days[d].we; }).reduce(function(a, d){ return a + days[d].sum; }, 0) / nWd : null,
    weDaily: nWe ? dayList.filter(function(d){ return days[d].we; }).reduce(function(a, d){ return a + days[d].sum; }, 0) / nWe : null,
    baseW: baseKwh != null ? baseKwh * 1000 : null,
    maxHourKW: maxH, maxHourAt: maxAt,
    maxMeterKW: extra.maxMeterKW || null,
    powerKW: extra.powerKW || null,
    monthly: monthly,
    cups: extra.cups || null,
    source: extra.source || 'csv'
  });
}

/* ================= análisis desde la factura ================= */
function analyzeBill(f){
  var per = null, estimated = false;
  if(f.p1 >= 0 && f.p2 >= 0 && f.p3 >= 0 && (f.p1 + f.p2 + f.p3) > 0){
    per = { 1: f.p1, 2: f.p2, 3: f.p3 };
    if(!(f.kwh > 0)) f.kwh = f.p1 + f.p2 + f.p3;
  } else {
    // Reparto típico de un hogar con la 2.0TD si la factura no lo trae.
    per = { 1: f.kwh * 0.30, 2: f.kwh * 0.33, 3: f.kwh * 0.37 };
    estimated = true;
  }
  return finalize({
    kind: 'bill',
    days: f.days,
    totalKWh: f.kwh,
    period: per,
    periodEstimated: estimated,
    powerKW: f.power > 0 ? f.power : null,
    billTotal: f.total > 0 ? f.total : null,
    cups: f.cups || null,
    source: f.source || 'manual'
  });
}

function finalize(m){
  m.annualKWh = m.totalKWh / m.days * 365;
  m.share = {
    1: m.period[1] / m.totalKWh,
    2: m.period[2] / m.totalKWh,
    3: m.period[3] / m.totalKWh
  };
  return m;
}

/* ================= consejos ================= */
function annualPeriods(m){
  var f = 365 / m.days;
  return { 1: m.period[1] * f, 2: m.period[2] * f, 3: m.period[3] * f };
}
function energyCost(per, pr, type){
  if(type === 'flat') return (per[1] + per[2] + per[3]) * pr.flat;
  return per[1] * pr.p1 + per[2] * pr.p2 + per[3] * pr.p3;
}

function buildTips(m, pr){
  var tips = [];
  var A = annualPeriods(m);
  var shiftFrac = 0.25;   // parte de la punta que se puede mover sin renunciar a nada (lavadora, lavavajillas, secadora, termo, coche)
  var shiftKwh = A[1] * shiftFrac + A[2] * 0.10;
  var moved = { 1: A[1] * (1 - shiftFrac), 2: A[2] * 0.90, 3: A[3] + shiftKwh };
  var est = m.periodEstimated ? ' (con un reparto típico, porque tu factura no trae el detalle por periodos)' : '';

  /* 1. Desplazar consumo a valle */
  if(pr.type === 'flat'){
    var nowFlat = energyCost(A, pr, 'flat');
    var touNow = energyCost(A, pr, 'tou');
    var touMoved = energyCost(moved, pr, 'tou');
    var save = (nowFlat - touMoved) * TAX;
    if(save > 15){
      tips.push({
        save: save,
        title: 'Pásate a una tarifa por horas y pon lo que puedas en valle',
        body: '<p>Con precio único, da igual cuándo pongas la lavadora: pagas lo mismo. Con tu reparto' + est + ', una tarifa con tres periodos te costaría <b>' + eur(touNow * TAX) + '</b> al año en energía frente a <b>' + eur(nowFlat * TAX) + '</b> de ahora' +
          (touNow < nowFlat ? ', ya sin cambiar nada' : '') + '. Si además mueves a valle una cuarta parte de lo que gastas en punta, bajaría a <b>' + eur(touMoved * TAX) + '</b>.</p>' +
          '<ul><li>Pide a tu comercializadora una tarifa de <b>tres periodos</b> o mira el <b>PVPC</b> (la tarifa regulada).</li><li>Compara siempre el precio de la punta: si es muy alto, solo compensa si de verdad mueves consumo.</li></ul>'
      });
    } else {
      tips.push({
        save: 0, info: true, good: true,
        title: 'Con tu forma de consumir, el precio único te conviene',
        body: '<p>Gastas mucho en las horas caras' + est + ', así que una tarifa por horas te saldría más cara (' + eur(touNow * TAX) + ' al año frente a ' + eur(nowFlat * TAX) + '). Quédate con precio único, salvo que puedas mover a la noche o al fin de semana buena parte de la lavadora, el lavavajillas o el termo.</p>'
      });
    }
  } else {
    var saveShift = (A[1] * shiftFrac * (pr.p1 - pr.p3) + A[2] * 0.10 * (pr.p2 - pr.p3)) * TAX;
    var unsure = pr.type === 'unknown' ? ' Esto vale si tu tarifa tiene precios distintos por horas (o es el PVPC); si pagas lo mismo a todas horas, indícalo abajo en «Ajustar los precios» y recalculamos.' : '';
    if(saveShift > 5){
      tips.push({
        save: saveShift,
        title: 'Programa los electrodomésticos para las horas baratas',
        body: '<p>Gastas el <b>' + pct(m.share[1]) + '</b> de tu luz en horas punta' + est + '. Mover a valle una cuarta parte de eso, unos <b>' + fmt(A[1] * shiftFrac) + ' kWh</b> al año, no te quita nada:</p>' +
          '<ul><li><b>Lavadora y lavavajillas</b> con inicio diferido para que arranquen después de las 0 h, o el fin de semana (todo el sábado y el domingo es valle).</li>' +
          '<li><b>Termo eléctrico</b>: un temporizador de 10 € para que caliente de madrugada. El agua aguanta caliente todo el día.</li>' +
          '<li><b>Secadora, plancha y horno</b> grandes, mejor en fin de semana.</li>' +
          '<li>Si tienes <b>coche eléctrico</b>, que cargue siempre de 0 a 8 h.</li></ul>' +
          (unsure ? '<p>' + unsure + '</p>' : '')
      });
    }
  }

  /* 2. Potencia contratada */
  var power = m.powerKW;
  if(power){
    var need = null, conf = '';
    if(m.maxMeterKW){
      need = Math.max(2.3, Math.ceil(m.maxMeterKW * 1.1 * 10) / 10);
      conf = 'Tu maxímetro marca un máximo de <b>' + fmt(m.maxMeterKW, 2) + ' kW</b>.';
    } else if(m.maxHourKW){
      // La media horaria se queda corta frente al pico real: margen amplio.
      need = Math.max(3.45, Math.ceil(m.maxHourKW * 1.8 * 10) / 10);
      conf = 'En la hora de más consumo de todo el periodo gastaste <b>' + fmt(m.maxHourKW, 2) + ' kWh</b> (una media de ' + fmt(m.maxHourKW, 2) + ' kW durante esa hora; los picos de unos minutos son más altos).';
    }
    if(need && power - need >= 0.5){
      var saveP = (power - need) * pr.power * TAX;
      tips.push({
        save: saveP,
        title: 'Baja la potencia contratada',
        body: '<p>Tienes contratados <b>' + fmt(power, 2) + ' kW</b> y pagas por ellos cada día, los uses o no. ' + conf + ' Con unos <b>' + fmt(need, 1) + ' kW</b> irías sobrado.</p>' +
          '<ul><li>Antes de cambiar, mira el <b>maxímetro</b> de tus últimas facturas o en Datadis: es el pico real que has llegado a usar.</li>' +
          '<li>Para no quedarte corto, evita encender a la vez horno, vitrocerámica y lavadora. Programar la lavadora de noche ya lo resuelve.</li>' +
          '<li>El cambio se pide a la comercializadora; la distribuidora puede cobrar unos derechos de enganche por bajar, y subir otra vez cuesta más.</li></ul>'
      });
    } else if(!need && power >= 5.75 && m.annualKWh < 3500){
      tips.push({
        save: 1.15 * pr.power * TAX,
        approx: true,
        title: 'Revisa si necesitas tanta potencia',
        body: '<p>Tienes <b>' + fmt(power, 2) + ' kW</b> contratados para un consumo moderado. Muchas casas así funcionan con 3,45 o 4,6 kW. Mira el <b>maxímetro</b> de tus facturas: si nunca pasa de ' + fmt(power - 1.5, 1) + ' kW, cada kW que bajes ahorra unos ' + eur(pr.power * TAX) + ' al año.</p>'
      });
    }
  } else {
    tips.push({
      save: 0, info: true,
      title: 'Comprueba la potencia contratada',
      body: '<p>No sabemos cuánta potencia tienes contratada. Viene en la primera página de la factura. Cada kW de más cuesta unos <b>' + eur(pr.power * TAX) + '</b> al año aunque no lo uses; si tu maxímetro nunca se acerca a lo contratado, bájala.</p>'
    });
  }

  /* 3. Consumo de fondo */
  if(m.baseW != null){
    var avgPrice = (pr.type === 'flat') ? pr.flat : (pr.p1 * m.share[1] + pr.p2 * m.share[2] + pr.p3 * m.share[3]);
    var baseCost = m.baseW * 8.76 * avgPrice * TAX;
    var reducible = Math.max(0, m.baseW - 90) * 0.4;
    if(m.baseW > 120){
      tips.push({
        save: reducible * 8.76 * avgPrice * TAX,
        title: 'Recorta el consumo que no ves',
        body: '<p>Ni de madrugada baja tu casa de <b>' + fmt(m.baseW) + ' W</b>. Ese consumo de fondo, 24 horas al día, te cuesta unos <b>' + eur(baseCost) + '</b> al año. Una nevera moderna se queda en 30–50 W de media; lo demás suelen ser aparatos en espera y equipos viejos.</p>' +
          '<ul><li><b>Regletas con interruptor</b> para la tele, el decodificador, la consola y el equipo de música: se apagan del todo con un clic.</li>' +
          '<li>Mira si hay un <b>segundo frigorífico o arcón</b> viejo funcionando casi vacío.</li>' +
          '<li>Un <b>termo</b> sin temporizador, un acuario, un deshumidificador o una bomba de piscina también suman.</li></ul>'
      });
    } else {
      tips.push({
        save: 0, info: true, good: true,
        title: 'Tu consumo de fondo está bien',
        body: '<p>De madrugada tu casa baja a unos <b>' + fmt(m.baseW) + ' W</b>, lo normal para nevera, router y poco más. Aquí no hay mucho que rascar.</p>'
      });
    }
  }

  /* 4. Climatización: meses muy por encima de los meses sin calefacción ni aire */
  if(m.monthly && m.monthly.length >= 6){
    var full = m.monthly.filter(function(x){ return x.days >= 25; });
    if(full.length >= 6){
      var daily = full.map(function(x){ return { m: x.m, v: x.kwh / x.days, days: x.days }; });
      var sorted = daily.map(function(x){ return x.v; }).sort(function(a, b){ return a - b; });
      var calm = (sorted[0] + sorted[1] + sorted[2]) / 3;   // media de los tres meses más tranquilos
      var avgP = (pr.type === 'flat') ? pr.flat : (pr.p1 * m.share[1] + pr.p2 * m.share[2] + pr.p3 * m.share[3]);
      var isWinter = function(x){ var mo = +x.m.slice(5); return mo <= 3 || mo >= 10; };
      [true, false].forEach(function(winter){
        var peaks = daily.filter(function(x){ return x.v > calm * 1.3 && isWinter(x) === winter; });
        if(!peaks.length) return;
        var extraKwh = peaks.reduce(function(a, x){ return a + (x.v - calm) * x.days; }, 0);
        tips.push({
          save: extraKwh * 0.15 * avgP * TAX,
          title: winter ? 'Ajusta la calefacción sin pasar frío' : 'Usa el aire acondicionado sin pasar calor',
          body: '<p>En ' + peaks.map(function(x){ return MONTHS[+x.m.slice(5) - 1]; }).join(', ') + ' gastas bastante más que en los meses tranquilos: unos <b>' + fmt(extraKwh) + ' kWh</b> de más. Casi seguro, ' + (winter ? 'calefacción eléctrica' : 'aire acondicionado') + '. Calculamos un ahorro de en torno al 15 % de ese extra:</p>' +
            '<ul>' + (winter
              ? '<li>Cada grado menos en el termostato ahorra en torno a un 7 %. Entre 19 y 21 °C de día y 15–17 °C para dormir es lo recomendado.</li><li>Si es bomba de calor, prográmala para que arranque en valle o en llano, no a tope a las 19 h cuando llegas a casa.</li><li>Burletes en puertas y ventanas: cuestan poco y el calor no se escapa.</li>'
              : '<li>Pon el aire a 25–26 °C en vez de 22: se está igual de bien y gasta mucho menos.</li><li>Baja persianas y toldos por la mañana y ventila de noche, cuando además la luz es más barata.</li><li>Limpia los filtros del split cada pocas semanas en temporada.</li>') +
            '</ul>'
        });
      });
    }
  }

  /* 5. Precio que pagas */
  if(m.billTotal && m.totalKWh > 0){
    var allIn = m.billTotal / m.totalKWh;
    if(allIn > 0.30){
      tips.push({
        save: 0, info: true,
        title: 'Compara tu tarifa',
        body: '<p>Contando todo (potencia, energía, alquiler del contador e impuestos), cada kWh te sale a <b>' + fmt(allIn, 2) + ' €</b>. Es alto' + (m.annualKWh < 2000 ? ', en parte porque consumes poco y los fijos pesan más' : '') + '. Compara con el comparador de la CNMC (comparadorofertasenergia.cnmc.es): es oficial y no cobra comisión.</p>' +
          '<ul><li>Mira el precio del kWh y el de la potencia, no solo los descuentos del primer año.</li><li>Si tienes ingresos bajos, familia numerosa o pensión mínima, consulta el <b>bono social</b>: descuentos de hasta el 50 % o más.</li></ul>'
      });
    }
  }

  tips = tips.filter(function(t){ return t.info || t.save >= 10; });
  tips.sort(function(a, b){ return (b.info ? -1 : b.save) - (a.info ? -1 : a.save); });
  return tips;
}

/* ================= pintado ================= */
function renderAll(m){
  current = m;
  $('results').hidden = false;
  var src = { csv: 'Con tu consumo hora a hora (CSV)', datadis: 'Con tus datos de Datadis', pdf: 'Con tu factura', manual: 'Con los datos de tu factura', demo: 'Ejemplo' }[m.source] || 'Tu análisis';
  $('r-source').textContent = src;
  $('demo-flag').hidden = m.source !== 'demo';
  $('r-range').textContent = m.from
    ? 'Del ' + new Date(m.from + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) + ' al ' + new Date(m.to + 'T12:00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) + ' · ' + fmt(m.days) + ' días'
    : 'Periodo de ' + fmt(m.days) + ' días' + (m.cups ? ' · CUPS ' + m.cups : '');

  renderTiles(m);
  renderVerdict(m);
  var tips = buildTips(m, prices);
  renderTips(tips);
  renderCharts(m);
  syncPriceForm();
  $('r-fine').textContent = 'Estimaciones orientativas con impuestos (impuesto eléctrico e IVA del 21 %) y precios de referencia sin impuestos de ' + fmt(prices.p1, 2) + ' / ' + fmt(prices.p2, 2) + ' / ' + fmt(prices.p3, 2) + ' €/kWh en punta, llano y valle, ' + fmt(prices.flat, 2) + ' €/kWh con precio único y ' + fmt(prices.power) + ' €/kW de potencia al año. Periodos de la tarifa 2.0TD para península, Baleares y Canarias. El ahorro real depende de tu contrato.';
}

function renderTiles(m){
  var A = annualPeriods(m);
  var cost = m.billTotal ? m.billTotal / m.days * 365 : (energyCost(A, prices, prices.type === 'flat' ? 'flat' : 'tou') + (m.powerKW || 4.6) * prices.power) * TAX;
  var t = [];
  t.push({ k: 'Consumo al año', v: fmt(m.annualKWh) + '<small>kWh</small>', d: m.days < 300 ? 'Estimado a partir de ' + fmt(m.days) + ' días' : 'Unos ' + fmt(m.annualKWh / 365, 1) + ' kWh al día' });
  t.push({ k: 'Gasto al año', v: fmt(Math.round(cost)) + '<small>€</small>', d: m.billTotal ? 'Según el total de tu factura' : 'Estimado con precios de referencia' });
  t.push({ k: 'En horas baratas', v: fmt(m.share[3] * 100) + '<small>%</small>', d: m.periodEstimated ? 'Reparto típico (tu factura no lo trae)' : 'De tu consumo cae en valle' });
  if(m.baseW != null) t.push({ k: 'Consumo de fondo', v: fmt(m.baseW) + '<small>W</small>', d: 'Lo mínimo que gasta tu casa, día y noche' });
  else t.push({ k: 'Potencia', v: m.powerKW ? fmt(m.powerKW, 2) + '<small>kW</small>' : '—', d: m.powerKW ? 'Contratada' : 'No la sabemos' });
  $('r-tiles').innerHTML = t.map(function(x){ return '<div class="h-tile"><div class="k">' + x.k + '</div><div class="v">' + x.v + '</div><div class="d">' + x.d + '</div></div>'; }).join('');
}

function renderVerdict(m){
  var ratio = m.annualKWh / AVG_HOME_KWH;
  var pos = Math.max(3, Math.min(97, m.annualKWh / (AVG_HOME_KWH * 2) * 100));
  var level = ratio < 0.7 ? 'por debajo de' : ratio > 1.3 ? 'por encima de' : 'en línea con';
  var s = m.share;
  var timing = s[1] > 0.33 ? 'Consumes mucho en las horas caras: aquí está tu mayor margen.'
    : s[3] > 0.5 ? 'Ya consumes la mitad o más en horas baratas. Bien hecho.'
    : 'Tu reparto es el habitual: hay margen para mover algo más a valle.';
  var homeAvg = AVG_HOME_KWH.toLocaleString('es-ES');
  $('r-verdict').innerHTML =
    '<div class="h-verdict">' +
      '<div><h3>¿Mucho o poco?</h3>' +
        '<div class="h-scale" role="img" aria-label="Tu consumo: ' + fmt(m.annualKWh) + ' kWh al año; hogar medio: ' + homeAvg + '"><i style="left:' + pos + '%">Tú</i></div>' +
        '<div class="h-scale-labels"><span>0</span><span>Hogar medio · ' + homeAvg + ' kWh</span><span>' + (AVG_HOME_KWH * 2).toLocaleString('es-ES') + '+</span></div>' +
        '<p>Con <b>' + fmt(m.annualKWh) + ' kWh al año</b> estás ' + level + ' un hogar medio en España. Es solo una referencia: una casa con calefacción o coche eléctrico gasta más y no tiene nada de malo. Lo que importa es <b>cuándo</b> consumes y cuánto pagas por ello.</p></div>' +
      '<div><h3>¿Cuándo consumes?</h3>' +
        '<div class="h-split" role="img" aria-label="Punta ' + pct(s[1]) + ', llano ' + pct(s[2]) + ', valle ' + pct(s[3]) + '">' +
          [1, 2, 3].map(function(p){ return '<span class="p' + p + '" style="flex:' + Math.max(s[p], 0.001) + '">' + (s[p] > 0.09 ? pct(s[p]) : '') + '</span>'; }).join('') +
        '</div>' +
        '<div class="h-split-legend">' + [1, 2, 3].map(function(p){ return '<span><i class="dot p' + p + '"></i>' + PNAME[p][0].toUpperCase() + PNAME[p].slice(1) + ' · ' + pct(s[p]) + '</span>'; }).join('') + '</div>' +
        '<p>' + timing + (m.periodEstimated ? ' <b>Ojo:</b> tu factura no trae el detalle por periodos y usamos un reparto típico. Con el CSV de Datadis lo vemos exacto.' : '') +
        (m.wdDaily && m.weDaily ? ' Entre semana gastas <b>' + fmt(m.wdDaily, 1) + ' kWh/día</b> y el fin de semana <b>' + fmt(m.weDaily, 1) + '</b>.' : '') + '</p></div>' +
    '</div>';
}

function renderTips(tips){
  var first = true;
  $('r-tips').innerHTML = tips.map(function(t){
    var top = !t.info && first; if(top) first = false;
    var save = t.info ? (t.good ? '<span class="save">✓</span>' : '<span class="save"><small>a revisar</small></span>')
      : '<span class="save">' + (t.approx ? '~' : '') + eur(t.save) + '<small>al año</small></span>';
    return '<li class="h-tip' + (top ? ' is-top' : '') + '"><h4>' + t.title + '</h4>' + save + '<div class="body">' + t.body + '</div></li>';
  }).join('');
}

/* ----- gráficos SVG ----- */
var tipEl;
function bindTip(svg){
  tipEl = tipEl || $('h-tip');
  svg.addEventListener('mousemove', function(e){
    var b = e.target.closest('[data-tip]');
    if(!b){ tipEl.style.opacity = 0; return; }
    tipEl.innerHTML = b.getAttribute('data-tip');
    var w = tipEl.offsetWidth;
    tipEl.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, e.clientX - w / 2)) + 'px';
    tipEl.style.top = (e.clientY - tipEl.offsetHeight - 12) + 'px';
    tipEl.style.opacity = 1;
  });
  svg.addEventListener('mouseleave', function(){ tipEl.style.opacity = 0; });
}
function niceMax(v){
  var e = Math.pow(10, Math.floor(Math.log10(v || 1))), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}
function barPath(x, y, w, h, r){
  r = Math.min(r, w / 2, h);
  return 'M' + x + ',' + (y + h) + 'V' + (y + r) + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) + 'V' + (y + h) + 'Z';
}
function barChart(o){
  // o: { values, colors[], labels[], tips[], unit, ref, refLabel, labelEvery }
  var W = 720, H = 230, L = 44, R = 8, T = 14, B = 26;
  var max = niceMax(Math.max.apply(null, o.values.concat(o.ref || 0)) * 1.08);
  var n = o.values.length, step = (W - L - R) / n, bw = Math.max(3, step - 2);
  var y = function(v){ return T + (H - T - B) * (1 - v / max); };
  var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.aria) + '">';
  for(var g = 0; g <= 4; g++){
    var gv = max * g / 4, gy = y(gv);
    s += '<line class="' + (g ? 'grid' : 'base') + '" x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '"/>';
    s += '<text class="axis" x="' + (L - 6) + '" y="' + (gy + 4) + '" text-anchor="end">' + fmt(gv, max < 2 ? 1 : 0) + '</text>';
  }
  o.values.forEach(function(v, i){
    var x = L + i * step + (step - bw) / 2, h = Math.max(0, y(0) - y(v));
    if(h > 0.5) s += '<path class="bar" fill="' + o.colors[i] + '" d="' + barPath(x, y(v), bw, h, 4) + '"/>';
    s += '<rect data-tip="' + esc(o.tips[i]) + '" x="' + (L + i * step) + '" y="' + T + '" width="' + step + '" height="' + (H - T - B) + '" fill="transparent"/>';
    if(i % (o.labelEvery || 1) === 0) s += '<text class="axis" x="' + (L + i * step + step / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + o.labels[i] + '</text>';
  });
  if(o.ref){
    s += '<line class="ref" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(o.ref) + '" y2="' + y(o.ref) + '"/>';
    s += '<text class="ref-t" x="' + (W - R) + '" y="' + (y(o.ref) - 6) + '" text-anchor="end">' + esc(o.refLabel) + '</text>';
  }
  return s + '</svg>';
}
function periodLegend(withRef, refText){
  return '<div class="legend">' + [1, 2, 3].map(function(p){ return '<span><i class="swatch p' + p + '"></i>' + PNAME[p][0].toUpperCase() + PNAME[p].slice(1) + '</span>'; }).join('') +
    (withRef ? '<span><i class="swatch ref"></i>' + refText + '</span>' : '') + '</div>';
}
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function renderCharts(m){
  var box = $('r-charts');
  if(m.kind !== 'hourly'){
    box.innerHTML = '<h3>¿Quieres ver tu día hora a hora?</h3><p class="h-sub">Con la factura solo vemos totales. Descarga el CSV de consumos de <a href="https://datadis.es" target="_blank" rel="noopener">Datadis</a> (gratis, 3 minutos) y súbelo en la segunda pestaña: verás a qué horas gastas y cuánto podrías mover.</p>';
    return;
  }
  var C = { 1: cssVar('--p1'), 2: cssVar('--p2'), 3: cssVar('--p3') };
  var html = '';
  if(m.profileWd){
    var wd = m.profileWd.map(function(v){ return v * 1000; });
    var refDay = m.baseW;
    html += '<div class="h-chart"><h3>Tu día típico entre semana</h3><p class="h-sub">Consumo medio en cada hora, en vatios. El color indica el precio de esa hora.</p>' +
      barChart({
        aria: 'Consumo medio por hora entre semana',
        values: wd,
        colors: wd.map(function(_, h){ return C[periodOf('2026-01-07', h)]; }),
        labels: wd.map(function(_, h){ return h + ' h'; }),
        labelEvery: 3,
        tips: wd.map(function(v, h){ return '<b>' + h + ':00 – ' + (h + 1) + ':00</b><br>' + fmt(v) + ' W de media · ' + PNAME[periodOf('2026-01-07', h)]; }),
        ref: refDay, refLabel: 'Consumo de fondo · ' + fmt(refDay) + ' W'
      }) + periodLegend(!!refDay, 'Consumo de fondo') + '</div>';
  }
  if(m.monthly && m.monthly.length >= 2){
    var mv = m.monthly.map(function(x){ return x.kwh; });
    html += '<div class="h-chart"><h3>Mes a mes</h3><p class="h-sub">kWh consumidos cada mes' + (m.monthly.some(function(x){ return x.days < 25; }) ? '; los meses incompletos salen más bajos' : '') + '.</p>' +
      barChart({
        aria: 'Consumo mensual en kWh',
        values: mv,
        colors: mv.map(function(){ return cssVar('--slate'); }),
        labels: m.monthly.map(function(x, i){ var mo = MONTHS[+x.m.slice(5) - 1]; return (i === 0 || mo === 'ene') ? mo + ' ' + x.m.slice(2, 4) : mo; }),
        labelEvery: m.monthly.length > 14 ? 2 : 1,
        tips: m.monthly.map(function(x){ return '<b>' + MONTHS[+x.m.slice(5) - 1] + ' ' + x.m.slice(0, 4) + '</b><br>' + fmt(x.kwh) + ' kWh · ' + fmt(x.days) + ' días con datos'; })
      }) + '</div>';
  }
  html += '<details class="data-toggle"><summary>Ver los datos en tabla</summary><div class="table-wrap"><table><thead><tr><th>Hora</th><th>Periodo</th><th class="num">Entre semana (W)</th><th class="num">Fin de semana (W)</th></tr></thead><tbody>' +
    (m.profileWd || []).map(function(v, h){ return '<tr><td>' + h + ':00</td><td>' + PNAME[periodOf('2026-01-07', h)] + '</td><td class="num">' + fmt(v * 1000) + '</td><td class="num">' + (m.profileWe ? fmt(m.profileWe[h] * 1000) : '—') + '</td></tr>'; }).join('') +
    '</tbody></table></div></details>';
  box.innerHTML = html;
  box.querySelectorAll('svg').forEach(bindTip);
}

/* ================= precios ================= */
function syncPriceForm(){
  $('pr-p1').value = fmt(prices.p1, 3); $('pr-p2').value = fmt(prices.p2, 3); $('pr-p3').value = fmt(prices.p3, 3);
  $('pr-flat').value = fmt(prices.flat, 3); $('pr-power').value = fmt(prices.power, 1); $('pr-type').value = prices.type;
}
$('price-form').addEventListener('submit', function(e){
  e.preventDefault();
  ['p1', 'p2', 'p3', 'flat', 'power'].forEach(function(k){
    var v = num($('pr-' + k).value, true);
    if(v > 0) prices[k] = v;
  });
  prices.type = $('pr-type').value;
  if(current) renderAll(current);
});

function showResults(m){
  renderAll(m);
  var r = $('results');
  r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  r.focus({ preventScroll: true });
}

/* ================= pestañas ================= */
var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
function selectTab(t){
  tabs.forEach(function(x){
    var on = x === t;
    x.setAttribute('aria-selected', on);
    x.tabIndex = on ? 0 : -1;
    $(x.getAttribute('aria-controls')).hidden = !on;
  });
}
tabs.forEach(function(t, i){
  t.addEventListener('click', function(){ selectTab(t); });
  t.addEventListener('keydown', function(e){
    var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if(!d) return;
    e.preventDefault();
    var n = tabs[(i + d + tabs.length) % tabs.length]; selectTab(n); n.focus();
  });
});

function setStatus(id, cls, html){ var el = $(id); el.className = 'h-status' + (cls ? ' ' + cls : ''); el.innerHTML = html; }
function wireDrop(id, input, onFile){
  var drop = $(id);
  ['dragenter', 'dragover'].forEach(function(ev){ drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add('is-over'); }); });
  ['dragleave', 'drop'].forEach(function(ev){ drop.addEventListener(ev, function(){ drop.classList.remove('is-over'); }); });
  drop.addEventListener('drop', function(e){ e.preventDefault(); if(e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
  $(input).addEventListener('change', function(){ if(this.files[0]) onFile(this.files[0]); this.value = ''; });
}

/* ================= factura PDF ================= */
var pdfReady = null;
function loadPdfJs(){
  if(pdfReady) return pdfReady;
  pdfReady = new Promise(function(ok, ko){
    var s = document.createElement('script');
    s.src = CONFIG.pdfjs;
    s.onload = function(){ window.pdfjsLib.GlobalWorkerOptions.workerSrc = CONFIG.pdfjsWorker; ok(window.pdfjsLib); };
    s.onerror = function(){ pdfReady = null; ko(new Error('No se pudo cargar el lector de PDF.')); };
    document.head.appendChild(s);
  });
  return pdfReady;
}
function pdfText(file){
  return Promise.all([loadPdfJs(), file.arrayBuffer()]).then(function(r){
    return r[0].getDocument({ data: r[1] }).promise;
  }).then(function(doc){
    var pages = [];
    for(var i = 1; i <= Math.min(doc.numPages, 6); i++) pages.push(doc.getPage(i).then(function(p){ return p.getTextContent(); }));
    return Promise.all(pages);
  }).then(function(contents){
    return contents.map(function(c){
      // Reconstruye líneas por posición vertical.
      var rows = [], last = null;
      c.items.forEach(function(it){
        var yy = Math.round(it.transform[5]);
        if(last === null || Math.abs(yy - last) > 2){ rows.push([]); last = yy; }
        rows[rows.length - 1].push(it.str);
      });
      return rows.map(function(r){ return r.join(' '); }).join('\n');
    }).join('\n');
  });
}

/* Lee los datos más habituales de una factura española. Es deliberadamente prudente:
   lo que no encuentra se queda vacío y el usuario lo completa. */
function extractBill(text){
  var t = text.replace(/[ \t ]+/g, ' ');
  var flat = t.replace(/\n/g, ' ');
  var out = {};
  var N = '(\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?)';

  var c = flat.match(/ES ?\d{4} ?\d{4} ?\d{4} ?\d{4} ?[A-Z]{2}(?: ?\d[FPCRXYZ])?/);
  if(c && cupsValid(c[0])) out.cups = cleanCups(c[0]);

  var dd = flat.match(/(\d{1,3})\s*d[ií]as/i);
  if(dd && +dd[1] > 0 && +dd[1] < 400) out.days = +dd[1];
  if(!out.days){
    var pr = flat.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{2,4})\s*(?:a|al|-|–|hasta)\s*(\d{2})[\/.-](\d{2})[\/.-](\d{2,4})/i);
    if(pr){
      var yr = function(y){ y = +y; return y < 100 ? 2000 + y : y; };
      var d1 = new Date(yr(pr[3]), +pr[2] - 1, +pr[1]), d2 = new Date(yr(pr[6]), +pr[5] - 1, +pr[4]);
      var n = Math.round((d2 - d1) / 864e5);
      if(n > 0 && n < 400) out.days = n;
    }
  }

  var pw = flat.match(/potencia(?:\s+contratada)?[^0-9]{0,60}?(?:P1|punta)?[^0-9]{0,20}?(\d{1,2}[.,]\d{1,3})\s*kW(?!h)/i);
  if(pw){ var pv = num(pw[1], true); if(pv > 0.5 && pv < 25) out.power = pv; }

  function kwhAfter(re){
    var m = flat.match(new RegExp(re + '[^0-9€]{0,40}?' + N + '\\s*kWh', 'i'));
    return m ? num(m[1]) : NaN;
  }
  var p1 = kwhAfter('(?:\\bP1\\b|punta)'), p2 = kwhAfter('(?:\\bP2\\b|llano)'), p3 = kwhAfter('(?:\\bP3\\b|valle)');
  if(p1 >= 0 && p2 >= 0 && p3 >= 0){ out.p1 = p1; out.p2 = p2; out.p3 = p3; }

  var tot = kwhAfter('(?:consumo\\s+total|total\\s+consumo|energ[ií]a\\s+consumida|consumo\\s+(?:del|en\\s+el|de\\s+este)\\s+periodo|consumo\\s+facturado|su\\s+consumo)');
  if(tot > 0) out.kwh = tot;
  else if(out.p1 != null) out.kwh = out.p1 + out.p2 + out.p3;

  var im = flat.match(new RegExp('total\\s*(?:a\\s+pagar|factura|importe(?:\\s+(?:de\\s+la\\s+)?factura)?)[^0-9]{0,30}?' + N + '\\s*€', 'i')) ||
           flat.match(new RegExp('importe\\s+total[^0-9]{0,30}?' + N + '\\s*€', 'i'));
  if(im){ var iv = num(im[1]); if(iv > 0 && iv < 5000) out.total = iv; }
  return out;
}

function fillBillForm(f){
  var map = { kwh: 'b-kwh', days: 'b-days', power: 'b-power', total: 'b-total', p1: 'b-p1', p2: 'b-p2', p3: 'b-p3', cups: 'b-cups' };
  Object.keys(map).forEach(function(k){
    var el = $(map[k]);
    el.classList.remove('is-filled');
    if(f[k] != null && f[k] !== ''){
      el.value = typeof f[k] === 'number' ? fmt(f[k], k === 'power' ? 2 : k === 'total' ? 2 : k === 'days' ? 0 : (f[k] % 1 ? 1 : 0)).replace(/\./g, '') : f[k];
      el.classList.add('is-filled');
    }
  });
}

wireDrop('drop-bill', 'file-bill', function(file){
  if(!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)){ setStatus('bill-status', 'err', 'Ese archivo no es un PDF. Si tienes una foto de la factura, copia los datos en el formulario de abajo.'); return; }
  setStatus('bill-status', '', 'Leyendo tu factura…');
  pdfText(file).then(function(text){
    if(text.replace(/\s/g, '').length < 80){
      setStatus('bill-status', 'err', 'Este PDF parece un escaneo y no tiene texto que podamos leer. Copia los datos en el formulario de abajo; son solo dos o tres números.');
      return;
    }
    var f = extractBill(text);
    fillBillForm(f);
    var found = ['kwh', 'days', 'power', 'total'].filter(function(k){ return f[k] != null; }).length;
    $('bill-form-intro').textContent = 'Esto es lo que hemos leído (en verde). Revísalo y completa lo que falte: cada factura es distinta.';
    if(found === 0) setStatus('bill-status', 'err', 'No hemos sabido leer esta factura. Copia los datos a mano abajo, son solo dos o tres números.');
    else setStatus('bill-status', 'ok', 'Hemos leído ' + found + ' de 4 datos principales' + (f.p1 != null ? ' y el consumo por periodos' : '') + '. Revísalos abajo y pulsa «Ver mi análisis».');
    $('bill-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }).catch(function(err){
    setStatus('bill-status', 'err', 'No pudimos abrir el PDF (' + esc(err.message) + '). Copia los datos a mano abajo.');
  });
});

$('bill-form').addEventListener('submit', function(e){
  e.preventDefault();
  var f = {
    kwh: num($('b-kwh').value), days: num($('b-days').value), power: num($('b-power').value, true), total: num($('b-total').value, true),
    p1: num($('b-p1').value), p2: num($('b-p2').value), p3: num($('b-p3').value), cups: cleanCups($('b-cups').value)
  };
  var hasPer = f.p1 >= 0 && f.p2 >= 0 && f.p3 >= 0 && f.p1 + f.p2 + f.p3 > 0;
  var err = '';
  if(!(f.kwh > 0) && !hasPer) err = 'Falta el consumo del periodo en kWh.';
  else if(!(f.days > 0 && f.days < 400)) err = 'Faltan los días facturados (suelen ser entre 28 y 62).';
  else if(f.cups && !cupsValid(f.cups)) err = 'El CUPS no parece correcto. Puedes dejarlo vacío.';
  $('bill-error').textContent = err;
  if(err) return;
  f.source = $('b-kwh').classList.contains('is-filled') ? 'pdf' : 'manual';
  showResults(analyzeBill(f));
});

/* ================= CSV ================= */
wireDrop('drop-csv', 'file-csv', function(file){
  setStatus('csv-status', '', 'Leyendo tus datos…');
  file.text().then(function(txt){
    var recs = parseCsv(txt);
    var cupsM = txt.match(/ES\d{16}[A-Z]{2}(?:\d[FPCRXYZ])?/);
    var m = analyzeHourly(recs, { source: 'csv', cups: cupsM ? cupsM[0] : null, powerKW: num($('b-power').value, true) || null });
    setStatus('csv-status', 'ok', 'Leídas ' + fmt(recs.length) + ' horas de consumo.');
    showResults(m);
  }).catch(function(err){
    setStatus('csv-status', 'err', esc(err.message) + ' Asegúrate de descargar el consumo <b>horario</b> en formato CSV.');
  });
});

/* ================= CUPS ================= */
var proxy = CONFIG.datadisProxy;
if(proxy){
  $('c-nif-field').hidden = false;
  document.querySelectorAll('[data-lead]').forEach(function(el){ el.hidden = true; });
  $('cups-send').textContent = 'Consultar mis datos';
}
if(CONFIG.vestaNif) $('vesta-nif-text').innerHTML = 'con el NIF <b>' + esc(CONFIG.vestaNif) + '</b>';

$('c-cups').addEventListener('input', function(){
  var v = cleanCups(this.value), h = $('cups-hint');
  if(v.length < 20){ h.className = 'h-hint'; h.textContent = ''; return; }
  var ok = cupsValid(v);
  h.className = 'h-hint ' + (ok ? 'ok' : 'err');
  h.textContent = ok ? 'CUPS válido' : 'Revisa el código: las dos letras de control no cuadran.';
});

$('cups-form').addEventListener('submit', function(e){
  e.preventDefault();
  var cups = cleanCups($('c-cups').value), err = '';
  if(!cupsValid(cups)) err = 'El CUPS no es válido. Cópialo tal cual de tu factura (empieza por ES).';
  else if(!$('c-consent').checked) err = 'Necesitamos tu permiso para consultar tus datos.';
  else if(proxy && !/^[XYZ\d]\d{7}[A-Z]$/i.test($('c-nif').value.trim())) err = 'Revisa el DNI o NIE del titular.';
  else if(!proxy && (!$('c-name').value.trim() || !/\S+@\S+\.\S+/.test($('c-email').value))) err = 'Déjanos tu nombre y un email para enviarte el análisis.';
  $('cups-error').textContent = err;
  if(err) return;
  var btn = $('cups-send'), old = btn.textContent;
  btn.disabled = true; btn.textContent = proxy ? 'Consultando Datadis…' : 'Enviando…';
  setStatus('cups-status', '', '');

  if(proxy){
    fetch(proxy.replace(/\/$/, '') + '/consumo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cups: cups, nif: $('c-nif').value.trim().toUpperCase() })
    }).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error || ('Error ' + r.status)); return j; }); })
      .then(function(j){
        var recs = j.consumption.map(function(c){
          var d = c.date.split('/'), H = parseInt(c.time, 10);
          return { d: isoDate(+d[0], +d[1], +d[2]), h: Math.max(0, Math.min(23, H - 1)), kwh: +c.consumptionKWh };
        });
        var mx = (j.maxPower || []).reduce(function(a, x){ return Math.max(a, +x.maxPower || 0); }, 0);
        if(mx > 100) mx = mx / 1000;   // Datadis lo da en W
        var pk = j.contract && j.contract.contractedPowerkW ? Math.max.apply(null, [].concat(j.contract.contractedPowerkW).map(Number)) : null;
        setStatus('cups-status', 'ok', 'Datos recibidos de Datadis.');
        showResults(analyzeHourly(recs, { source: 'datadis', cups: cups, powerKW: pk, maxMeterKW: mx || null }));
      })
      .catch(function(err){ setStatus('cups-status', 'err', esc(err.message)); })
      .finally(function(){ btn.disabled = false; btn.textContent = old; });
    return;
  }

  var fd = new FormData();
  fd.append('_subject', 'Análisis de hogar con Datadis — ' + cups);
  fd.append('_template', 'table');
  fd.append('nombre', $('c-name').value.trim());
  fd.append('email', $('c-email').value.trim());
  fd.append('cups', cups);
  fd.append('origen', 'Herramienta para hogares (/hogar/)');
  fetch(CONFIG.formEndpoint, { method: 'POST', headers: { 'Accept': 'application/json' }, body: fd })
    .then(function(r){ if(!r.ok) throw new Error(r.status); return r.json(); })
    .then(function(d){
      if(String(d.success) !== 'true') throw new Error('rejected');
      setStatus('cups-status', 'ok', '¡Recibido! ' + (CONFIG.vestaNif ? '' : 'Te escribimos con el NIF que debes autorizar en Datadis y, ') + 'en cuanto la autorización esté activa, te enviamos tu análisis por correo. Mientras tanto, si descargas el CSV de Datadis puedes verlo ya en la segunda pestaña.');
      $('cups-form').reset(); $('cups-hint').textContent = '';
    })
    .catch(function(){ setStatus('cups-status', 'err', 'No se pudo enviar. Escríbenos a juanluis@vestaenergia.com con tu CUPS.'); })
    .finally(function(){ btn.disabled = false; btn.textContent = old; });
});

/* ================= ejemplo ================= */
function demoRecords(){
  // Hogar de dos adultos con termo eléctrico y lavadora por la tarde. Datos inventados y reproducibles.
  var seed = 7; function rnd(){ seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  var out = [], start = new Date(2025, 9, 1);
  for(var i = 0; i < 365; i++){
    var dt = new Date(start.getTime() + i * 864e5), iso = isoDate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
    var mo = dt.getMonth() + 1, we = dt.getDay() === 0 || dt.getDay() === 6;
    var heat = (mo <= 2 || mo === 12) ? 1 : (mo === 3 || mo === 11) ? 0.5 : 0;
    var cool = (mo === 7 || mo === 8) ? 1 : 0;
    for(var h = 0; h < 24; h++){
      var v = 0.16 + rnd() * 0.03;                                     // fondo: nevera, router, esperas
      if(h === 7) v += we ? 0.1 : 0.45;                                // desayuno
      if(h >= 13 && h <= 14) v += 0.35 + rnd() * 0.3;                  // comida
      if(h >= 19 && h <= 21) v += 0.4 + rnd() * 0.35;                  // cena, tele
      if(h === 19 && (i % 3 === 0)) v += 1.1;                          // lavadora a las 19 h
      if((h === 20 || h === 21) && !we) v += 1.2;                      // termo calentando al llegar a casa
      if(heat && (h >= 17 && h <= 22)) v += heat * (1.1 + rnd() * 0.3);
      if(cool && (h >= 15 && h <= 18)) v += 0.6 + rnd() * 0.3;
      out.push({ d: iso, h: h, kwh: Math.round(v * 1000) / 1000 });
    }
  }
  return out;
}
$('demo-btn').addEventListener('click', function(){
  showResults(analyzeHourly(demoRecords(), { source: 'demo', powerKW: 5.75 }));
});
$('reset-btn').addEventListener('click', function(){
  $('results').hidden = true;
  current = null;
  window.scrollTo({ top: document.querySelector('.h-tool').offsetTop - 80, behavior: 'smooth' });
});

/* para pruebas automáticas */
window.__vestaHogar = { parseCsv: parseCsv, analyzeHourly: analyzeHourly, analyzeBill: analyzeBill, extractBill: extractBill, cupsValid: cupsValid, periodOf: periodOf, buildTips: buildTips, prices: prices };
})();
