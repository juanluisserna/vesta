/* =========================================================================
   Vesta Energía — escena 3D del hero
   Instalación isométrica con ciclo día/noche: solar, red, baterías y negocio.
   Sin assets externos: toda la geometría se construye por código.
   ========================================================================= */
import * as THREE from 'three';

/* ---------- paleta (espejo de las variables CSS del sitio) ---------- */
const C = {
  ink:    0x16222f,
  navy:   0x101c29,
  paper:  0xfffcf5,
  cream:  0xfff6e6,
  flame:  0xff7a1a,
  ember:  0xffb52e,
  glow:   0xffd98a,
  grid:   0x2e6bb0,
  panel:  0x1d2f45,
  soft:   0xe6dccb,
};

/* ---------- fases del día: el guion que cuenta la escena ---------- */
const PHASES = [
  { key: 'valle', from: 0.00, to: 0.30 },
  { key: 'sol',   from: 0.30, to: 0.58 },
  { key: 'punta', from: 0.58, to: 0.82 },
  { key: 'noche', from: 0.82, to: 1.00 },
];

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/* pulso que sube y baja dentro de una ventana: sirve para activar flujos */
const daylight = t => smooth(0.25, 0.35, t) * (1 - smooth(0.66, 0.80, t));
const band = (x, a, b, feather = 0.05) => smooth(a - feather, a + feather, x) * (1 - smooth(b - feather, b + feather, x));

export function initVesta3D(canvas, opts = {}) {
  const onPhase = opts.onPhase || function () {};
  const reduced = !!opts.reducedMotion;
  const PERIOD = opts.period || 26000; // un día completo, en ms

  /* ===================== renderer / escena / cámara ===================== */
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: false, powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.cream);

  const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.1, 120);
  camera.position.set(12, 10.5, 13);

  /* el grupo "site" es lo que la cámara encuadra (el sol queda fuera) */
  const site = new THREE.Group();
  scene.add(site);

  /* ===================== luces ===================== */
  const hemi = new THREE.HemisphereLight(C.paper, C.soft, 1.15);
  scene.add(hemi);

  const sunLight = new THREE.DirectionalLight(0xfff0d8, 2.1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  const sc = sunLight.shadow.camera;
  sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = 1; sc.far = 46;
  sunLight.shadow.bias = -0.0018;
  scene.add(sunLight);
  scene.add(sunLight.target);

  /* resplandor cálido del armario cuando descarga */
  const batGlow = new THREE.PointLight(C.flame, 0, 9, 2);
  batGlow.position.set(3.0, 1.7, 1.4);
  scene.add(batGlow);

  /* ===================== materiales ===================== */
  const mat = {
    ground:  new THREE.MeshStandardMaterial({ color: 0xf3e3c6, roughness: 0.95, metalness: 0 }),
    wall:    new THREE.MeshStandardMaterial({ color: 0xfffdf8, roughness: 0.75, metalness: 0 }),
    wallAlt: new THREE.MeshStandardMaterial({ color: 0xefe3ce, roughness: 0.85, metalness: 0 }),
    roof:    new THREE.MeshStandardMaterial({ color: 0xe4d3b4, roughness: 0.88, metalness: 0 }),
    dark:    new THREE.MeshStandardMaterial({ color: C.ink, roughness: 0.6, metalness: 0.2 }),
    steel:   new THREE.MeshStandardMaterial({ color: 0x8d9aa8, roughness: 0.5, metalness: 0.6 }),
    panel:   new THREE.MeshStandardMaterial({ color: 0x16243a, roughness: 0.22, metalness: 0.6, emissive: 0x7ab0e0, emissiveIntensity: 0 }),
    window:  new THREE.MeshStandardMaterial({ color: 0x2b3d52, roughness: 0.35, emissive: C.glow, emissiveIntensity: 0 }),
    cabinet: new THREE.MeshStandardMaterial({ color: C.paper, roughness: 0.55, metalness: 0.1 }),
    level:   new THREE.MeshStandardMaterial({ color: C.flame, emissive: C.flame, emissiveIntensity: 0.75, roughness: 0.4 }),
    cable:   new THREE.MeshStandardMaterial({ color: 0x3d4a58, roughness: 0.8 }),
  };

  const box = (w, h, d, m, x, y, z, parent = site) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  /* ===================== suelo ===================== */
  const padShape = new THREE.Shape();
  (function rounded(s, w, h, r) {
    s.moveTo(-w + r, -h);
    s.lineTo(w - r, -h); s.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
    s.lineTo(w, h - r);  s.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
    s.lineTo(-w + r, h); s.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(-w, -h + r);s.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
  })(padShape, 5.5, 4.8, 1.0);

  const pad = new THREE.Mesh(
    new THREE.ExtrudeGeometry(padShape, { depth: 0.5, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 2, curveSegments: 12 }),
    mat.ground
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0;
  pad.receiveShadow = true;
  site.add(pad);

  /* ===================== la nave: "tu negocio" ===================== */
  const nave = new THREE.Group();
  nave.position.set(-1.9, 0, -0.5);
  site.add(nave);

  box(5.0, 2.6, 3.6, mat.wall, 0, 1.3, 0, nave);
  box(5.25, 0.22, 3.85, mat.roof, 0, 2.68, 0, nave);           // alero
  box(1.0, 1.5, 0.14, mat.dark, 1.4, 0.75, 1.85, nave);        // portón
  box(0.5, 0.7, 0.3, mat.steel, 2.35, 1.5, 1.2, nave);         // cuadro / contador

  const windows = [];
  for (let i = 0; i < 3; i++) {
    windows.push(box(0.82, 0.62, 0.12, mat.window, -1.55 + i * 1.05, 1.65, 1.83, nave));
  }
  windows.push(box(0.12, 0.62, 0.9, mat.window, -2.53, 1.65, 0.5, nave));

  /* placas solares en la cubierta */
  const panels = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.08, 1.12), mat.panel);
      p.position.set(-1.5 + c * 1.5, 3.0, -0.8 + r * 1.5);
      p.rotation.x = -0.3;
      p.castShadow = true;
      nave.add(p);
      panels.push(p);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.06), mat.dark);
      leg.position.set(p.position.x, 2.85, p.position.z + 0.34);
      nave.add(leg);
    }
  }

  /* ===================== armario de baterías (BESS) ===================== */
  const bess = new THREE.Group();
  bess.position.set(3.0, 0, 1.5);
  site.add(bess);

  box(0.3, 0.16, 0.3, mat.dark, 0, 0.08, 0, bess);              // zapata
  const shell = box(1.7, 2.15, 1.15, mat.cabinet, 0, 1.16, 0, bess);
  box(1.76, 0.14, 1.21, mat.dark, 0, 2.28, 0, bess);            // remate superior
  box(0.5, 0.28, 0.06, mat.dark, 0, 1.98, 0.6, bess);           // display

  /* barra de nivel: se escala en Y para representar el estado de carga */
  const levelTrack = box(0.9, 1.24, 0.05, mat.wallAlt, 0, 1.1, 0.585, bess);
  const level = new THREE.Mesh(new THREE.BoxGeometry(0.78, 1.12, 0.07), mat.level);
  level.position.set(0, 1.1, 0.6);
  bess.add(level);
  const LEVEL_H = 1.12, LEVEL_BOTTOM = 1.1 - LEVEL_H / 2;

  /* rejillas de ventilación, para que lea como equipo real */
  for (let i = 0; i < 4; i++) {
    box(1.3, 0.05, 0.04, mat.wallAlt, 0, 0.42 + i * 0.13, 0.59, bess);
  }

  /* ===================== torre de red ===================== */
  const pylon = new THREE.Group();
  pylon.position.set(3.4, 0, -3.1);
  site.add(pylon);

  const legGeo = new THREE.CylinderGeometry(0.07, 0.11, 5.0, 6);
  [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]].forEach(([x, z]) => {
    const l = new THREE.Mesh(legGeo, mat.steel);
    l.position.set(x * 0.75, 2.5, z * 0.75);
    l.rotation.z = -x * 0.055; l.rotation.x = z * 0.055;
    l.castShadow = true;
    pylon.add(l);
  });
  for (let i = 0; i < 4; i++) {
    const y = 0.9 + i * 1.1, s = 0.92 - i * 0.13;
    box(s, 0.07, 0.07, mat.steel, 0, y, 0, pylon);
    box(0.07, 0.07, s, mat.steel, 0, y, 0, pylon);
  }
  box(2.5, 0.09, 0.09, mat.steel, 0, 4.55, 0, pylon);           // travesaño
  box(2.1, 0.09, 0.09, mat.steel, 0, 4.05, 0, pylon);
  [-1.2, 1.2].forEach(x => box(0.12, 0.3, 0.12, mat.dark, x, 4.75, 0, pylon));

  /* ===================== cables ===================== */
  const curve = pts => new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)));

  const cGridToBat  = curve([[3.4, 4.5, -2.5], [3.6, 3.4, -1.2], [3.3, 2.6, 0.4], [3.0, 2.35, 1.0]]);
  const cSolarToBat = curve([[-0.5, 3.05, 0.2], [0.9, 2.9, 0.9], [2.2, 2.6, 1.35], [2.85, 2.35, 1.45]]);
  const cBatToNave  = curve([[2.25, 1.45, 1.95], [1.45, 1.2, 2.35], [0.35, 1.05, 2.15], [-0.35, 1.35, 1.4]]);
  const cGridToNave = curve([[3.4, 4.1, -2.7], [2.2, 3.5, -2.4], [1.0, 2.6, -1.6], [0.6, 1.55, -1.0]]);

  const flows = [
    { curve: cGridToBat,  color: C.grid,  key: 'gridCharge' },
    { curve: cSolarToBat, color: C.ember, key: 'solar' },
    { curve: cBatToNave,  color: C.flame, key: 'discharge' },
    { curve: cGridToNave, color: C.grid,  key: 'gridDirect' },
  ];

  const PARTICLES = 9;
  const dummy = new THREE.Object3D();
  const partGeo = new THREE.SphereGeometry(0.135, 8, 6);

  flows.forEach(f => {
    const tube = new THREE.Mesh(new THREE.TubeGeometry(f.curve, 26, 0.035, 5, false), mat.cable);
    site.add(tube);

    f.material = new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: 0 });
    f.mesh = new THREE.InstancedMesh(partGeo, f.material, PARTICLES);
    f.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    f.mesh.frustumCulled = false;
    site.add(f.mesh);
  });

  /* ===================== sol y luna ===================== */
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(0.62, 20, 16),
    new THREE.MeshBasicMaterial({ color: C.glow })
  );
  scene.add(sun);
  const sunHalo = new THREE.Mesh(
    new THREE.SphereGeometry(1.15, 20, 16),
    new THREE.MeshBasicMaterial({ color: C.glow, transparent: true, opacity: 0.3 })
  );
  scene.add(sunHalo);

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xdfe8f2 })
  );
  scene.add(moon);

  /* ===================== encuadre automático ===================== */
  function fit() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);

    const bbox = new THREE.Box3().setFromObject(site);
    const center = bbox.getCenter(new THREE.Vector3());
    camera.lookAt(center);
    camera.updateMatrixWorld();

    const inv = camera.matrixWorldInverse;
    let maxX = 0, maxY = 0;
    const min = bbox.min, max = bbox.max;
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Vector3(
        i & 1 ? max.x : min.x,
        i & 2 ? max.y : min.y,
        i & 4 ? max.z : min.z
      ).applyMatrix4(inv);
      maxX = Math.max(maxX, Math.abs(v.x));
      maxY = Math.max(maxY, Math.abs(v.y));
    }
    const aspect = w / h;
    const halfH = Math.max(maxY, maxX / aspect) * 1.03;
    camera.top = halfH; camera.bottom = -halfH;
    camera.left = -halfH * aspect; camera.right = halfH * aspect;
    camera.updateProjectionMatrix();
  }

  /* ===================== estado del ciclo ===================== */
  const skyKeys = [
    { t: 0.00, sky: 0x16263a, hemiSky: 0x24384f, hemiGround: 0x11202f, sun: 0.05 },
    { t: 0.22, sky: 0x2f4260, hemiSky: 0x44587a, hemiGround: 0x26313f, sun: 0.12 },
    { t: 0.30, sky: 0xffbe86, hemiSky: 0xffdcb8, hemiGround: 0xd8c2a4, sun: 1.50 },
    { t: 0.38, sky: 0xbcdcf7, hemiSky: 0xffffff, hemiGround: 0xf2e6cf, sun: 2.70 },
    { t: 0.60, sky: 0xc9e3f7, hemiSky: 0xfffdf6, hemiGround: 0xf2e6cf, sun: 2.60 },
    { t: 0.70, sky: 0xffc98e, hemiSky: 0xffdcb0, hemiGround: 0xe0c49e, sun: 1.90 },
    { t: 0.79, sky: 0xff9a5c, hemiSky: 0xffbb85, hemiGround: 0xb89070, sun: 0.90 },
    { t: 0.87, sky: 0x2b3d59, hemiSky: 0x4a5b76, hemiGround: 0x2a3648, sun: 0.12 },
    { t: 1.00, sky: 0x16263a, hemiSky: 0x24384f, hemiGround: 0x11202f, sun: 0.05 },
  ];

  const cTmpA = new THREE.Color(), cTmpB = new THREE.Color();
  function sky(t) {
    let i = 0;
    while (i < skyKeys.length - 2 && t > skyKeys[i + 1].t) i++;
    const a = skyKeys[i], b = skyKeys[i + 1];
    const k = clamp01((t - a.t) / (b.t - a.t));
    scene.background.copy(cTmpA.setHex(a.sky)).lerp(cTmpB.setHex(b.sky), k);
    hemi.color.copy(cTmpA.setHex(a.hemiSky)).lerp(cTmpB.setHex(b.hemiSky), k);
    hemi.groundColor.copy(cTmpA.setHex(a.hemiGround)).lerp(cTmpB.setHex(b.hemiGround), k);
    hemi.intensity = lerp(0.34, 0.95, daylight(t));
    sunLight.intensity = lerp(a.sun, b.sun, k);
  }

  function battery(t) {
    if (t < 0.30) return lerp(0.25, 0.85, smooth(0, 0.30, t));
    if (t < 0.58) return lerp(0.85, 1.00, smooth(0.30, 0.58, t));
    if (t < 0.82) return lerp(1.00, 0.42, smooth(0.58, 0.82, t));
    return lerp(0.42, 0.25, smooth(0.82, 1.0, t));
  }

  function phaseOf(t) {
    for (const p of PHASES) if (t >= p.from && t < p.to) return p.key;
    return 'valle';
  }

  let lastPhase = '', lastPct = -1;
  const offsets = new Float32Array(PARTICLES);
  for (let i = 0; i < PARTICLES; i++) offsets[i] = i / PARTICLES;

  function update(t, dt) {
    sky(t);

    /* --- sol y luna sobre un arco --- */
    const dayA = daylight(t);
    const ang = Math.PI * clamp01((t - 0.24) / (0.82 - 0.24));
    /* el disco decorativo vive en el cielo, detras de la escena... */
    sun.position.set(Math.cos(Math.PI - ang) * 9.5, Math.max(Math.sin(ang) * 6.8 + 1.5, 2.4), -6);
    sunHalo.position.copy(sun.position);
    sun.visible = sunHalo.visible = dayA > 0.03;
    /* ...y la luz va por delante, que es donde ilumina las caras que se ven */
    sunLight.position.set(Math.cos(Math.PI - ang) * 8.2, Math.sin(ang) * 6.2 + 1.6, 2.5 + Math.cos(Math.PI - ang) * 1.5);
    sunLight.target.position.set(0, 1, 0);
    sunLight.target.updateMatrixWorld();

    const nightA = 1 - dayA;
    moon.position.set(-Math.cos(Math.PI - ang) * 11, 9 - Math.abs(Math.sin(ang)) * 4, -6);
    moon.visible = nightA > 0.35;
    moon.material.opacity = nightA;

    /* --- intensidad de cada flujo según la hora --- */
    const act = {
      gridCharge: band(t, 0.00, 0.30, 0.045) + band(t, 0.86, 1.00, 0.045),
      solar:      band(t, 0.30, 0.60, 0.05),
      discharge:  band(t, 0.58, 0.86, 0.045),
      gridDirect: 0.16 + 0.1 * Math.sin(t * Math.PI * 2),
    };

    /* --- nivel de la batería --- */
    const lv = battery(t);
    level.scale.y = Math.max(0.02, lv);
    level.position.y = LEVEL_BOTTOM + (LEVEL_H * lv) / 2;
    mat.level.color.setHex(lv < 0.35 ? 0xe04b00 : C.flame);
    mat.level.emissive.setHex(lv < 0.35 ? 0xe04b00 : C.flame);

    /* --- placas y ventanas --- */
    mat.panel.emissiveIntensity = act.solar * 0.22 + dayA * 0.06;
    const lit = Math.max(nightA, act.discharge * 0.85);
    mat.window.emissiveIntensity = lerp(0.04, 1.25, lit);
    batGlow.intensity = act.discharge * 2.6;

    /* --- partículas viajando por los cables --- */
    flows.forEach(f => {
      const a = clamp01(act[f.key]);
      f.material.opacity = a;
      f.mesh.visible = a > 0.02;
      if (!f.mesh.visible) return;
      for (let i = 0; i < PARTICLES; i++) {
        offsets[i] = (offsets[i] + dt * 0.00028 * (0.6 + a)) % 1;
        const p = f.curve.getPointAt(offsets[i]);
        dummy.position.copy(p);
        const s = 0.7 + 0.5 * Math.sin(offsets[i] * Math.PI);
        dummy.scale.setScalar(s * (0.6 + a * 0.6));
        dummy.updateMatrix();
        f.mesh.setMatrixAt(i, dummy.matrix);
      }
      f.mesh.instanceMatrix.needsUpdate = true;
    });

    /* --- avisar al DOM del cambio de fase --- */
    const ph = phaseOf(t), pct = Math.round(lv * 100);
    if (ph !== lastPhase || pct !== lastPct) {
      lastPhase = ph; lastPct = pct;
      onPhase(ph, pct);
    }
  }

  /* ===================== bucle ===================== */
  /* staticT fija el instante del día (0..1) para el fotograma estático */
  const staticT = typeof opts.staticT === 'number' ? opts.staticT : 0.46;
  let raf = 0, running = false, prev = 0, clock = reduced ? staticT * PERIOD : 0;

  function loop(ts) {
    if (!running) return;
    const dt = prev ? Math.min(ts - prev, 60) : 16;
    prev = ts;
    clock = (clock + dt) % PERIOD;
    update(clock / PERIOD, dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (running || reduced) return;
    running = true; prev = 0;
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function renderOnce() {
    fit();
    update(clock / PERIOD, 16);
    renderer.render(scene, camera);
  }

  fit();
  renderOnce();

  const ro = new ResizeObserver(() => { fit(); if (!running) renderOnce(); });
  ro.observe(canvas);

  return {
    start, stop, renderOnce,
    dispose() {
      stop(); ro.disconnect(); renderer.dispose();
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
      });
    },
  };
}
