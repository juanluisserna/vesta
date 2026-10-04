# Proxy de Datadis para /hogar/

La herramienta de `/hogar/` funciona sin servidor con la factura en PDF y con el CSV de
Datadis. La tercera ruta, **"Solo tengo mi CUPS"**, necesita este Worker porque:

- consultar Datadis exige la contraseña de la cuenta de Vesta, que no puede ir en la web, y
- la API de Datadis no acepta llamadas desde el navegador (CORS).

Mientras no esté desplegado, esa pestaña envía una solicitud por correo (FormSubmit) con el
nombre, el email y el CUPS, y el análisis se hace a mano.

La carpeta empieza por `_` para que GitHub Pages (Jekyll) no la publique.

## Cómo funciona

1. El titular del contrato entra en datadis.es → **Autorizaciones** y autoriza el NIF de Vesta.
2. En la web introduce su CUPS y su DNI/NIE.
3. El Worker inicia sesión con la cuenta de Vesta, pide `get-supplies?authorizedNif=<DNI>` y
   solo sigue si ese CUPS aparece entre los suministros que ese titular ha autorizado.
4. Devuelve 12 meses de consumo horario, el contrato (potencias) y el maxímetro. No guarda nada.

## Desplegar (Cloudflare, plan gratuito)

```sh
cd _datadis-worker
npx wrangler login
npx wrangler secret put DATADIS_USER        # NIF/CIF de la cuenta de Vesta en Datadis
npx wrangler secret put DATADIS_PASSWORD
npx wrangler deploy
```

Después, en `hogar/hogar.js`, rellena:

```js
datadisProxy: 'https://vesta-datadis.<tu-subdominio>.workers.dev',
vestaNif: 'B12345678',   // el NIF que el titular debe autorizar en Datadis
```

## Antes de abrirlo al público

- **Privacidad:** cualquiera que conozca el CUPS y el DNI de alguien que haya autorizado a Vesta
  podría ver su consumo. Para producción conviene añadir Cloudflare Turnstile y, mejor aún,
  enviar el resultado al email del titular en vez de devolverlo en pantalla.
- **RGPD:** añade a la política de privacidad que se consultan datos de consumo con autorización
  del titular y para qué se usan.
- El límite por IP del código vive en memoria de cada instancia; para algo robusto usa las reglas
  de Rate Limiting de Cloudflare.
- Datadis cambia la API de vez en cuando (hay endpoints `-v2`). Si una llamada empieza a fallar,
  revisa la documentación de la API privada en datadis.es.
