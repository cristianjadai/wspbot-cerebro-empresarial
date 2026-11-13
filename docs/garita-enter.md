# ENTER en el grupo Jadai

La función `garita` conecta Cerebro con `http://garita-session.railway.internal:8097`.
El servicio permanece privado, conserva su volumen y renueva la misma sesión de ENTER.
No se envían tokens de ENTER al modelo ni a WhatsApp.

Las herramientas de ENTER solo se ofrecen cuando el mensaje viene del grupo exacto configurado en
`GARITA_GROUP_ID`, tiene autor e ID de mensaje y no es una intervención autónoma. La identidad
del grupo, autor y mensaje se toma del webhook, no de argumentos del modelo. El proxy comprueba
otra vez el grupo y la whitelist opcional de autores, y audita cada consulta.

Preguntas de ejemplo, mencionando al bot en Jadai:

- «¿Tienes acceso a ENTER?»: consulta el estado real de la sesión.
- «¿Qué áreas puedo reservar?»: consulta áreas, reglas y estado del servicio de reservas.
- «Muéstrame las visitas que tengo creadas»: consulta las dos listas del residente verificado.
- «Dame mi QR para la placa ABC-1234»: envía Mi QR del residente, con retiro programado a los 10 segundos de activarlo. Usa tu placa real.

La comprobación inicial devolvió servicio social habilitado, cero áreas y ninguna configuración.
Eso no demuestra que el historial de reservas esté vacío. Ahora `garita_reservas` integra el
historial propio, disponibilidad MySQL, creación y cancelación. Primero consulta las áreas: si no
hay ninguna, explica el bloqueo sin pedir fechas ni inventar espacios. Cuando la administración
configure áreas se aplicarán sus reglas reales. Horarios no equivalen a disponibilidad.

Para crear, pide área/fecha/horas e invitados, consulta disponibilidad y prepara la solicitud.
El proxy devuelve resumen, costo, garantía, estado esperado y un comando `CONFIRMAR RESERVA`
con código. Muéstralo y espera otro mensaje del mismo autor. Para cancelar, lista las reservas
propias, identifica el ID y prepara la cancelación; su comando es `CONFIRMAR CANCELACION`.
Ambas confirmaciones caducan en cinco minutos, quedan ligadas al grupo/autor/operación y se
persisten en el volumen. La confirmación proviene del texto actual del webhook, no de argumentos
del modelo ni de una cita. El modelo no puede confirmar su propia preparación en el mismo mensaje.

La creación revalida sesión, servicio social, alícuota, financiero, área, horarios/duración,
anticipación, cupos y límites de reservas. El SQL usa transacciones serializables, bloqueo de
filas/rangos y parámetros; no crea/edita áreas ni hace DDL en ENTER. Los cambios de costos o reglas
exigen otra preparación. La cancelación valida propiedad, estado y vigencia; cambia a CANCELADA
sin borrar la fila. Las reservas pendientes de pago se pagan en ENTER; las pendientes de
aprobación requieren administración. No se realizan cobros, reembolsos ni avisos a terceros.
Un resultado SQL incierto solo se concilia: nunca se repite una inserción a ciegas. La app puede
seguir operando sobre esas mismas filas. Las invitaciones generales de visitante y los pases permanentes siguen sin habilitarse;
PedidosYa/delivery sí se permite por el flujo separado de visita rápida. Los permanentes
requieren confirmación explícita.

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
las escrituras generales. Reservas usa permiso separado `AGENT_RESERVAS_ENABLED=true` y conexión
MySQL privada `ENTER_RESERVAS_MYSQL`, con TLS requerido. Mi QR tiene su propio permiso explícito.
No usar `NEXT_PUBLIC_` para estas variables. Configurar variables antes del despliegue.

Validación: `npm run garita-check`, `npm run features-check`, `npm run smoke` y `npm run build`.
El proxy tiene pruebas de autenticación, grupo, whitelist, aislamiento del residente, filtrado
de datos y bloqueo de escrituras. No se envían mensajes de verificación a WhatsApp.

## PedidosYa y visitas rápidas

«Genera una invitación para PedidosYa» llama `garita_visita_rapida` con servicio PEDIDOSYA.
No exige placa, identificación ni nombre personal del repartidor. Si no se suministran,
se usa PEDIDOSYA como nombre y ENTREGA DE PEDIDOSYA como motivo. No inventar datos.
También admite RAPPI y DELIVERY cuando corresponda a la solicitud actual.

El endpoint privado `/agent/visita-rapida` revalida grupo, whitelist, sesión/dispositivo y
permisos de visitas/alícuota/financiero. Usa `AGENT_QUICK_ENABLED=true`. Conserva un journal
privado antes de los PUT y verifica ambas copias en ENTER antes de devolver codigo_ingreso.
Es un código nativo de visita rápida, no un QR. No hay aviso MQTT a garita ni pase permanente.
No se promete caducidad fija. Solicitudes repetidas del mismo autor dentro de 60 segundos
reutilizan el mismo código verificado; «otra/nueva» en el mensaje actual solicita una distinta.
Un resultado incierto se concilia sin repetir escrituras; una creación parcial propia se
retira condicionalmente por ETag, sin tocar registros ajenos. Un código utilizado no se reactiva.

## Invitar a un amigo

El mismo flujo admite `servicio=VISITA` con `nombre` obligatorio, que puede ser un nombre o
apodo proporcionado por el usuario. No consulta ni exige registro previo del amigo, placa ni CI.
Motivo predeterminado: VISITA AL RESIDENTE. No se infiere identidad legal a partir del apodo.
Genera código de ingreso de visita rápida, no QR de invitado, ni pase permanente. Se conservan
los controles de grupo, sesión, permisos, auditoría y deduplicación. Un planteamiento hipotético
no crea un acceso: para actuar se usa una petición actual y clara como «invita a [nombre]».
