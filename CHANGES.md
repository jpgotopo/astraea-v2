# Auditoría y correcciones — astraea-v2

Este documento resume la revisión de código, funcionalidad y UI/UX hecha sobre
[`jpgotopo/astraea`](https://github.com/jpgotopo/astraea) y las correcciones
aplicadas en este repositorio. El repositorio original **no fue modificado**.

Metodología: lectura completa del código fuente, `npm run lint`, `npm run build`,
y pruebas funcionales reales con un navegador headless (Playwright + Chromium)
contra la app corriendo con `npm run dev`, reproduciendo el flujo de registro
de personas/proyectos/sesiones para confirmar causa raíz antes de corregir.

## 🐛 Bug reportado: "no me permite registrar personas nuevas"

**Causa raíz confirmada:** en `handleSaveProject` y `handleSavePerson`
(`src/App.jsx`) había **dos `alert()` distintos** disparándose por cada guardado:

1. Uno hardcodeado en inglés al final de la propia función (`alert('Person Saved')`),
   ignorando el idioma seleccionado.
2. Otro en el `onSubmit` del formulario, usando `i18next` (`alert(t('people.alertSave'))`).

El `onSubmit` llamaba a `handleSavePerson(e)` **sin `await`**, así que el segundo
alert se disparaba de inmediato, antes de que terminara de guardarse en
IndexedDB. Como `alert()` bloquea el hilo de JavaScript, el resultado real era:
el usuario completaba el formulario, aparecían **dos ventanas modales
idénticas** seguidas, y la persona/proyecto recién creado **no aparecía en la
lista** hasta cerrar ambas — dando la sensación de que el registro había
fallado. Confirmado reproduciendo el flujo con Playwright antes y después del
fix (ver `dialogCount` en las pruebas): antes disparaba 2 diálogos por guardado,
después solo 1.

**Corrección:**
- Se eliminó el `alert()` interno duplicado de `handleSaveProject` y `handleSavePerson`.
- Los `onSubmit` de los tres formularios (Proyecto, Persona, Sesión) ahora son
  `async` y usan `await` antes de mostrar el alert de confirmación, para que el
  guardado en IndexedDB termine y el estado de React se actualice primero.

## 🗑️ Funcionalidad faltante: no había forma de eliminar registros

`deleteData()` ya existía en `src/utils/db.js` pero **nunca se usaba** en la UI
(ESLint ya marcaba `deleteData` como variable importada sin uso). No existía
ningún botón para borrar un Proyecto, Persona o Sesión creados por error.

**Corrección:** se agregaron botones "Eliminar" (con confirmación) en las tres
pestañas:
- Eliminar Proyecto y Eliminar Persona **están bloqueados** con un mensaje claro
  si existen Sesiones vinculadas a ese registro, para evitar dejar sesiones con
  referencias rotas (`projectId` / `personId` colgando).
- Eliminar Sesión borra también su grabación y transcripción.

## ♻️ Los formularios no se reiniciaban al cambiar de registro

Los formularios de Proyecto/Persona/Sesión usan campos *uncontrolled*
(`defaultValue`) sin `key`, así que al hacer clic en "Nuevo" después de editar
otro registro, React no remontaba los `<input>` y podían quedar visualmente
datos del registro anterior en los campos.

**Corrección:** se agregó `key={currentX?.id || 'new-x'}` a los tres `<form>`,
forzando el remount y reseteo correcto de los campos.

## 🧟 Cierre obsoleto (stale closure) al terminar una transcripción

El `useEffect` que crea el Web Worker de transcripción se ejecuta una sola vez
(`[]`) y su `onmessage` capturaba `currentSession` del primer render. La
comparación `if (currentSession?.id === targetId)` (para decidir si refrescar
la sesión abierta en pantalla tras terminar de transcribir) siempre comparaba
contra el valor **inicial** (`null`), nunca el actual. ESLint ya señalaba la
dependencia faltante (`react-hooks/exhaustive-deps`).

**Corrección:** se agregó un `useRef` (`currentSessionRef`) sincronizado con el
estado mediante un efecto propio, y el callback del worker ahora lo consulta a
él en vez de la variable de estado cerrada. Esto también resuelve el warning
de ESLint sin necesidad de recrear el worker en cada cambio de sesión.

## 🔒 IndexedDB sin manejo de `onblocked` / `onversionchange`

Si el usuario tenía otra pestaña abierta con una conexión vieja a la base de
datos, una apertura que requiere subir de versión de esquema podía quedarse
**colgada indefinidamente y en silencio** (sin éxito ni error) — otra vía
plausible hacia "no me deja guardar nada".

**Corrección:** `openDB()` ahora rechaza explícitamente la promesa si la
apertura queda bloqueada (`request.onblocked`), y cierra proactivamente
cualquier conexión que quede obsoleta por un upgrade en otra pestaña
(`db.onversionchange`).

## 🎨 CSS con variables no definidas

`--primary-rgb` y `--btn-primary-bg` se usaban en sombras y estados `:hover`
pero nunca se declaraban en `:root` / `[data-theme='light']`, cayendo siempre
al valor de respaldo azul (`3, 169, 244`) — que no combina con el amarillo/naranja
del tema oscuro (color por defecto de la app).

**Corrección:** se definieron ambas variables para cada tema.

## 🧹 Limpieza de código muerto

- `src/hooks/useSpeechToIpa.js` y `src/utils/ipaHelpers.js` (motor alterno de
  IPA por reglas + Web Speech API) no se importaban desde ningún lado de la
  app, y además `useSpeechToIpa.js` tenía un error real de ESLint
  (`react-hooks/set-state-in-effect`). Se eliminaron.
- La dependencia `text-to-ipa` en `package.json` nunca se usaba (se importaba
  solo desde el archivo muerto de arriba). Se eliminó junto con el lockfile
  regenerado.
- `src/App.css` (sobrante de la plantilla de Vite: `.logo`, `.read-the-docs`)
  y `src/assets/react.svg` no se usaban en ningún lado. Se eliminaron.
- El `<title>` de la pestaña seguía diciendo `astral-exoplanet` y el favicon
  apuntaba al logo por defecto de Vite (`/vite.svg`) en vez del ícono propio
  de la app (`/pwa-icon.svg`). Corregido en `index.html`.
- `package.json` conservaba el nombre `astral-exoplanet` de la plantilla
  inicial; se renombró a `astraea`.
- Se quitó una duplicación literal de líneas (heartbeat + configuración de
  `env`) en `src/workers/transcriptionWorker.js`.
- Los `alert()` restantes con texto hardcodeado en inglés (fuera del flujo de
  guardado) ahora usan las claves de `i18next` ya existentes, para que
  respeten el idioma elegido por el usuario.

## ✅ Validación

- `npm run lint` → 0 errores, 0 warnings (antes: 2 errores, 1 warning).
- `npm run build` → build de producción exitosa.
- Pruebas funcionales con Playwright: alta de personas (1 solo diálogo, antes
  2), reseteo del formulario al presionar "Nuevo", y eliminación de un
  registro sin sesiones vinculadas — todo verificado en un navegador real.

## 📝 No abordado en esta pasada (recomendaciones a futuro)

- El motor de transcripción fuerza `language: 'en'` en la llamada a Whisper
  (`src/workers/transcriptionWorker.js`) incluso cuando el proyecto está
  documentando otro idioma; valdría la pena revisar si el modelo IPA
  realmente ignora ese parámetro o si conviene exponerlo como configuración.
- No hay export/import de la base completa (solo exportación de texto por
  sesión); para un uso de campo real (respaldo entre dispositivos) sería
  valioso un export/import de todo `AstraeaDB`.
- No hay botón para cancelar una transcripción en curso una vez iniciada.

---

## 🎙️ Segunda pasada: motor de transcripción (`transcriptionWorker.js` / `audioUtils.js`)

Revisión enfocada a pedido del usuario, con las mismas pruebas reales
(Playwright) — incluyendo, en este caso, aprovechar que el entorno de pruebas
**no tiene acceso a huggingface.co**, lo cual reproduce exactamente el
escenario real de un investigador de campo sin conexión en el primer uso.

### 🔴 Los errores del worker se ignoraban por completo

`worker.current.onmessage` en `App.jsx` solo manejaba `progress`, `ready`,
`segment_start`, `segment_complete` y `complete`. El worker sí emite
`{ status: 'error', ... }` (fallas de red, de WebGPU/WASM, o de la
transcripción en sí), pero al no existir esa rama, el mensaje se perdía en
silencio: la pantalla de carga o el spinner de grabación se quedaban
congelados para siempre, sin ningún aviso.

**Corrección:** se agregó el caso `status === 'error'`, con un banner visible
(`app.engineErrorTitle` + el mensaje técnico) y un botón "Reintentar" que
termina el worker actual y crea uno nuevo desde cero. Verificado en un
navegador real: con la red bloqueada, el banner aparece automáticamente tras
la falla, y el botón de reintento crea exactamente un worker nuevo por clic
(sin duplicados).

### 🔴 El fallback WebGPU→WASM también se disparaba con fallas de red

```js
this.instance = await pipeline(..., { device: 'webgpu' }).catch(async (err) => {
    console.warn('WebGPU fallback to WASM:', err.message);
    return await pipeline(..., { device: 'wasm' });
});
```

Esto asumía que cualquier falla del primer intento era por falta de soporte de
WebGPU, y reintentaba con WASM — incluyendo cuando la falla real era de red
(`Failed to fetch`). Resultado: sin conexión, la app intentaba descargar el
modelo **dos veces completas** antes de finalmente reportar el error (que
además el bug anterior ignoraba).

**Corrección:** se agregó `isNetworkError()` para distinguir errores de
conectividad de errores de dispositivo/backend. Ante una falla de red, se
reporta de inmediato sin reintentar con WASM. Verificado: en la prueba con
red bloqueada, la falla ahora se reporta en un solo intento (antes: dos
intentos fallidos y silenciosos).

### 🟠 Barra de progreso que saltaba hacia atrás

`progress_callback` de `@huggingface/transformers` reporta el progreso por
archivo del modelo (tokenizer, config, encoder, decoder…), cada uno de 0 a
100%. Al reenviar esos eventos tal cual, la barra de progreso avanzaba a
100% y luego caía de golpe al empezar a descargar el siguiente archivo.

**Corrección:** el worker ahora agrega `loaded`/`total` de todos los archivos
vistos hasta el momento (`fileProgress` Map) y reporta un porcentaje global
monótonamente creciente en vez de reenviar el progreso crudo por archivo.

### 🟠 Sin persistencia incremental de segmentos

Los segmentos transcritos solo se guardaban en estado de React; la sesión
recién se persistía en IndexedDB al recibir el evento final `complete`. Si la
app se cerraba o recargaba a mitad de una grabación larga, se perdía todo el
progreso transcrito hasta ese momento.

**Corrección:** se extrajo la lógica de guardado a `persistProgress()` y ahora
se llama también en cada `segment_complete`, no solo en `complete` — cada
segmento transcrito queda guardado en IndexedDB de inmediato.

### 🟡 Audio cruzando el worker por copia en vez de por transferencia

`postMessage({ audio: audioBuffer })` (grabación y subida de archivo) y la
respuesta `segment_complete` del worker mandaban los `Float32Array` por
*structured clone* (copia completa) en ambas direcciones.

**Corrección:** ambos lados ahora pasan la lista de `transferables`
(`[buffer]`) a `postMessage`, evitando la copia — el emisor no vuelve a leer
esos datos después de enviarlos, así que es seguro transferirlos.

### ✅ Validación

- `npm run lint` → 0 errores, 0 warnings.
- `npm run build` → build de producción exitosa.
- Playwright contra la app real, con la red a huggingface.co bloqueada
  (reproduciendo el caso de un usuario sin internet):
  - Antes de corregir: pantalla de carga congelada indefinidamente, dos
    intentos de descarga fallidos, cero mensaje de error.
  - Después de corregir: un solo intento fallido, banner de error visible
    con el mensaje técnico, botón "Reintentar" funcional (un worker nuevo
    por clic, sin duplicados).
- Regresión: se repitió la prueba de alta/borrado de Personas para confirmar
  que los cambios en `App.jsx` no rompieron nada de la primera pasada.

---

## 🎙️ Tercera pasada: idioma forzado y cancelación

### 🟡 `language: 'en'` fijo — confirmado contra la propia tarjeta del modelo

En la revisión anterior quedó como "a confirmar". Se consultó la tarjeta
oficial de [`onnx-community/ipa-whisper-base-ONNX`](https://huggingface.co/onnx-community/ipa-whisper-base-ONNX)
(fine-tune de `neurlang/ipa-whisper-base`, un Whisper multilingüe entrenado en
15 000 audios de Common Voice en **70+ idiomas**, listado con más de 90 tags
de idioma). El propio ejemplo de uso recomendado en la tarjeta del modelo
**des-fuerza explícitamente** el token de idioma del decodificador:

```python
model.config.forced_decoder_ids = None
model.generation_config.forced_decoder_ids = None
```

Es decir: el autor del modelo espera que Whisper **auto-detecte el idioma**
por segmento, no que se fije uno. Forzar `language: 'en'` (como hacía el
código) va en contra del uso documentado del propio modelo y sesga la
decodificación hacia fonología inglesa en cualquier otro idioma — justo lo
opuesto al objetivo de un transcriptor fonético "universal".

**Corrección:** se quitó `language: 'en'` de la llamada a `transcriber()` en
`transcriptionWorker.js`, dejando `task: 'transcribe'` (que sí conviene forzar,
para que nunca decida traducir en vez de transcribir). Whisper ahora
auto-detecta el idioma de cada segmento, como indica la documentación oficial
del modelo.

### 🟡 Sin botón de cancelar una transcripción en curso

No había forma de detener una transcripción larga una vez iniciada; el único
recurso era esperar o recargar la página (perdiendo el progreso — aunque tras
la pasada anterior eso ya no ocurre, gracias a la persistencia incremental).

**Corrección:** se agregó un botón "Cancelar" junto al indicador de estado
mientras `isProcessing` está activo. `transformers.js`/ONNX Runtime no expone
una forma de abortar una sola llamada de inferencia en curso, así que la
única manera confiable de detenerla es terminar el worker por completo y
levantar uno nuevo (se reutiliza la misma lógica que ya usa el botón
"Reintentar" del motor, factorizada en `restartWorker()`). El modelo se
recarga, pero al estar cacheado por el navegador (y por el service worker de
la PWA) esto debería ser prácticamente instantáneo tras el primer uso. Lo ya
transcrito no se pierde, porque queda persistido de forma incremental.

### ✅ Validación

- `npm run lint` → 0 errores, 0 warnings.
- `npm run build` → build de producción exitosa.
- Regresión con Playwright: alta/borrado de Personas y banner de error del
  motor (con la red bloqueada) siguen funcionando igual que en la pasada
  anterior.

---

## 💾 Cuarta pasada: respaldo completo (export/import de toda la base)

Última recomendación pendiente de la revisión original: no había forma de
respaldar o mover todos los datos (proyectos, personas, sesiones, audios y
transcripciones) a otro dispositivo — solo se podía exportar el texto de
una sesión a la vez.

**Implementación** (`src/utils/db.js`: `exportBackup()` / `importBackup()`,
tres botones nuevos en el encabezado):

- **Exportar respaldo**: descarga un único archivo `.json` con el contenido
  completo de `AstraeaDB` (proyectos, personas, sesiones, audios y
  transcripciones legado). Los audios (`Blob`) se serializan como *data URLs*
  base64 — sin depender de ninguna librería nueva (`FileReader`/`fetch()` del
  navegador alcanzan para ambas direcciones).
- **Importar (combinar)**: agrega el contenido del respaldo a lo que ya hay
  en el dispositivo, **sin tocar nada existente**. Como los ids de
  IndexedDB (`autoIncrement`) solo son únicos por dispositivo, reusar los ids
  del respaldo tal cual podría sobrescribir silenciosamente registros locales
  no relacionados que compartieran el mismo id. Por eso, en este modo se
  descartan los ids originales (dejando que el store asigne unos nuevos) y se
  **remapean** `projectId`/`personId` de cada sesión importada para que sigan
  apuntando al proyecto/persona correctos ya con sus nuevos ids.
- **Importar (reemplazar todo)**: borra todo lo del dispositivo y lo
  reemplaza exactamente por el contenido del archivo — para restaurar un
  respaldo completo en un dispositivo nuevo o vacío. Pide confirmación
  explícita antes de borrar, por ser destructivo.

### ✅ Validación

- `npm run lint` → 0 errores, 0 warnings.
- `npm run build` → build de producción exitosa.
- Prueba de extremo a extremo con Playwright (sembrando datos directo en
  IndexedDB, incluida una sesión con audio real en `audio` y en
  `segments[].audioBlob`):
  - Exportar → el JSON resultante tiene la estructura esperada y el audio
    queda como *data URL* (`data:audio/wav;base64,...`).
  - Importar el mismo respaldo en modo **combinar** → los conteos de
    proyectos/personas/sesiones se duplican (1→2) sin sobrescribir nada; la
    sesión importada quedó vinculada al proyecto y persona **nuevos** (ids
    remapeados correctamente); el audio se recuperó como `Blob` real, mismo
    tamaño (8 bytes) y mismo `type` (`audio/wav`) que el original.
  - Importar el mismo respaldo en modo **reemplazar** → aparece el diálogo
    de confirmación destructiva; tras aceptar, los conteos vuelven
    exactamente a los del archivo de respaldo (1/1/1), descartando los datos
    duplicados del paso anterior.
- Regresión: alta/borrado de Personas sigue funcionando sin cambios.

---

## 🔤 Nueva funcionalidad: ortografía adaptada al alfabeto de referencia

A pedido del usuario: además de la transcripción fonética (AFI), la app
ahora puede mostrar una **aproximación en ortografía "normal"**, adaptada al
alfabeto de referencia del proyecto (Español, Bahasa Indonesia o Inglés).

**Importante — límite honesto de esta funcionalidad:** convertir AFI a
ortografía real de una lengua requiere conocimiento fonológico y morfológico
de esa lengua específica, que en documentación de lenguas no documentadas
(el caso de uso central de Astraea) por definición no existe todavía. Por
eso esto **no** es un conversor lingüísticamente riguroso — es una
"re-deletreada" automática símbolo-por-símbolo del AFI a las convenciones de
letras del alfabeto de referencia elegido, pensada como punto de partida
legible para la comunidad o estudiantes que no leen AFI, **nunca** como
sustituto de la transcripción fonética ni como ortografía práctica
definitiva. Esto se explicita en la propia UI con un texto de advertencia.

### Implementación

- **`src/utils/orthography.js`** (nuevo): `ipaToOrthography(texto, alfabeto)`.
  Tabla de sustitución símbolo→letra(s) para tres alfabetos de referencia
  (`es`, `id`, `en`), con coincidencia de secuencias multi-símbolo primero
  (diptongos, africadas) antes que símbolos sueltos, y remoción de marcas
  sin letra propia (acento primario/secundario, alargamiento vocálico,
  ligaduras). Sin dependencias nuevas.
- **Nuevo campo de Proyecto**: "Alfabeto de Referencia" (`referenceAlphabet`:
  ninguno / Español / Bahasa Indonesia / Inglés) — se elige una vez por
  proyecto, según el idioma de referencia con el que la comunidad o el
  equipo va a leer las transcripciones. Se usa esto en vez de intentar
  adivinarlo del campo libre "País", que no es un valor controlado y sería
  poco confiable para decidir automáticamente.
- **UI de Sesiones**: cuando el proyecto tiene un alfabeto de referencia
  distinto de "ninguno", aparece una tercera caja "Ortografía Adaptada"
  (junto a Transcripción y Traducción) calculada en vivo a partir del AFI —
  tanto en la vista simple como por cada segmento individual — más un botón
  para exportarla como TXT.
- De paso, se conectaron un par de claves de i18n para Transcripción/
  Traducción/mensajes de "aún vacío" que ya existían en los archivos de
  idioma pero no se usaban en el componente (estaban hardcodeadas en inglés).

### ✅ Validación

- `npm run lint` → 0 errores, 0 warnings.
- `npm run build` → build de producción exitosa.
- Prueba de extremo a extremo con Playwright: proyecto con
  `referenceAlphabet: 'es'` + sesión con AFI conocido → aparece la caja
  "Adapted Spelling"/"Ortografía Adaptada" con el texto convertido exacto
  esperado y el aviso de advertencia; al cambiar el alfabeto del proyecto a
  "ninguno" desde el propio formulario de la UI, la caja desaparece.
- Regresión completa: alta/borrado de Personas, banner de error del motor
  (red bloqueada), y exportar/combinar/reemplazar de respaldo — todo sigue
  funcionando sin cambios.
