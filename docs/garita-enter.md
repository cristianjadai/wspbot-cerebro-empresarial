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

La comprobación del 12 de noviembre de 2026 devolvió servicio social habilitado, cero áreas y
ninguna configuración de áreas. Eso no demuestra que el historial de reservas esté vacío.
El historial, la ocupación, la creación y la cancelación usan MySQL en la app original y aún
no están integrados en esta función. Horarios configurados no equivalen a disponibilidad.
No se anuncian reservas, invitaciones o QR creados por estas consultas. Los pases permanentes
siguen sin habilitarse y requieren confirmación explícita.

Configuración: `GARITA_ENABLED=true`, URL privada anterior, `GARITA_API_KEY` igual a la clave
del proxy y `GARITA_GROUP_ID` igual al grupo autorizado del proxy. El servicio de sesión usa
`AGENT_READ_ENABLED=true`, manteniendo `SESSION_ONLY=true` para bloquear escrituras.
No usar `NEXT_PUBLIC_` para estas variables. Configurar variables antes del despliegue.

Validación: `npm run garita-check`, `npm run features-check`, `npm run smoke` y `npm run build`.
El proxy tiene pruebas de autenticación, grupo, whitelist, aislamiento del residente, filtrado
de datos y bloqueo de escrituras. No se envían mensajes de verificación a WhatsApp.
