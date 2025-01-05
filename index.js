/*****************************************************************
 * index.js - Example of using the new OpenAI client in ESM
 *****************************************************************/
import express from "express";
import axios from "axios";
import mysql from "mysql2/promise";
import cron from "node-cron";
import OpenAI from "openai";

/***********************************************
 * 1. Setup environment variables & constants
 ***********************************************/
const {
  WHATSAPP_TOKEN,
  VERIFY_TOKEN,
  PHONE_NUMBER_ID,
  OPENAI_API_KEY,
  MYSQLHOST,
  MYSQLUSER,
  MYSQLPASSWORD,
  MYSQLDATABASE,
  MYSQLPORT,
} = process.env;

// This is your personal WhatsApp number to filter incoming messages
const MY_WHATSAPP_NUMBER = "529983214356";

/***********************************************
 * 2. Initialize the new OpenAI client
 ***********************************************/
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  // organization: "org-XXXX", // If needed
  // project: "project-id-here",  // If you're using new project-based keys
});

/***********************************************
 * 3. Initialize MySQL pool
 ***********************************************/
const pool = mysql.createPool({
  host: MYSQLHOST,
  user: MYSQLUSER,
  password: MYSQLPASSWORD,
  database: MYSQLDATABASE,
  port: MYSQLPORT || 3306,
});

/***********************************************
 * 4. Example DB init functions
 ***********************************************/
async function initDB() {
  // Tareas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tareas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      hecha TINYINT DEFAULT 0
    )
  `);

  // Inventario
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventario (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      stock INT DEFAULT 0,
      costo_unitario FLOAT DEFAULT 0
    )
  `);

  // Recordatorios
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recordatorios (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(255) NOT NULL,
      fecha_hora DATETIME NOT NULL,
      enviado TINYINT DEFAULT 0
    )
  `);
  console.log("DB tables verified/created.");
}

await initDB().catch((e) => console.error("Error initDB:", e));

/***********************************************
 * 5. Tareas, Inventario, Recordatorios logic
 ***********************************************/

// TAREAS
export async function agregarTarea(desc) {
  const [result] = await pool.query(
    "INSERT INTO tareas (descripcion, hecha) VALUES (?, 0)",
    [desc]
  );
  return result.insertId;
}
export async function listarTareas() {
  const [rows] = await pool.query("SELECT * FROM tareas WHERE hecha=0");
  return rows;
}
export async function marcarTareaHecha(idTarea) {
  const [result] = await pool.query(
    "UPDATE tareas SET hecha=1 WHERE id=?",
    [idTarea]
  );
  return result.affectedRows;
}

// INVENTARIO
export async function agregarComponente(nombre, cantidad, costo) {
  const [rows] = await pool.query(
    "SELECT * FROM inventario WHERE nombre=?",
    [nombre]
  );
  if (rows.length === 0) {
    await pool.query(
      "INSERT INTO inventario (nombre, stock, costo_unitario) VALUES (?,?,?)",
      [nombre, cantidad, costo]
    );
    return `Componente ${nombre} agregado. Stock=${cantidad}, CostoUnit=${costo}`;
  } else {
    const newStock = rows[0].stock + cantidad;
    await pool.query(
      "UPDATE inventario SET stock=?, costo_unitario=? WHERE id=?",
      [newStock, costo, rows[0].id]
    );
    return `Componente ${nombre} actualizado. Stock=${newStock}, CostoUnit=${costo}`;
  }
}
export async function verComponente(nombre) {
  const [rows] = await pool.query(
    "SELECT * FROM inventario WHERE nombre=?",
    [nombre]
  );
  if (!rows.length) return `No se encontró "${nombre}" en el inventario.`;
  const c = rows[0];
  return `Componente: ${c.nombre}\nStock: ${c.stock}\nCosto Unit: ${c.costo_unitario}`;
}

// RECORDATORIOS
export async function agregarRecordatorio(desc, fechaHora) {
  const [result] = await pool.query(
    "INSERT INTO recordatorios (descripcion, fecha_hora, enviado) VALUES (?, ?, 0)",
    [desc, fechaHora]
  );
  return result.insertId;
}
async function obtenerRecordatoriosPendientes() {
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

/***********************************************
 * 6. node-cron for recordatorios
 ***********************************************/
cron.schedule("* * * * *", async () => {
  try {
    const pendientes = await obtenerRecordatoriosPendientes();
    for (const rec of pendientes) {
      await sendWhatsAppMessage(MY_WHATSAPP_NUMBER, `Recordatorio: ${rec.descripcion}`);
      await marcarRecordatorioEnviado(rec.id);
    }
  } catch (err) {
    console.error("Error en cron job recordatorios:", err);
  }
});

/***********************************************
 * 7. Chat with OpenAI (the new client usage)
 ***********************************************/

async function consultarInfoOpenAI(tema) {
  // We'll call openai.chat.completions.create with the new approach
  const prompt = `Explica detalladamente acerca de: ${tema}`;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // or "gpt-3.5-turbo", etc.
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error("Error consultando OpenAI:", error);
    return "Error al consultar la información.";
  }
}

async function generarPreguntas(tema) {
  const prompt = `
Genera 3 preguntas con sus respuestas sobre el tema "${tema}" 
en formato JSON: [{"pregunta":"...","respuesta":"..."}]
`;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });
    let content = response.choices[0].message.content || "";
    // Intentar parsear
    let preguntas;
    try {
      preguntas = JSON.parse(content);
    } catch (err) {
      console.error("No se pudo parsear JSON:", err);
      preguntas = [{ pregunta: "Error parse", respuesta: content }];
    }
    return preguntas;
  } catch (err) {
    console.error("Error generando preguntas:", err);
    return [];
  }
}

/***********************************************
 * 8. Express + WhatsApp Webhook
 ***********************************************/
const app = express();
app.use(express.json());

// Verificar token
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado con éxito");
    return res.status(200).send(challenge);
  } else {
    console.log("Error verificación webhook");
    return res.sendStatus(403);
  }
});

// Recibir mensajes
app.post("/webhook", async (req, res) => {
  console.log("*** Mensaje entrante ***");
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.object) {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObject = value?.messages?.[0];

    if (messageObject) {
      const from = messageObject.from;
      const textUser = messageObject.text?.body || "";
      const textLower = textUser.toLowerCase().trim();

      // Filtrar
      if (from !== MY_WHATSAPP_NUMBER) {
        console.log("Mensaje de otro número, se ignora.");
        return res.sendStatus(200);
      }

      // Lógica
      if (textLower === "hola" || textLower === "hello") {
        await sendWhatsAppMessage(from, 
          "¡Hola! Soy tu bot con la nueva API de OpenAI.\n" +
          "Comandos: /info, /quiz, /tarea, /listar, /done, /componente, /vercomp, /recordatorio ..."
        );
      }
      else if (textLower.startsWith("/info ")) {
        const tema = textUser.slice(6).trim();
        if (!tema) {
          await sendWhatsAppMessage(from, "Uso: /info <tema>");
        } else {
          const info = await consultarInfoOpenAI(tema);
          await sendWhatsAppMessage(from, info);
        }
      }
      else if (textLower.startsWith("/quiz ")) {
        const tema = textUser.slice(6).trim();
        if (!tema) {
          await sendWhatsAppMessage(from, "Uso: /quiz <tema>");
        } else {
          const preguntas = await generarPreguntas(tema);
          if (preguntas.length === 0) {
            await sendWhatsAppMessage(from, "No pude generar preguntas.");
          } else {
            let resp = `Preguntas de ${tema}:\n\n`;
            preguntas.forEach((p, idx) => {
              resp += `P${idx+1}: ${p.pregunta}\nRespuesta: ${p.respuesta}\n\n`;
            });
            await sendWhatsAppMessage(from, resp);
          }
        }
      }
      // /tarea <desc>, /listar, /done <id>
      else if (textLower.startsWith("/tarea ")) {
        const desc = textUser.slice(7).trim();
        if (!desc) {
          await sendWhatsAppMessage(from, "Uso: /tarea <desc>");
        } else {
          const newId = await agregarTarea(desc);
          await sendWhatsAppMessage(from, `Tarea #${newId} agregada.`);
        }
      }
      else if (textLower === "/listar") {
        const tareas = await listarTareas();
        if (!tareas.length) {
          await sendWhatsAppMessage(from, "No hay tareas pendientes.");
        } else {
          let msg = "Tareas pendientes:\n";
          tareas.forEach(t => {
            msg += `#${t.id} - ${t.descripcion}\n`;
          });
          await sendWhatsAppMessage(from, msg);
        }
      }
      else if (textLower.startsWith("/done ")) {
        const idStr = textUser.slice(6).trim();
        const idNum = parseInt(idStr, 10);
        if (isNaN(idNum)) {
          await sendWhatsAppMessage(from, "Uso: /done <id>");
        } else {
          const changes = await marcarTareaHecha(idNum);
          if (changes > 0) {
            await sendWhatsAppMessage(from, `Tarea #${idNum} marcada como hecha.`);
          } else {
            await sendWhatsAppMessage(from, "No se encontró la tarea o ya está hecha.");
          }
        }
      }
      // /componente <nombre> <stock> <costo>
      else if (textLower.startsWith("/componente ")) {
        const parts = textUser.split(" ");
        if (parts.length < 4) {
          await sendWhatsAppMessage(from, "Uso: /componente <nombre> <stock> <costo>");
        } else {
          const nombre = parts[1];
          const stock = parseInt(parts[2], 10);
          const costo = parseFloat(parts[3]);
          if (isNaN(stock) || isNaN(costo)) {
            await sendWhatsAppMessage(from, "Valores de stock/costo inválidos.");
          } else {
            const resComp = await agregarComponente(nombre, stock, costo);
            await sendWhatsAppMessage(from, resComp);
          }
        }
      }
      // /vercomp <nombre>
      else if (textLower.startsWith("/vercomp ")) {
        const nombre = textUser.slice(9).trim();
        if (!nombre) {
          await sendWhatsAppMessage(from, "Uso: /vercomp <nombre>");
        } else {
          const data = await verComponente(nombre);
          await sendWhatsAppMessage(from, data);
        }
      }
      // /recordatorio YYYY-MM-DD HH:MM algo
      else if (textLower.startsWith("/recordatorio ")) {
        const resto = textUser.slice(14).trim();
        const firstSpace = resto.indexOf(" ");
        if (firstSpace < 0) {
          await sendWhatsAppMessage(from, "Uso: /recordatorio <YYYY-MM-DD HH:MM> <desc>");
        } else {
          const fechaHoraStr = resto.slice(0, firstSpace);
          const desc = resto.slice(firstSpace+1);
          const dateObj = new Date(fechaHoraStr.replace(" ", "T") + ":00");
          if (isNaN(dateObj.getTime())) {
            await sendWhatsAppMessage(from, "Fecha/hora inválida. Formato: YYYY-MM-DD HH:MM");
          } else {
            const iso = dateObj.toISOString().slice(0,19).replace("T"," ");
            const newId = await agregarRecordatorio(desc, iso);
            await sendWhatsAppMessage(from, `Recordatorio #${newId} guardado para ${iso}`);
          }
        }
      }
      else {
        // Desconocido
        await sendWhatsAppMessage(from, 
          `No reconozco este comando.\n` +
          `Prueba: /info <tema>, /quiz <tema>, /tarea, /listar, /done, /componente, /vercomp, /recordatorio...`
        );
      }
    }
  }

  res.sendStatus(200);
});

// Ruta raíz
app.get("/", (req, res) => {
  res.send("¡Hola! Bot con la nueva openai en ESM está corriendo.");
});

/***********************************************
 * 9. Función para enviar msg a WhatsApp
 ***********************************************/
export async function sendWhatsAppMessage(to, message) {
  try {
    const url = `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`;
    const response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("Mensaje enviado con éxito:", response.data);
  } catch (err) {
    console.error("Error al enviar mensaje:", err.response?.data || err.message);
  }
}

/***********************************************
 * 10. Levantar servidor
 ***********************************************/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
