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
