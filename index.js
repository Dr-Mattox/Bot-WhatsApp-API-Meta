/*****************************************************************
 * index.js - Chatbot interactivo con menús de botones y 
 *            funcionalidades de Tareas y Recordatorios
 *            (Máximo 3 botones por menú).
 *****************************************************************/
import express from "express";
import axios from "axios";
import mysql from "mysql2/promise";
import cron from "node-cron";
import { format } from "date-fns";
const { utcToZonedTime } = require("date-fns-tz");


/***********************************************
 * 1. Variables de entorno y configuración
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

// Tu número personal (si deseas filtrar)
const MY_WHATSAPP_NUMBER = "529983214356";

// Objeto para manejar el estado de la conversación por cada usuario
const sessions = {};

/***********************************************
 * 2. Conexión a MySQL y creación de tablas
 ***********************************************/
const pool = mysql.createPool({
  host: MYSQLHOST,
  user: MYSQLUSER,
  password: MYSQLPASSWORD,
  database: MYSQLDATABASE,
  port: MYSQLPORT || 3306,
});

async function initDB() {
  // TAREAS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tareas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      hecha TINYINT DEFAULT 0
    )
  `);

  // RECORDATORIOS
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recordatorios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      fecha_hora DATETIME NOT NULL,
      enviado TINYINT DEFAULT 0
    )
  `);

  console.log("Tablas 'tareas' y 'recordatorios' creadas/verificadas.");
}

await initDB().catch((e) => console.error("Error initDB:", e));

/***********************************************
 * 3. Lógica para Tareas
 ***********************************************/
async function agregarTarea(desc) {
  const [result] = await pool.query(
    "INSERT INTO tareas (descripcion, hecha) VALUES (?, 0)",
    [desc]
  );
  return result.insertId;
}

async function listarTareasPendientes() {
  const [rows] = await pool.query(
    "SELECT * FROM tareas WHERE hecha=0"
  );
  return rows;
}

async function completarTarea(id) {
  const [result] = await pool.query(
    "UPDATE tareas SET hecha=1 WHERE id=? AND hecha=0",
    [id]
  );
  return result.affectedRows;
}

// Función para obtener mensajes bonitos aleatorios
const buenosDiasMensajes = [
  "Buenos días! Que tengas un día increíble 🌞",
  "¡Despierta y brilla! Hoy es un gran día para ti 🌟",
  "Buenos días, ¡no olvides sonreír! 😊"
];

const buenasNochesMensajes = [
  "Buenas noches, que descanses y tengas dulces sueños 🌙",
  "Que el sueño te lleve a un mundo de paz. Buenas noches ✨",
  "Buenas noches, recarga energías para un día maravilloso mañana 🌌"
];

// Tareas cron para enviar mensajes de buenos días y buenas noches
cron.schedule("0 10 * * *", async () => {
  const mensaje = buenosDiasMensajes[Math.floor(Math.random() * buenosDiasMensajes.length)];
  await sendWhatsAppMessage(MY_WHATSAPP_NUMBER, mensaje);
});

cron.schedule("0 22 * * *", async () => {
  const mensaje = buenasNochesMensajes[Math.floor(Math.random() * buenasNochesMensajes.length)];
  await sendWhatsAppMessage(MY_WHATSAPP_NUMBER, mensaje);
});

// Respuestas a frases comunes
const frasesComunes = {
  "descansa": "Gracias, ¡tú también descansa mucho! 🌙",
  "te amo": "¡Yo también te aprecio mucho! ❤️",
  "duerme rico": "¡Duerme súper bien y que tengas sueños lindos! ✨",
  "buenos días": "¡Buenos días! Que hoy sea un día espectacular 🌟",
  "buenas noches": "¡Buenas noches! Que descanses mucho 🌙",
  "nos vemos": "¡Hasta luego! Cuídate mucho 😊",
  "cómo estás?": "¡Estoy aquí para ayudarte! ¿Y tú cómo estás? 😊",
  "te quiero": "¡Yo también te quiero un montón! ❤️"
};


/***********************************************
 * 4. Lógica para Recordatorios + node-cron
 ***********************************************/
async function agregarRecordatorio(desc, fechaHora) {
  const [result] = await pool.query(
    "INSERT INTO recordatorios (descripcion, fecha_hora, enviado) VALUES (?, ?, 0)",
    [desc, fechaHora]
  );
  return result.insertId;
}

async function listarRecordatoriosPendientes() {
  const [rows] = await pool.query(`
    SELECT * FROM recordatorios WHERE enviado = 0 ORDER BY fecha_hora ASC
  `);

  return rows.map((row) => {
    const localTime = utcToZonedTime(row.fecha_hora, "America/Cancun");
    return {
      ...row,
      fecha_hora: format(localTime, "dd/MM/yyyy hh:mm a"),
    };
  });
}

async function eliminarRecordatorio(id) {
  const [result] = await pool.query(
    "DELETE FROM recordatorios WHERE id=? AND enviado=0",
    [id]
  );
  return result.affectedRows;
}

async function obtenerRecordatoriosParaEnviar() {
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

// Cron: cada minuto
cron.schedule("* * * * *", async () => {
  try {
    const lista = await obtenerRecordatoriosParaEnviar();
    for (const rec of lista) {
      await sendWhatsAppMessage(MY_WHATSAPP_NUMBER, `Recordatorio: ${rec.descripcion}`);
      await marcarRecordatorioEnviado(rec.id);
    }
  } catch (err) {
    console.error("Error en cron recordatorios:", err);
  }
});

/***********************************************
 * 5. Servidor Express
 ***********************************************/
const app = express();
app.use(express.json());

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado con éxito");
    return res.status(200).send(challenge);
  }
  console.log("Error verificación webhook");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  if (req.body.object) {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (value.messages) {
      const msg = value.messages[0];
      await handleIncomingMessage(msg);
    }
  }
  res.sendStatus(200);
});

// Ruta raíz
app.get("/", (req, res) => {
  res.send("Bot con menús (máx 3 botones), tareas y recordatorios. Escribe 'chambea' en WhatsApp.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});

/***********************************************
 * 6. Manejo principal de mensajes
 ***********************************************/
async function handleIncomingMessage(msg) {
  const from = msg.from;
  const type = msg.type;
  const textBody = msg.text?.body?.trim().toLowerCase();

  // Filtrar si quieres
  if (from !== MY_WHATSAPP_NUMBER) {
    console.log("Mensaje de otro número, se ignora.");
    return;
  }

  if (frasesComunes[textBody]) {
    await sendWhatsAppMessage(from, frasesComunes[textBody]);
    return;
  }
  // Si es un reply de botón (interactive)
  if (type === "interactive") {
    if (msg.interactive.type === "button_reply") {
      const buttonId = msg.interactive.button_reply.id;
      await handleButtonReply(from, buttonId);
      return;
    }
  }

  // Mensaje de texto normal
  const lower = textBody.toLowerCase();

  if (lower === "chambea") {
    sessions[from] = { state: "MAIN_MENU" };
    await sendMainMenu(from);
    return;
  }

  // Revisar estado
  const userSession = sessions[from] || {};
  const st = userSession.state || "NONE";

  // Estados Tareas
  if (st === "TASK_ADD_DESC") {
    const tareaId = await agregarTarea(textBody);
    await sendWhatsAppMessage(from, `Tarea #${tareaId} agregada: "${textBody}"`);
    sessions[from].state = "NONE";
    return;
  }
  if (st === "TASK_COMPLETE_ID") {
    const idNum = parseInt(textBody, 10);
    if (isNaN(idNum)) {
      await sendWhatsAppMessage(from, "ID inválido. Cancelo la acción.");
    } else {
      const done = await completarTarea(idNum);
      if (done > 0) {
        await sendWhatsAppMessage(from, `Tarea #${idNum} completada.`);
      } else {
        await sendWhatsAppMessage(from, "No se encontró esa tarea o ya está hecha.");
      }
    }
    sessions[from].state = "NONE";
    return;
  }

  // Estados Recordatorios
  if (st === "REM_ADD_DATE") {
    const dt = parseCustomDate(textBody);
    if (!dt) {
      await sendWhatsAppMessage(from, "Formato de fecha/hora no reconocido. Intenta otra vez o escribe 'chambea' para cancelar.");
      return;
    }
    sessions[from].tempDate = dt;
    sessions[from].state = "REM_ADD_TIME";
    await sendWhatsAppMessage(from, "¿A qué hora? (ej: 3:25 pm o en 20 minutos)");
    return;
  }
  if (st === "REM_ADD_TIME") {
    const tempDate = sessions[from].tempDate;
    const time = parseCustomTime(textBody);
    if (!time) {
      await sendWhatsAppMessage(from, "Formato de hora no reconocido. Intenta otra vez o escribe 'chambea' para cancelar.");
      return;
    }
    tempDate.setHours(time.getHours(), time.getMinutes(), 0, 0);
    sessions[from].tempDate = tempDate;
    sessions[from].state = "REM_ADD_DESC";
    await sendWhatsAppMessage(from, "¿Cuál es la descripción del recordatorio?");
    return;
  }
  if (st === "REM_ADD_DESC") {
    const desc = textBody;
    const dt = sessions[from].tempDate;
    if (!dt) {
      await sendWhatsAppMessage(from, "No hay fecha y hora guardadas. Cancelo la acción.");
      sessions[from].state = "NONE";
      return;
    }
    const iso = dt.toISOString().slice(0, 19).replace("T", " ");
    const newId = await agregarRecordatorio(desc, iso);
    await sendWhatsAppMessage(from, `Recordatorio #${newId} para ${format(dt, "dd/MM/yyyy hh:mm a")}: "${desc}"`);
    sessions[from].state = "NONE";
    return;
  }
  if (st === "REM_DEL_ID") {
    const idNum = parseInt(textBody, 10);
    if (isNaN(idNum)) {
      await sendWhatsAppMessage(from, "ID inválido. Cancelo la acción.");
    } else {
      const del = await eliminarRecordatorio(idNum);
      if (del > 0) {
        await sendWhatsAppMessage(from, `Recordatorio #${idNum} eliminado.`);
      } else {
        await sendWhatsAppMessage(from, "No se encontró ese recordatorio o ya fue enviado/eliminado.");
      }
    }
    sessions[from].state = "NONE";
    return;
  }

  // Nada coincide
  await sendWhatsAppMessage(from, "No reconozco ese comando. Escribe 'chambea' para ver el menú.");
}

/***********************************************
 * 7. Botones: handleButtonReply
 ***********************************************/
async function handleButtonReply(from, buttonId) {
  console.log("Button reply ID:", buttonId);

  // Menú Principal
  if (buttonId === "BTN_TASKS") {
    await sendTaskMenu(from);
    return;
  }
  if (buttonId === "BTN_REMINDERS") {
    await sendReminderMenu(from);
    return;
  }
  if (buttonId === "BTN_SPECIAL") {
    await sendWhatsAppMessage(from, "No hay comandos especiales por ahora.");
    return;
  }

  // Submenú Tareas
  if (buttonId === "T_SHOW") {
    const tareas = await listarTareasPendientes();
    if (tareas.length === 0) {
      await sendWhatsAppMessage(from, "No hay tareas pendientes.");
    } else {
      let msg = "Tareas pendientes:\n";
      tareas.forEach(t => {
        msg += `#${t.id} - ${t.descripcion}\n`;
      });
      await sendWhatsAppMessage(from, msg);
    }
    return;
  }
  if (buttonId === "T_ADD") {
    sessions[from] = { state: "TASK_ADD_DESC" };
    await sendWhatsAppMessage(from, "Escribe la descripción de la nueva tarea:");
    return;
  }
  if (buttonId === "T_COMPLETE") {
    sessions[from] = { state: "TASK_COMPLETE_ID" };
    await sendWhatsAppMessage(from, "Indica el ID de la tarea a completar:");
    return;
  }

  // Submenú Recordatorios
  if (buttonId === "R_LIST") {
    const recs = await listarRecordatoriosPendientes();
    if (recs.length === 0) {
      await sendWhatsAppMessage(from, "No hay recordatorios pendientes.");
    } else {
      let msg = "Recordatorios pendientes:\n";
      recs.forEach(r => {
        msg += `#${r.id} -> ${r.descripcion} (${r.fecha_hora})\n`;
      });
      await sendWhatsAppMessage(from, msg);
    }
    return;
  }
  if (buttonId === "R_ADD") {
    sessions[from] = { state: "REM_ADD_DATE" };
    await sendWhatsAppMessage(from, "¿Para cuándo es el recordatorio? (ej: hoy, mañana, 2025-01-10 14:00, en 2 dias, en 30 min, etc.)");
    return;
  }
  if (buttonId === "R_DEL") {
    sessions[from] = { state: "REM_DEL_ID" };
    await sendWhatsAppMessage(from, "¿Cuál es el ID del recordatorio a eliminar?");
    return;
  }

  // No reconocido
  await sendWhatsAppMessage(from, "Botón no reconocido. Escribe 'chambea' para menú principal.");
}

/***********************************************
 * 8. Enviar menús (máx 3 botones)
 ***********************************************/

// Menú Principal: 3 botones
async function sendMainMenu(to) {
  const bodyText = "¿Qué quieres hacer?";
  const buttons = [
    {
      type: "reply",
      reply: { id: "BTN_TASKS", title: "Tareas" },
    },
    {
      type: "reply",
      reply: { id: "BTN_REMINDERS", title: "Recordatorios" },
    },
    {
      type: "reply",
      reply: { id: "BTN_SPECIAL", title: "Comandos especiales" },
    },
  ];
  await sendInteractiveButtons(to, bodyText, buttons);
}

// Menú Tareas: 3 botones
async function sendTaskMenu(to) {
  const bodyText = "Opciones Tareas";
  const buttons = [
    {
      type: "reply",
      reply: { id: "T_SHOW", title: "Mostrar Tareas" },
    },
    {
      type: "reply",
      reply: { id: "T_ADD", title: "Agregar Tarea" },
    },
    {
      type: "reply",
      reply: { id: "T_COMPLETE", title: "Completar Tarea" },
    },
  ];
  await sendInteractiveButtons(to, bodyText, buttons);
}

// Menú Recordatorios: 3 botones
async function sendReminderMenu(to) {
  const bodyText = "Opciones Recordatorios";
  const buttons = [
    {
      type: "reply",
      reply: { id: "R_LIST", title: "Listar Recordatorios" },
    },
    {
      type: "reply",
      reply: { id: "R_ADD", title: "Agregar Recordatorio" },
    },
    {
      type: "reply",
      reply: { id: "R_DEL", title: "Eliminar Recordatorio" },
    },
  ];
  await sendInteractiveButtons(to, bodyText, buttons);
}

/***********************************************
 * 9. Enviar mensaje interactivo (máx 3 btns)
 ***********************************************/
async function sendInteractiveButtons(to, bodyText, buttons) {
  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: bodyText,
        },
        action: {
          buttons: buttons,
        },
      },
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    console.log("Menú interactivo enviado:", response.data);
  } catch (err) {
    console.error("Error al enviar menú interactivo:", err.response?.data || err.message);
  }
}

/***********************************************
 * 10. sendWhatsAppMessage (texto normal)
 ***********************************************/
async function sendWhatsAppMessage(to, text) {
  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    };

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    console.log("Mensaje enviado:", response.data);
  } catch (err) {
    console.error("Error al enviar mensaje:", err.response?.data || err.message);
  }
}

/***********************************************
 * 11. parseCustomDate para recordatorios
 ***********************************************/
// Corregir y mejorar recordatorios
function parseCustomDate(str) {
  const lower = str.toLowerCase();
  const now = new Date();
  
  if (lower === "hoy") {
    return now;
  } else if (lower === "mañana") {
    now.setDate(now.getDate() + 1);
    return now;
  } else if (lower === "pasado mañana") {
    now.setDate(now.getDate() + 2);
    return now;
  }

  const match = lower.match(/^en (\d+) (minutos?|horas?)$/);
  if (match) {
    const value = parseInt(match[1], 10);
    if (lower.includes("minuto")) {
      now.setMinutes(now.getMinutes() + value);
    } else {
      now.setHours(now.getHours() + value);
    }
    return now;
  }

  const parts = lower.match(/^(\d{2}) (\d{2}) (\d{4})$/);
  if (parts) {
    const [_, day, month, year] = parts;
    return new Date(`${year}-${month}-${day}`);
  }

  return null;
}

function parseCustomTime(str) {
  const match = str.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (match) {
    let [_, hours, minutes, period] = match;
    hours = parseInt(hours, 10);
    minutes = parseInt(minutes, 10);
    if (period.toLowerCase() === "pm" && hours < 12) {
      hours += 12;
    } else if (period.toLowerCase() === "am" && hours === 12) {
      hours = 0;
    }
    const time = new Date();
    time.setHours(hours, minutes, 0, 0);
    return time;
  }
  return null;
}
