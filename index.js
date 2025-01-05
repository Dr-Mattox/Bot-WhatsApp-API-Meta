/*****************************************************************
 * index.js
 * Bot de WhatsApp en ESM
 * Funciones:
 *   - /help (con botones interactivos)
 *   - /tarea <desc>, /listar, /done <id>
 *   - /recordatorio <YYYY-MM-DD HH:MM> <texto>
 *   - Cron job para enviar recordatorios a la fecha/hora indicada
 *****************************************************************/
import express from "express";
import axios from "axios";
import mysql from "mysql2/promise";
import cron from "node-cron";

/***********************************************
 * 1. Variables de entorno
 ***********************************************/
const {
  WHATSAPP_TOKEN,
  VERIFY_TOKEN,
  PHONE_NUMBER_ID,
  MYSQLHOST,
  MYSQLUSER,
  MYSQLPASSWORD,
  MYSQLDATABASE,
  MYSQLPORT,
} = process.env;

// Número personal de WhatsApp (filtro)
const MY_WHATSAPP_NUMBER = "529983214356";

/***********************************************
 * 2. Inicializar DB (MySQL)
 ***********************************************/
const pool = mysql.createPool({
  host: MYSQLHOST,
  user: MYSQLUSER,
  password: MYSQLPASSWORD,
  database: MYSQLDATABASE,
  port: MYSQLPORT || 3306,
});

async function initDB() {
  // Tabla de TAREAS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tareas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      hecha TINYINT DEFAULT 0
    )
  `);

  // Tabla de RECORDATORIOS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recordatorios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      fecha_hora DATETIME NOT NULL,
      enviado TINYINT DEFAULT 0
    )
  `);

  console.log("Tablas de DB verificadas/creadas correctamente.");
}

await initDB().catch((err) => {
  console.error("Error al inicializar DB:", err);
});

/***********************************************
 * 3. Lógica de Tareas
 ***********************************************/
async function agregarTarea(descripcion) {
  const [result] = await pool.query(
    "INSERT INTO tareas (descripcion, hecha) VALUES (?, 0)",
    [descripcion]
  );
  return result.insertId; // Devuelve ID de la nueva tarea
}

async function listarTareasPendientes() {
  const [rows] = await pool.query(
    "SELECT * FROM tareas WHERE hecha=0"
  );
  return rows;
}

async function marcarTareaHecha(idTarea) {
  const [result] = await pool.query(
    "UPDATE tareas SET hecha=1 WHERE id=?",
    [idTarea]
  );
  return result.affectedRows; 
}

/***********************************************
 * 4. Lógica de Recordatorios + cron
 ***********************************************/
async function agregarRecordatorio(descripcion, fechaHora) {
  // fechaHora en formato YYYY-MM-DD HH:MM:SS
  const [result] = await pool.query(
    "INSERT INTO recordatorios (descripcion, fecha_hora, enviado) VALUES (?, ?, 0)",
    [descripcion, fechaHora]
  );
  return result.insertId;
}

async function obtenerRecordatoriosPendientes() {
  // Recordatorios que NO se han enviado y cuya fecha ya pasó
  const [rows] = await pool.query(`
    SELECT * FROM recordatorios
    WHERE enviado=0
      AND fecha_hora <= NOW()
  `);
  return rows;
}

async function marcarRecordatorioEnviado(id) {
  await pool.query(
    "UPDATE recordatorios SET enviado=1 WHERE id=?",
    [id]
  );
}

// Tarea programada que corre cada minuto
cron.schedule("* * * * *", async () => {
  try {
    const pendientes = await obtenerRecordatoriosPendientes();
    for (const rec of pendientes) {
      // Enviar aviso a TU número
      await sendWhatsAppMessage(MY_WHATSAPP_NUMBER, `Recordatorio: ${rec.descripcion}`);
      // Marcarlo como enviado
      await marcarRecordatorioEnviado(rec.id);
    }
  } catch (err) {
    console.error("Error en cron job recordatorios:", err);
  }
});

/***********************************************
 * 5. Servidor Express + Webhook de WhatsApp
 ***********************************************/
const app = express();
app.use(express.json());

// Verificación del webhook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado con éxito.");
    return res.status(200).send(challenge);
  } else {
    console.log("Error de verificación de webhook.");
    return res.sendStatus(403);
  }
});

// Manejo de mensajes entrantes
app.post("/webhook", async (req, res) => {
  console.log("*** Mensaje entrante ***");
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.object) {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // El usuario puede mandar texto o puede dar click a un botón interactivo
    const msg = value?.messages?.[0];
    const interactive = msg?.interactive; // En caso de que sea un button/interactive

    if (msg) {
      const from = msg.from; // número del remitente
      if (from !== MY_WHATSAPP_NUMBER) {
        console.log("Mensaje de otro número, se ignora.");
        return res.sendStatus(200);
      }

      // Revisamos si es un texto normal o un "button reply"
      if (interactive && interactive.type === "button") {
        // El usuario pulsó un botón
        const buttonReply = interactive.button_reply;
        const buttonId = buttonReply?.id;   // ID del botón
        const buttonText = buttonReply?.title; // Título del botón
        console.log("Usuario pulsó botón:", buttonId, buttonText);

        // Aquí decides qué hacer según el "id" del botón
        if (buttonId === "BTN_LISTAR_TAREAS") {
          const tareas = await listarTareasPendientes();
          if (!tareas.length) {
            await sendWhatsAppMessage(from, "No hay tareas pendientes.");
          } else {
            let respuesta = "Tareas pendientes:\n";
            tareas.forEach(t => {
              respuesta += `#${t.id} - ${t.descripcion}\n`;
            });
            await sendWhatsAppMessage(from, respuesta);
          }
        }
        else if (buttonId === "BTN_AGREGAR_TAREA") {
          await sendWhatsAppMessage(from, "Para agregar una tarea, escribe:\n/tarea <descripción>");
        }
        else if (buttonId === "BTN_RECORDATORIO") {
          await sendWhatsAppMessage(
            from, 
            "Para crear un recordatorio, usa:\n/recordatorio YYYY-MM-DD HH:MM <texto>"
          );
        }
        else {
          await sendWhatsAppMessage(from, "Botón no reconocido.");
        }

      } else {
        // Mensaje de texto normal
        const textUser = msg.text?.body || "";
        const textLower = textUser.toLowerCase().trim();

        // Comandos:
        if (textLower === "/help" || textLower === "ayuda") {
          // Enviar un mensaje interactivo con botones
          await sendWhatsAppInteractiveMessage(from);
        }
        else if (textLower.startsWith("/tarea ")) {
          const desc = textUser.slice(7).trim();
          if (!desc) {
            await sendWhatsAppMessage(from, "Uso: /tarea <descripción>");
          } else {
            const newId = await agregarTarea(desc);
            await sendWhatsAppMessage(from, `Tarea #${newId} agregada.`);
          }
        }
        else if (textLower === "/listar") {
          const pendientes = await listarTareasPendientes();
          if (!pendientes.length) {
            await sendWhatsAppMessage(from, "No hay tareas pendientes.");
          } else {
            let msgTareas = "Tareas pendientes:\n";
            pendientes.forEach(t => {
              msgTareas += `#${t.id} - ${t.descripcion}\n`;
            });
            await sendWhatsAppMessage(from, msgTareas);
          }
        }
        else if (textLower.startsWith("/done ")) {
          const idStr = textUser.slice(6).trim();
          const idNum = parseInt(idStr, 10);
          if (isNaN(idNum)) {
            await sendWhatsAppMessage(from, "Uso: /done <número_id>");
          } else {
            const changes = await marcarTareaHecha(idNum);
            if (changes > 0) {
              await sendWhatsAppMessage(from, `Tarea #${idNum} marcada como hecha.`);
            } else {
              await sendWhatsAppMessage(from, "No se encontró la tarea o ya estaba hecha.");
            }
          }
        }
        else if (textLower.startsWith("/recordatorio ")) {
          // Ejemplo: /recordatorio 2025-01-10 14:00 Revisar simulación
          const resto = textUser.slice(14).trim();
          const firstSpace = resto.indexOf(" ");
          if (firstSpace < 0) {
            await sendWhatsAppMessage(
              from, 
              "Uso: /recordatorio <YYYY-MM-DD HH:MM> <descripcion>"
            );
          } else {
            const fechaHoraStr = resto.slice(0, firstSpace);
            const desc = resto.slice(firstSpace + 1);

            // Intentamos parsear la fecha/hora
            // Se asume formato "YYYY-MM-DD HH:MM"
            // Le añadimos ":00" para segundos
            const dateObj = new Date(fechaHoraStr.replace(" ", "T") + ":00");
            if (isNaN(dateObj.getTime())) {
              await sendWhatsAppMessage(from, "Fecha/hora inválida. Formato: YYYY-MM-DD HH:MM");
            } else {
              // Convertimos a "YYYY-MM-DD HH:MM:SS"
              // OJO con zona horaria
              const iso = new Date(dateObj.getTime() - (dateObj.getTimezoneOffset()*60000))
                             .toISOString()
                             .slice(0,19)
                             .replace("T"," ");
              // Guardar en DB
              const newRecId = await agregarRecordatorio(desc, iso);
              await sendWhatsAppMessage(from, 
                `Recordatorio #${newRecId} guardado para ${iso}`
              );
            }
          }
        }
        else {
          // Respuesta por defecto
          await sendWhatsAppMessage(
            from, 
            "Comando no reconocido. Escribe /help para ver opciones."
          );
        }
      }
    }
  }

  return res.sendStatus(200);
});

// Ruta raíz
app.get("/", (req, res) => {
  res.send("¡Hola! Bot de Mecatrónica sin ChatGPT ni Inventario corriendo.");
});

/***********************************************
 * 6. Función para enviar msg de texto a WhatsApp
 ***********************************************/
export async function sendWhatsAppMessage(to, message) {
  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`;
    const data = {
      messaging_product: "whatsapp",
      to: to,
      text: { body: message }
    };
    const headers = {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    };
    const response = await axios.post(url, data, { headers });
    console.log("Mensaje enviado con éxito:", response.data);
  } catch (err) {
    console.error("Error al enviar mensaje:", err.response?.data || err.message);
  }
}

/***********************************************
 * 7. Función para enviar msg con BOTONES
 ***********************************************/
export async function sendWhatsAppInteractiveMessage(to) {
  // Enviamos un mensaje de tipo 'interactive' con 'type': 'button'
  // Documentación: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#buttons
  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`;
    const data = {
      messaging_product: "whatsapp",
      to: to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: "¿Qué deseas hacer? Usa los botones o escribe un comando."
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "BTN_LISTAR_TAREAS",
                title: "Listar Tareas"
              }
            },
            {
              type: "reply",
              reply: {
                id: "BTN_AGREGAR_TAREA",
                title: "Agregar Tarea"
              }
            },
            {
              type: "reply",
              reply: {
                id: "BTN_RECORDATORIO",
                title: "Recordatorio"
              }
            }
          ]
        }
      }
    };
    const headers = {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    };
    const response = await axios.post(url, data, { headers });
    console.log("Mensaje con botones enviado:", response.data);
  } catch (error) {
    console.error("Error al enviar mensaje interactivo:", error.response?.data || error.message);
  }
}

/***********************************************
 * 8. Iniciar servidor
 ***********************************************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
