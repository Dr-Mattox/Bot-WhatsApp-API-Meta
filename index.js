/*****************************************************************
 * index.js - Chatbot interactivo con menús de botones y 
 *            funcionalidades de Tareas y Recordatorios.
 * 
 * Comandos principales:
 *  - "chambea" -> Muestra menú principal con 3 botones:
 *      1) Tareas
 *      2) Recordatorios
 *      3) Comandos especiales
 *****************************************************************/
import express from "express";
import axios from "axios";
import mysql from "mysql2/promise";
import cron from "node-cron";

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

// Número personal (para filtrar si quieres)
const MY_WHATSAPP_NUMBER = "529983214356";

// Objeto para almacenar el “estado” conversacional de cada usuario:
const sessions = {};  // { "529983214356": { state: "...", ... }}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tareas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      hecha TINYINT DEFAULT 0
    )
  `);

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
async function agregarTarea(descripcion) {
  const [result] = await pool.query(
    "INSERT INTO tareas (descripcion, hecha) VALUES (?, 0)",
    [descripcion]
  );
  return result.insertId;
}

async function listarTareasPendientes() {
  const [rows] = await pool.query("SELECT * FROM tareas WHERE hecha=0");
  return rows;
}

async function completarTarea(id) {
  const [result] = await pool.query(
    "UPDATE tareas SET hecha=1 WHERE id=? AND hecha=0",
    [id]
  );
  return result.affectedRows; // 1 si se marcó, 0 si no se encontró
}

/***********************************************
 * 4. Lógica para Recordatorios + node-cron
 ***********************************************/
async function agregarRecordatorio(desc, fechaHora) {
  // fechaHora = string "YYYY-MM-DD HH:MM:SS"
  const [result] = await pool.query(
    "INSERT INTO recordatorios (descripcion, fecha_hora, enviado) VALUES (?, ?, 0)",
    [desc, fechaHora]
  );
  return result.insertId;
}

async function listarRecordatoriosPendientes() {
  const [rows] = await pool.query(`
    SELECT * 
    FROM recordatorios
    WHERE enviado=0
    ORDER BY fecha_hora ASC
  `);
  return rows;
}

async function eliminarRecordatorio(id) {
  // Eliminar físicamente (o podrías setear "enviado=1")
  const [result] = await pool.query(
    "DELETE FROM recordatorios WHERE id=? AND enviado=0",
    [id]
  );
  return result.affectedRows;
}

async function obtenerRecordatoriosParaEnviar() {
  const [rows] = await pool.query(`
    SELECT * 
    FROM recordatorios
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

// CRON: cada minuto revisamos recordatorios que ya deban enviarse
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

// Verificación de webhook
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

// Manejo de mensajes entrantes
app.post("/webhook", async (req, res) => {
  console.log("*** Mensaje entrante ***");
  //console.log(JSON.stringify(req.body, null, 2));

  if (req.body.object) {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Manejo de los "messages" y "interactive" (botones)
    if (value.messages) {
      const msg = value.messages[0];
      handleIncomingMessage(msg, value, res);
    } else if (value.interactive) {
      // A veces el "interactive" puede venir en otra estructura
      // pero en la práctica, es parte de messages[].interactive
      // Se maneja igual que un "msg" con type=interactive
    }
  }

  // WhatsApp requiere 200 OK
  res.sendStatus(200);
});

// Ruta raíz
app.get("/", (req, res) => {
  res.send("Bot de WhatsApp con menús interactivos, tareas y recordatorios.");
});

/***********************************************
 * 6. Lógica principal: handleIncomingMessage
 ***********************************************/
async function handleIncomingMessage(msg, parentValue, res) {
  const from = msg.from;
  const type = msg.type;
  const text = msg.text?.body?.trim() || "";

  // Filtrar si quieres que solo responda a tu número
  if (from !== MY_WHATSAPP_NUMBER) {
    console.log("Mensaje de otro número, se ignora.");
    return;
  }

  // Revisar si es un mensaje de botón interactivo
  if (type === "interactive") {
    if (msg.interactive?.type === "button_reply") {
      const buttonId = msg.interactive.button_reply.id;
      await handleButtonReply(from, buttonId);
      return;
    }
  }

  // Si es texto normal
  const lower = text.toLowerCase();

  // 1) Palabra clave "chambea"
  if (lower === "chambea") {
    sessions[from] = { state: "MAIN_MENU" };
    await sendMainMenu(from);
    return;
  }

  // Si hay un "estado" guardado
  const userSession = sessions[from] || {};
  const st = userSession.state || "NONE";

  // Checar si el usuario está en un flujo (ej. agregando tarea, etc.)
  if (st === "ADD_TASK_DESC") {
    // El usuario tecleó la descripción de la tarea
    const tareaId = await agregarTarea(text);
    await sendWhatsAppMessage(from, `Tarea #${tareaId} agregada: ${text}`);
    // Volver al submenú de tareas
    sessions[from].state = "MAIN_MENU"; // o "TASK_MENU" si quieres
    await sendTaskMenu(from);
    return;
  }

  if (st === "COMPLETE_TASK_ID") {
    // El usuario tecleó el ID de la tarea
    const idNum = parseInt(text, 10);
    if (isNaN(idNum)) {
      await sendWhatsAppMessage(from, "ID no válido. Se cancela.");
    } else {
      const done = await completarTarea(idNum);
      if (done > 0) {
        await sendWhatsAppMessage(from, `Tarea #${idNum} completada.`);
      } else {
        await sendWhatsAppMessage(from, "No se encontró esa tarea pendiente.");
      }
    }
    sessions[from].state = "MAIN_MENU";
    await sendTaskMenu(from);
    return;
  }

  if (st === "ADD_REMINDER_DATE") {
    // El usuario especificó la fecha/hora (o 'hoy', 'mañana', 'en x días', etc.)
    // Para simplificar, parseamos la fecha. 
    const dt = parseCustomDate(text);
    if (!dt) {
      await sendWhatsAppMessage(from, "Formato de fecha/hora no reconocido. Intenta de nuevo.");
      // Mantenemos state
      return;
    } else {
      // Guardamos la fecha en session
      sessions[from].tempReminderDate = dt;
      // Preguntamos la descripción
      sessions[from].state = "ADD_REMINDER_DESC";
      await sendWhatsAppMessage(from, "¿Cuál es la descripción del recordatorio?");
      return;
    }
  }

  if (st === "ADD_REMINDER_DESC") {
    const desc = text;
    const dt = sessions[from].tempReminderDate;
    if (!dt) {
      await sendWhatsAppMessage(from, "No se tiene fecha/hora guardada. Reinicia.");
      sessions[from].state = "MAIN_MENU";
      await sendReminderMenu(from);
      return;
    }
    // Convert dt a "YYYY-MM-DD HH:MM:SS"
    const isoStr = dt.toISOString().slice(0,19).replace("T"," ");
    const newId = await agregarRecordatorio(desc, isoStr);
    await sendWhatsAppMessage(from, `Recordatorio #${newId} guardado para ${isoStr} con desc: ${desc}`);
    // Regresamos al submenú de recordatorios
    sessions[from].state = "MAIN_MENU";
    await sendReminderMenu(from);
    return;
  }

  if (st === "DEL_REMINDER_ID") {
    const idNum = parseInt(text, 10);
    if (isNaN(idNum)) {
      await sendWhatsAppMessage(from, "ID no válido. Se cancela.");
    } else {
      const del = await eliminarRecordatorio(idNum);
      if (del > 0) {
        await sendWhatsAppMessage(from, `Recordatorio #${idNum} eliminado.`);
      } else {
        await sendWhatsAppMessage(from, "No se encontró ese recordatorio pendiente.");
      }
    }
    sessions[from].state = "MAIN_MENU";
    await sendReminderMenu(from);
    return;
  }

  // Si no cayó en ningún flujo y no es "chambea"
  await sendWhatsAppMessage(from, "No reconozco ese comando. Escribe 'chambea' para menú.");
}

/***********************************************
 * 7. Manejo de botones (interactive button_reply)
 ***********************************************/
async function handleButtonReply(from, buttonId) {
  console.log("Button reply ID:", buttonId);
  // Según el ID, decidimos qué hacer
  // Ejemplo: MAIN_MENU -> TAREAS, RECORDATORIOS, COMANDOS

  // TAREAS
  if (buttonId === "BTN_TASKS") {
    sessions[from].state = "MAIN_MENU";
    await sendTaskMenu(from);
    return;
  }
  // RECORDATORIOS
  if (buttonId === "BTN_REMINDERS") {
    sessions[from].state = "MAIN_MENU";
    await sendReminderMenu(from);
    return;
  }
  // COMANDOS ESPECIALES
  if (buttonId === "BTN_SPECIAL") {
    await sendWhatsAppMessage(from, "No hay comandos especiales por ahora.");
    // Te podríamos regresar al menú principal
    await sendMainMenu(from);
    return;
  }

  // Botones submenú TAREAS
  if (buttonId === "TASK_SHOW") {
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
    // Volver
    await sendTaskMenu(from);
    return;
  }
  if (buttonId === "TASK_ADD") {
    // Pasamos a estado para que el usuario escriba la tarea
    sessions[from].state = "ADD_TASK_DESC";
    await sendWhatsAppMessage(from, "Escribe la descripción de la nueva tarea:");
    return;
  }
  if (buttonId === "TASK_COMPLETE") {
    // Pedimos ID de la tarea
    sessions[from].state = "COMPLETE_TASK_ID";
    await sendWhatsAppMessage(from, "¿Cuál es el ID de la tarea a completar?");
    return;
  }
  if (buttonId === "TASK_BACK") {
    // Volvemos al menú principal
    await sendMainMenu(from);
    return;
  }

  // Botones submenú RECORDATORIOS
  if (buttonId === "REM_LIST") {
    const list = await listarRecordatoriosPendientes();
    if (list.length === 0) {
      await sendWhatsAppMessage(from, "No hay recordatorios pendientes.");
    } else {
      let msg = "Recordatorios pendientes (en orden cronológico):\n";
      list.forEach(r => {
        msg += `#${r.id} -> ${r.descripcion} [${r.fecha_hora}]\n`;
      });
      await sendWhatsAppMessage(from, msg);
    }
    await sendReminderMenu(from);
    return;
  }
  if (buttonId === "REM_ADD") {
    // Pedimos la fecha/hora
    sessions[from].state = "ADD_REMINDER_DATE";
    await sendWhatsAppMessage(from, "¿Para cuándo es el recordatorio? (ej: 2025-01-10 14:00, hoy, mañana, en 2 dias, en 30 min, etc.)");
    return;
  }
  if (buttonId === "REM_DEL") {
    // Pedimos ID
    sessions[from].state = "DEL_REMINDER_ID";
    await sendWhatsAppMessage(from, "¿Cuál es el ID del recordatorio a eliminar?");
    return;
  }
  if (buttonId === "REM_BACK") {
    await sendMainMenu(from);
    return;
  }

  // Si no se reconoció
  await sendWhatsAppMessage(from, "Botón no reconocido.");
}

/***********************************************
 * 8. Funciones para enviar menús
 ***********************************************/

// Menú principal (3 botones)
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

// Submenú TAREAS
async function sendTaskMenu(to) {
  const bodyText = "Menú de Tareas";
  const buttons = [
    {
      type: "reply",
      reply: { id: "TASK_SHOW", title: "Mostrar Tareas" },
    },
    {
      type: "reply",
      reply: { id: "TASK_ADD", title: "Agregar Tarea" },
    },
    {
      type: "reply",
      reply: { id: "TASK_COMPLETE", title: "Completar Tarea" },
    },
    {
      type: "reply",
      reply: { id: "TASK_BACK", title: "Volver" },
    },
  ];
  await sendInteractiveButtons(to, bodyText, buttons);
}

// Submenú RECORDATORIOS
async function sendReminderMenu(to) {
  const bodyText = "Menú de Recordatorios";
  const buttons = [
    {
      type: "reply",
      reply: { id: "REM_LIST", title: "Ver Recordatorios" },
    },
    {
      type: "reply",
      reply: { id: "REM_ADD", title: "Agregar Recordatorio" },
    },
    {
      type: "reply",
      reply: { id: "REM_DEL", title: "Eliminar Recordatorio" },
    },
    {
      type: "reply",
      reply: { id: "REM_BACK", title: "Volver" },
    },
  ];
  await sendInteractiveButtons(to, bodyText, buttons);
}

/***********************************************
 * 9. Enviar un mensaje interactivo de botones
 ***********************************************/
async function sendInteractiveButtons(to, bodyText, buttons) {
  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: to,
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
 * 10. parseCustomDate (para "hoy", "mañana", "en X dias", etc.)
 ***********************************************/
function parseCustomDate(str) {
  const lower = str.toLowerCase();

  // "hoy"
  if (lower === "hoy") {
    const now = new Date();
    now.setSeconds(0,0);
    return now;
  }
  // "mañana"
  if (lower === "mañana") {
    const now = new Date();
    now.setDate(now.getDate() + 1);
    now.setSeconds(0,0);
    return now;
  }
  // "pasadomañana"
  if (lower === "pasadomañana") {
    const now = new Date();
    now.setDate(now.getDate() + 2);
    now.setSeconds(0,0);
    return now;
  }

  // "en X dias"
  const enXdias = lower.match(/^en\s+(\d+)\s*d(i|í)as?$/);
  if (enXdias) {
    const days = parseInt(enXdias[1],10);
    if (!isNaN(days)) {
      const now = new Date();
      now.setDate(now.getDate() + days);
      now.setSeconds(0,0);
      return now;
    }
  }

  // "en X horas"
  const enXhours = lower.match(/^en\s+(\d+)\s*h(oras?)?$/);
  if (enXhours) {
    const hours = parseInt(enXhours[1],10);
    if (!isNaN(hours)) {
      const now = new Date();
      now.setHours(now.getHours() + hours);
      now.setSeconds(0,0);
      return now;
    }
  }

  // "en X minutos"
  const enXmin = lower.match(/^en\s+(\d+)\s*min(utos?)?$/);
  if (enXmin) {
    const mins = parseInt(enXmin[1],10);
    if (!isNaN(mins)) {
      const now = new Date();
      now.setMinutes(now.getMinutes() + mins);
      now.setSeconds(0,0);
      return now;
    }
  }

  // Formato "dd-mm-yyyy hh:mm"
  // Ej: "10-01-2025 14:00"
  // Convertimos a "yyyy-mm-ddThh:mm" para new Date
  const reDMY = /^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})$/;
  const matchDMY = lower.match(reDMY);
  if (matchDMY) {
    const dd = matchDMY[1];
    const mm = matchDMY[2];
    const yyyy = matchDMY[3];
    const hh = matchDMY[4];
    const mn = matchDMY[5];
    const isoString = `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}T${hh.padStart(2,"0")}:${mn.padStart(2,"0")}:00`;
    const dt = new Date(isoString);
    if (!isNaN(dt.getTime())) {
      return dt;
    }
  }

  // Formato "yyyy-mm-dd hh:mm"
  const reYMD = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/;
  const matchYMD = lower.match(reYMD);
  if (matchYMD) {
    const yyyy = matchYMD[1];
    const mm = matchYMD[2].padStart(2, "0");
    const dd = matchYMD[3].padStart(2, "0");
    const hh = matchYMD[4].padStart(2, "0");
    const mn = matchYMD[5].padStart(2, "0");
    const isoString = `${yyyy}-${mm}-${dd}T${hh}:${mn}:00`;
    const dt = new Date(isoString);
    if (!isNaN(dt.getTime())) {
      return dt;
    }
  }

  // Si no se pudo parsear nada
  return null;
}

/***********************************************
 * 11. Levantar el servidor
 ***********************************************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto", PORT);
});
