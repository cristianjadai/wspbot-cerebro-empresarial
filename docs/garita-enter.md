# ENTER en el grupo Jadai

La función `garita` conecta Cerebro con `http://garita-session.railway.internal:8097`.
El servicio permanece privado, conserva su volumen y renueva la misma sesión de ENTER.
No se envían tokens de ENTER al modelo ni a WhatsApp.

Solo se ofrece `garita_consultar` cuando el mensaje viene del grupo exacto configurado en
`GARITA_GROUP_ID`, tiene autor e ID de mensaje y no es una intervención autónoma. La identidad
del grupo, autor y mensaje se toma del webhook, no de argumentos del modelo. El proxy comprueba
otra vez el grupo y la whitelist opcional de autores, y audita cada consulta.

Preguntas de ejemplo, mencionando al bot en Jadai:

- «¿Tienes acceso a ENTER?»: consulta el estado real de la sesión.
- «¿Qué áreas puedo reservar?»: consulta áreas, reglas y estado del servicio de reservas.
- «Muéstrame las visitas que tengo creadas»: consulta las dos listas del residente verificado.
- «Dame mi QR para la placa ABC-1234»: envía Mi QR del residente, con retiro programado a los 10 segundos de activarlo. Usa tu placa real.

La comprobación del 12 de noviembre de 2026 devolvió servicio social habilitado, cero áreas y
ninguna configuración de áreas. Eso no demuestra que el historial de reservas esté vacío.
El historial, la ocupación, la creación y la cancelación usan MySQL en la app original y aún
no están integrados en esta función. Horarios configurados no equivalen a disponibilidad.
No se anuncian reservas o invitaciones creadas por estas consultas. Los pases permanentes
siguen sin habilitarse y requieren confirmación explícita.

`garita_mi_qr` es una operación separada y requiere petición explícita del hablante actual y
una placa. No reutiliza peticiones citadas ni recordatorios. Prepara el PNG sin crear un acceso,
lo sube a WAPI, activa las dos copias de Agenda y envía la imagen al grupo de origen. La hora de
retiro se incluye en el pie. Código, PNG y enlace de la imagen no se devuelven al modelo.
Repetir la activación no prolonga su vigencia; una nueva generación requiere otro mensaje.
Si falla el envío se solicita la retirada anticipada. El proxy persiste un journal antes de
escribir en ENTER, elimina con ETag solo sus registros y recupera la limpieza tras reinicios.
El backend original no ofrece TTL: el retiro depende de sus DELETE y se reintenta si falla.
No se convierte en un QR permanente, ni es una invitación para otra persona.

Configuración: `GARITA_ENABLED=true`, URL privada anterior, `GARITA_API_KEY` igual a la clave
del proxy y `GARITA_GROUP_ID` igual al grupo autorizado del proxy. El servicio de sesión usa
`AGENT_READ_ENABLED=true`, `AGENT_MIQR_ENABLED=true` y `ENTER_FINANCIAL_HEADERS` privado para
comprobar los permisos financieros antes de generar Mi QR. `SESSION_ONLY=true` sigue bloqueando
las otras escrituras; Mi QR tiene su propio permiso explícito.
No usar `NEXT_PUBLIC_` para estas variables. Configurar variables antes del despliegue.

Validación: `npm run garita-check`, `npm run features-check`, `npm run smoke` y `npm run build`.
El proxy tiene pruebas de autenticación, grupo, whitelist, aislamiento del residente, filtrado
de datos y bloqueo de escrituras. No se envían mensajes de verificación a WhatsApp.
