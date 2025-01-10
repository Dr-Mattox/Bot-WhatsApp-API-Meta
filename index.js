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

await initDB().catch((e) => console.error("Error initDB:", e))

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

// Ajustar cron jobs para mensajes
cron.schedule("0 10 * * *", async () => {
  const mensaje = buenosDiasMensajes[Math.floor(Math.random() * buenosDiasMensajes.length)];
  await sendWhatsAppMessage(MY_WHATSAPP_NUMBER, mensaje);
}, {
  timezone: "America/Cancun"
});

cron.schedule("0 22 * * *", async () => {
  const mensaje = buenasNochesMensajes[Math.floor(Math.random() * buenosNochesMensajes.length)];
  await sendWhatsAppMessage(MY_WHATSAPP_NUMBER, mensaje);
}, {
  timezone: "America/Cancun"
});


// Respuestas a frases comunes
const frasesComunes = {
  "descansa": "Gracias, ¡tú también descansa mucho! 🌙",
  "te amo": "¡Yo también te aprecio mucho! ❤️",
  "duerme rico": "¡Duerme súper bien y que tengas sueños lindos! ✨",
  "buenos días": "¡Buenos días! Que hoy sea un día espectacular 🌟",
  "buenas tardes": "¡Buenas tardes! ¿Cómo va tu día? 😁",
  "buenas noches": "¡Buenas noches! Que descanses mucho 🌙",
  "nos vemos": "¡Hasta luego! Cuídate mucho 😊",
  "cómo estás?": "¡Estoy aquí para ayudarte! ¿Y tú cómo estás? 😊",
  "te quiero": "¡Yo también te quiero un montón! ❤️",
  "hola": "¡Hola! Qué gusto saludarte 😊",
  "adiós": "Adiós, ¡cuídate mucho! 🌟"
};

/***********************************************
 * 4. Lógica para Recordatorios + node-cron
 ***********************************************/
async function agregarRecordatorio(desc, fechaHora) {
  // Asegurarnos de usar la hora local antes de guardar en la base de datos.
  const localTime = new Date(fechaHora.getTime() - fechaHora.getTimezoneOffset() * 60000);
  const [result] = await pool.query(
    "INSERT INTO recordatorios (descripcion, fecha_hora, enviado) VALUES (?, ?, 0)",
    [desc, localTime]
  );
  return result.insertId;
}


async function listarRecordatoriosPendientes() {
  const [rows] = await pool.query(`
    SELECT * FROM recordatorios WHERE enviado = 0 ORDER BY fecha_hora ASC
  `);

  return rows.map((row) => {
    const localTime = new Date(row.fecha_hora);
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

 // Estados para tareas
if (st === "TASK_ADD_DESC") {
  const desc = msg.text?.body?.trim(); // Preservar mayúsculas y minúsculas.
  const tareaId = await agregarTarea(desc);
  await sendWhatsAppMessage(from, `Tarea #${tareaId} agregada: "${desc}"`);
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

  // Manejo de mensajes en estados para recordatorios
if (st === "REM_ADD_DATE") {
  const date = parseCustomDate(textBody);
  if (!date) {
    await sendWhatsAppMessage(from, "Formato de fecha no reconocido. Intenta con 'hoy', 'mañana' o '10/01/2025'.");
    return;
  }
  sessions[from].tempDate = date;
  sessions[from].state = "REM_ADD_TIME";
  await sendWhatsAppMessage(from, "¿A qué hora? (ej: 3:25 pm o en 20 minutos)");
  return;
}

if (st === "REM_ADD_TIME") {
  const tempDate = sessions[from].tempDate;
  const time = parseCustomTime(textBody);
  if (!time) {
    await sendWhatsAppMessage(from, "Formato de hora no reconocido. Intenta con '3:25 pm' o 'en 20 minutos'.");
    return;
  }
  tempDate.setHours(time.getHours(), time.getMinutes(), 0, 0);
  sessions[from].tempDate = tempDate;
  sessions[from].state = "REM_ADD_DESC";
  await sendWhatsAppMessage(from, "¿Cuál es la descripción del recordatorio?");
  return;
}

if (st === "REM_ADD_DESC") {
  const desc = msg.text?.body?.trim(); // Preservar mayúsculas y minúsculas.
  const dt = sessions[from].tempDate;
  if (!dt) {
    await sendWhatsAppMessage(from, "No hay fecha y hora guardadas. Cancelo la acción.");
    sessions[from].state = "NONE";
    return;
  }
  dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset()); // Ajuste de zona horaria.
  const newId = await agregarRecordatorio(desc, dt.toISOString().slice(0, 19).replace("T", " "));
  await sendWhatsAppMessage(from, `Recordatorio guardado: ${desc} para el ${format(dt, "dd/MM/yyyy hh:mm a")}`);
  sessions[from].state = "NONE";
  return;
}

if (st === "REM_DEL_INDEX") {
  const index = parseInt(textBody, 10) - 1;
  const recs = await listarRecordatoriosPendientes();
  if (isNaN(index) || index < 0 || index >= recs.length) {
    await sendWhatsAppMessage(from, "Número inválido. Intenta de nuevo o escribe 'chambea' para cancelar.");
    return;
  }
  const recToDelete = recs[index];
  await eliminarRecordatorio(recToDelete.id);
  await sendWhatsAppMessage(from, `Recordatorio eliminado: ${recToDelete.descripcion}`);
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
    recs.forEach((r, index) => {
      msg += `${index + 1}. ${r.descripcion} (${format(new Date(r.fecha_hora), "dd/MM/yyyy hh:mm a")})\n`;
    });
    await sendWhatsAppMessage(from, msg);
  }
  return;
}

if (buttonId === "R_ADD") {
  sessions[from] = { state: "REM_ADD_DATE" };
  await sendWhatsAppMessage(from, "¿Para qué día es el recordatorio? (ej: hoy, mañana, pasado mañana, 10/01/2025)");
  return;
}

if (buttonId === "R_DEL") {
  sessions[from] = { state: "REM_DEL_INDEX" };
  await sendWhatsAppMessage(from, "Indica el número del recordatorio en la lista para eliminar:");
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
  const bodyText = "Menu Recordatorios";
  const buttons = [
    {
      type: "reply",
      reply: { id: "R_LIST", title: "Ver Recordatorios" },
    },
    {
      type: "reply",
      reply: { id: "R_ADD", title: "Nuevo Recordatorio" },
    },
    {
      type: "reply",
      reply: { id: "R_DEL", title: "Elim Recordatorio" },
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
// Corregir y mejorar parseCustomDate y parseCustomTime
function parseCustomDate(str) {
  const lower = str.toLowerCase();
  const now = new Date();

  if (lower === "hoy") {
    now.setHours(0, 0, 0, 0);
    return now;
  } else if (lower === "mañana") {
    now.setDate(now.getDate() + 1);
    now.setHours(0, 0, 0, 0);
    return now;
  } else if (lower === "pasado mañana") {
    now.setDate(now.getDate() + 2);
    now.setHours(0, 0, 0, 0);
    return now;
  }

  const dateMatch = lower.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  if (dateMatch) {
    const [day, month, year] = dateMatch[0].split("/");
    return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00`);
  }

  return null;
}

function parseCustomTime(str) {
  const lower = str.toLowerCase();
  const now = new Date();

  const timeMatch = lower.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (timeMatch) {
    let [_, hours, minutes, period] = timeMatch;
    hours = parseInt(hours, 10);
    minutes = parseInt(minutes, 10);
    if (period === "pm" && hours < 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    now.setHours(hours, minutes, 0, 0);
    return now;
  }

  const relativeMatch = lower.match(/^en\s+(\d+)\s+(minutos?|horas?)$/);
  if (relativeMatch) {
    const [, value, unit] = relativeMatch;
    const intValue = parseInt(value, 10);
    if (unit.startsWith("minuto")) now.setMinutes(now.getMinutes() + intValue);
    else now.setHours(now.getHours() + intValue);
    return now;
  }

  return null;
}